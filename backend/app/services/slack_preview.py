"""Block Kit → HTML, for previews only (the admin's message gallery and the before/after shots).

It draws the subset of Block Kit Markdrop's messages use (header, section with text / fields /
accessory, context with text and images, actions with buttons and overflow menus, divider) the way a
chat client lays them out, in light and dark. It is not Slack's interface and is never shown to
customers: the docs illustrate messages with their own neutral card (frontend/scripts/docs-media/shots/
i-slack.mjs). Pure functions: no database, no network.
"""

from __future__ import annotations

import html
import re
from typing import Any

EMOJI = {
    "spiral_note_pad": "🗒️", "white_large_square": "⬜", "white_check_mark": "✅", "clipboard": "📋",
    "calendar": "📆", "warning": "⚠️", "memo": "📝", "busts_in_silhouette": "👥", "hourglass_flowing_sand": "⏳",
    "pushpin": "📌", "speech_balloon": "💬", "mag": "🔍", "sparkles": "✨", "bell": "🔔", "lock": "🔒",
}

_TOKEN = re.compile(r"<(@[A-Z0-9]+|#[A-Z0-9]+(?:\|[^>]*)?|![a-z]+|(?:https?|mailto):[^|>]+)(?:\|([^>]*))?>")


def _unesc(s: str) -> str:
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def mrkdwn(text: str, users: dict[str, str] | None = None) -> str:
    """Slack mrkdwn (already Slack-escaped) → HTML."""
    users = users or {}
    keep: list[str] = []

    def hold(h: str) -> str:
        keep.append(h)
        return f"\x00{len(keep) - 1}\x00"

    def token(m: re.Match) -> str:
        target, label = m.group(1), m.group(2)
        if target.startswith("@"):
            return hold(f'<span class="men">@{html.escape(users.get(target[1:], "someone"))}</span>')
        if target.startswith("#"):
            return hold(f'<span class="men">#{html.escape((target.split("|") + ["channel"])[1] or "channel")}</span>')
        if target.startswith("!"):
            return hold(f'<span class="men">@{html.escape(target[1:])}</span>')
        return hold(f'<a href="#">{html.escape(_unesc(label or target))}</a>')

    t = _TOKEN.sub(token, text or "")
    # Code blocks before anything else touches their contents.
    t = re.sub(r"```(.+?)```", lambda m: hold(f"<pre>{html.escape(_unesc(m.group(1)))}</pre>"), t, flags=re.S)
    t = re.sub(r"`([^`\n]+)`", lambda m: hold(f"<code>{html.escape(_unesc(m.group(1)))}</code>"), t)
    t = html.escape(_unesc(t), quote=False)
    t = re.sub(r":([a-z0-9_+-]+):", lambda m: EMOJI.get(m.group(1), m.group(0)), t)
    t = re.sub(r"(^|[\s(\x00>/])\*([^*\n]+?)\*(?=$|[\s).,:;!?\x00<])", r"\1<b>\2</b>", t, flags=re.M)
    t = re.sub(r"(^|[\s(\x00>/])_([^_\n]+?)_(?=$|[\s).,:;!?\x00<])", r"\1<i>\2</i>", t, flags=re.M)
    t = re.sub(r"(^|[\s(\x00>/])~([^~\n]+?)~(?=$|[\s).,:;!?\x00<])", r"\1<s>\2</s>", t, flags=re.M)
    lines = []
    for line in t.split("\n"):
        lines.append(f'<span class="q">{line[4:]}</span>' if line.startswith("&gt;") else line)
    t = "<br>".join(lines).replace('</span><br><span class="q">', '<br>')
    return re.sub(r"\x00(\d+)\x00", lambda m: keep[int(m.group(1))], t)


def _text(obj: dict | None, users: dict[str, str]) -> str:
    if not obj:
        return ""
    if obj.get("type") == "mrkdwn":
        return mrkdwn(obj.get("text") or "", users)
    return html.escape(obj.get("text") or "").replace("\n", "<br>")


def _element(e: dict, users: dict[str, str]) -> str:
    t = e.get("type")
    if t == "button":
        return f'<span class="btn {e.get("style") or ""}">{html.escape((e.get("text") or {}).get("text") or "")}</span>'
    if t == "overflow":
        return '<span class="btn ovf" title="More">&#8943;</span>'
    if t == "image":
        return f'<span class="img" title="{html.escape(e.get("alt_text") or "", quote=True)}"></span>'
    if t in ("mrkdwn", "plain_text"):
        return _text(e, users)
    if t in ("static_select", "users_select", "datepicker"):
        ph = ((e.get("placeholder") or {}).get("text")) or "Choose"
        return f'<span class="btn sel">{html.escape(ph)} &#9662;</span>'
    return ""


