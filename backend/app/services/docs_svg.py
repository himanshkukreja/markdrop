"""SVG uploads to a docs site: parsed, cut down to an allowlist, written out again.

A site's files are served from the site's own address, so an SVG that a reader
opens directly would run any script in it there. A blocklist over the bytes
can't hold (``<svg:script xmlns:svg=...>``, ``<h:script xmlns:h=XHTML>``,
``href="javascript&#58;..."``, an ``<animate>`` that sets ``href``), so the file
is read with a real XML parser (expat, namespace-aware) and only what is on the
lists below survives:

- elements: drawing, text, paint servers, filters, clipping, markers and SMIL
  animation, in the SVG namespace (an SVG without ``xmlns`` counts as SVG).
  Anything else, with everything inside it, is dropped.
- attributes: geometry, presentation, filter and animation attributes, plus
  ``xlink:href`` / ``xml:space`` / ``xml:lang``, ``aria-*`` and ``data-*``.
- links (``href``, ``xlink:href``): ``#fragment``, ``https://``, or a
  ``data:image/(png|jpeg|gif|webp)``. ``url(...)`` in attributes and CSS: a
  fragment or such a data image only. CSS can't ``@import`` or bind behaviour.

Active content (script, foreignObject, iframe, embed, object, ``on*``
handlers, a ``javascript:`` link, an animation of ``href``) refuses the upload
with a message, rather than quietly giving back a different picture. A DOCTYPE
with an internal subset, any entity declaration, an undefined entity, or a file
that isn't well-formed XML is refused too (no entity is ever expanded). A bare
public DOCTYPE (what Illustrator writes) is ignored and not written back.
"""

from __future__ import annotations

import re
from xml.parsers import expat

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_NS = "http://www.w3.org/XML/1998/namespace"

MAX_DEPTH = 256

UNREADABLE = "That SVG couldn't be read. Save it again as a plain SVG and upload that."
ACTIVE = "SVG files can't contain scripts, event handlers or embedded pages."
NOT_SVG = "That file type isn't supported."


class SvgRejected(ValueError):
    pass


_ELEMENTS = {
    "svg", "g", "defs", "symbol", "use", "title", "desc", "switch", "a", "view",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textPath",
    "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker", "image", "style",
    "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix",
    "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA",
    "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology",
    "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
    "animate", "animateMotion", "animateTransform", "set", "mpath",
}
_ANIMATIONS = {"animate", "animateMotion", "animateTransform", "set"}
# Never allowed, in any namespace: the upload is refused rather than silently changed.
_ACTIVE_ELEMENTS = {"script", "foreignobject", "iframe", "embed", "object", "handler", "listener", "frame",
                    "frameset", "applet", "base", "meta", "link", "form", "input", "button", "textarea"}

_ATTRS = set("""
id class style lang tabindex role transform viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry
fx fy fr d points pathLength version baseProfile target
alignment-baseline baseline-shift clip clip-path clip-rule color color-interpolation color-interpolation-filters
color-profile color-rendering cursor direction display dominant-baseline enable-background fill fill-opacity
fill-rule filter flood-color flood-opacity font font-family font-size font-size-adjust font-stretch font-style
font-variant font-weight glyph-orientation-horizontal glyph-orientation-vertical image-rendering kerning
letter-spacing lighting-color marker marker-end marker-mid marker-start mask mask-type opacity overflow
paint-order pointer-events shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset
stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration
text-rendering transform-origin transform-box unicode-bidi vector-effect visibility word-spacing writing-mode
mix-blend-mode isolation
gradientUnits gradientTransform spreadMethod offset patternUnits patternContentUnits patternTransform
clipPathUnits maskUnits maskContentUnits markerUnits markerWidth markerHeight refX refY orient
filterUnits primitiveUnits filterRes
dx dy rotate textLength lengthAdjust startOffset method spacing side
in in2 result stdDeviation mode type values tableValues slope intercept amplitude exponent k1 k2 k3 k4 operator
radius scale xChannelSelector yChannelSelector baseFrequency numOctaves seed stitchTiles order kernelMatrix
divisor bias targetX targetY edgeMode kernelUnitLength preserveAlpha surfaceScale diffuseConstant
specularConstant specularExponent azimuth elevation z pointsAtX pointsAtY pointsAtZ limitingConeAngle
attributeName attributeType begin dur end min max restart repeatCount repeatDur calcMode keyTimes keySplines
keyPoints from to by additive accumulate path
requiredFeatures requiredExtensions systemLanguage
""".split())
_LINK_ATTRS = {"href"}  # in no namespace (SVG 2) or the xlink namespace
_XLINK_ATTRS = {"href", "title"}
_XML_ATTRS = {"space", "lang"}

