#!/usr/bin/env bash
# Install apt packages on a GitHub runner from a cache of their .deb files when there is one.
#
#   .github/scripts/apt-cached.sh <cache-dir> <package>...
#
# The workflow restores <cache-dir> with actions/cache, keyed by the runner image (ImageOS +
# ImageVersion) and the package list, so the cached .debs are exactly what that image lacks. A hit
# installs them with dpkg, with no network at all (the Ubuntu mirror has held this step for 5-9
# minutes). A miss (or a dpkg failure) goes to apt, bounded, and leaves the downloaded .debs in
# <cache-dir> with `save=true` in the step's outputs, for actions/cache/save. Never fails the job:
# without the packages, the tests that need them skip and say so.
set -u
dir=$1; shift
pkgs="$*"
mkdir -p "$dir/partial"

if compgen -G "$dir/*.deb" >/dev/null; then
  if timeout 180 sudo dpkg -i "$dir"/*.deb >/dev/null 2>"$dir/../dpkg.err"; then
    echo "installed $pkgs from the cache ($(ls "$dir"/*.deb | wc -l) .debs)"
    exit 0
  fi
  echo "::warning::the cached .debs didn't install ($(tail -n 3 "$dir/../dpkg.err" | tr '\n' ' ')); trying apt"
  rm -f "$dir"/*.deb
fi

opts=(-y -qq --no-install-recommends -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o "Dir::Cache::Archives=$dir")
inst() { timeout 150 sudo apt-get install "${opts[@]}" $pkgs >/dev/null; }
if inst || { timeout 120 sudo apt-get update -qq -o Acquire::Retries=3 -o Acquire::http::Timeout=20 && inst; }; then
  sudo chown -R "$(id -u):$(id -g)" "$dir"
  rm -rf "$dir/partial" "$dir/lock"
  echo "installed $pkgs from apt ($(ls "$dir"/*.deb 2>/dev/null | wc -l) .debs kept for the cache)"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "save=true" >> "$GITHUB_OUTPUT"
else
  sudo chown -R "$(id -u):$(id -g)" "$dir" 2>/dev/null
  rm -f "$dir"/*.deb  # a partial set mustn't be cached
  echo "::warning::couldn't install $pkgs: the tests that need them skip in this job"
fi
exit 0
