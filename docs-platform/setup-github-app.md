# Set up the Markdrop Guides GitHub App

Import from GitHub and keep in sync need one GitHub App, owned by Markdrop, that customers install on
their accounts and organizations. This page creates it on github.com, connects it to the API server with
`docs-platform/setup-github-app.sh`, and checks that it works end to end.

Until it is set up, public repositories still import (paste a URL). Private repositories and syncing show
"Not set up yet".

Do it once. Rotating a secret or key later is at the end of this page.

## Before you start

- The backend with Import from GitHub must be deployed first. The API refuses settings it doesn't know,
  so the script checks this and changes nothing if the server is on older code.
- Have a terminal open on the Mac that has `~/Downloads/server.pem` (the API server's SSH key).
- Make the webhook secret now and keep it in a password manager. You paste it into GitHub and into the
  script:

  ```bash
  openssl rand -hex 32
  ```

## 1. Create the app

Pick who owns it:

- **Your account:** github.com › your avatar › **Settings** › **Developer settings** (bottom of the left
  sidebar) › **GitHub Apps** › **New GitHub App**. Direct link: https://github.com/settings/apps/new
- **An organization** (if Markdrop gets a GitHub org): the org › **Settings** › **Developer settings** ›
  **GitHub Apps** › **New GitHub App**, or `https://github.com/organizations/<org>/settings/apps/new`.
  You can also transfer the app to an org later (the app › **Advanced** › **Transfer ownership**); the
  App ID, keys and installations stay the same.

GitHub may ask for your password or 2FA. Then fill in the form from top to bottom.

### Basic information

| Field | Value |
| --- | --- |
| GitHub App name | `Markdrop Guides` |
| Description | `Import your docs into Markdrop Guides and keep them in sync on every push. Read-only.` |
| Homepage URL | `https://www.markdrop.in/guides` |

The name decides the slug in the public link (`markdrop-guides` for "Markdrop Guides"). If GitHub says the
name is taken, pick another (for example "Markdrop Guides App") and note the slug it gets.

### Identifying and authorizing users

1. **Callback URL:** `https://guides.markdrop.in/github/installed` (Markdrop Guides' studio host)
   (exactly this, https, no trailing slash; one callback URL is enough). An app made before the studio
   moved there has `https://www.markdrop.in/guides/github/installed`: **add** the new one with **Add
   Callback URL** (GitHub allows several) before deploying the API that names it, then remove the old
   one. The API sends whatever `MARKDROP_GUIDES_STUDIO_URL` gives (`/github/installed` on it).
2. **Expire user authorization tokens:** leave it **checked**. Markdrop uses the user token once, right
   after install, and never stores it.
3. **Request user authorization (OAuth) during installation:** **check it.** This is how Markdrop proves
   that the person who installs the app is allowed to use that installation: after installing, GitHub
   sends them to the Callback URL with a one-time code, Markdrop turns it into a user token, and asks
   GitHub which installations that user can reach. Without it, anyone could claim someone else's
   installation by guessing its number. With it checked, GitHub sends people to the Callback URL after
   installing, and the **Setup URL** field below becomes disabled (that is expected).
4. **Enable Device Flow:** leave it **unchecked**.

### Post installation

1. **Setup URL:** greyed out (because of step 3 above). Leave it empty.
2. **Redirect on update:** **check it.** When someone changes the installation later (adds a repository,
   for example), GitHub sends them back to Markdrop too.

### Webhook

1. **Active:** **checked**.
2. **Webhook URL:** `https://api.markdrop.in/api/v1/github/webhook`
3. **Secret:** paste the value from `openssl rand -hex 32`.
4. **SSL verification:** **Enable SSL verification** (the default).

### Permissions

Open **Repository permissions** and set exactly two:

| Permission | Access | What Markdrop uses it for |
| --- | --- | --- |
| Contents | Read-only | Download the repository at a commit (the import and every sync) and read its files for the preview. |
| Metadata | Read-only | List the repositories and branches people can pick, and each repository's default branch. GitHub makes it mandatory and sets it for you once Contents is chosen. |

Leave everything else at **No access**: no write permission anywhere, because Markdrop never changes a
repository. **Organization permissions** and **Account permissions**: leave all at **No access**.

### Subscribe to events

The list of checkboxes depends on the permissions above. With Contents set to Read-only:

- **Push:** **check it.** Every push to the guide's branch starts a sync.
- Leave every other checkbox unchecked (including "Installation target" and "Meta").

You won't find checkboxes for `installation` and `installation_repositories`: GitHub always sends those
two to a GitHub App's webhook. Markdrop uses them to notice when an installation is removed or suspended,
and when repositories are added to or removed from it.

### Where can this GitHub App be installed?

Choose **Any account**, so customers can install it on their own accounts and organizations. You can
switch to "Only on this account" later (the app › **Advanced** › **Make private**) as long as it isn't
installed elsewhere.

Click **Create GitHub App**.

## 2. Collect the values

You land on the app's **General** page. Note these (the first three aren't secret):

1. **App ID:** under **About**, a number like `1234567`.
2. **App slug:** from **Public link** at the top, `https://github.com/apps/<slug>` (for example
   `markdrop-guides`). You also see it in the address bar on the app's public page.
3. **Client ID:** under **About**, like `Iv23li...` (older apps show `Iv1....`).
4. **Client secret:** **Client secrets** › **Generate a new client secret**. GitHub shows it once: copy
   it straight into your password manager.
5. **Private key:** scroll to **Private keys** › **Generate a private key**. Your browser downloads
   `<slug>.<date>.private-key.pem`. Move it out of Downloads and out of any repository, and lock it down:

   ```bash
   mkdir -p ~/.markdrop && mv ~/Downloads/markdrop-guides.*.private-key.pem ~/.markdrop/
   chmod 600 ~/.markdrop/markdrop-guides.*.private-key.pem
   ```

   Never commit it and never paste it into chat or a ticket.

Optional, for a nicer install screen: **Display information** › upload the Markdrop logo and set the badge
background to the Markdrop blue.

## 3. Run the script

From the repository root on the Mac:

```bash
docs-platform/setup-github-app.sh \
  --app-id 1234567 \
  --slug markdrop-guides \
  --client-id Iv23liXXXXXXXXXXXXXX \
  --private-key ~/.markdrop/markdrop-guides.2026-11-02.private-key.pem
```

It then asks for the **client secret** and the **webhook secret** with hidden prompts. They are never
arguments, never printed and never on a command line, here or on the server.

Leave out `--app-id`, `--slug`, `--client-id` or `--private-key` and it asks for them. Without a terminal
(for example from a password manager CLI), it reads the client secret from stdin line 1 and the webhook
secret from line 2.

What it does:

1. Checks the values on the Mac: App ID is a number, slug is `a-z 0-9 -`, Client ID looks right (it only
   warns on an unusual prefix), webhook secret has at least 20 characters, the two secrets differ, and the
   key file is an unencrypted RSA PEM.
2. Asks GitHub, signed with the app's own key, that the App ID and key belong together, that the slug and
   Client ID match, that permissions are Contents + Metadata read-only with no write access, that Push is
   subscribed, that the webhook URL is the one above with SSL verification on, and that GitHub accepts the
   client secret. `--skip-github-check` skips this (offline, or on purpose).
3. On the API server (`/opt/markdrop/backend/.env`): writes the six settings into a temp copy (replaced or
   added, duplicates removed), loads it with the API's own settings code and checks every value reads back
   as written and the private key is the same key as your file. Only then it backs up `.env` to
   `.env.bak-<timestamp>`, swaps it in, restarts the API and waits for `/health`. If the API isn't healthy,
   it restores the backup and restarts again.
4. Sends a signed test ping to the webhook URL to confirm the server has the same webhook secret.

Want to see it pass before it changes anything? Add `--dry-run`: it does every check, including writing
and validating the new `.env` in a temp folder on the server, but doesn't back up, swap or restart.

The six settings it writes (all `MARKDROP_` settings of the API):

| Setting | Value |
| --- | --- |
| `MARKDROP_DOCS_GITHUB_APP_ID` | App ID |
| `MARKDROP_DOCS_GITHUB_APP_SLUG` | App slug |
| `MARKDROP_DOCS_GITHUB_CLIENT_ID` | Client ID |
| `MARKDROP_DOCS_GITHUB_CLIENT_SECRET` | Client secret |
| `MARKDROP_DOCS_GITHUB_WEBHOOK_SECRET` | Webhook secret |
| `MARKDROP_DOCS_GITHUB_APP_PRIVATE_KEY` | The .pem on one line, double-quoted, with `\n` between its lines |

## 4. Verify

Use a test repository you own, for example a private `markdrop-guides-test` with a `README.md` and a
`docs/` folder holding two or three Markdown pages.

1. Open https://guides.markdrop.in/new?start=github while signed in to Markdrop.
2. Under **Your repositories**, click **Connect GitHub**.
3. On GitHub: pick your account, choose **Only select repositories**, select the test repository, then
   **Install & Authorize**.
4. GitHub sends you to `guides.markdrop.in/github/installed`, which says "GitHub is connected: <account>" and takes
   you back to the import screen.
5. Pick the repository, the branch and the folder. Check the preview (page count, groups), turn on
   **Keep in sync**, leave **Update drafts**, name the guide and click **Import**. Wait for it to finish.
6. Change a page in the test repository and push to that branch.
7. In the guide, open **Settings › GitHub**: the sync history shows a `push` row with your commit and the
   pages updated. The page's draft shows the change.
8. Optional: the app › **Advanced** › **Recent Deliveries** shows the `installation` and `push` deliveries
   with a green tick (HTTP 2xx).

## Troubleshooting

**Where to look first.** The app's settings › **Advanced** › **Recent Deliveries** lists every webhook
GitHub sent, with the request, the response code and body. Open one and click **Redeliver** to send it
again (useful after fixing a setting). On the server, `sudo journalctl -u markdrop -n 200 | grep -i github`.

**401 on deliveries, or the script warns "the webhook rejected the signature".** The webhook secret on
GitHub and on the server differ. Run the script again with the secret GitHub has, or set a new secret in
the app's **General** › **Webhook secret** and run the script with that one. Then redeliver the failed
deliveries.

**Markdrop says "Not set up yet".** One of the six settings is missing or empty on the server, or the API
wasn't restarted. Check without printing values:


```bash
ssh -i ~/Downloads/server.pem ubuntu@api.markdrop.in \
  "grep -c '^MARKDROP_DOCS_GITHUB_' /opt/markdrop/backend/.env"
```

It should print 6 (8 if you also set the optional `MARKDROP_DOCS_GITHUB_API` and `_WEB` overrides, which
production doesn't need). Run the script again.

**The script says the API code doesn't have the settings yet.** The server runs code from before Import
from GitHub. Deploy the backend, then run the script again. Nothing was changed.

**Private key problems** ("isn't a valid RSA private key", "Could not deserialize key data", "A JSON web
token could not be decoded"). Use the `.pem` exactly as GitHub downloaded it (it starts with
`-----BEGIN RSA PRIVATE KEY-----`). Don't open and re-save it in an editor, don't paste it with spaces,
don't convert it. "A JSON web token could not be decoded" also means the key belongs to a different app:
check the App ID. When in doubt, generate a new key and run the script with it.

**Clock skew** ("'Issued at' claim ('iat') must be an Integer representing a time in the past", "'Expiration
time' claim ('exp') is too far in the future"). The app signs a short-lived token with the current time, so
the clock matters. On the Mac: System Settings › General › Date & Time › Set time automatically. On the
server: `timedatectl status` should say `System clock synchronized: yes`; if not, `sudo timedatectl
set-ntp true`.

**After installing, GitHub doesn't come back to Markdrop, or shows a redirect_uri error.** The Callback URL
must be exactly `https://guides.markdrop.in/github/installed`, and "Request user authorization (OAuth)
during installation" must be checked.

**Markdrop can't link an installation on an organization (403).** The person who authorizes must have
access to that installation. An org member who isn't an owner can only *request* the
install; once an org owner approves it, the member uses **Connect GitHub** again to link it.

**A push didn't sync.** Check that the push went to the guide's branch, that **Keep in sync** is on in
Settings › GitHub, that the repository is among the installation's selected repositories, and that Recent
Deliveries shows the `push` with a 2xx response.

## Rotate a secret or key

Re-run the script with the new value (it always writes all six; the App ID, slug and Client ID stay the
same). Then:

- **Client secret:** the app › **General** › **Client secrets** › **Generate a new client secret**, run the
  script with it, then **Delete** the old secret. Both work until you delete the old one, so there is no
  gap.
- **Private key:** **Private keys** › **Generate a private key**, run the script with the new file, then
  **Delete** the old key on GitHub and delete the old file. Both keys work until then, so there is no gap.
- **Webhook secret:** there is only one. Make a new one (`openssl rand -hex 32`), run the script with it,
  then paste it into the app › **General** › **Webhook secret** › **Save changes**. Deliveries sent between
  those two steps fail with 401: redeliver them from Recent Deliveries. Do the two steps back to back.

Rotate right away if a secret or the `.pem` may have leaked. Old values stay in the server's
`.env.bak-<timestamp>` backups: delete those once the new values work.
