---
title: Install the markdrop CLI
nav: Install
description: Install the markdrop command-line tool on macOS, Linux or Windows with Homebrew, the install script or a release package.
updated: 2026-10-30
checked: 2026-10-30
keywords: [cli, install, homebrew, brew, curl, powershell, deb, rpm, apk, terminal]
---

The markdrop CLI is a single binary for macOS, Linux and Windows. It sends files peer to peer (`send`, `get`), publishes files behind a link you can replace later (`upload`, `replace`), and runs a local MCP server for AI apps on your computer (`mcp`). The current release is 0.5.1.

## Install

::::tabs{sync="os"}
:::tab[macOS]
With Homebrew:

```bash title="Install with Homebrew"
brew install himanshkukreja/tap/markdrop
```

Without Homebrew, run the install script. It downloads the latest release for your Mac (Apple silicon or Intel) and puts `markdrop` in `/usr/local/bin` when it can write there (or use `sudo` without a password prompt), otherwise in `~/bin`.

```bash title="Install with the script"
curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh
```
:::

:::tab[Windows]
In PowerShell:

```powershell title="Install with PowerShell"
irm https://github.com/himanshkukreja/markdrop/releases/latest/download/install.ps1 | iex
```

The script installs `markdrop.exe` to `%LOCALAPPDATA%\markdrop` and adds that folder to your user `PATH`. Open a new terminal before you run `markdrop`.

Windows builds are 64-bit x86 (amd64) only. On Windows on Arm, the script installs the x64 build, which runs under emulation.
:::

:::tab[Linux]
Run the install script. It picks the build for your machine (x86-64 or arm64) and puts `markdrop` in `/usr/local/bin` when it can write there (or use `sudo` without a password prompt), otherwise in `~/bin`.

```bash title="Install with the script"
curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh
```

Prefer a package? Every release has `.deb`, `.rpm` and `.apk` files for `amd64` and `arm64`. Download the one for your system from the [releases page](https://github.com/himanshkukreja/markdrop/releases/latest), then install it:

```bash title="Install a downloaded package"
sudo apt install ./markdrop_0.5.1_linux_amd64.deb      # Debian, Ubuntu
sudo dnf install ./markdrop_0.5.1_linux_amd64.rpm      # Fedora, RHEL
sudo apk add --allow-untrusted ./markdrop_0.5.1_linux_amd64.apk   # Alpine
```

Markdrop doesn't run an apt or dnf repository, so packages don't update themselves. Download the new package to update.
:::
::::

## Check it works

```bash
markdrop --version
```

```text
markdrop version 0.5.1
```

If your shell says `markdrop: command not found`, the folder it was installed to isn't on your `PATH`. The install script prints where it put the binary. When it falls back to `~/bin`, add that folder to your `PATH`:

```bash
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Use `~/.zshrc` instead of `~/.bashrc` if your shell is zsh.

## Update

| You installed with | Update with |
|---|---|
| Homebrew | `brew upgrade markdrop` |
| The install script | Run the same script again. It always fetches the latest release. |
| A `.deb`, `.rpm` or `.apk` package | Download and install the newer package. |

## Download a binary yourself

Each [GitHub release](https://github.com/himanshkukreja/markdrop/releases/latest) has these files, where `0.5.1` is the version:

| File | For |
|---|---|
| `markdrop_0.5.1_darwin_arm64.tar.gz` | macOS on Apple silicon |
| `markdrop_0.5.1_darwin_amd64.tar.gz` | macOS on Intel |
| `markdrop_0.5.1_linux_amd64.tar.gz`, `markdrop_0.5.1_linux_arm64.tar.gz` | Linux |
| `markdrop_0.5.1_windows_amd64.zip` | Windows (x86-64) |
| `checksums.txt` | SHA-256 of every file above |

Check the download against `checksums.txt` before you run it:

```bash title="Linux"
sha256sum --ignore-missing -c checksums.txt
```

```bash title="macOS"
shasum -a 256 markdrop_0.5.1_darwin_arm64.tar.gz
# compare with the matching line in checksums.txt
```

Then extract the archive and move `markdrop` (or `markdrop.exe`) to a folder on your `PATH`.

## Uninstall

1. Run `markdrop logout` to delete the API token saved on this computer, if you saved one. See [Sign in and API tokens](/cli/login-and-tokens).
2. Remove the binary the way you installed it:

| You installed with | Remove with |
|---|---|
| Homebrew | `brew uninstall markdrop` |
| The install script | Delete `/usr/local/bin/markdrop` or `~/bin/markdrop`. On Windows, delete the `%LOCALAPPDATA%\markdrop` folder. |
| A `.deb` package | `sudo apt remove markdrop` |
| An `.rpm` package | `sudo dnf remove markdrop` |
| An `.apk` package | `sudo apk del markdrop` |

Packages install the binary at `/usr/bin/markdrop`.

## Build from source

You need Go 1.25 or later and `make`. The module path isn't the repository's, so `go install …@latest` doesn't work. Clone the repository and build in `cli/`:

```bash title="Build from source"
git clone https://github.com/himanshkukreja/markdrop
cd markdrop/cli
make build      # writes ./markdrop
make install    # or put markdrop in $GOBIN (default ~/go/bin)
```

## Next steps

::::cards
:::card[Sign in]{href="/cli/login-and-tokens" icon="lock"}
Save an API token so `upload` and `replace` can publish as you.
:::
:::card[Publish a file]{href="/cli/upload-and-replace" icon="upload"}
Put a video, PDF or HTML page behind a link and update it later.
:::
:::card[Send a file]{href="/cli/send-and-receive" icon="wave"}
Send a file or folder straight to another computer.
:::
:::card[Every command]{href="/cli/reference" icon="code"}
Flags, defaults, environment variables and exit codes.
:::
::::
