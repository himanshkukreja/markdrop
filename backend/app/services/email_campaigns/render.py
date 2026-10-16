"""Campaign email renderer: one function for the admin preview, the test send
and every real send, so the preview is exactly what a recipient gets (only the
tracking token differs).

Two document layouts:

``blocks``  editable content blocks (markdown text, buttons, features, an accent
            callout, images, dividers, raw HTML) inside Markdrop's light email
            shell (``mailer._shell``), with an Unsubscribe link the author can't
            remove.
``raw``     a complete HTML email plus its plain-text twin (the announcement
            templates, or pasted HTML).

Pipeline: blocks → HTML with merge tags → tags resolved (values HTML-escaped) →
links on our own domain get UTM parameters → allow-listed links are wrapped for
click tracking → unsafe link schemes neutralised → open pixel before </body>.
A plain-text part is always produced.

Security: link, button and image URLs are scheme-checked (http/https/mailto;
images https only) at validation time *and* at render time, and a final pass
replaces any ``javascript:``/``data:``/``vbscript:`` href or src in the output,
including inside admin-authored raw HTML, so no email we send can carry one.
"""

from __future__ import annotations

import html as html_lib
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.services import mailer
from app.services.mailer import _ACCENT, _BODY, _INK, _LINE, _MONO, _MUTED, _SANS

from . import links
from .tags import CONTROL_RE, TAG_RE, MergeVars, check_field, has_empty_tag, problem, resolve_tags

BLOCK_TYPES = ("hero", "text", "button", "feature", "callout", "image", "divider", "html")
BLOCK_LABELS = {
    "hero": "Heading",
    "text": "Text (markdown)",
    "button": "Button",
    "feature": "Feature",
    "callout": "Callout",
    "image": "Image",
    "divider": "Divider",
    "html": "Raw HTML",
}
BLOCK_FIELDS: dict[str, tuple[str, ...]] = {
    "hero": ("eyebrow", "title"),
    "text": ("md",),
    "button": ("label", "url"),
    "feature": ("tag", "title", "md"),
    "callout": ("eyebrow", "title", "label", "url"),
    "image": ("src", "alt", "href"),
    "divider": (),
    "html": ("html",),
}
# Fields holding a link target, and whether the link is required for the block
# to make sense.
URL_FIELDS = {("button", "url"): True, ("callout", "url"): False, ("image", "href"): False}

DEFAULT_FOOTER = "You're getting this because you have a Markdrop account ({{email}})."

_esc = lambda s: html_lib.escape(s or "", quote=True)  # noqa: E731


# ── Tiny email-safe markdown ───────────────────────────────────────────────────

def _protect(s: str) -> tuple[str, list[str]]:
    """Hide merge tags from the markdown parser: underscores in {{first_name}}
    are not emphasis, and a tag can be a link target."""
    saved: list[str] = []

    def keep(m: re.Match[str]) -> str:
        saved.append(m.group(0))
        return f"\x00{len(saved) - 1}\x00"

    combined = re.compile(f"{TAG_RE.pattern}|{CONTROL_RE.pattern}")
    return combined.sub(keep, s), saved


def _restore(s: str, saved: list[str]) -> str:
    return re.sub(r"\x00(\d+)\x00", lambda m: saved[int(m.group(1))] if int(m.group(1)) < len(saved) else "", s)


def _safe_md_href(u: str) -> bool:
    t = u.strip()
    return bool(re.match(r"^(https?://|mailto:|\x00\d+\x00)", t, re.I))


