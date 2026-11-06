"""Room for thinking, and what happens when an answer still runs out of it.

Claude Haiku 5.5 thinks before it answers, even at effort "low", and its thinking counts against
``max_tokens`` (platform docs, "Prompting Claude Haiku 5.5 › Use effort to control thinking":
"Thinking is on by default and counts toward max_tokens … A max_tokens value sized for Claude
Haiku 4.5 requests that ran without thinking can cut the reply off, so leave room for thinking").
A cap sized for the visible answer alone (600, 900, 1200 tokens) can be spent on thinking: the
reply comes back empty, or cut off mid-sentence, with ``stop_reason == "max_tokens"``.

So, everywhere Markdrop calls the model:

* **Headroom.** ``max_tokens`` is a ceiling with room for thinking plus the answer (at least
  :data:`MIN_ANSWER_CAP` for anything a person reads); the prompts still bound how long the visible
  answer is, so the cost of a normal answer doesn't change.
* **Thinking off where it buys nothing.** Tiny classification calls (search-term expansion, a
  cover pick) send :data:`NO_THINKING` (``thinking: {"type": "disabled"}``, accepted by Haiku 5.5
  at effort low, medium and high; a 400 at xhigh and max). Only where the model is fixed to Haiku 5.5.
* **Never an empty answer.** When a call still stops at ``max_tokens``: retry once with a higher
  cap (:func:`retry_cap`) where nothing was shown yet or the output must be whole (JSON, a
  rewrite); otherwise keep the partial text and say it was cut short (:func:`finish`).

Every attempt is metered on the request's own meter, so usage and cost are recorded as before
and the spend caps (checked before the request) still apply.
"""

from __future__ import annotations

MAX_TOKENS = "max_tokens"

# The smallest cap for an answer a person reads (thinking plus the answer).
MIN_ANSWER_CAP = 2500
# A retry's cap: twice the first, at least this, at most RETRY_CEILING (streamed calls) or
# RETRY_CEILING_SYNC (a non-streamed messages.create, which must finish within the HTTP timeout).
RETRY_FLOOR = 4000
RETRY_CEILING = 16000
RETRY_CEILING_SYNC = 8000

# Haiku 5.5 only (other models may reject it): thinking off for a tiny classification call.
NO_THINKING = {"type": "disabled"}

# Plain text: some answer views render only bold, code and citations (AI search), not italics.
CUT_NOTE = "(Cut short: the answer hit its length limit. Ask a narrower question for the rest.)"
CUT_EMPTY = "The answer was cut short before it started. Ask again, or ask something narrower."


def was_cut(stop: str | None) -> bool:
    return stop == MAX_TOKENS


def retry_cap(cap: int, *, sync: bool = False) -> int:
    """The cap for the one retry after ``cap`` ran out."""
    ceiling = RETRY_CEILING_SYNC if sync else RETRY_CEILING
    return max(cap, min(ceiling, max(RETRY_FLOOR, cap * 2)))


def finish(text: str | None, stop: str | None, *, empty: str = CUT_EMPTY, note: str = CUT_NOTE) -> str:
    """The answer to show: as it is when it finished; when it was cut short, the partial text and a
    note saying so, or ``empty`` when nothing visible came back. Never empty when cut."""
    body = (text or "").strip()
    if not was_cut(stop):
        return body
    if not body:
        return empty
    return f"{body}\n\n{note}" if note else body


# A citation list the model sometimes writes ("[2-s1, 2-s2]", "[1, 3]", "[M2-s4; M3]"): one bracket each, so
# every label is kept, linked and counted ("[2-s1][2-s2]"). Labels: 3, 3-s12, M2, M2-s14, s12, n3.
_LABEL = r"(?:M?\d{1,3}(?:-[sn]\d{1,5})?|[sn]\d{1,5})"
_CITE_LIST = __import__("re").compile(rf"\[\s*({_LABEL}(?:\s*[,;]\s*{_LABEL})+)\s*\]")


def split_cites(text: str | None) -> str:
    import re

    return _CITE_LIST.sub(lambda m: "".join(f"[{x.strip()}]" for x in re.split(r"[,;]", m.group(1))), text or "")
