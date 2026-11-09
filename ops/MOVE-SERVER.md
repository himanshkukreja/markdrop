# Moving the Markdrop API server

One command moves everything that runs on the API server (`api.markdrop.in`) to a new Linux VM — on AWS,
GCP, Oracle, Lightsail or anywhere else with Ubuntu/Debian — with under a minute of API downtime:

| Moved | How |
|---|---|
| Code (same commit as the old server) + Python venv with **exactly** the old server's package versions | git clone + `pip install -c <old server's pip freeze>` |
| API + background worker (`markdrop`, `markdrop-worker` + drop-ins), backup timer | `backend/deploy/*.service` |
| nginx site + rate limits, TLS certificate and its renewal (`/etc/letsencrypt`) | copied; certbot renews with the nginx plugin |
| MongoDB 8.0 (all data, users, keyfile) | live copy (dump + change stream) until the cut-over, then counts checked per collection |
| Redis (rate-limit counters) | RDB snapshot at the cut-over |
| GeoIP database + its update config, old local backups | copied |
| Secrets: `backend/.env`, `/etc/markdrop/{mongo,backup}.env`, `/etc/mongod.key`, `/etc/GeoIP.conf` | streamed old → new through SSH; never written to the Mac or printed |

**Not moved** (they don't live on the server): the frontend on Vercel, the Cloudflare Worker / R2 buckets / DNS
zone, the docs site, MongoDB Atlas (the old fallback cluster), GitHub. Nothing there needs changing — they all
reach the API by its name, `api.markdrop.in`.

Files: `ops/move-server.sh` (runs on the Mac), `ops/rehearse-move.sh`, `ops/aws-eip.sh`,
`backend/deploy/provision.sh` (runs on the new server; the move script copies `backend/deploy/` to
`/opt/markdrop-ops` there and calls it).

---

## 1. Create the new server

Size: **≥ 2 vCPU / 4 GB RAM** (2 GB works, as today, but swaps), **≥ 20 GB disk**, **Ubuntu 26.04 LTS**
(same OS and Python 3.14 as today; 24.04 / 22.04 / Debian 12 also work), x86_64 **or arm64**.
Firewall: inbound **22, 80, 443** only (80 is needed for certificate renewals). A **static public IP**.

- **AWS (same account, the planned move):** EC2 › Launch instance › *Ubuntu Server 26.04 LTS (arm64)*,
  **t4g.medium**, gp3 20 GB, key pair `server` (the same `server.pem`), the same security group as the old
  server. Then give it an Elastic IP (EC2 › Elastic IPs › Allocate › Associate) — or pass `--aws-eip` to the
  move and the script does it (keys from `backend/.env`: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
- **Another AWS account:** same as above; a new key pair is fine (`--to-key new.pem`). Elastic IPs can't move
  between accounts: DNS changes either way, the script handles it.
- **Lightsail:** Ubuntu 24.04+, the 4 GB plan, attach a static IP, Networking › IPv4 firewall: add HTTPS (80 and
  22 are there by default).
- **GCP:** Compute Engine, `e2-medium` (or `t2a-standard-1` arm64), Ubuntu 24.04+ image, 20 GB, reserve a static
  external IP, firewall: allow HTTP + HTTPS. The login user is your Google username: the script creates the
  `ubuntu` user (passwordless sudo, your SSH key), so after the move `ssh ubuntu@…`, `deploy.sh` and every
  runbook work exactly as today. Use `--to you@IP --to-key ~/.ssh/google_compute_engine`.
- **Oracle Cloud:** Ampere A1 (arm64) 2 OCPU / 12 GB is in the free tier; Ubuntu 24.04+; reserve a public IP;
  open 80/443 in the VCN security list **and** note Oracle's Ubuntu images also block them in iptables —
  `sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save`.

The login user needs passwordless sudo (the default on all of the above).

**Before the cut-over, outside the server** — services that may only accept calls from known IPs:
- **Brevo** (e-mail): Settings › Security › *Authorised IPs* — if blocking of unknown IPs is on there, add the
  new IP before the cut-over, or e-mails sent through Brevo fail after the move.
- **MongoDB Atlas** (old fallback cluster): only if you'd ever point the app back at it — Network Access › add the new IP.
- Nothing else in `backend/.env` is IP-restricted today (Resend, Anthropic, R2, Google, Slack, GitHub, Vercel,
  PostHog, Atlassian, Cloudflare TURN use keys only) — re-check if you add an IP allowlist anywhere.

## 2. On the Mac

Needs: the two SSH keys, `dig`, `python3`, `curl` (all on macOS). Optional, for an automatic DNS switch:
`export CF_API_TOKEN=… CF_ZONE_ID=…` (Cloudflare › markdrop.in › API token with *Zone › DNS › Edit*, zone ID from
the zone's overview page — in the himanshu@markdrop.in Cloudflare account). Without them the script stops and
tells you exactly which record to change.

**Keep the Mac awake and online from step b to the end of step d**: the database copy flows OLD → Mac → NEW
through SSH tunnels (both MongoDBs listen on localhost only). The script runs `caffeinate` for you; don't
close the lid.

```bash
OLD="ubuntu@ec2-43-205-199-138.ap-south-1.compute.amazonaws.com"
NEW="ubuntu@<new IP>"
K=~/Downloads/server.pem
```

### a. Check (read-only, changes nothing anywhere)
```bash
ops/move-server.sh --from $OLD --from-key $K --to $NEW --to-key $K --dry-run
```
It checks OLD (healthy, self-hosted MongoDB, certificate, no unknown configs, its live config files identical
to `backend/deploy/`) and NEW (OS, arch, RAM, disk, sudo, free ports, can reach GitHub/PyPI/MongoDB downloads,
not already serving) and prints the plan. Any ✗ stops it.

### b. Prepare (OLD keeps serving; takes ~10 min; re-run it as often as you like)
```bash
ops/move-server.sh --from $OLD --from-key $K --to $NEW --to-key $K        # add --aws-eip to get an Elastic IP first
```
Ships the kit, streams the secrets, provisions NEW (packages, `ubuntu` user, swap, code at OLD's commit,
Python + venv pinned to OLD's versions, MongoDB, Redis, units, nginx with the copied certificate), copies
GeoIP + old backups, starts NEW's API once to check `https://api.markdrop.in/health` **through NEW's IP**
(`curl --resolve`), stops it again, then starts the live database copy. Ends with **"✓ ready"**.
NEW's API, worker and backups stay off (role *standby*) until the cut-over.

### c. Rehearse (optional, recommended the first time)
```bash
ops/rehearse-move.sh --from $OLD --from-key $K --to $NEW --to-key $K
```
Runs step b, then checks NEW against OLD (same commit, identical `pip freeze`, certificate, port 80, MongoDB
memory, every collection's count while live), then times NEW's half of the cut-over (drain the copy, start the
API on the copied data, probe, stop) and prints an estimated downtime. OLD is only read. Afterwards NEW holds a
snapshot: **run step b again** before the real cut-over. (`--keep-live` skips the timing part and leaves the
live copy running.)

### d. Cut over (< 1 min of API downtime)
```bash
ops/move-server.sh --from $OLD --from-key $K --to $NEW --to-key $K --cutover        # --dry-run first to see the plan
```
1. stops OLD's API + worker (**downtime starts**);
2. drains the copy and compares every collection's document count — any mismatch: OLD is restarted and nothing else changes;
3. copies Redis;
4. starts NEW's API + worker + backup timer, checks `/health` and the database (**downtime ends**, ~15–30 s);
5. turns OLD's nginx into a **bridge** to NEW, so clients that still resolve the old IP keep working while DNS spreads
   (NEW trusts OLD's `X-Forwarded-For`, so rate limits and logs keep real client IPs);
6. switches DNS `api.markdrop.in` A → NEW (Cloudflare API, or asks you), waits until Cloudflare's nameserver,
   1.1.1.1 and 8.8.8.8 answer the new IP;
7. closes the tunnel and runs `certbot renew --dry-run` on NEW (renewal works once DNS points there).

OLD keeps MongoDB and its data (frozen at the cut-over) and forwards stray traffic; its API, worker and backups are off.

### e. After
- `ops/move-server.sh … --status` shows both servers, DNS and the copy.
- Deploys: `ssh -i $K ubuntu@api.markdrop.in /opt/markdrop/backend/deploy.sh` — unchanged.
- Update the docs that hard-code the old hostname: `docs-platform/setup-github-app.{sh,md}`,
  `docs-platform/slack/SETUP.md` (and PROJECT_CONTEXT / memory).
- After a day or two without problems: stop OLD, keep its disk (snapshot) a week, then terminate it.

### Roll back (any time while OLD still exists)
```bash
ops/move-server.sh --from $OLD --from-key $K --to $NEW --to-key $K --rollback
```
Stops NEW's API + worker, copies NEW's database back onto OLD through a tunnel (counts checked — so writes
made since the cut-over are kept), starts OLD, bridges NEW → OLD, switches DNS back. ~1–2 min of downtime.
If the copy-back fails, NEW is started again and nothing else changes.

---

## Re-running, safety, state

- Every step can be re-run. Prepare restarts the database copy from scratch (`mongorestore --drop`, on NEW only).
- The tools refuse to: provision or copy onto a server that runs the API (OLD, or NEW after the cut-over), use the
  same host as both ends, copy a MongoDB onto itself (a tunnel looping back), cut over when the copy is not live.
- State and a full log live in `~/.markdrop-move/<hash of NEW>/` on the Mac (`move.log`, `rehearse.log`).
  No secret is ever in them.
- Server roles: `/etc/markdrop/role` = `standby` (provisioned, not serving) or `live`. `provision.sh install`
  refuses a live server; code updates there go through `backend/deploy.sh` as always.
- Config drift: preflight compares OLD's live unit/nginx/sysctl files with `backend/deploy/` and stops on any
  difference — commit OLD's version into `backend/deploy/` (or `--allow-drift` to use the kit's).

## Sizing (applied automatically from the RAM)

| RAM | swap | MongoDB cache | mongod MemoryHigh / Max | API (fixed) | worker (fixed) |
|---|---|---|---|---|---|
| < 3 GB (today's t3.small) | 2 GB | 0.25 GB | 600M / 900M | 1100M / 1500M | 600M / 900M |
| 3.5–16 GB (t4g.medium: 4 GB) | 1 GB | 1 GB | 1624M / 2024M | 1100M / 1500M | 600M / 900M |

Override with `MONGO_CACHE_GB`, `MONGO_MEMORY_HIGH`, `MONGO_MEMORY_MAX` when running `install-mongo.sh` by hand.

## arm64 and Python

- MongoDB 8.0.34 and database tools 100.20.1 have official arm64 builds for Ubuntu 22.04/24.04 (used on 24.04+,
  as on today's 26.04 x86 server); Debian arm64 uses the Ubuntu 22.04 build. MongoDB 8 on arm needs ARMv8.2-A:
  AWS Graviton2+ (t4g, m6g, c7g…), Oracle Ampere, GCP Tau T2A all qualify; a Raspberry Pi 4 does not.
- Python: the system `python3` is used when ≥ 3.12 (26.04: 3.14 = today; 24.04: 3.12). Older systems get a
  standalone CPython 3.14 via `uv` (`--python 3.14` forces it). Every one of the 79 packages, at today's exact
  versions, ships a binary wheel for cp312 and cp314 on both x86_64 and aarch64 (checked 2026-11-09), so no
  compiler is needed. If a future version lacks one, provision installs `build-essential python3-dev pkg-config
  libffi-dev libssl-dev` and retries.
- System packages: nginx, redis-server, certbot + python3-certbot-nginx, ffmpeg (video posters/metadata),
  geoipupdate, git, python3-venv — all in Ubuntu's arm64 archive.

---

## Disaster recovery: the old server is gone

Build a new server from the newest R2 backup (backups run every 6 h, kept 14 days locally and in the
`markdrop-backups` R2 bucket):

```bash
ops/move-server.sh --from-backup latest --to $NEW --to-key $K \
    --env-file ~/secure/markdrop.env --backup-env ~/secure/backup.env \
    [--geoip-conf ~/secure/GeoIP.conf] [--email you@markdrop.in] [--aws-eip]
```
(`--from-backup mongo-20261109T121700Z.archive.gz` picks a specific one.) It provisions NEW, downloads and
restores the backup, starts everything, switches DNS, then issues a fresh Let's Encrypt certificate.

**Secrets you must have outside the server** (password manager), because they exist nowhere else:
1. `backend/.env` — the whole file (every setting: auth/token-encryption/artifact-signing keys, R2, Google, Slack,
   GitHub App, Resend/Brevo, Anthropic, Vercel, PostHog, VAPID, Atlassian, Cloudflare…). Losing
   `MARKDROP_TOKEN_ENCRYPTION_KEY` makes every stored Google/Slack/Jira token unreadable; losing
   `MARKDROP_AUTH_SECRET` signs everyone out.
2. `/etc/markdrop/backup.env` — `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `MARKDROP_BACKUP_R2_BUCKET` (to download the backup).
3. `/etc/GeoIP.conf` — MaxMind account ID + licence key (optional: without it, no city-level analytics until added).

Not needed: `mongo.env` and `mongod.key` (fresh ones are generated; `.env`'s database URI is rewritten to them),
the certificate (re-issued). Lost by nature: writes after the backup (≤ 6 h), Redis counters.

> ⚠ As of 2026-11-09 the R2 upload of backups fails with **AccessDenied** (the R2 key in `backup.env` cannot write
> to `markdrop-backups`): only the local copies on the server exist, so this recovery path does not work until the
> key is fixed. Check with `sudo journalctl -u markdrop-backup -n 20` after the next run.

Practise it while the real server lives: add `--practice` — it provisions a spare VM, restores the backup and
checks the API on it, but never starts the worker (it would send e-mails from a copy), never touches DNS and
never asks for a certificate. Terminate the VM afterwards.

## Running the server-side steps by hand

`/opt/markdrop-ops/provision.sh` on any provisioned server:
`install` · `smoke` · `go-live` · `standby` · `realip <IP>|off` · `bridge <IP>|off` · `restore-backup latest|<name>` ·
`issue-cert [EMAIL]` · `status`. The live database copy is the transient unit `markdrop-move-sync`
(log `/var/log/markdrop-move-sync.log`, stop file `/var/lib/markdrop-move/sync.stop`).
