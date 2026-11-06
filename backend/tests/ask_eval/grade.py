"""Grading an eval answer by code: facts present, nothing forbidden, "not found" when nothing matches,
English for Hinglish questions, citations that exist in the prompt (no hallucinated labels), no
restricted text in any prompt sent for the question (access leak)."""

from __future__ import annotations

import re
from datetime import date

NOT_FOUND = re.compile(
    r"\b(no (?:mention|record|information|info|meeting|item|document|decision|discussion|details?|data|notes?|one|lines?)"
    r"|nothing (?:about|on|in|was|that|here|matches|mentions)|not (?:mentioned|found|discussed|covered|recorded|listed|"
    r"in (?:the|your|any|these|those))|couldn't find|could not find|can't find|cannot find|can't see|cannot see|"
    r"don't see|do not see|didn't find|did not find|isn't (?:mentioned|covered|in|any)|aren't (?:mentioned|any)|"
    r"doesn't (?:mention|say|cover|appear|include)|don't (?:have|mention|cover|include)|do not (?:have|mention|include)|"
    r"there (?:is|are|was|were) no|none of|no (?:such|record)|nobody|didn't (?:say|mention|speak|come up)|"
    r"did not (?:say|mention|speak|come up)|not (?:able|available)|nothing you can open|found no|find no|(?:don't|doesn't|do not|does not) (?:answer|show|cover|contain|record|state|give|list|say)|"
    r"none (?:of them |of these )?(?:gives?|says?|states?|mentions?)|"
    r"no .{0,40}?(?:found|mentioned|recorded|in (?:your|the|these) (?:items|results|meetings|records)))", re.I)
_HINDI = re.compile(r"\b(hai|kya|mein|kitna|hua|tha|bola|wale|liye|nahi|haan|kal|hoga|baare)\b", re.I)
LABEL = re.compile(r"^(?:M?\d{1,3}(?:-s\d{1,5})?|[sn]\d{1,5})$")
BRACKET = re.compile(r"\[([^\[\]\n]{1,40})\]")


def norm(text: str | None) -> str:
    t = (text or "").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace(" ", " ")
    t = t.replace("**", "").replace("`", "")
    return re.sub(r"\s+", " ", t).strip().casefold()


def fill(s: str) -> str:
    d = date.today()
    return (s.replace("{today_iso}", d.isoformat()).replace("{today_long}", f"{d.strftime('%B')} {d.day}")
            .replace("{today_short}", f"{d.strftime('%b')} {d.day}"))


def has(text: str, alt: str) -> bool:
    return norm(fill(alt)) in norm(text)


def labels_known(prompt: str) -> set[str]:
    known: set[str] = set()
    for m in re.finditer(r'<untrusted_(?:document|meeting|task)\s+n="(\d+)"', prompt):
        known.add(m.group(1))
        known.add(f"M{m.group(1)}")
    for m in BRACKET.finditer(prompt):
        lab = m.group(1).strip()
        if LABEL.match(lab):
            known.add(lab)
    return known


def labels_used(raw: str) -> tuple[list[str], int]:
    """Citation labels in a raw model answer, and how many bracket *lists* ("[1, 3]") it wrote."""
    body = re.sub(r"<ranking>.*?</ranking>", "", raw or "", flags=re.S)
    out, lists = [], 0
    for m in BRACKET.finditer(body):
        inner = m.group(1)
        parts = [p.strip() for p in re.split(r"[,;]", inner)]
        if all(LABEL.match(p) for p in parts if p) and any(parts):
            if len([p for p in parts if p]) > 1:
                lists += 1
            out.extend(p for p in parts if p)
    return out, lists


def english(answer: str) -> bool:
    outside = re.sub(r'"[^"]*"|“[^”]*”|\'[^\']{12,}\'', " ", answer or "")
    return len(_HINDI.findall(outside)) < 2


def grade(item: dict, result: dict) -> dict:
    """``item``: a question (questions.py); ``result``: {answer, citations, prompts: [str], raws: [(prompt, raw)]}.
    Returns {pass, fails: [...], halluc: n, lists: n, leak: bool}."""
    answer = result.get("answer") or ""
    fails: list[str] = []
    for group in item.get("expect") or []:
        alts = [group] if isinstance(group, str) else group
        if not any(has(answer, a) for a in alts):
            fails.append("missing: " + " | ".join(alts))
    forbid = item.get("forbid") or []
    cites_text = " ".join(f"{c.get('title') or ''} {c.get('quote') or ''}" for c in result.get("citations") or [])
    for f in forbid:
        if has(answer, f) or (item.get("leak") and has(cites_text, f)):
            fails.append("forbidden in answer: " + f)
    leak = False
    if item.get("leak"):
        for p in result.get("prompts") or []:
            for f in forbid:
                if has(p, f):
                    leak = True
                    fails.append("LEAK in prompt: " + f)
                    break
    if item.get("notfound") and not NOT_FOUND.search(answer):
        fails.append("should say not found")
    if item.get("english") and not english(answer):
        fails.append("not in English")
    if item.get("cite"):
        titles = [norm(c.get("title")) + " " + norm(c.get("subtitle")) for c in result.get("citations") or []]
        if not any(norm(t) in x for t in item["cite"] for x in titles):
            fails.append("no citation of: " + " | ".join(item["cite"]))
    halluc = 0
    lists = 0
    for prompt, raw in result.get("raws") or []:
        known = labels_known(prompt)
        used, n_lists = labels_used(raw)
        lists += n_lists
        halluc += sum(1 for lab in used if lab not in known)
    if halluc:
        fails.append(f"hallucinated citations: {halluc}")
    if result.get("error"):
        fails.append("error: " + str(result["error"])[:200])
    if not answer.strip() and not result.get("error"):
        fails.append("empty answer")
    return {"pass": not fails, "fails": fails, "halluc": halluc, "lists": lists, "leak": leak}
