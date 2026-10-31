#!/bin/bash
# Vercel Ignored Build Step script
# Exit 0 = skip build, Exit 1 = proceed with build
#
# Builds cost plan usage, so only build what someone will look at:
#   - main (production), when something under frontend/ changed;
#   - a branch named preview/*, when a preview link is really wanted.
# Every other branch (feature work, agent worktrees) is skipped: it's tested locally.

case "$VERCEL_GIT_COMMIT_REF" in
  main | preview/*) ;;
  *)
    echo "Skipping build: branch '$VERCEL_GIT_COMMIT_REF' is not main or preview/*"
    exit 0
    ;;
esac

git diff HEAD^ HEAD --quiet -- .
exit $?