_MD_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def _inline_html(s: str, link_color: str = _ACCENT) -> str:
    t = _esc(s)
    t = re.sub(
        r"`([^`]+)`",
        lambda m: f'<code style="font-family:{_MONO};font-size:0.92em;background-color:#f3f4f6;padding:1px 4px;border-radius:4px">{m.group(1)}</code>',
        t,
    )

    def link(m: re.Match[str]) -> str:
        text, url = m.group(1), m.group(2)
        raw = html_lib.unescape(url)
        if not _safe_md_href(raw):
            return text
        return f'<a href="{url}" style="color:{link_color};font-weight:600;text-decoration:underline">{text}</a>'

    t = _MD_LINK.sub(link, t)
    t = re.sub(r"\*\*([^*]+)\*\*", lambda m: f'<strong style="color:{_INK};font-weight:700">{m.group(1)}</strong>', t)
    t = re.sub(r"(^|[^*])\*([^*\n]+)\*", lambda m: f"{m.group(1)}<em>{m.group(2)}</em>", t)
    return t.replace("\n", "<br>")


def _inline_text(s: str) -> str:
    t = re.sub(r"`([^`]+)`", r"\1", s)
    t = _MD_LINK.sub(lambda m: m.group(2) if m.group(1).strip() == m.group(2).strip() else f"{m.group(1)} ({m.group(2)})", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"\1", t)
    return re.sub(r"(^|[^*])\*([^*\n]+)\*", r"\1\2", t)


def _md_nodes(md: str) -> list[tuple[str, list[str]]]:
    nodes: list[tuple[str, list[str]]] = []
    for chunk in re.split(r"\n{2,}", (md or "").replace("\r\n", "\n")):
        lines = [ln for ln in chunk.split("\n") if ln.strip()]
        if not lines:
            continue
        if all(re.match(r"^\s*[-*]\s+", ln) for ln in lines):
            nodes.append(("ul", [re.sub(r"^\s*[-*]\s+", "", ln) for ln in lines]))
        elif all(re.match(r"^\s*\d+[.)]\s+", ln) for ln in lines):
            nodes.append(("ol", [re.sub(r"^\s*\d+[.)]\s+", "", ln) for ln in lines]))
        elif len(lines) == 1 and re.match(r"^#{1,3}\s+", lines[0]):
            nodes.append(("h", [re.sub(r"^#{1,3}\s+", "", lines[0])]))
        elif all(re.match(r"^>\s?", ln) for ln in lines):
            nodes.append(("quote", [re.sub(r"^>\s?", "", ln) for ln in lines]))
        else:
            nodes.append(("p", lines))
    return nodes


def markdown_to_html(md: str, *, size: int = 15) -> str:
    out, saved = _protect(md)
    parts: list[str] = []
    for kind, lines in _md_nodes(out):
        if kind == "h":
            parts.append(
                f'<h2 style="font-family:{_SANS};font-size:20px;line-height:1.3;font-weight:700;color:{_INK};'
                f'margin:8px 0 10px;padding:0">{_inline_html(lines[0])}</h2>'
            )
        elif kind in ("ul", "ol"):
            items = "".join(f'<li style="margin:0 0 6px">{_inline_html(ln)}</li>' for ln in lines)
            parts.append(
                f'<{kind} style="font-family:{_SANS};font-size:{size}px;line-height:1.6;color:{_BODY};'
                f'margin:0 0 16px;padding:0 0 0 22px">{items}</{kind}>'
            )
        elif kind == "quote":
            parts.append(
                f'<div style="font-family:{_SANS};font-size:{size}px;line-height:1.6;color:{_BODY};'
                f'margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid {_LINE}">{_inline_html(chr(10).join(lines))}</div>'
            )
        else:
            parts.append(mailer._p(_inline_html("\n".join(lines)), size=size))
    return _restore("\n".join(parts), saved)


def markdown_to_text(md: str) -> str:
    out, saved = _protect(md)
    parts: list[str] = []
    for kind, lines in _md_nodes(out):
        if kind == "h":
            parts.append(_inline_text(lines[0]).upper())
        elif kind == "ul":
            parts.append("\n".join(f"- {_inline_text(ln)}" for ln in lines))
        elif kind == "ol":
            parts.append("\n".join(f"{i}. {_inline_text(ln)}" for i, ln in enumerate(lines, 1)))
        elif kind == "quote":
            parts.append("\n".join(f"> {_inline_text(ln)}" for ln in lines))
        else:
            parts.append(_inline_text("\n".join(lines)))
    return _restore("\n\n".join(parts), saved)


