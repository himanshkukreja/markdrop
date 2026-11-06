"""Send every email Markdrop sends, built from the gallery's fixtures, to one inbox, to check it in
real clients (Gmail web and app, Apple Mail, Outlook) in light and dark.

    cd backend && .venv/bin/python -m scripts.send_test_emails                 # dry run: lists what it would send
    cd backend && .venv/bin/python -m scripts.send_test_emails --send          # sends to team@markdrop.in
    cd backend && .venv/bin/python -m scripts.send_test_emails --send --to you@example.com --only team

Goes through the normal send path (mailer._post → email_delivery: provider routing, daily limits,
the admin email log, kind "template_test"), from each email's real sender, with "[test] " in front of every
subject. Needs the real provider keys (run it where the API's .env is), and the owner's go-ahead:
it uses today's sending allowance (about 25 emails).
"""

from __future__ import annotations

import argparse
import asyncio


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--send", action="store_true", help="really send (default: list only)")
    ap.add_argument("--to", default="team@markdrop.in")
    ap.add_argument("--only", default="", help="only entries whose id contains this")
    args = ap.parse_args()

    from app.services import mailer, message_gallery as g

    todo = [e for e in g.ENTRIES if e.kind == "email" and args.only in e.id]
    if args.send and not mailer.is_configured():
        raise SystemExit("No email provider is configured here: nothing sent.")
    for e in todo:
        m = e.build()
        subject = "[test] " + m["subject"]
        if not args.send:
            print(f"would send  {e.id:32}  {subject}")
            continue
        status = await mailer._post({"from": m["from"], "to": [args.to], "subject": subject,
                                     "reply_to": mailer.settings.email_reply_to, "html": m["html"], "text": m["text"]},
                                    kind="template_test", ref=f"gallery:{e.id}")
        print(f"{status:8}  {e.id:32}  {subject}")
        await asyncio.sleep(0.6)   # gentle on the provider's rate limit
    if not args.send:
        print(f"\n{len(todo)} emails. Add --send to send them to {args.to}.")


if __name__ == "__main__":
    asyncio.run(main())
