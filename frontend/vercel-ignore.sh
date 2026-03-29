#!/bin/bash
# Vercel Ignored Build Step script
# Exit 0 = skip build, Exit 1 = proceed with build

git diff HEAD^ HEAD --quiet -- .
exit $?