def html_to_text(src: str) -> str:
    """A readable plain-text version of an HTML email (raw templates, html blocks)."""
    s = re.sub(r"<!--[\s\S]*?-->", "", src or "")
    s = re.sub(r"<(head|style|script|title)\b[\s\S]*?</\1>", "", s, flags=re.I)
    s = re.sub(r'<div[^>]*display:\s*none[^>]*>[\s\S]*?</div>', "", s, flags=re.I)

    def a(m: re.Match[str]) -> str:
        href = html_lib.unescape(m.group(2)).strip()
        inner = m.group(3)
        text = html_lib.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", inner))).strip()
        if not text:
            alt = re.search(r"\balt=([\"'])(.*?)\1", inner, re.I)
            text = html_lib.unescape(alt.group(2)).strip() if alt else ""
        if not href or href.startswith("#"):
            return text
        if not text or text == href:
            return f"\n{href}\n"
        return f"{text} ({href})"

    s = re.sub(r"<a\b[^>]*?href=([\"'])(.*?)\1[^>]*>([\s\S]*?)</a>", a, s, flags=re.I)
    s = re.sub(r"<img\b[^>]*>", "", s, flags=re.I)
    s = re.sub(r"<(p|div|h\d|tr|table)\b", r"\n<\1", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<li\b[^>]*>", "\n- ", s, flags=re.I)
    s = re.sub(r"</(p|div|h\d|li|tr|table|ul|ol)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html_lib.unescape(s).replace(" ", " ").replace("͏", "").replace("‌", "")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in s.split("\n")]
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return out.strip()


# ── Blocks ─────────────────────────────────────────────────────────────────────

def _block_url(v: str, *, image: bool = False) -> str:
    """A block's link target if it is safe to emit: a merge tag (checked again
    after resolving) or an allowed scheme. Anything else renders unlinked."""
    t = (v or "").strip()
    if not t:
        return ""
    if t.startswith("{{"):
        return t
    return t if links.safe_scheme(t, image=image) else ""


def _block_html(b: dict[str, Any]) -> str:
    t = b.get("type")
    if t == "hero":
        eyebrow = mailer._eyebrow(_esc(b.get("eyebrow", ""))) if (b.get("eyebrow") or "").strip() else ""
        return eyebrow + mailer._heading(_esc(b.get("title", "")))
    if t == "text":
        return markdown_to_html(b.get("md", ""))
    if t == "button":
        url = _block_url(b.get("url", ""))
        label = _esc(b.get("label", "")) or "Open"
        if not url:
            return mailer._p(f'<strong style="color:{_INK}">{label}</strong>')
        return mailer._button(_esc(url), label, margin="4px 0 24px")
    if t == "feature":
        tag = (
            f'<div style="font-family:{_SANS};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;'
            f'text-transform:uppercase;color:{_ACCENT};margin:0 0 6px">{_esc(b.get("tag", ""))}</div>'
            if (b.get("tag") or "").strip() else ""
        )
        title = (
            f'<div style="font-family:{_SANS};font-size:16px;line-height:1.4;font-weight:700;color:{_INK};margin:0 0 6px">'
            f'{_esc(b.get("title", ""))}</div>'
        )
        return f'<div style="margin:0 0 8px">{tag}{title}{markdown_to_html(b.get("md", ""), size=14)}</div>'
    if t == "callout":
        # A saturated block with white text: Gmail's forced inversion leaves
        # saturated fills alone (mailer.py), so it reads the same either way.
        url = _block_url(b.get("url", ""))
        eyebrow = (
            f'<div style="font-family:{_SANS};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;'
            f'text-transform:uppercase;color:#dbe7ff;margin:0 0 6px">{_esc(b.get("eyebrow", ""))}</div>'
            if (b.get("eyebrow") or "").strip() else ""
        )
        link = (
            f'<a href="{_esc(url)}" style="font-family:{_SANS};font-size:14px;font-weight:700;color:#ffffff;'
            f'text-decoration:underline">{_esc(b.get("label", "")) or "Open"}</a>'
            if url and (b.get("label") or "").strip() else ""
        )
        return (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px">'
            f'<tr><td bgcolor="{_ACCENT}" style="background-color:{_ACCENT};border-radius:8px;padding:18px 20px">'
            f'{eyebrow}<div style="font-family:{_SANS};font-size:18px;line-height:1.35;font-weight:700;color:#ffffff;'
            f'margin:0 0 {10 if link else 0}px">{_esc(b.get("title", ""))}</div>{link}</td></tr></table>'
        )
    if t == "image":
        src = _block_url(b.get("src", ""), image=True)
        if not src:
            return ""
        img = (
            f'<img src="{_esc(src)}" alt="{_esc(b.get("alt", ""))}" width="494" '
            f'style="display:block;width:100%;max-width:494px;height:auto;border:0;border-radius:8px;'
            f'font-family:{_SANS};font-size:14px;color:{_BODY}">'
        )
        href = _block_url(b.get("href", ""))
        inner = f'<a href="{_esc(href)}" style="text-decoration:none;display:block">{img}</a>' if href else img
        return f'<div style="margin:4px 0 24px">{inner}</div>'
    if t == "divider":
        return mailer._rule()
    if t == "html":
        return b.get("html", "")
    return ""


def _block_text(b: dict[str, Any]) -> str:
    t = b.get("type")
    strip_arrow = lambda s: re.sub(r"\s*(→|&rarr;)\s*$", "", s or "")  # noqa: E731
    if t == "hero":
        return "\n".join(x for x in [(b.get("eyebrow") or "").upper(), b.get("title") or ""] if x.strip())
    if t == "text":
        return markdown_to_text(b.get("md", ""))
    if t == "button":
        url = _block_url(b.get("url", ""))
        return f"{strip_arrow(b.get('label', '')) or 'Open'}: {url}" if url else strip_arrow(b.get("label", ""))
    if t == "feature":
        head = " · ".join(x for x in [(b.get("tag") or "").upper(), (b.get("title") or "").upper()] if x.strip())
        return f"{head}\n{markdown_to_text(b.get('md', ''))}".strip()
    if t == "callout":
        url = _block_url(b.get("url", ""))
        lines = [(b.get("eyebrow") or "").upper(), b.get("title") or ""]
        if url:
            lines.append(f"{strip_arrow(b.get('label', '')) or 'Open'}: {url}")
        return "\n".join(x for x in lines if x.strip())
    if t == "image":
        if not (b.get("alt") or "").strip():
            return ""
        href = _block_url(b.get("href", ""))
        return f"[{b.get('alt')}]" + (f" {href}" if href else "")
    if t == "divider":
        return "—"
    if t == "html":
        return html_to_text(b.get("html", ""))
    return ""


def _footer_html(doc: dict[str, Any]) -> str:
    footer = (doc.get("footer") or "").strip()
    unsub = (
        f'<a href="{{{{unsubscribe_url}}}}" style="color:{_MUTED};text-decoration:underline">Unsubscribe</a>'
    )
    if not footer:
        return unsub
    out, saved = _protect(footer)
    return f"{_restore(_inline_html(out, _MUTED), saved)} {unsub}"


def blocks_html(doc: dict[str, Any], subject: str, preheader: str) -> str:
    content = "\n".join(h for h in (_block_html(b) for b in doc.get("blocks", [])) if h)
    label = (doc.get("top_label") or "").strip()
    return mailer._shell(
        title=_esc(subject),
        preheader=_esc(preheader),
        content=content,
        footer=_footer_html(doc),
        top_label=_esc(label),
    )


def blocks_text(doc: dict[str, Any]) -> str:
    parts = [p for p in (_block_text(b) for b in doc.get("blocks", [])) if p.strip()]
    out, saved = _protect((doc.get("footer") or "").strip())
    footer = _restore(_inline_text(out), saved)
    tail = f"{footer}\n" if footer else ""
    return "\n\n".join(parts) + f"\n\n--\n{tail}Unsubscribe: {{{{unsubscribe_url}}}}"


# ── Tracking, UTM, hardening ───────────────────────────────────────────────────

_A_HREF = re.compile(r"(<a\b[^>]*?\shref=)([\"'])(.*?)\2", re.I | re.S)
_BAD_ATTR = re.compile(r"(\s(?:href|src|action|formaction|background)\s*=\s*)([\"'])\s*(?:javascript|vbscript|data):[^\"']*\2", re.I)


def _with_utm(u: str, campaign: str) -> str:
    parts = urlsplit(u)
    q = parse_qsl(parts.query, keep_blank_values=True)
    if any(k.lower().startswith("utm_") for k, _ in q):
        return u
    q += [("utm_source", "email"), ("utm_medium", "email"), ("utm_campaign", campaign)]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))


