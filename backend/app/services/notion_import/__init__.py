"""Import from Notion (brief .work/briefs/notion-import.md).

One source-agnostic pipeline, so a live "Connect Notion" sync (Phase B, the Notion API) reuses everything
past the first step:

    source adapter  →  intermediate tree  →  writer
    export_zip.py      tree.py               writer.py
    (Phase B: an       SourceNode per page,  creates / updates Markdrop pages, sub-pages, database folders
     API adapter)      database and row;     (typed properties), page images and files from the tree,
                       blocks (blocks.py)    idempotent by Notion id (``notion_links``), with each page's
                                             source hash, Notion ``last_edited`` and the revision it wrote:
                                             a page edited in Markdrop since is kept ("detached"), never
                                             overwritten.

    notion_md.py   Notion's exported Markdown (with its HTML bits: <aside>, <details>…) → blocks
    props.py       a database's CSV columns → typed properties (select, multi-select, date, person…)
    render.py      blocks → Markdrop page Markdown (callouts, toggles, columns, to-dos, KaTeX, tables…)
    jobs.py        the import job: the zip's upload (one presigned PUT), a background run with progress,
                   resumable (a stopped run is picked up again and skips what it already wrote)
"""
