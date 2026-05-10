# Release Guide

## Prerequisites (one-time)

- `gh` CLI active account must be `himanshkukreja`:
  ```bash
  gh auth status   # check
  gh auth switch --user himanshkukreja   # switch if needed
  ```
- `HOMEBREW_TAP_TOKEN` secret set on the repo:
  ```bash
  gh secret set HOMEBREW_TAP_TOKEN --repo himanshkukreja/markdrop
  ```
- `himanshkukreja/homebrew-tap` repo exists on GitHub.

---

## Steps for each release

### 1. Make sure main is clean and pushed
```bash
cd /Users/himanshukukreja/markdrop
git status          # should be clean
git push origin main
```

### 2. Choose a version
Follow semver: `v0.1.0` → `v0.1.1` (patch), `v0.2.0` (minor), `v1.0.0` (major).

### 3. Dry-run locally (optional but recommended)
```bash
cd cli
goreleaser release --snapshot --clean
# Check dist/ for binaries, .deb, .rpm, .apk, .rb formula
```

### 4. Tag and push
```bash
VERSION=v0.2.0   # ← change this

cd /Users/himanshukukreja/markdrop
git tag cli/$VERSION
git push origin cli/$VERSION
```

This triggers the GitHub Actions workflow automatically.

### 5. Watch the run
```
https://github.com/himanshkukreja/markdrop/actions
```

### 6. Verify the release
- GitHub Release published at `https://github.com/himanshkukreja/markdrop/releases`
- Homebrew formula pushed to `himanshkukreja/homebrew-tap`
- `.deb` / `.rpm` / `.apk` attached to the release

---

## If the release fails

Delete the tag, fix the issue on main, then re-tag:
```bash
VERSION=v0.1.0   # ← version that failed

git tag -d cli/$VERSION
git push origin :refs/tags/cli/$VERSION

# fix, commit, push to main…

git tag cli/$VERSION
git push origin cli/$VERSION
```

---

## Install the released binary (test it)

```bash
# macOS (after homebrew-tap is set up)
brew install himanshkukreja/tap/markdrop

# Linux / macOS (curl)
curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh

# Verify
markdrop --version
```