def rewrite_links(html: str, *, token: str | None, track_clicks: bool, utm_campaign: str | None) -> str:
    wrap = bool(track_clicks and token)
    if not wrap and not utm_campaign:
        return html

    def sub(m: re.Match[str]) -> str:
        pre, q, href = m.group(1), m.group(2), m.group(3)
        raw = html_lib.unescape(href.strip())
        u = links.allowed_url(raw)
        if not u or links.is_tracking_url(u):
            return m.group(0)
        if utm_campaign and links.is_own_url(u):
            u = _with_utm(u, utm_campaign)
        target = links.click_url(token, u) if wrap and token else u
        return f"{pre}{q}{_esc(target)}{q}"

    return _A_HREF.sub(sub, html)


def neutralise(html: str) -> str:
    """No script-capable or data URLs in anything we send."""
    return _BAD_ATTR.sub(lambda m: f'{m.group(1)}{m.group(2)}#{m.group(2)}', html)


def inject_pixel(html: str, token: str | None, track_opens: bool) -> str:
    if not track_opens or not token:
        return html
    img = (
        f'<img src="{_esc(links.open_pixel_url(token))}" width="1" height="1" alt="" '
        'style="display:block;width:1px;height:1px;border:0;opacity:0" />'
    )
    idx = html.lower().rfind("</body>")
    return f"{html[:idx]}{img}\n{html[idx:]}" if idx != -1 else html + img