_WS = re.compile(r"[\x00-\x20\x7f]+")
_SCRIPTY = re.compile(r"^(?:javascript|vbscript|data):", re.I)
_DATA_IMAGE = re.compile(r"^data:image/(?:png|jpeg|gif|webp)[;,]", re.I)
_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
_CSS_BAD = re.compile(r"@import|javascript:|vbscript:|expression\s*\(|-moz-binding|behavior\s*:|</", re.I)


def _safe_link(value: str) -> bool:
    v = _WS.sub("", value)
    return v.startswith("#") or v.lower().startswith("https://") or bool(_DATA_IMAGE.match(v))


def _safe_urls(value: str) -> bool:
    """Every ``url(...)`` in ``value`` points inside the file or at a data image."""
    for m in _URL.finditer(value):
        target = _WS.sub("", m.group(2))
        if not (target.startswith("#") or _DATA_IMAGE.match(target)):
            return False
    # An unterminated or escaped url( that the pattern can't read: not taken.
    return value.lower().count("url(") == len(_URL.findall(value))


def _safe_css(text: str) -> bool:
    plain = re.sub(r"\\[0-9a-fA-F]{1,6}\s?|\\.", "", text)  # CSS escapes could hide a keyword
    return plain == text and not _CSS_BAD.search(text) and _safe_urls(text)


def _split(name: str) -> tuple[str | None, str]:
    if " " in name:
        ns, local = name.split(" ", 1)
        return ns, local
    return None, name


class _Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag: str, attrs: list[tuple[str, str]]):
        self.tag = tag
        self.attrs = attrs
        self.children: list = []


def _attr_name(ns: str | None, local: str) -> str | None:
    """The name to write the attribute under, or None to drop it. SvgRejected for a handler."""
    if local.lower().startswith("on"):
        raise SvgRejected(ACTIVE)
    if ns is None:
        if local in _ATTRS or local in _LINK_ATTRS or local.startswith(("aria-", "data-")):
            return local
        return None
    if ns == XLINK_NS and local in _XLINK_ATTRS:
        return f"xlink:{local}"
    if ns == XML_NS and local in _XML_ATTRS:
        return f"xml:{local}"
    return None


def _clean_attrs(tag: str, raw: list[str]) -> list[tuple[str, str]]:
    """The attributes to keep. SvgRejected for a handler, a script link or an animation of href
    (checked on dropped elements too)."""
    out: list[tuple[str, str]] = []
    pairs = list(zip(raw[0::2], raw[1::2]))
    for name, value in pairs:
        ns, local = _split(name)
        written = _attr_name(ns, local)
        if written is None:
            continue
        if written in ("href", "xlink:href"):
            if not _safe_link(value):
                if _SCRIPTY.match(_WS.sub("", value)):
                    raise SvgRejected(ACTIVE)
                continue  # a relative or other link: dropped
        elif written == "style":
            if not _safe_css(value):
                continue
        elif "url(" in value.lower() and not _safe_urls(value):
            continue
        out.append((written, value))
    if tag in _ANIMATIONS:
        target = next((v for k, v in out if k == "attributeName"), "")
        bare = _WS.sub("", target).split(":")[-1].lower()
        if bare == "href" or bare.startswith("on"):
            raise SvgRejected(ACTIVE)
    return out


