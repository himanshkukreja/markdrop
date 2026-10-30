---
title: API tokens
description: Create a token for the VS Code extension, the CLI, a script or the API. Each token acts as you; revoke it any time.
updated: 2026-10-30
keywords: [api token, mdk, personal access token, bearer, authorization, revoke, vs code, cli, script]
---

An API token lets a program act as you: the VS Code extension, the Markdrop CLI, a script, or a call to the API. Tokens start with `mdk_`.

Manage them at [Settings › API tokens](https://markdrop.in/settings/tokens).

:::warning[Treat a token like a password]
A token can do anything your account can: publish, change and delete your documents, and manage your workspaces. Keep it out of shared files and repositories. If one leaks, revoke it.
:::

## Create a token

::::steps
### Open API tokens
Go to [Settings › API tokens](https://markdrop.in/settings/tokens) and choose **Create token**.

### Name it
Name it after the device or script that will use it, like `My laptop` or `Nightly report`. Names can be up to 80 characters.

### Copy it now
Choose **Create token**, then **Copy token**. This is the only time the full token is shown. Markdrop keeps only a hash of it, so it can't show it to you again.
::::

Make one token for each device or script. Then you can revoke one without breaking the others.

:::tip[VS Code makes its own]
You don't need to create a token for the VS Code extension. Install Markdrop Sync, run **Markdrop: Sign in**, and approve in the browser. Markdrop creates a token named "VS Code" for you. See [Sync with VS Code](/vscode/sync).
:::

## Use a token

Send it in the `Authorization` header:

```bash title="Check who the token belongs to"
curl https://api.markdrop.in/api/v1/auth/me \
  -H "Authorization: Bearer $MARKDROP_TOKEN"
```

The CLI reads the same token from the `MARKDROP_TOKEN` environment variable. See [Sign in and tokens](/cli/login-and-tokens).

Tokens don't expire. A revoked or mistyped token gets `401 Invalid API token`; it's never treated as a signed-out visitor.

:::note[AI assistants use a different sign-in]
The hosted MCP server at `https://api.markdrop.in/mcp` doesn't accept API tokens. AI apps connect with their own sign-in, and you approve each one. See [Connected apps](/account/connected-apps). The local MCP server in the CLI does use an API token.
:::

## See and revoke tokens

The list shows each token's **Name**, the start of the **Token**, when it was **Created**, and when it was **Last used** ("Never" if it hasn't been).

To revoke one, open its menu and choose **Revoke**, then **Revoke token**. Anything using it stops working at once; a VS Code extension using it stops syncing. This can't be undone. Create a new token if you need one again.