def utm_slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:60]
    return s or "campaign"


# ── Entry points ───────────────────────────────────────────────────────────────

def render_subject(content: dict[str, Any], vars: MergeVars) -> str:
    fb = (content.get("subject_fallback") or "").strip()
    subject = content.get("subject") or ""
    use_fb = bool(fb) and has_empty_tag(subject, vars)
    out = resolve_tags(fb if use_fb else subject, vars, "text")
    return re.sub(r"\s+", " ", out).strip()


def render_email(
    content: dict[str, Any],
    vars: MergeVars,
    *,
    token: str | None,
    track_opens: bool = True,
    track_clicks: bool = True,
    utm_campaign: str | None = None,
) -> dict[str, str]:
    """``{subject, preheader, html, text}`` for one recipient.

    ``vars`` must already carry ``unsubscribe_url`` for this token.
    """
    subject = render_subject(content, vars)
    preheader = re.sub(r"\s+", " ", resolve_tags(content.get("preheader") or "", vars, "text")).strip()
    doc = content["doc"]
    if doc.get("layout") == "raw":
        html_tpl, text_tpl = doc.get("html") or "", doc.get("text") or ""
        if not text_tpl.strip():
            text_tpl = html_to_text(html_tpl)
    else:
        html_tpl, text_tpl = blocks_html(doc, subject, preheader), blocks_text(doc)
    out = resolve_tags(html_tpl, vars, "html")
    out = rewrite_links(out, token=token, track_clicks=track_clicks, utm_campaign=utm_campaign)
    out = neutralise(out)
    out = inject_pixel(out, token, track_opens)
    text = resolve_tags(text_tpl, vars, "text").strip() + "\n"
    return {"subject": subject, "preheader": preheader, "html": out, "text": text}