def _esc_text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(s: str) -> str:
    return (_esc_text(s).replace('"', "&quot;").replace("\t", "&#9;").replace("\n", "&#10;")
            .replace("\r", "&#13;"))


def _write(root: _Node) -> bytes:
    uses_xlink = False
    parts: list[str] = []
    stack: list = [(root, False)]
    while stack:
        node, closing = stack.pop()
        if isinstance(node, str):
            parts.append(_esc_text(node))
            continue
        if closing:
            parts.append(f"</{node.tag}>")
            continue
        attrs = "".join(f' {k}="{_esc_attr(v)}"' for k, v in node.attrs)
        uses_xlink = uses_xlink or any(k.startswith("xlink:") for k, _ in node.attrs)
        if node is root:
            attrs = f' xmlns="{SVG_NS}"__XLINK__' + attrs
        if not node.children:
            parts.append(f"<{node.tag}{attrs}/>")
            continue
        parts.append(f"<{node.tag}{attrs}>")
        stack.append((node, True))
        for child in reversed(node.children):
            stack.append((child, False))
    out = "".join(parts).replace("__XLINK__", f' xmlns:xlink="{XLINK_NS}"' if uses_xlink else "", 1)
    return out.encode("utf-8")


def sanitize(data: bytes) -> bytes:
    """The SVG in ``data`` with only allowed elements and attributes, as UTF-8. SvgRejected when it
    isn't a readable SVG or carries active content."""
    p = expat.ParserCreate(namespace_separator=" ")
    p.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    root: list[_Node] = []
    stack: list[_Node | None] = []  # None: inside a dropped element

    def doctype(_name, _sysid, _pubid, has_internal_subset):
        if has_internal_subset:
            raise SvgRejected(UNREADABLE)

    def no_entities(*_a):
        raise SvgRejected(UNREADABLE)

    def start(name, attrs):
        if len(stack) >= MAX_DEPTH:
            raise SvgRejected(UNREADABLE)
        ns, local = _split(name)
        if local.lower() in _ACTIVE_ELEMENTS:
            raise SvgRejected(ACTIVE)
        if not stack:
            if local != "svg" or ns not in (None, SVG_NS):
                raise SvgRejected(NOT_SVG)
        parent = stack[-1] if stack else "root"
        if parent is None or ns not in (None, SVG_NS) or local not in _ELEMENTS:
            if not stack:
                raise SvgRejected(NOT_SVG)
            # Dropped with everything inside it, but still checked for active content.
            _clean_attrs(local, attrs)
            stack.append(None)
            return
        node = _Node(local, _clean_attrs(local, attrs))
        if parent == "root":
            root.append(node)
        else:
            parent.children.append(node)
        stack.append(node)

    def end(_name):
        stack.pop()

    def text(s):
        if stack and stack[-1] is not None:
            kids = stack[-1].children
            if kids and isinstance(kids[-1], str):
                kids[-1] += s
            else:
                kids.append(s)

    p.StartDoctypeDeclHandler = doctype
    p.EntityDeclHandler = no_entities
    p.UnparsedEntityDeclHandler = no_entities
    p.NotationDeclHandler = no_entities
    p.ExternalEntityRefHandler = lambda *_a: 0  # never fetched: a reference to one is an error
    p.SkippedEntityHandler = no_entities
    p.StartElementHandler = start
    p.EndElementHandler = end
    p.CharacterDataHandler = text
    p.ordered_attributes = True
    try:
        p.Parse(data, True)
    except SvgRejected:
        raise
    except (expat.ExpatError, ValueError, RecursionError):
        raise SvgRejected(UNREADABLE) from None
    if not root:
        raise SvgRejected(NOT_SVG)
    # <style> text is CSS: kept only when it is safe.
    pending = [root[0]]
    while pending:
        n = pending.pop()
        if n.tag == "style" and not _safe_css("".join(c for c in n.children if isinstance(c, str))):
            n.children = []
        pending.extend(c for c in n.children if isinstance(c, _Node))
    return _write(root[0])
