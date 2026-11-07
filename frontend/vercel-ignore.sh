#!/bin/bash
# Vercel Ignored Build Step script
# Exit 0 = skip build, Exit 1 = proceed with build
#
# Vercel never builds Markdrop on a Git push: frontend/vercel.json has "git": {"deploymentEnabled":
# false}, and production is built on GitHub Actions and uploaded prebuilt (vercel-deploy.yml).
# The one Git-sourced build left is the emergency fallback (vercel-git-deploy.yml, run by hand),
# which always deploys main: build that, whatever its last commit touched. Every other branch,
# preview/* included, is skipped (no preview builds: they cost the shared team's build minutes).

case "$VERCEL_GIT_COMMIT_REF" in
  main) exit 1 ;;
  *)
    echo "Skipping build: branch '$VERCEL_GIT_COMMIT_REF' is not main (Vercel builds only the emergency fallback)"
    exit 0
    ;;
esac
