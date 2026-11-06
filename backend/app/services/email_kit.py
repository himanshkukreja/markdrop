"""Markdrop's email design system: one layout and the components every email is built from.

Every component returns a :class:`Part` holding its HTML *and* its plain-text twin, so the text part
of an email is generated from the same content as its HTML and can't drift. Components take plain
strings and escape them; pre-built markup is passed as :class:`Html` (``link()``, ``strong()``), so
user-chosen text (a title, a name, a note) can never become markup in someone's inbox.

Email-client rules the layout follows:

* Table layout, every style inline (written inline by the components, nothing to inline later),
  600 px wide at most, one column under 480 px (``.md-stack`` cells stack, padding tightens).
* Light by default, dark where the client supports it: ``color-scheme: light dark`` plus a
  ``prefers-color-scheme: dark`` block (Apple Mail, iOS Mail, Outlook for Mac, Thunderbird) and the
  ``[data-ogsc]`` / ``[data-ogsb]`` hooks Outlook.com uses. Gmail's apps invert colours on their own
  and ignore both; the light design survives that because no text sits on an image and every
  coloured fill that carries text (buttons, avatars) is a saturated colour inversion leaves alone.
* No images needed: the wordmark and avatars are text, so the email looks the same with images off.
* Bulletproof buttons (the fill is on the table cell), a hidden preheader with filler, alt text on
  any image, a web-safe font stack with Inter first, no external CSS or JS.
"""

from __future__ import annotations

import hashlib
import html as _html
import re
from dataclasses import dataclass, field
from typing import Iterable, Sequence

# ── Tokens ────────────────────────────────────────────────────────────────────

GROUND = "#f4f5f7"
CARD = "#ffffff"
LINE = "#e5e7eb"
INSET = "#f6f7f9"
ACCENT = "#155dfc"
INK = "#111827"      # headings, strong text
BODY = "#374151"     # body copy
MUTED = "#6b7280"    # meta, footers (AA on white and on the ground)
WARN_BG, WARN_LINE, WARN_INK = "#fffbeb", "#fde68a", "#92400e"
OK_BG, OK_LINE, OK_INK = "#ecfdf5", "#a7f3d0", "#065f46"
INFO_BG, INFO_LINE, INFO_INK = "#eff6ff", "#bfdbfe", "#1e40af"

D_GROUND, D_CARD, D_LINE, D_INSET = "#0f1115", "#171a21", "#2a2f3a", "#1e222b"
D_INK, D_BODY, D_MUTED, D_LINK = "#f3f4f6", "#cfd4dc", "#9aa3b2", "#7aa5ff"

SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

# Saturated avatar fills (white initials read on each, and inversion leaves them alone).
AVATAR = ("#155dfc", "#7c3aed", "#0d9488", "#db2777", "#ea580c", "#4f46e5", "#0891b2", "#65a30d")

WIDTH = 600
MAX_BYTES = 102 * 1024          # Gmail clips a message's HTML past this
_PREHEADER_PAD = "&#847;&zwnj;&nbsp;" * 60


# ── Parts and inline content ──────────────────────────────────────────────────


class Html(str):
    """Markup that is already safe (built here or escaped by the caller)."""


@dataclass
class Part:
    html: str
    text: str = ""

    def __add__(self, other: "Part") -> "Part":
        return Part(self.html + other.html, "\n\n".join(t for t in (self.text, other.text) if t))


def esc(s: object) -> str:
    return _html.escape(str(s if s is not None else ""), quote=True)


_TAG = re.compile(r"<[^>]+>")


def _text_of(markup: str) -> str:
    """Plain text of a bit of inline markup: a link becomes "label (url)"."""
    t = re.sub(r'<a [^>]*href="([^"]*)"[^>]*>(.*?)</a>',
               lambda m: f"{_TAG.sub('', m.group(2))} ({_html.unescape(m.group(1))})"
               if _html.unescape(m.group(1)) != _html.unescape(_TAG.sub('', m.group(2))) else _TAG.sub('', m.group(2)),
               markup, flags=re.S)
    t = re.sub(r"<br\s*/?>", "\n", t)
    return _html.unescape(_TAG.sub("", t)).replace(" ", " ")