def render_for(campaign: dict[str, Any], vars: MergeVars, token: str) -> dict[str, str]:
    """Render one recipient's copy of a campaign (or a draft, for preview/test)."""
    v = {**vars, "unsubscribe_url": links.unsubscribe_url(token)}
    r = render_email(
        campaign,
        v,
        token=token,
        track_opens=campaign.get("track_opens", True),
        track_clicks=campaign.get("track_clicks", True),
        utm_campaign=utm_slug(campaign.get("name") or ""),
    )
    r["unsubscribe_url"] = v["unsubscribe_url"]
    return r


# ── Validation ─────────────────────────────────────────────────────────────────

def doc_fields(doc: dict[str, Any]) -> list[tuple[str, str]]:
    if doc.get("layout") == "raw":
        return [("HTML", doc.get("html") or ""), ("Plain text", doc.get("text") or "")]
    out = [("Top bar label", doc.get("top_label") or ""), ("Footer", doc.get("footer") or "")]
    for i, b in enumerate(doc.get("blocks", []), 1):
        at = f"Block {i} · {BLOCK_LABELS.get(b.get('type', ''), b.get('type', ''))}"
        for k in BLOCK_FIELDS.get(b.get("type", ""), ()):
            out.append((f"{at} · {k}", b.get(k) or ""))
    return out


def _url_problem(where: str, value: str, *, image: bool, required: bool) -> dict[str, str] | None:
    v = (value or "").strip()
    if not v:
        return problem(where, "", "Add a link.") if required else None
    if v.startswith("{{"):
        m = TAG_RE.match(v)
        if not m:
            return None  # reported by check_field
        from .tags import URL_TAGS
        if m.group(1).lower() not in URL_TAGS and m.start() == 0 and m.end() == len(v):
            return problem(where, v, f"{m.group(0)} isn't a link tag. Use {{{{site_url}}}}, {{{{dashboard_url}}}} or a full https:// address.")
        return None
    if image:
        return None if links.safe_scheme(v, image=True) else problem(where, v[:60], "Images must be https:// URLs.")
    if not links.safe_scheme(v):
        return problem(where, v[:60], "Links must start with https://, http:// or mailto:.")
    return None


def content_problems(content: dict[str, Any]) -> list[dict[str, str]]:
    problems = [
        *check_field("Subject", content.get("subject")),
        *check_field("Subject fallback", content.get("subject_fallback")),
        *check_field("Preheader", content.get("preheader")),
    ]
    doc = content.get("doc") or {}
    for where, value in doc_fields(doc):
        problems += check_field(where, value)
    if not (content.get("subject") or "").strip():
        problems.append(problem("Subject", "", "Subject is empty."))
    if doc.get("layout") == "raw":
        body = doc.get("html") or ""
        if not body.strip():
            problems.append(problem("HTML", "", "The HTML is empty."))
        elif not re.search(r"\{\{\s*unsubscribe_url\s*\}\}", re.sub(r"<!--[\s\S]*?-->", "", body)):
            problems.append(problem("HTML", "", "The HTML has no {{unsubscribe_url}} link."))
        bad = _BAD_ATTR.search(body)
        if bad:
            problems.append(problem("HTML", bad.group(0).strip()[:60], "Remove javascript:, vbscript: and data: URLs; they're stripped when sending."))
    else:
        blocks = doc.get("blocks") or []
        if not blocks:
            problems.append(problem("Body", "", "Add at least one block."))
        for i, b in enumerate(blocks, 1):
            t = b.get("type", "")
            at = f"Block {i} · {BLOCK_LABELS.get(t, t)}"
            for (bt, field), required in URL_FIELDS.items():
                if bt == t:
                    p = _url_problem(f"{at} · {field}", b.get(field, ""), image=False, required=required)
                    if p:
                        problems.append(p)
            if t == "image":
                if not (b.get("src") or "").strip():
                    problems.append(problem(f"{at} · src", "", "Add an image URL."))
                else:
                    p = _url_problem(f"{at} · src", b.get("src", ""), image=True, required=True)
                    if p:
                        problems.append(p)
                if not (b.get("alt") or "").strip():
                    problems.append(problem(f"{at} · alt", "", "Add alt text: most clients block images at first."))
            if t == "html":
                bad = _BAD_ATTR.search(b.get("html") or "")
                if bad:
                    problems.append(problem(f"{at} · html", bad.group(0).strip()[:60], "Remove javascript:, vbscript: and data: URLs."))
    return problems