def blocks_html(blocks: list[dict], users: dict[str, str] | None = None) -> str:
    users = users or {}
    out = []
    for b in blocks or []:
        t = b.get("type")
        if t == "header":
            out.append(f'<div class="hdr">{html.escape((b.get("text") or {}).get("text") or "")}</div>')
        elif t == "section":
            acc = b.get("accessory")
            acc_html = f'<div class="acc">{_element(acc, users)}</div>' if acc else ""
            inner = f'<div class="txt">{_text(b.get("text"), users)}</div>' if b.get("text") else ""
            if b.get("fields"):
                inner += '<div class="fields">' + "".join(f'<div class="fld">{_text(f, users)}</div>'
                                                           for f in b["fields"]) + "</div>"
            out.append(f'<div class="sec"><div class="main">{inner}</div>{acc_html}</div>')
        elif t == "context":
            els = []
            for e in b.get("elements") or []:
                els.append(_element(e, users))
            out.append(f'<div class="ctx">{"".join(f"<span class=c>{x}</span>" for x in els)}</div>')
        elif t == "actions":
            out.append(f'<div class="acts">{"".join(_element(e, users) for e in b.get("elements") or [])}</div>')
        elif t == "divider":
            out.append('<hr class="div">')
    return "".join(out)


CSS = """
:root{--bg:#fff;--ink:#1d1c1d;--mute:#616061;--link:#1264a3;--line:#dddddd;--men-bg:#e8f5fa;--men:#1264a3;
--btn:#fff;--btn-line:#bbbabb;--primary:#007a5a;--danger:#e01e5a;--code:#f8f8f8;--code-line:#e8e8e8;--q:#dddddd;--app:#4a154b}
:root.dark{--bg:#1a1d21;--ink:#d1d2d3;--mute:#ababad;--link:#1d9bd1;--line:#35373b;--men-bg:#1d3b4d;--men:#1d9bd1;
--btn:#1a1d21;--btn-line:#565856;--primary:#148567;--danger:#e01e5a;--code:#222529;--code-line:#35373b;--q:#565856}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.46668 Lato,"Helvetica Neue",Helvetica,"Segoe UI",Tahoma,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{padding:14px 18px 18px}.where{font-size:12px;color:var(--mute);margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.msg{display:flex;gap:9px}.av{flex:none;width:36px;height:36px;border-radius:6px;display:grid;place-items:center;
font-weight:900;color:#fff;background:#155dfc;font-size:15px}.body{flex:1;min-width:0}
.who{font-weight:900}.who small{font-weight:400;color:var(--mute);font-size:12px;margin-left:6px}
.who .app{font-size:10px;font-weight:700;background:var(--code-line);color:var(--mute);border-radius:3px;padding:1px 3px;margin-left:4px;vertical-align:1px}
.eph{font-size:12px;color:var(--mute);margin:2px 0 4px}
.hdr{font-weight:900;font-size:18px;line-height:1.33;margin:4px 0 2px}
.sec{display:flex;gap:12px;align-items:flex-start;margin:6px 0 2px}.main{flex:1;min-width:0;overflow-wrap:anywhere}
.acc{flex:none;padding-top:1px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:4px}
.ctx{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:6px 0 2px;font-size:12.6px;color:var(--mute)}
.ctx .c{display:inline-flex;align-items:center}.ctx a{color:var(--link)}
.acts{display:flex;gap:8px;margin:10px 0 4px;flex-wrap:wrap}
.btn{display:inline-block;padding:0 12px;height:28px;line-height:26px;border:1px solid var(--btn-line);border-radius:4px;
background:var(--btn);font-weight:700;font-size:13px;color:var(--ink);white-space:nowrap}
.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}.btn.danger{color:var(--danger);border-color:var(--btn-line)}
.btn.ovf{padding:0 8px;font-weight:900}.img{display:inline-block;width:20px;height:20px;border-radius:4px;background:#c7d2fe}
a{color:var(--link);text-decoration:none}.men{background:var(--men-bg);color:var(--men);border-radius:3px;padding:0 2px}
code{font:12px Monaco,Menlo,Consolas,monospace;background:var(--code);border:1px solid var(--code-line);border-radius:3px;padding:1px 3px;color:#e01e5a}
pre{font:12px Monaco,Menlo,monospace;background:var(--code);border:1px solid var(--code-line);border-radius:4px;padding:8px;margin:4px 0;white-space:pre-wrap}
.q{display:block;border-left:4px solid var(--q);padding-left:12px;margin:2px 0}
.div{border:0;border-top:1px solid var(--line);margin:12px 0 8px}
.unfurl{margin-top:6px;border-left:4px solid var(--line);padding:2px 0 2px 12px}
@media (max-width:480px){.fields{grid-template-columns:1fr}.wrap{padding:12px}}
"""


def page(message: dict, *, where: str = "", sender: str = "Markdrop", ephemeral: bool = False,
         users: dict[str, str] | None = None, theme: str = "light", unfurl_of: str | None = None) -> str:
    """One message as a standalone HTML page."""
    users = users or {}
    body = blocks_html(message.get("blocks") or [], users)
    if unfurl_of:
        body = f'<div><a href="#">{html.escape(unfurl_of)}</a></div><div class="unfurl">{body}</div>'
    eph = '<div class="eph">Only visible to you</div>' if ephemeral else ""
    initial = html.escape((sender or "M")[:1].upper())
    app = '<span class="app">APP</span>' if sender == "Markdrop" else ""
    return (f'<!doctype html><html class="{"dark" if theme == "dark" else ""}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><style>{CSS}</style></head><body>'
            f'<div class="wrap">{f"<div class=where>{html.escape(where)}</div>" if where else ""}'
            f'<div class="msg"><div class="av">{initial}</div><div class="body">'
            f'<div class="who">{html.escape(sender)}{app}<small>9:41 AM</small></div>{eph}{body}</div></div></div>'
            "</body></html>")