Inline = "str | Html | Sequence[str | Html]"


def inline(x) -> tuple[str, str]:
    """(html, text) of inline content: a str is escaped, Html kept, a list joined."""
    if x is None:
        return "", ""
    if isinstance(x, Html):
        return str(x), _text_of(x)
    if isinstance(x, str):
        return esc(x), x
    hs, ts = zip(*(inline(i) for i in x)) if x else ((), ())
    return "".join(hs), "".join(ts)


def strong(x) -> Html:
    h, _ = inline(x)
    return Html(f'<strong class="md-ink" style="color:{INK};font-weight:650">{h}</strong>')


def link(href: str, label, *, muted: bool = False) -> Html:
    h, _ = inline(label)
    color, cls = (MUTED, "md-muted") if muted else (ACCENT, "md-link")
    return Html(f'<a href="{esc(href)}" class="{cls}" style="color:{color};text-decoration:underline;'
                f'text-underline-offset:2px">{h}</a>')


def mono(x) -> Html:
    h, _ = inline(x)
    return Html(f'<span style="font-family:{MONO};font-size:13px">{h}</span>')


def join(*xs, sep: str = " ") -> Html:
    """Inline pieces joined (each escaped unless Html)."""
    return Html(esc(sep).join(inline(x)[0] for x in xs if x))


# ── Block components ──────────────────────────────────────────────────────────


def _t(style: str = "") -> str:
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="{style}">'


def eyebrow(text: str) -> Part:
    return Part(f'<div class="md-muted" style="font-family:{SANS};font-size:12px;line-height:16px;font-weight:600;'
                f'letter-spacing:0.06em;text-transform:uppercase;color:{MUTED};margin:0 0 10px">{esc(text)}</div>',
                text.upper())


def title(x) -> Part:
    h, t = inline(x)
    return Part(f'<h1 class="md-ink md-h1" style="font-family:{SANS};font-size:24px;line-height:32px;font-weight:700;'
                f'letter-spacing:-0.015em;color:{INK};margin:0 0 12px;padding:0">{h}</h1>', t)


def heading(x, *, count: int | str | None = None, top: int = 28) -> Part:
    """A section's heading inside an email ("Due this week  3")."""
    h, t = inline(x)
    c = (f' <span class="md-muted" style="font-weight:500;color:{MUTED}">&nbsp;{esc(count)}</span>'
         if count not in (None, "") else "")
    return Part(f'<h2 class="md-ink" style="font-family:{SANS};font-size:15px;line-height:22px;font-weight:650;'
                f'color:{INK};margin:{top}px 0 10px;padding:0">{h}{c}</h2>',
                (t + (f" ({count})" if count not in (None, "") else "")).upper())


def p(x, *, size: int = 15, muted: bool = False, margin: str = "0 0 16px") -> Part:
    h, t = inline(x)
    color, cls = (MUTED, "md-muted") if muted else (BODY, "md-body")
    lh = round(size * 1.6)
    return Part(f'<p class="{cls}" style="font-family:{SANS};font-size:{size}px;line-height:{lh}px;color:{color};'
                f'margin:{margin}">{h}</p>', t)


def lead(x) -> Part:
    return p(x, size=16, margin="0 0 20px")


def small(x, *, margin: str = "0 0 16px") -> Part:
    return p(x, size=13, muted=True, margin=margin)


def spacer(px: int = 8) -> Part:
    return Part(f'<div style="height:{px}px;line-height:{px}px;font-size:0">&nbsp;</div>')


def divider(margin: str = "24px 0") -> Part:
    return Part(f'<div class="md-line" style="border-top:1px solid {LINE};height:0;line-height:0;font-size:0;'
                f'margin:{margin}">&nbsp;</div>', "")


