#!/usr/bin/env bash
# Install apt packages on a GitHub runner from a cache of their .deb files when there is one.
#
#   .github/scripts/apt-cached.sh <cache-dir> <package>...
#
# The workflow restores <cache-dir> with actions/cache, keyed by the runner image (ImageOS +
# ImageVersion) and the package list, so the cached .debs are exactly what that image lacks. A hit
# installs them with dpkg, with no network at all (the Ubuntu mirror has held this step for 5-9
# minutes). A miss (or a dpkg failure) goes to apt, retried with backoff in stages, each one more
# forgiving than the last:
#   1. install with the image's package lists
#   2. apt-get update (a failing third-party repo doesn't stop it), install
#   3. apt-get update --fix-missing, install --fix-missing
#   4. the same against archive.ubuntu.com instead of the runner's Azure mirror
#   5. the same against mirrors.edge.kernel.org
# all within APT_BUDGET seconds (default 420). The downloaded .debs stay in <cache-dir> between
# stages, so a slow mirror's progress isn't lost. If the whole set still won't install, each package
# is tried on its own (zsh alone is a few hundred KB; ffmpeg pulls ~90 .debs). A full install leaves
# `save=true` in the step's outputs, for actions/cache/save; a partial one caches nothing. Never fails
# the job: without the packages, the tests that need them skip and say so (the workflow checks the
# ones it can't do without, e.g. zsh).
set -u
dir=$1; shift
pkgs=("$@")
budget=${APT_BUDGET:-420}
mkdir -p "$dir/partial"
log="$dir/../apt.log"; : > "$log"

if compgen -G "$dir/*.deb" >/dev/null; then
  if timeout 180 sudo dpkg -i "$dir"/*.deb >/dev/null 2>"$dir/../dpkg.err"; then
    echo "installed ${pkgs[*]} from the cache ($(ls "$dir"/*.deb | wc -l) .debs)"
    exit 0
  fi
  echo "::warning::the cached .debs didn't install ($(tail -n 3 "$dir/../dpkg.err" | tr '\n' ' ')); trying apt"
  rm -f "$dir"/*.deb
fi

apt=(sudo DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20
     -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60)
left() { echo $(( budget - SECONDS )); }
# bounded by the time left in the budget, never more than $1 seconds
cap() { local l; l=$(left); (( l < $1 )) && echo $(( l > 10 ? l : 10 )) || echo "$1"; }
inst() { timeout "$(cap 150)" "${apt[@]}" install -y -qq --no-install-recommends \
           -o "Dir::Cache::Archives=$dir" "$@" >>"$log" 2>&1; }
upd() { timeout "$(cap 100)" "${apt[@]}" update -qq "$@" >>"$log" 2>&1 \
          || echo "  apt-get update $* exited $? (carrying on: one bad repo mustn't stop the install)"; }
# point the Ubuntu archive at another mirror (the runner's sources use the Azure mirror, directly or
# through mirror+file:/etc/apt/apt-mirrors.txt; security.ubuntu.com stays as it is)
mirror() {
  sudo sed -i -E "s#(mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z0-9.-]*(archive\.ubuntu\.com|edge\.kernel\.org)/ubuntu/?)#$1#g" \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null
  echo "  using the mirror $1"
}
stage() {  # stage <n> <backoff-seconds>: false when the budget is spent
  (( $(left) > 20 )) || { echo "  apt budget (${budget}s) spent"; return 1; }
  (( $2 > 0 )) && { echo "  stage $1 in ${2}s (${SECONDS}s so far)"; sleep "$2"; }
  echo "--- stage $1" >> "$log"
  return 0
}

ok=0
if   stage 1 0  && inst "${pkgs[@]}"; then ok=1
elif stage 2 5  && { upd; inst "${pkgs[@]}"; }; then ok=1
elif stage 3 15 && { upd --fix-missing; inst --fix-missing "${pkgs[@]}"; }; then ok=1
elif stage 4 30 && { mirror http://archive.ubuntu.com/ubuntu/; upd --fix-missing; inst --fix-missing "${pkgs[@]}"; }; then ok=1
elif stage 5 45 && { mirror http://mirrors.edge.kernel.org/ubuntu/; upd --fix-missing; inst --fix-missing "${pkgs[@]}"; }; then ok=1
fi

sudo chown -R "$(id -u):$(id -g)" "$dir" 2>/dev/null
rm -rf "$dir/partial" "$dir/lock"
if (( ok )); then
  echo "installed ${pkgs[*]} from apt in ${SECONDS}s ($(ls "$dir"/*.deb 2>/dev/null | wc -l) .debs kept for the cache)"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "save=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "::group::apt log (last 40 lines)"; tail -n 40 "$log"; echo "::endgroup::"
# one at a time, so the small essential ones (zsh) don't go down with the big ones (ffmpeg)
budget=$(( budget + 120 )); missing=()
for p in "${pkgs[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 && continue
  (( $(left) > 10 )) && inst --fix-missing "$p" && { echo "  installed $p on its own"; continue; }
  missing+=("$p")
done
sudo chown -R "$(id -u):$(id -g)" "$dir" 2>/dev/null
rm -f "$dir"/*.deb  # a partial set mustn't be cached
if (( ${#missing[@]} )); then
  echo "::warning::couldn't install ${missing[*]} after ${SECONDS}s: the tests that need them skip in this job"
else
  echo "::warning::installed ${pkgs[*]} one at a time after the set failed (${SECONDS}s); nothing cached"
fi
exit 0