# ── Parsing (request bodies → stored documents) ────────────────────────────────

def _s(v: Any, n: int) -> str:
    return v[:n] if isinstance(v, str) else ""


class ContentError(ValueError):
    pass


def new_block_id() -> str:
    import secrets
    return secrets.token_hex(4)


def parse_doc(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ContentError("The email body is missing.")
    layout = raw.get("layout")
    if layout == "raw":
        return {
            "layout": "raw",
            "html": _s(raw.get("html"), 400_000),
            "text": _s(raw.get("text"), 200_000),
            "source": _s(raw.get("source"), 200) or None,
        }
    if layout != "blocks":
        raise ContentError("Unknown email layout.")
    blocks_in = raw.get("blocks") if isinstance(raw.get("blocks"), list) else []
    blocks: list[dict[str, Any]] = []
    for i, b in enumerate(blocks_in[:80]):
        if not isinstance(b, dict) or b.get("type") not in BLOCK_FIELDS:
            continue
        t = b["type"]
        limit = 100_000 if t == "html" else 20_000
        blk: dict[str, Any] = {"id": _s(b.get("id"), 40) or f"b{i}", "type": t}
        for k in BLOCK_FIELDS[t]:
            blk[k] = _s(b.get(k), limit)
        blocks.append(blk)
    return {
        "layout": "blocks",
        "top_label": _s(raw.get("top_label"), 60),
        "footer": _s(raw.get("footer"), 2000),
        "blocks": blocks,
    }


AUDIENCE_KINDS = (
    "all", "recent", "active", "with_documents", "with_artifacts",
    "never_published", "vscode", "workspace", "custom",
)


def parse_audience(raw: Any) -> dict[str, Any]:
    a = raw if isinstance(raw, dict) else {}
    kind = a.get("kind") if a.get("kind") in AUDIENCE_KINDS else "all"

    def clamp(v: Any, lo: int, hi: int, default: int) -> int:
        try:
            return max(lo, min(hi, int(v)))
        except (TypeError, ValueError):
            return default

    return {
        "kind": kind,
        "days": clamp(a.get("days"), 1, 3650, 30),
        "min": clamp(a.get("min"), 1, 1000, 1),
        "emails": _s(a.get("emails"), 500_000),
    }


def _one_line(v: Any, n: int) -> str:
    return re.sub(r"[\r\n]+", " ", _s(v, n))


def parse_content(body: Any) -> dict[str, Any]:
    """A campaign draft from a request body: every string clipped, CR/LF out of
    header-bound fields (subject), unknown fields dropped."""
    b = body if isinstance(body, dict) else {}
    subject = _one_line(b.get("subject"), 300)
    return {
        "name": _s(b.get("name"), 120).strip() or subject[:80].strip() or "Untitled campaign",
        "subject": subject,
        "subject_fallback": _one_line(b.get("subject_fallback"), 300).strip() or None,
        "preheader": _one_line(b.get("preheader"), 300).strip() or None,
        "template": _s(b.get("template"), 40) or "newsletter",
        "doc": parse_doc(b.get("doc")),
        "sender_id": _s(b.get("sender_id"), 60) or None,
        "audience": parse_audience(b.get("audience")),
        "track_opens": b.get("track_opens") is not False,
        "track_clicks": b.get("track_clicks") is not False,
    }