def button(href: str, label: str, *, secondary: bool = False, margin: str = "8px 0 24px", full: bool = False) -> Part:
    """Bulletproof: the fill is on the cell, so clients that drop padding on links still show a button."""
    if secondary:
        cell = (f'<td class="md-card md-line" bgcolor="{CARD}" style="background-color:{CARD};border:1px solid {LINE};'
                f'border-radius:8px">')
        a_style, a_cls = f"color:{INK};", "md-ink"
    else:
        cell = f'<td bgcolor="{ACCENT}" style="background-color:{ACCENT};border-radius:8px">'
        a_style, a_cls = "color:#ffffff;", ""
    width = ' width="100%"' if full else ""
    return Part(
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"{width} style="margin:{margin}">'
        f"<tr>{cell}"
        f'<a href="{esc(href)}" class="{a_cls}" style="display:{"block" if full else "inline-block"};padding:11px 20px;'
        f'font-family:{SANS};font-size:14px;line-height:20px;font-weight:600;{a_style}text-decoration:none;'
        f'text-align:center;border-radius:8px">{esc(label)}</a></td></tr></table>',
        f"{label}: {href}")


def buttons(primary: tuple[str, str] | None, *secondary: tuple[str, str], margin: str = "8px 0 24px") -> Part:
    """A primary action and a few secondary ones side by side (stacked on a phone)."""
    cells, texts = [], []
    for i, (href, label) in enumerate(([primary] if primary else []) + list(secondary)):
        b = button(href, label, secondary=bool(primary is None or i > 0), margin="0")
        cells.append(f'<td class="md-stack md-btncell" style="padding:0 8px 8px 0" valign="top">{b.html}</td>')
        texts.append(b.text)
    return Part(f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:{margin}">'
                f'<tr>{"".join(cells)}</tr></table>', "\n".join(texts))


def initials(name: str) -> str:
    words = [w for w in re.split(r"[\s._@-]+", name or "") if w and w[0].isalnum()]
    if not words:
        return "?"
    return (words[0][0] + (words[1][0] if len(words) > 1 else "")).upper()


def avatar(name: str, size: int = 32) -> str:
    """Initials on a colour picked from the name: text, so it shows with images off."""
    color = AVATAR[int(hashlib.md5((name or "?").encode()).hexdigest(), 16) % len(AVATAR)]
    fs = max(10, round(size * 0.4))
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td width="{size}" height="{size}" align="center" valign="middle" bgcolor="{color}" '
            f'style="width:{size}px;height:{size}px;background-color:{color};border-radius:{size // 2}px;'
            f'font-family:{SANS};font-size:{fs}px;line-height:{size}px;font-weight:700;color:#ffffff;'
            f'text-align:center">{esc(initials(name))}</td></tr></table>')


