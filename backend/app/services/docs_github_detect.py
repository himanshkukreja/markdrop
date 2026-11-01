"""Which docs a repository holds, for the import screen's preview (before anything is imported).

The import itself (frontend/scripts/docs-import/github.mjs, run by the job runner) reads the whole
repository and is the authority; this module reads only the file list (GitHub's recursive tree) and
a few small config files, and answers what the picker shows: folders worth importing, the format of
the chosen one, its page count and the groups its sidebar will have.

Detection for a folder F, first match wins (the same rules as the converter's lib/repo/detect.mjs):

1. ``mintlify``    F/docs.json (with ``navigation``) or F/mint.json; content root F.
2. ``gitbook``     F/.gitbook.yaml (content root F/<root:>) or F/SUMMARY.md (content root F).
3. ``mkdocs``      F/mkdocs.yml or F/mkdocs.yaml; content root F/<docs_dir> (default docs).
4. ``docusaurus``  F/docusaurus.config.{js,ts,mjs,cjs}; content root F/docs (or a ``path:`` found
                   statically in the config).
5. ``markdown``    anything else; content root F.

Paths are repo-relative without leading or trailing slashes; "" is the repository's root.
"""

from __future__ import annotations

import json
import re
from typing import Awaitable, Callable

import yaml

FORMATS = ("markdown", "gitbook", "mintlify", "docusaurus", "mkdocs")
FORMAT_LABELS = {"markdown": "Markdown folder", "gitbook": "GitBook (Git Sync)", "mintlify": "Mintlify",
                 "docusaurus": "Docusaurus", "mkdocs": "MkDocs"}
IGNORED = frozenset({"node_modules", ".git", "vendor", "dist", "build", ".next", "site-packages", ".venv", "venv",
                     "__pycache__", ".docusaurus", ".cache", "out", "target"})
DOCUSAURUS_CONFIGS = ("docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", "docusaurus.config.cjs")
OPENAPI_NAME = re.compile(r"(^|/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$", re.I)
MAX_FOLDERS = 12
PREVIEW_TITLES = 8

Reader = Callable[[str], Awaitable[bytes | None]]


def join(*parts: str) -> str:
    return "/".join(p.strip("/") for p in parts if p and p.strip("/"))


def norm_folder(path: str | None) -> str:
    p = (path or "").strip().strip("/")
    segs = [s for s in p.split("/") if s and s != "."]
    if any(s == ".." for s in segs):
        raise ValueError("Not a valid folder.")
    return "/".join(segs)


def usable(path: str) -> bool:
    return not any(seg in IGNORED for seg in path.split("/")[:-1])


