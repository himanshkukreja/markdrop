# Set up Markdrop for Slack (about 5 minutes)

Markdrop for Slack is one Slack app, owned by Markdrop, that each team installs from
**Workspace settings › Integrations › Slack › Add to Slack**. This page creates the app on
api.slack.com from `docs-platform/slack/manifest.yaml`, gives the API server its three secrets, and
checks that it works.

Until it is set up, the Slack card in Workspace settings says "Not set up yet" and nothing else
changes.

## Before you start

- **Deploy the backend with the Slack integration first.** The API refuses `.env` keys it doesn't
  know (an unknown `MARKDROP_*` key stops it from starting), so the three keys below go in only
  after the code that declares them is live.
- Have a terminal open on the Mac that has `~/Downloads/server.pem` (the API server's SSH key).
- Sign in to Slack in the browser with the workspace you want to own the app (the Markdrop team's
  own Slack). The app can be installed by any other Slack workspace later. It doesn't need to be
  listed in the Slack Marketplace for that; the listing comes later.

## 1. Create the app from the manifest (1 minute)

1. Open https://api.slack.com/apps › **Create New App** › **From an app manifest**.
2. Pick your workspace › **Next**.
3. Choose the **YAML** tab, delete what's there, and paste all of `docs-platform/slack/manifest.yaml`.
   › **Next** › **Create**.

Slack may say the **Event Subscriptions** request URL isn't verified yet. That's expected: the API
can't answer Slack until it has the signing secret (step 3). You verify it in step 4.

The manifest asks for these bot scopes: `commands`, `chat:write`, `chat:write.public`, `links:read`,
`links:write`, `im:write`, `channels:read`, `groups:read`, and the user scope `openid` (Sign in with
Slack, used once to link a person's account; Markdrop keeps no user token).

## 2. Copy the three secrets (1 minute)

On the app's **Basic Information** page, under **App Credentials**:

| Slack shows | Goes into the server `.env` as |
| --- | --- |
| Client ID | `MARKDROP_SLACK_CLIENT_ID` |
| Client Secret (click **Show**) | `MARKDROP_SLACK_CLIENT_SECRET` |
| Signing Secret (click **Show**) | `MARKDROP_SLACK_SIGNING_SECRET` |

Keep them in your password manager. They never go into git, chat or a ticket.

Also check that the server `.env` already has `MARKDROP_TOKEN_ENCRYPTION_KEY` (it does if Google
Docs export works). Slack bot tokens are encrypted at rest with it; without it, Add to Slack
answers "Not set up yet".

## 3. Put the secrets on the server (2 minutes)

```bash
ssh -i ~/Downloads/server.pem ubuntu@ec2-43-205-199-138.ap-south-1.compute.amazonaws.com
cd /opt/markdrop/backend
cp .env .env.bak-$(date +%Y%m%d%H%M)
nano .env        # add the three lines from step 2, save
# Check the file before restarting (an unknown or misspelled key stops the API):
PYTHONPATH=/opt/markdrop/backend .venv/bin/python -c "from app.config import Settings; s=Settings(); print('slack ok' if s.slack_configured else 'slack MISSING')"
sudo systemctl restart markdrop
curl -s http://127.0.0.1:8080/health
```

It should print `slack ok`, then `{"status":"ok"...}` after 10 to 20 seconds. If the health check
fails, put the backup back (`cp .env.bak-… .env`, restart) and check the key names.

## 4. Verify the request URLs (30 seconds)

Back on api.slack.com, in the app:

1. **Event Subscriptions**: next to the Request URL `https://api.markdrop.in/api/v1/slack/events`,
   click **Retry** (or re-save). It should turn **Verified**. **Save Changes**.
2. **Interactivity & Shortcuts** and **Slash Commands** need no verification; check they show
   `https://api.markdrop.in/api/v1/slack/interactivity` and `…/slack/commands`.
3. **Manage Distribution** › **Activate Public Distribution** (tick the checklist and confirm). This
   lets other Slack workspaces install the app from Markdrop's Add to Slack button. It does not list
   it in the Slack Marketplace.

## 5. Install it and check it works (1 minute)

1. In Markdrop: **Workspace settings › Integrations › Slack › Add to Slack**. Pick the Slack
   workspace, **Allow**. You come back to Markdrop, connected, with your own account linked.
2. Pick a **Meetings channel** (a public channel works straight away; for a private one, first type
   `/invite @Markdrop` in it).
3. In Slack, type `/markdrop help` (only you see the reply), then `/markdrop search` with a word from
   one of your documents.
4. Paste a link to a document that anyone with the link can open into a channel. It unfurls with a
   preview. A private document's link shows "Markdrop link — sign in to view" instead.
5. Import a meeting in Markdrop (Meetings › Import). When its summary is ready, it's posted in the
   meetings channel; click **Done** on an action item and it's ticked on the Markdrop page.

## Rotating a secret

- **Signing Secret:** Basic Information › App Credentials › **Regenerate**, then replace
  `MARKDROP_SLACK_SIGNING_SECRET` on the server and restart. Requests are refused (401) in between,
  so do both within a minute or two.
- **Client Secret:** same place, **Regenerate**, replace `MARKDROP_SLACK_CLIENT_SECRET`, restart.
  Installed teams keep working; only new installs and account links use it.
- **Encryption key** (`MARKDROP_TOKEN_ENCRYPTION_KEY`): changing it makes the stored bot tokens
  unreadable, so every team must click **Add to Slack** again. Don't rotate it casually; it also
  protects Google Docs tokens.

## Removing the app from a team

The team's Slack admin removes it in Slack (Settings › Manage apps › Markdrop › Remove), or a
Markdrop workspace admin clicks **Disconnect** in Workspace settings › Integrations › Slack. Either
way Markdrop deletes the team's bot token and account links.