def item(title_, *, who: str | None = None, body=None, meta=None, href: str | None = None,
         action: str | None = None, quote_=None, last: bool = False, pad: int = 14) -> Part:
    """One row of a list: an avatar (when ``who``), a title line, optional body / quote / meta line,
    and an optional link under it."""
    th, tt = inline(title_)
    bits_h = [f'<div class="md-ink" style="font-family:{SANS};font-size:15px;line-height:22px;color:{INK}">{th}</div>']
    bits_t = [tt]
    if body is not None:
        bh, bt = inline(body)
        bits_h.append(f'<div class="md-body" style="font-family:{SANS};font-size:14px;line-height:21px;color:{BODY};'
                      f'margin-top:3px">{bh}</div>')
        bits_t.append(bt)
    if quote_:
        qh, qt = inline(quote_)
        bits_h.append(f'<div class="md-body md-line" style="font-family:{SANS};font-size:14px;line-height:21px;'
                      f'color:{BODY};border-left:3px solid {LINE};padding:1px 0 1px 12px;margin-top:8px">{qh}</div>')
        bits_t.append(f"> {qt}")
    if meta:
        mh, mt = inline(meta)
        bits_h.append(f'<div class="md-muted" style="font-family:{SANS};font-size:13px;line-height:19px;color:{MUTED};'
                      f'margin-top:4px">{mh}</div>')
        bits_t.append(mt)
    if href and action:
        bits_h.append(f'<div style="font-family:{SANS};font-size:13px;line-height:19px;margin-top:6px">'
                      f'<a href="{esc(href)}" class="md-link" style="color:{ACCENT};font-weight:600;text-decoration:none">'
                      f"{esc(action)}&nbsp;&rarr;</a></div>")
        bits_t.append(f"{action}: {href}")
    border = "" if last else f"border-bottom:1px solid {LINE};"
    av = (f'<td width="44" valign="top" class="md-line" style="padding:{pad}px 0;{border}">{avatar(who)}</td>'
          if who else "")
    return Part(f'<tr>{av}<td valign="top" class="md-line" style="padding:{pad}px 0;{border}">{"".join(bits_h)}</td></tr>',
                "- " + "\n  ".join(t for t in bits_t if t))


def rows(items: Iterable[Part], *, margin: str = "0 0 8px") -> Part:
    """A list of :func:`item` rows (the last one without a rule under it)."""
    items = list(items)
    return Part(_t(f"margin:{margin}") + "".join(i.html for i in items) + "</table>",
                "\n".join(i.text for i in items))


def card(*parts: Part, inset: bool = False, pad: str = "16px 18px", margin: str = "0 0 20px") -> Part:
    bg, cls = (INSET, "md-inset") if inset else (CARD, "md-card")
    inner = "".join(x.html for x in parts)
    return Part(_t(f"margin:{margin}") + f'<tr><td class="{cls} md-line" bgcolor="{bg}" style="background-color:{bg};'
                f'border:1px solid {LINE};border-radius:10px;padding:{pad}">{inner}</td></tr></table>',
                "\n".join(x.text for x in parts if x.text))


def doc_card(title_: str, url: str, *, meta=None) -> Part:
    """The item an email is about: its title and where it lives."""
    mh, mt = inline(meta) if meta else ("", "")
    meta_html = (f'<div class="md-muted" style="font-family:{SANS};font-size:13px;line-height:19px;color:{MUTED};'
                 f'margin-top:4px">{mh}</div>') if meta else ""
    return card(Part(
        f'<a href="{esc(url)}" style="text-decoration:none"><div dir="auto" class="md-ink" style="font-family:{SANS};'
        f'font-size:16px;line-height:23px;font-weight:650;color:{INK}">{esc(title_)}</div></a>{meta_html}'
        f'<div class="md-muted" style="font-family:{MONO};font-size:12px;line-height:18px;color:{MUTED};margin-top:6px;'
        f'word-break:break-all">{esc(url)}</div>', f"{title_}\n{url}" + (f"\n{mt}" if mt else "")), inset=True)


def quote(x, *, who: str | None = None) -> Part:
    h, t = inline(x)
    by = (f'<div class="md-muted" style="font-family:{SANS};font-size:13px;line-height:18px;color:{MUTED};'
          f'margin-top:6px">&mdash; {esc(who)}</div>') if who else ""
    return Part(_t("margin:0 0 20px") + f'<tr><td class="md-line" style="border-left:3px solid {LINE};padding:2px 0 2px 14px">'
                f'<div class="md-body" style="font-family:{SANS};font-size:15px;line-height:24px;color:{BODY};'
                f'white-space:pre-wrap">&ldquo;{h}&rdquo;</div>{by}</td></tr></table>',
                f'"{t}"' + (f" — {who}" if who else ""))


