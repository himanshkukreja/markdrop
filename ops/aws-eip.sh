#!/usr/bin/env bash
#
# aws-eip.sh — give an EC2 instance a fixed public address (Elastic IP), so its IP survives a stop/start
# and DNS can point at it for good. Runs on the Mac; used by `move-server.sh --aws-eip`, or on its own:
#
#   ops/aws-eip.sh <instance-id | public IP | public DNS name> [--region ap-south-1] [--aws-env FILE] [--dry-run]
#
# - Already has an Elastic IP → prints it, changes nothing.
# - Otherwise allocates one (tag Name=markdrop-api) and associates it. The instance's old auto-assigned IP is
#   released by AWS at that moment: SSH to the new address from then on.
# The last line of output is always the instance's public IP after this ran ("EIP <ip>").
#
# AWS keys: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment, else read (never printed) from
# --aws-env (default: backend/.env next to this script's repo). Needs EC2 rights: Describe*, AllocateAddress,
# AssociateAddress, CreateTags. Python with boto3: $MOVE_PY, else backend/.venv/bin/python, else python3.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="" REGION="${AWS_REGION:-ap-south-1}" AWS_ENV="$HERE/../backend/.env" DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --region) REGION=$2; shift 2 ;;
    --aws-env) AWS_ENV=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option $1"; exit 1 ;;
    *) TARGET=$1; shift ;;
  esac
done
[ -n "$TARGET" ] || { sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

PY="${MOVE_PY:-}"
for c in "$PY" "$HERE/../backend/.venv/bin/python" python3; do
  [ -n "$c" ] && command -v "$c" >/dev/null && "$c" -c 'import boto3' 2>/dev/null && { PY=$c; break; }
done
"$PY" -c 'import boto3' 2>/dev/null || { echo "  ✗ needs a Python with boto3 (set MOVE_PY)"; exit 1; }

TARGET="$TARGET" REGION="$REGION" AWS_ENV="$AWS_ENV" DRY="$DRY" "$PY" - <<'EOF'
import os, socket, sys, boto3

def env_file(p):
    out = {}
    try:
        for line in open(p):
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                out[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return out

keys = {k: os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")}
if not all(keys.values()):
    f = env_file(os.environ["AWS_ENV"])
    keys = {k: f.get(k) for k in keys}
if not all(keys.values()):
    sys.exit(f"  ✗ no AWS keys in the environment or {os.environ['AWS_ENV']}")
ec2 = boto3.client("ec2", region_name=os.environ["REGION"], aws_access_key_id=keys["AWS_ACCESS_KEY_ID"],
                   aws_secret_access_key=keys["AWS_SECRET_ACCESS_KEY"])
dry = os.environ["DRY"] == "1"
t = os.environ["TARGET"]
if t.startswith("i-"):
    flt = [{"Name": "instance-id", "Values": [t]}]
else:
    ip = socket.gethostbyname(t)
    flt = [{"Name": "ip-address", "Values": [ip]}]
res = [i for r in ec2.describe_instances(Filters=flt)["Reservations"] for i in r["Instances"]]
if len(res) != 1:
    sys.exit(f"  ✗ found {len(res)} instances for {t} in {os.environ['REGION']}")
inst = res[0]
iid, ip = inst["InstanceId"], inst.get("PublicIpAddress")
name = next((x["Value"] for x in inst.get("Tags", []) if x["Key"] == "Name"), "")
print(f"  ✓ {iid} {name} {inst['InstanceType']} {inst['State']['Name']} public {ip}")
addrs = ec2.describe_addresses(Filters=[{"Name": "instance-id", "Values": [iid]}])["Addresses"]
if addrs:
    print(f"  ✓ already has Elastic IP {addrs[0]['PublicIp']}")
    print(f"EIP {addrs[0]['PublicIp']}")
    sys.exit(0)
if dry:
    print("  · (dry-run) would allocate an Elastic IP and associate it (the current public IP goes away)")
    print(f"EIP {ip}")
    sys.exit(0)
a = ec2.allocate_address(Domain="vpc", TagSpecifications=[{"ResourceType": "elastic-ip",
                         "Tags": [{"Key": "Name", "Value": "markdrop-api"}]}])
ec2.associate_address(AllocationId=a["AllocationId"], InstanceId=iid)
print(f"  ✓ Elastic IP {a['PublicIp']} ({a['AllocationId']}) → {iid}; {ip} is released")
print(f"EIP {a['PublicIp']}")
EOF
