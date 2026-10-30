---
title: Publish into workspaces and folders
nav: Workspaces and folders
description: List your workspaces and their folders with markdrop workspaces, then upload straight into a folder and get a link on the workspace's own domain.
updated: 2026-10-30
prerequisites: [/cli/login-and-tokens, /workspaces/create]
since: CLI 0.5.0
keywords: [workspace, folder, custom domain, team, upload, --workspace, --folder]
---

A file you upload can go straight into one of your workspaces, and into a folder there. When the workspace has a live custom domain, the link you get is on that domain.

## List your workspaces

```bash
markdrop workspaces
```

```text
ID                        NAME   ROLE    DOMAINS
6719f0c2a8e4b3d1c5f60a12  Acme   admin   docs.acme.com
671a22b9d0c4e8f7a1b3c540  Notes  owner   -
```

`ROLE` is your role in that workspace: `viewer`, `member`, `admin` or `owner`. `DOMAINS` lists the custom domains that serve documents right now. A domain that is still being verified, or has lapsed, isn't listed.

## List a workspace's folders

Give the workspace's id, its name or one of its domains:

```bash
markdrop workspaces Acme
markdrop workspaces docs.acme.com
```

```text
PATH                NAME     ITEMS  ID
guides              Guides   12     671b03e1f2a9c7d4b8e60f31
guides/setup        Setup    4      671b03f4a7c2e9d1b0f58a62
releases            Release  7      671b0402c9e1f7a3d5b26c94
```

`PATH` is what `--folder` takes. `ITEMS` counts what you can open in the folder and the folders inside it. A name matches without regard to case. If two of your workspaces have the same name, the CLI asks you to use the id.

## Upload into a folder

```bash
markdrop upload spec.pdf --workspace Acme --folder guides/setup
```

```text
  ✓ Published spec (1.8 MB)
    also at https://markdrop.in/spec
https://docs.acme.com/guides/setup/spec
```

- `--workspace` takes an id, a name or a domain, as above.
- `--folder` takes a path such as `guides/setup`, or a folder id. The folder must already exist. Create folders on markdrop.in, see [Folders](/workspaces/folders), or ask an AI app to use the `create_folder` tool.
- Without `--folder`, the file goes to the top level of the workspace.

The link printed on standard output is the one to share. It is on the workspace's custom domain when it has a live one. The markdrop.in address is printed on standard error as "also at". Both open the same file with the same access: a document has one access level at every address.

### Who can open it

With `--workspace` and no `--access`, the file is open to the workspace's members. Choose something else with `--access`:

```bash
markdrop upload launch.mp4 --workspace Acme --access link       # anyone with the link
markdrop upload draft.pdf --workspace Acme --access private      # only you
```

What "members" includes depends on the workspace's privacy settings. See [Workspace privacy](/workspaces/privacy) and [Who can open a link](/sharing/who-can-open).

### Roles

You need to be a member, an admin or the owner of the workspace to add files to it. Viewers can't add files.

## If filing fails

The CLI looks up the workspace before it sends any data, and Markdrop checks the folder when the upload starts. If filing still fails at the end (for example, the folder was deleted during a long upload, or your role changed), the file is uploaded but stays private to you, and the CLI prints the reason after a `!`:

```text
  ✓ Published spec (1.8 MB)
  ! The file was uploaded but couldn't be added to the workspace (…). It is private to you.
https://markdrop.in/spec
```

Fix the cause and move the file into place on markdrop.in. With `--json`, the reason is in `workspace_error`.

## Use it in scripts

```bash
markdrop workspaces --json          # {"workspaces":[…]}
markdrop workspaces Acme --json     # the folder tree
markdrop upload spec.pdf --workspace Acme --folder guides/setup --json
```

In the upload result, `url` is the address on the custom domain (when it is live) and `markdrop_url` is the markdrop.in address.

## Related

- [Put your workspace on your own domain](/workspaces/custom-domain)
- [Members and roles](/workspaces/members-and-roles)
- [Upload and replace files](/cli/upload-and-replace)