def callout(x, *, tone: str = "info", title_: str | None = None) -> Part:
    bg, line, ink = {"warn": (WARN_BG, WARN_LINE, WARN_INK), "ok": (OK_BG, OK_LINE, OK_INK)}.get(
        tone, (INFO_BG, INFO_LINE, INFO_INK))
    h, t = inline(x)
    head = f'<strong style="font-weight:700">{esc(title_)}</strong> ' if title_ else ""
    return Part(_t("margin:0 0 20px") + f'<tr><td bgcolor="{bg}" style="background-color:{bg};border:1px solid {line};'
                f'border-radius:10px;padding:12px 14px"><div style="font-family:{SANS};font-size:14px;line-height:21px;'
                f'color:{ink}">{head}{h}</div></td></tr></table>', (f"{title_} " if title_ else "") + t)


def stats(tiles: Sequence[tuple[str, str] | tuple[str, str, str | None]], *, margin: str = "4px 0 24px") -> Part:
    """Number tiles in a row ("Views 1,284 ↑18%"); two a row on a phone."""
    cells, texts = [], []
    n = len(tiles)
    for i, tile in enumerate(tiles):
        label_, value = tile[0], tile[1]
        note = tile[2] if len(tile) > 2 else None
        note_html = (f'<div class="md-muted" style="font-family:{SANS};font-size:12px;line-height:16px;color:{MUTED};'
                     f'margin-top:2px">{esc(note)}</div>') if note else ""
        pad = "0 8px 8px 0" if i < n - 1 else "0 0 8px 0"
        cells.append(
            f'<td class="md-stack2" width="{100 // n}%" valign="top" style="padding:{pad}">' + _t() +
            f'<tr><td class="md-inset" bgcolor="{INSET}" style="background-color:{INSET};border-radius:10px;padding:12px 14px">'
            f'<div class="md-muted" style="font-family:{SANS};font-size:12px;line-height:16px;color:{MUTED}">{esc(label_)}</div>'
            f'<div class="md-ink" style="font-family:{SANS};font-size:22px;line-height:30px;font-weight:700;color:{INK};'
            f'letter-spacing:-0.01em">{esc(value)}</div>{note_html}</td></tr></table></td>')
        texts.append(f"{label_}: {value}" + (f" ({note})" if note else ""))
    return Part(_t(f"margin:{margin}") + f'<tr>{"".join(cells)}</tr></table>', " · ".join(texts))


def people(names: Sequence[str], *, more: int = 0, label_: str | None = None) -> Part:
    """A row of avatars with a caption ("Maya, Alex and 3 others")."""
    shown = list(names)[:6]
    avs = "".join(f'<td style="padding:0 4px 0 0">{avatar(n, 28)}</td>' for n in shown)
    cap = label_ or ", ".join(n.split()[0] for n in shown) + (f" and {more} more" if more else "")
    return Part(f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>{avs}'
                f'<td class="md-muted" style="padding-left:8px;font-family:{SANS};font-size:13px;color:{MUTED}">'
                f"{esc(cap)}</td></tr></table>", cap)


def code(value: str) -> Part:
    return Part(_t("margin:4px 0 12px") + f'<tr><td align="center" class="md-inset" bgcolor="{INSET}" style="background-color:'
                f'{INSET};border-radius:10px;padding:18px 8px 18px 14px"><span class="md-ink" style="font-family:{MONO};'
                f'font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;color:{INK}">{esc(value)}</span>'
                "</td></tr></table>", value)