def parent(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def under(path: str, folder: str) -> bool:
    return not folder or path == folder or path.startswith(folder + "/")


def rel(path: str, folder: str) -> str:
    return path[len(folder) + 1:] if folder else path


def is_page(path: str, fmt: str = "markdown") -> bool:
    if not path.lower().endswith((".md", ".mdx")):
        return False
    segs = path.split("/")
    if any(s.startswith(".") for s in segs):
        return False
    if any(s.startswith("_") for s in segs[:-1]):
        return False
    name = segs[-1]
    if name.startswith("_"):
        return False
    return True


def page_files(paths: list[str], root: str, fmt: str) -> list[str]:
    out = [p for p in paths if under(p, root) and usable(p) and is_page(rel(p, root), fmt)]
    if fmt == "gitbook":
        out = [p for p in out if rel(p, root) != "SUMMARY.md"]
    return sorted(out)


def _yaml(data: bytes | None) -> dict:
    """mkdocs.yml / .gitbook.yaml: a mapping, tolerating tags like !!python/name: and !ENV."""
    if not data:
        return {}

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_multi_constructor("", lambda loader, suffix, node: None)
    try:
        doc = yaml.load(data.decode("utf-8", "replace"), Loader=Loader)  # noqa: S506 (SafeLoader subclass)
    except yaml.YAMLError:
        return {}
    return doc if isinstance(doc, dict) else {}


def _json(data: bytes | None) -> dict:
    if not data:
        return {}
    try:
        doc = json.loads(data.decode("utf-8", "replace"))
    except ValueError:
        return {}
    return doc if isinstance(doc, dict) else {}


def suggest_folders(paths: list[str]) -> list[str]:
    """Folders worth importing, best first (see the module docstring)."""
    files = [p for p in paths if usable(p)]
    names = set(files)
    out: list[str] = []
    projects: list[str] = []  # folders with a config: their own docs folder isn't offered again

    def add(f: str, project: bool = True) -> None:
        if not project and any(under(f, c) for c in projects):
            return
        if f not in out:
            out.append(f)
        if project:
            projects.append(f)

    for p in files:
        if p.endswith(("/docs.json", "/mint.json")) or p in ("docs.json", "mint.json"):
            add(parent(p))
    if ".gitbook.yaml" in names:
        add("")
    for p in files:
        if p.endswith("/.gitbook.yaml"):
            add(parent(p))
        if p == "SUMMARY.md" or p.endswith("/SUMMARY.md"):
            add(parent(p))
    for p in files:
        if p.rsplit("/", 1)[-1] in ("mkdocs.yml", "mkdocs.yaml"):
            add(parent(p))
    for p in files:
        if p.rsplit("/", 1)[-1] in DOCUSAURUS_CONFIGS:
            add(parent(p))
    for f in ("docs", "website/docs", "documentation", "doc"):
        if any(under(p, f) and is_page(rel(p, f)) for p in files):
            add(f, project=False)
    if "" not in out:
        out.append("")
    return out[:MAX_FOLDERS]


async def detect(paths: list[str], folder: str, read: Reader) -> dict:
    """{format, content_root, config} for a folder."""
    names = set(paths)
    f = folder
    for cfg in ("docs.json", "mint.json"):
        p = join(f, cfg)
        if p in names:
            if cfg == "docs.json" and "navigation" not in _json(await read(p)):
                continue
            return {"format": "mintlify", "content_root": f, "config": p}
    if join(f, ".gitbook.yaml") in names:
        doc = _yaml(await read(join(f, ".gitbook.yaml")))
        root = doc.get("root") if isinstance(doc.get("root"), str) else ""
        try:
            content = join(f, norm_folder(root))
        except ValueError:
            content = f
        return {"format": "gitbook", "content_root": content, "config": join(f, ".gitbook.yaml"), "gitbook": doc}
    if join(f, "SUMMARY.md") in names:
        return {"format": "gitbook", "content_root": f, "config": join(f, "SUMMARY.md"), "gitbook": {}}
    for cfg in ("mkdocs.yml", "mkdocs.yaml"):
        p = join(f, cfg)
        if p in names:
            doc = _yaml(await read(p))
            docs_dir = doc.get("docs_dir") if isinstance(doc.get("docs_dir"), str) else "docs"
            try:
                content = join(f, norm_folder(docs_dir))
            except ValueError:
                content = join(f, "docs")
            return {"format": "mkdocs", "content_root": content, "config": p, "mkdocs": doc}
    for cfg in DOCUSAURUS_CONFIGS:
        p = join(f, cfg)
        if p in names:
            text = (await read(p) or b"").decode("utf-8", "replace")
            docs = "docs"
            m = re.search(r"docs\s*:\s*\{[^{}]*?\bpath\s*:\s*['\"]([^'\"]+)['\"]", text, re.S)
            if m:
                try:
                    docs = norm_folder(m.group(1)) or "docs"
                except ValueError:
                    docs = "docs"
            return {"format": "docusaurus", "content_root": join(f, docs), "config": p}
    return {"format": "markdown", "content_root": f, "config": None}


def content_root_for(fmt: str, folder: str, detected: dict) -> str:
    """The content root when the format is chosen by hand (an override)."""
    if fmt == detected["format"]:
        return detected["content_root"]
    if fmt == "mkdocs":
        return join(folder, "docs")
    if fmt == "docusaurus":
        return join(folder, "docs")
    return folder


# ── Preview groups ─────────────────────────────────────────────────────────────


def humanize(name: str) -> str:
    base = re.sub(r"\.(mdx?|ya?ml|json)$", "", name.rsplit("/", 1)[-1], flags=re.I)
    base = re.sub(r"^\d+[-_.\s]+", "", base)
    base = re.sub(r"[-_]+", " ", base).strip()
    if base.lower() in ("readme", "index"):
        return "Overview"
    return base[:1].upper() + base[1:] if base else name


def _group(name: str, titles: list[str]) -> dict:
    return {"group": name[:80], "count": len(titles), "pages": titles[:PREVIEW_TITLES]}


def _mint_pages(items, out: list[str]) -> None:
    for it in items if isinstance(items, list) else []:
        if isinstance(it, str):
            out.append(humanize(it))
        elif isinstance(it, dict):
            _mint_pages(it.get("pages"), out)
            for g in it.get("groups") or []:
                if isinstance(g, dict):
                    _mint_pages(g.get("pages"), out)


def mintlify_groups(doc: dict) -> list[dict]:
    nav = doc.get("navigation")
    groups: list[dict] = []

    def from_groups(gs) -> None:
        for g in gs if isinstance(gs, list) else []:
            if isinstance(g, dict) and isinstance(g.get("group"), str):
                titles: list[str] = []
                _mint_pages(g.get("pages"), titles)
                groups.append(_group(g["group"], titles))

    if isinstance(nav, list):  # mint.json
        from_groups(nav)
    elif isinstance(nav, dict):  # docs.json
        if isinstance(nav.get("groups"), list):
            from_groups(nav["groups"])
        for key, inner in (("tabs", "groups"), ("anchors", "groups"), ("dropdowns", "groups")):
            for t in nav.get(key) or []:
                if isinstance(t, dict):
                    from_groups(t.get(inner))
                    if isinstance(t.get("pages"), list):
                        titles: list[str] = []
                        _mint_pages(t["pages"], titles)
                        groups.append(_group(str(t.get("tab") or t.get("anchor") or "Pages"), titles))
        for key in ("versions", "languages"):
            first = (nav.get(key) or [None])[0]
            if isinstance(first, dict):
                return mintlify_groups({"navigation": first})
        if isinstance(nav.get("pages"), list) and not groups:
            titles = []
            _mint_pages(nav["pages"], titles)
            groups.append(_group("Pages", titles))
    return groups


def summary_groups(text: str) -> list[dict]:
    groups: list[dict] = []
    current = {"group": "Getting started", "titles": []}
    for line in text.splitlines():
        h = re.match(r"^\s{0,3}#{2,3}\s+(.+?)\s*#*\s*$", line)
        if h:
            if current["titles"]:
                groups.append(_group(current["group"], current["titles"]))
            current = {"group": h.group(1).strip(), "titles": []}
            continue
        m = re.match(r"^\s*[*+-]\s+\[([^\]]+)\]\(([^)]+)\)", line)
        if m:
            current["titles"].append(m.group(1).strip())
    if current["titles"]:
        groups.append(_group(current["group"], current["titles"]))
    return groups


def _mk_titles(items, out: list[str]) -> None:
    for it in items if isinstance(items, list) else [items]:
        if isinstance(it, str):
            if not re.match(r"^[a-z]+://", it):
                out.append(humanize(it))
        elif isinstance(it, dict):
            for k, v in it.items():
                if isinstance(v, str):
                    if not re.match(r"^[a-z]+://", v):
                        out.append(str(k))
                else:
                    _mk_titles(v, out)


def mkdocs_groups(doc: dict) -> list[dict] | None:
    nav = doc.get("nav")
    if not isinstance(nav, list):
        return None
    groups: list[dict] = []
    loose: list[str] = []
    for it in nav:
        if isinstance(it, dict) and len(it) == 1:
            k, v = next(iter(it.items()))
            if isinstance(v, list):
                titles: list[str] = []
                _mk_titles(v, titles)
                groups.append(_group(str(k), titles))
                continue
        _mk_titles(it, loose)
    if loose:
        groups.insert(0, _group("Getting started", loose))
    return groups


def folder_groups(pages: list[str], root: str) -> list[dict]:
    loose: list[str] = []
    by: dict[str, list[str]] = {}
    for p in pages:
        r = rel(p, root)
        if "/" in r:
            by.setdefault(r.split("/", 1)[0], []).append(humanize(r))
        elif r.lower() not in ("readme.md", "index.md", "index.mdx", "readme.mdx"):
            loose.append(humanize(r))
    groups = [_group("Getting started", loose)] if loose else []
    groups += [_group(humanize(k), v) for k, v in by.items()]
    return groups


def _openapi_refs(doc: dict) -> list[str]:
    out: list[str] = []

    def walk(v) -> None:
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            if isinstance(v.get("source"), str):
                out.append(v["source"])
            for k, x in v.items():
                if k == "openapi":
                    walk(x)
                elif isinstance(x, (dict, list)):
                    for y in (x if isinstance(x, list) else [x]):
                        if isinstance(y, dict) and "openapi" in y:
                            walk(y["openapi"])

    if "openapi" in doc:
        walk(doc["openapi"])
    nav = doc.get("navigation")
    stack = [nav]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if "openapi" in cur:
                walk(cur["openapi"])
            stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
        elif isinstance(cur, list):
            stack.extend(cur)
    return [x for x in out if isinstance(x, str) and not re.match(r"^[a-z]+://", x)]


async def preview(paths: list[str], folder: str, read: Reader, fmt: str | None = None) -> dict:
    """What the picker shows for one folder (see the module docstring)."""
    folder = norm_folder(folder)
    det = await detect(paths, folder, read)
    chosen = fmt if fmt in FORMATS else det["format"]
    root = content_root_for(chosen, folder, det)
    pages = page_files(paths, root, chosen)
    warnings: list[str] = []
    groups: list[dict] | None = None
    if chosen == "mintlify" and det.get("config"):
        doc = _json(await read(det["config"]))
        groups = mintlify_groups(doc) or None
    elif chosen == "gitbook":
        summary_path = join(root, ((det.get("gitbook") or {}).get("structure") or {}).get("summary") or "SUMMARY.md")
        if summary_path in set(paths):
            groups = summary_groups((await read(summary_path) or b"").decode("utf-8", "replace")) or None
        else:
            warnings.append("There is no SUMMARY.md: the sidebar follows the folders.")
    elif chosen == "mkdocs" and det.get("mkdocs") is not None:
        groups = mkdocs_groups(det["mkdocs"])
    if groups is None:
        groups = folder_groups(pages, root)
    if not pages:
        warnings.append("This folder has no Markdown pages (.md or .mdx).")
    if chosen != det["format"]:
        warnings.append(f"This folder looks like {FORMAT_LABELS[det['format']]}; it will be read as {FORMAT_LABELS[chosen]}.")
    openapi: list[str] = []
    if chosen == "mintlify" and det.get("config"):
        for ref in _openapi_refs(_json(await read(det["config"]))):
            p = join(folder, ref.lstrip("./")) if not ref.startswith("/") else join(folder, ref)
            if p in set(paths) and p not in openapi:
                openapi.append(p)
    for p in paths:
        if under(p, folder) and usable(p) and OPENAPI_NAME.search(p) and p not in openapi:
            openapi.append(p)
    return {
        "path": folder,
        "format": chosen,
        "detected_format": det["format"],
        "content_root": root,
        "pages": len(pages),
        "groups": groups[:30],
        "openapi": openapi[:5],
        "warnings": warnings,
    }


async def folders(paths: list[str], read: Reader) -> list[dict]:
    out = []
    for f in suggest_folders(paths):
        det = await detect(paths, f, read)
        n = len(page_files(paths, det["content_root"], det["format"]))
        if n or not f:
            out.append({"path": f, "format": det["format"], "pages": n})
    return out


def watched_prefix(fmt: str, folder: str) -> str:
    """The part of the repository a push must touch for a sync: the project folder (it holds the
    config, the pages and, for Docusaurus, static/)."""
    return norm_folder(folder)
