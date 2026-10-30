---
title: Sign in with an API token
nav: Sign in and tokens
description: Create a Markdrop API token, save it with markdrop login or pass it as MARKDROP_TOKEN, and revoke it when a device is gone.
updated: 2026-10-30
prerequisites: [/cli/install]
since: CLI 0.4.0
keywords: [login, logout, token, api token, mdk, MARKDROP_TOKEN, ci, authentication]
---

The CLI acts as you through an API token, a long string that starts with `mdk_`. Commands that publish or look up your files need one. Peer-to-peer `send` and `get` work without it; with one, `send` and the shares `markdrop mcp` starts are listed under your account.

| Needs a token | Works without one |
|---|---|
| `upload`, `replace`, `versions`, `restore`, `info`, `workspaces` | `send`, `get` |
| The file and workspace tools of `markdrop mcp` | The peer-to-peer tools of `markdrop mcp` |

## Create a token

::::steps
### Open API tokens
Go to [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens) while signed in.

### Create it
Choose **Create token**, name it after the device or script that will use it (for example "My laptop" or "CI"), and choose **Create token**.

### Copy it now
The full token is shown once. Choose **Copy token** and keep it somewhere safe until you've saved it in the CLI.
::::

:::warning[A token is your whole account]
An API token can do anything you can do on Markdrop: publish, change access, delete. Make one token per device or script, so you can revoke one without breaking the others, and never commit a token to a repository.
:::

## Save it on this computer

```bash
markdrop login
```

Paste the token when asked. Nothing is shown while you paste. The CLI checks the token with Markdrop and prints the account it belongs to:

```text
  ✓ Logged in as you@example.com. Token saved to /Users/you/Library/Application Support/markdrop/token
```

If Markdrop rejects the token, nothing is saved. If Markdrop can't be reached, the token is saved anyway and checked on first use.

You can also pass the token without the prompt:

```bash
markdrop login --token mdk_••••
printf '%s\n' "$MY_TOKEN" | markdrop login   # read from a pipe
```

### Where the token is kept

The token is stored in a file only your user can read (mode `0600`, in a folder with mode `0700`):

| System | File |
|---|---|
| macOS | `~/Library/Application Support/markdrop/token` |
| Linux | `~/.config/markdrop/token` (or `$XDG_CONFIG_HOME/markdrop/token`) |
| Windows | `%AppData%\markdrop\token` |

Set `MARKDROP_CONFIG_DIR` to keep it somewhere else. The file is then `$MARKDROP_CONFIG_DIR/token`.

## Use a token without saving it

Set `MARKDROP_TOKEN` in the environment, or pass `--token` to a single command:

```bash
export MARKDROP_TOKEN=mdk_••••
markdrop upload demo.mp4

markdrop upload demo.mp4 --token mdk_••••
```

When more than one is set, the CLI uses the first it finds in this order:

1. `--token` on the command
2. `MARKDROP_TOKEN`
3. The token saved by `markdrop login`

`markdrop login` warns you when `MARKDROP_TOKEN` is set, because that one wins over the token it saved.

## Use it in CI

Store the token as a secret in your CI system and expose it as `MARKDROP_TOKEN`. For example, in GitHub Actions:

```yaml title=".github/workflows/publish.yml"
- name: Publish the demo video
  env:
    MARKDROP_TOKEN: ${{ secrets.MARKDROP_TOKEN }}
  run: |
    curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh
    markdrop replace demo-clip build/demo.mp4 --json
```

In scripts, `--json` prints one JSON object on standard output and nothing else. See [Upload and replace files](/cli/upload-and-replace#use-it-in-scripts).

## Sign out

```bash
markdrop logout
```

This deletes the saved token from this computer. It doesn't revoke the token: anyone who copied it can still use it. To end a token everywhere, open [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens), choose **Revoke** on its row and confirm with **Revoke token**. Anything using it, such as a VS Code window or a CI job, stops working at once.

## If something goes wrong

:::details[“no Markdrop API token: set MARKDROP_TOKEN (or run `markdrop login`)”]
The command needs a token and found none in `--token`, `MARKDROP_TOKEN` or the saved file. Run `markdrop login`, or set `MARKDROP_TOKEN`.
:::

:::details[“the API token was rejected”]
The token was revoked, mistyped or belongs to another server. Create a new one at [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens) and run `markdrop login` again. If `MARKDROP_TOKEN` is set in your shell, it is the one being used: unset it or update it.
:::

:::details[Can I use the same token for the AI connector on claude.ai or ChatGPT?]
No. The hosted MCP server at `https://api.markdrop.in/mcp` only accepts the sign-in each AI app gets through Markdrop's own approval screen, and refuses `mdk_` tokens. API tokens are for the CLI, the VS Code extension, the local MCP server and the REST API. See [Connect an AI app](/ai/hosted-mcp).
:::

More about tokens on the web: [API tokens](/account/api-tokens).