def bar(label_, value: str, pct: int, *, href: str | None = None, note: str | None = None) -> Part:
    """A labelled bar (a link's share of views)."""
    lh, lt = inline(label_)
    if href:
        lh = f'<a href="{esc(href)}" class="md-ink" style="color:{INK};text-decoration:none">{lh}</a>'
    note_html = (f'<div class="md-muted" style="font-family:{SANS};font-size:12px;line-height:18px;color:{MUTED};'
                 f'margin-top:4px">{esc(note)}</div>') if note else ""
    pct = max(2, min(100, int(pct)))
    return Part(
        _t("margin:0 0 14px") + f'<tr><td class="md-ink" style="font-family:{SANS};font-size:14px;line-height:20px;'
        f'font-weight:600;color:{INK}">{lh}</td><td align="right" class="md-body" style="font-family:{SANS};font-size:13px;'
        f'line-height:20px;color:{BODY};white-space:nowrap;padding-left:12px">{esc(value)}</td></tr>'
        f'<tr><td colspan="2" style="padding-top:5px">' + _t() +
        f'<tr><td class="md-inset" bgcolor="{INSET}" style="background-color:{INSET};border-radius:3px;height:6px;'
        f'line-height:6px;font-size:0"><table role="presentation" width="{pct}%" cellpadding="0" cellspacing="0" border="0">'
        f'<tr><td bgcolor="{ACCENT}" style="background-color:{ACCENT};border-radius:3px;height:6px;line-height:6px;'
        f'font-size:0">&nbsp;</td></tr></table></td></tr></table>{note_html}</td></tr></table>',
        f"- {lt}: {value}" + (f" ({note})" if note else ""))


def raw(markup: str, text: str = "") -> Part:
    """Markup built elsewhere and already safe (the campaign editor's blocks)."""
    return Part(markup, text or _text_of(markup))


# ── Footer and layout ─────────────────────────────────────────────────────────


@dataclass
class Footer:
    """Why this email came, the ways to get fewer, and who sent it."""
    why: str | Html = ""
    links: list[tuple[str, str]] = field(default_factory=list)   # (label, url)
    note: str | Html = ""


def _postal() -> str:
    try:
        from app.config import get_settings

        return (getattr(get_settings(), "email_postal_address", "") or "").strip()
    except Exception:
        return ""


def _footer(f: Footer, base: str) -> Part:
    wh, wt = inline(f.why)
    nh, nt = inline(f.note)
    link_html = " &nbsp;&middot;&nbsp; ".join(
        f'<a href="{esc(u)}" class="md-muted" style="color:{MUTED};text-decoration:underline">{esc(lbl)}</a>'
        for lbl, u in f.links)
    addr = _postal()
    sender = f'<a href="{esc(base)}" class="md-muted" style="color:{MUTED};text-decoration:none">Markdrop</a>' + \
        (f" &middot; {esc(addr)}" if addr else " &middot; markdrop.in")
    parts_h = [x for x in (wh, nh) if x]
    html_ = "".join(f'<p style="margin:0 0 8px">{x}</p>' for x in parts_h)
    if link_html:
        html_ += f'<p style="margin:0 0 8px">{link_html}</p>'
    html_ += f'<p style="margin:0">{sender}</p>'
    text = "\n".join([x for x in (wt, nt) if x] + [f"{lbl}: {u}" for lbl, u in f.links] +
                     [f"Markdrop · {addr or 'markdrop.in'}"])
    return Part(html_, text)


CSS = f"""
  :root {{ color-scheme: light dark; supported-color-schemes: light dark; }}
  body {{ margin:0 !important; padding:0 !important; width:100% !important; }}
  a {{ color:{ACCENT}; }}
  @media (max-width: 480px) {{
    .md-outer {{ padding:12px 8px !important; }}
    .md-pad {{ padding-left:20px !important; padding-right:20px !important; }}
    .md-h1 {{ font-size:21px !important; line-height:28px !important; }}
    .md-stack {{ display:block !important; width:100% !important; padding-right:0 !important; }}
    .md-stack2 {{ display:inline-block !important; width:48% !important; }}
    .md-btncell a {{ display:block !important; }}
  }}
  @media (prefers-color-scheme: dark) {{
    .md-bg {{ background-color:{D_GROUND} !important; }}
    .md-card {{ background-color:{D_CARD} !important; }}
    .md-inset {{ background-color:{D_INSET} !important; }}
    .md-line {{ border-color:{D_LINE} !important; }}
    .md-ink {{ color:{D_INK} !important; }}
    .md-body {{ color:{D_BODY} !important; }}
    .md-muted {{ color:{D_MUTED} !important; }}
    .md-link {{ color:{D_LINK} !important; }}
  }}
  [data-ogsb] .md-bg {{ background-color:{D_GROUND} !important; }}
  [data-ogsb] .md-card {{ background-color:{D_CARD} !important; }}
  [data-ogsb] .md-inset {{ background-color:{D_INSET} !important; }}
  [data-ogsc] .md-ink {{ color:{D_INK} !important; }}
  [data-ogsc] .md-body {{ color:{D_BODY} !important; }}
  [data-ogsc] .md-muted {{ color:{D_MUTED} !important; }}
  [data-ogsc] .md-link {{ color:{D_LINK} !important; }}
"""


def wordmark(size: int = 18) -> str:
    """The Markdrop wordmark as text (an image would be blocked or broken; text always renders)."""
    return (f'<span class="md-ink" style="font-family:{SANS};font-size:{size}px;line-height:1;font-weight:800;'
            f'letter-spacing:-0.02em;color:{INK}">mark<span style="color:{ACCENT}">drop</span></span>')


@dataclass
class Email:
    html: str
    text: str

    @property
    def size(self) -> int:
        return len(self.html.encode())


def layout(*, title_: str, body: Iterable[Part], footer: Footer, preheader: str = "", label_: str = "",
           base: str = "https://markdrop.in", page: bool = False, text_head: str | None = None) -> Email:
    """The one layout every email (and the email-preference pages) uses.

    ``title_`` and ``preheader`` are plain text (escaped here). ``label_``: a small label opposite the
    wordmark (the workspace's name, "Product update"). ``page``: a web page in the same shell (no
    preheader, noindex) for the pages an email's links land on."""
    parts = [b for b in body if b is not None]
    content = "".join(b.html for b in parts)
    brand = f'<a href="{esc(base)}" style="text-decoration:none">{wordmark()}</a>'
    right = (f'<td align="right" valign="middle" class="md-muted" style="font-family:{SANS};font-size:13px;line-height:18px;'
             f'font-weight:600;color:{MUTED}">{esc(label_)}</td>') if label_ else ""
    pre = (f'<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;'
           f'line-height:1px;color:{GROUND}">{esc(preheader)}{_PREHEADER_PAD}</div>') if preheader and not page else ""
    robots = '<meta name="robots" content="noindex">\n' if page else ""
    outer = "48px 12px 40px" if page else "28px 12px 36px"
    foot = _footer(footer, base)
    html_ = f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
{robots}<title>{esc(title_)}</title>
<style>{CSS}</style>
</head>
<body class="md-bg" bgcolor="{GROUND}" style="margin:0;padding:0;background-color:{GROUND};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
{pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="md-bg" bgcolor="{GROUND}" style="background-color:{GROUND}">
<tr><td align="center" class="md-outer" style="padding:{outer}">
<!--[if mso]><table role="presentation" width="{WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<div style="max-width:{WIDTH}px;margin:0 auto">
{_t()}
<tr><td class="md-pad" style="padding:4px 32px 18px">{_t()}<tr><td valign="middle">{brand}</td>{right}</tr></table></td></tr>
<tr><td class="md-card md-line" bgcolor="{CARD}" style="background-color:{CARD};border:1px solid {LINE};border-radius:14px">
{_t()}<tr><td class="md-pad" style="padding:32px 32px 12px;font-family:{SANS};color:{BODY};word-break:break-word;overflow-wrap:anywhere">
{content}
</td></tr></table>
</td></tr>
<tr><td class="md-pad md-muted" style="padding:22px 32px 0;font-family:{SANS};font-size:12px;line-height:19px;color:{MUTED}">
{foot.html}
</td></tr>
</table>
</div>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>"""
    head = text_head if text_head is not None else ""
    text = "\n\n".join(t for t in [head] + [b.text for b in parts] + ["—", foot.text] if t)
    text = re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
    return Email(html_, text)
