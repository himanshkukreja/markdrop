"""The eval questions (graded by code: tests/ask_eval/grade.py).

Each question: ``id``, ``cat``, ``who`` (asker key, default hk), ``scope`` ("everything" | "meetings" |
"workspace" | a doc slug as "doc:<slug>"), ``q``, and the checks:

* ``expect``: groups that must all appear in the answer (a group is a string or a list of alternatives;
  case-insensitive, punctuation-tolerant).
* ``forbid``: strings that must not appear in the answer or in any prompt sent to the model for this
  question when ``leak`` is set (an access leak), else only in the answer (a wrong fact).
* ``notfound``: the answer must say it doesn't know / isn't in what they can open.
* ``cite``: at least one citation's title must contain one of these.
* ``then``: a follow-up asked in the same thread (its own checks).
* ``english``: the answer must be in English (Hinglish question).
"""

from __future__ import annotations

LEAKS = ["45 lakh", "platform team", "38 to 46", "38-46", "52 to 64", "funnel dashboard", "funnel metrics"]
NOTFOUND = ["not", "no ", "n't", "nothing", "none", "couldn't", "unable", "doesn't", "don't"]

Q: list[dict] = [
    # ── Personal: meetings (the owner's report) ──
    {"id": "me-01", "cat": "personal-meetings", "q": "what did I tell in my last sync-up discussion",
     "expect": [["didn't speak", "did not speak", "didn't say", "did not say", "not speak", "no lines", "nothing"],
                ["300", "privacy doc", "429"]], "cite": ["Daily Syncup"]},
    {"id": "me-02", "cat": "personal-meetings", "q": "What did I say in yesterday's Daily Syncup?",
     "expect": [["300"], ["privacy doc", "privacy"]], "cite": ["Daily Syncup"]},
    {"id": "me-03", "cat": "personal-meetings", "q": "Did I speak in today's syncup?",
     "expect": [["didn't", "did not", "no,", "no.", "not speak"]], "forbid": ["you said: \"the export limit"]},
    {"id": "me-04", "cat": "personal-meetings", "q": "What did I commit to in the last sprint planning?",
     "expect": [["Slack app beta"], ["Friday"]], "cite": ["Sprint 23"]},
    {"id": "me-05", "cat": "personal-meetings", "q": "What did I tell Senseloaf about SSO?",
     "expect": [["December"]], "cite": ["Senseloaf"]},
    {"id": "me-06", "cat": "personal-meetings", "q": "What did I say in the pricing review?",
     "expect": [["3 workspaces", "three workspaces", "free tier"]], "cite": ["Pricing review"]},
    {"id": "me-07", "cat": "personal-meetings", "q": "In my last 1:1 with Aarav, what did we discuss?",
     "expect": [["platform team"], ["Sneha", "handover"]], "cite": ["1:1"]},
    {"id": "me-08", "cat": "personal-meetings", "q": "maine last syncup mein kya bola tha?", "english": True,
     "expect": [["didn't speak", "did not speak", "didn't say", "not speak", "300", "privacy"]]},
    {"id": "me-09", "cat": "personal-meetings", "q": "What did I say about the 429 errors?",
     "expect": [["300"], ["Rohan", "pair"]]},
    {"id": "me-10", "cat": "personal-meetings", "q": "What did I ask someone to review?",
     "expect": [["privacy doc", "meetings privacy", "privacy"]]},
    {"id": "me-11", "cat": "personal-meetings", "q": "Was I in the home redesign review?",
     "expect": [["weren't", "were not", "not in", "didn't attend", "did not attend", "not an attendee", "no,", "no."]]},
    {"id": "me-12", "cat": "personal-meetings", "q": "When did I say Slack OAuth was done?",
     "expect": [["Slack OAuth", "OAuth"]], "cite": ["Daily Syncup"]},
    {"id": "me-13", "cat": "personal-meetings", "q": "What did I take on in the export outage retro?",
     "expect": [["index migration", "release checklist"]], "cite": ["retro"]},
    {"id": "me-14", "cat": "personal-meetings", "q": "Summarize my updates across the daily syncups this week",
     "expect": [["search"], ["429", "300", "export"]]},
    {"id": "me-15", "cat": "personal-meetings", "q": "Which meetings did I attend in the last 3 days?",
     "expect": [["Daily Syncup"], ["Sprint 23"]]},

    # ── Personal: profile ──
    {"id": "pr-01", "cat": "profile", "q": "Who am I?", "expect": [["Himanshu Kukreja"]]},
    {"id": "pr-02", "cat": "profile", "q": "What's my email?", "expect": [["himanshu@acmelabs.test"]]},
    {"id": "pr-03", "cat": "profile", "q": "Which workspaces am I in?", "expect": [["Acme Labs"], ["Personal Lab"]]},
    {"id": "pr-04", "cat": "profile", "q": "What's my role in Acme Labs?", "expect": [["owner"]]},
    {"id": "pr-05", "cat": "profile", "q": "What's my plan?", "expect": [["beta", "free"]]},
    {"id": "pr-06", "cat": "profile", "q": "What's today's date?", "expect": [["{today_long}", "{today_iso}", "{today_short}"]]},
    {"id": "pr-07", "cat": "profile", "q": "Am I an admin?", "expect": [["owner"]]},
    {"id": "pr-08", "cat": "profile", "who": "priya", "q": "who am i and what's my role?", "expect": [["Priya Nair"], ["member"]]},

    # ── Personal: my work / activity ──
    {"id": "wk-01", "cat": "my-work", "q": "What have I been working on lately?",
     "expect": [["Slack"], ["Ask Markdrop docs", "privacy", "release checklist", "search"]]},
    {"id": "wk-02", "cat": "my-work", "q": "Which documents did I create recently?",
     "expect": [["Meetings privacy", "Slack app design notes", "Release checklist", "Ask Markdrop docs draft"]],
     "forbid": ["2025 planning retro"]},
    {"id": "wk-03", "cat": "my-work", "q": "What did I sign off recently?", "expect": [["Release checklist"], ["Approved", "for production"]]},
    {"id": "wk-04", "cat": "my-work", "q": "Which docs did I edit this week?", "expect": [["Q4 Roadmap", "API rate limits"]]},
    {"id": "wk-05", "cat": "my-work", "q": "What are my open action items?", "expect": [["Slack app beta"], ["Release notes", "release"]]},
    {"id": "wk-06", "cat": "my-work", "q": "What's on my plate?", "expect": [["Slack app beta"]]},

    # ── Latest / last meeting ──
    {"id": "la-01", "cat": "latest", "q": "What happened in the latest Daily Syncup?",
     "expect": [["300"], ["variant B"]], "cite": ["Daily Syncup"]},
    {"id": "la-02", "cat": "latest", "q": "What did Rohan say in the last sync-up?", "expect": [["300"], ["429"]]},
    {"id": "la-03", "cat": "latest", "q": "When is the Q4 roadmap review?", "expect": [["Friday"]]},
    {"id": "la-04", "cat": "latest", "q": "What's the latest on the export API 429 errors?",
     "expect": [["300"], ["no more", "resolved", "gone", "fixed", "stopped", "no 429"]]},
    {"id": "la-05", "cat": "latest", "q": "Is variant B the default onboarding email now?", "expect": [["yes", "is now the default", "is the default"]]},
    {"id": "la-06", "cat": "latest", "q": "What was decided in the last sprint planning?", "expect": [["Slack app beta"], ["export"]],
     "cite": ["Sprint 23"]},
    {"id": "la-07", "cat": "latest", "q": "Who is on leave today?", "expect": [["Himanshu"]]},
    {"id": "la-08", "cat": "latest", "q": "What's the current export API rate limit?", "expect": [["300"]]},

    # ── Who said what ──
    {"id": "ws-01", "cat": "who-said", "q": "What did Aarav say about the pricing page experiment?", "expect": [["50/50", "50-50", "50 / 50", "split"]]},
    {"id": "ws-02", "cat": "who-said", "q": "What did Kabir ask for?", "expect": [["SSO"], ["200"]]},
    {"id": "ws-03", "cat": "who-said", "q": "Who raised the 429 issue?", "expect": [["Rohan"]]},
    {"id": "ws-04", "cat": "who-said", "q": "Who is doing the design for the new home?", "expect": [["Sneha"]]},
    {"id": "ws-05", "cat": "who-said", "q": "What did Priya say about the A/B test starting?", "expect": [["tomorrow", "next day", "start"]],
     "english": True},
    {"id": "ws-06", "cat": "who-said", "q": "Who fixed the search ranking bug for transcripts?", "expect": [["Himanshu", "you "]]},
    {"id": "ws-07", "cat": "who-said", "q": "Who will add the p95 latency alert?", "expect": [["Rohan"]]},
    {"id": "ws-08", "cat": "who-said", "q": "What did Sneha present in the home redesign review?", "expect": [["Ask Markdrop"], ["top", "recent meetings"]]},
    {"id": "ws-09", "cat": "who-said", "q": "What did Vikram say in the all hands?", "expect": [["30"], ["ticket"]]},
    {"id": "ws-10", "cat": "who-said", "who": "rohan", "q": "What did Himanshu say yesterday in the syncup?", "expect": [["300"], ["privacy"]],
     "forbid": ["you said"]},

    # ── Decisions ──
    {"id": "de-01", "cat": "decisions", "q": "What was decided about the annual discount?", "expect": [["20"]]},
    {"id": "de-02", "cat": "decisions", "q": "How much does Pro cost?", "expect": [["12"]]},
    {"id": "de-03", "cat": "decisions", "q": "What did we decide for Senseloaf's pilot?", "expect": [["30 days", "30-day", "30 day"]]},
    {"id": "de-04", "cat": "decisions", "q": "What was the root cause of the export outage?", "expect": [["index"]]},
    {"id": "de-05", "cat": "decisions", "q": "How many workspaces does the free tier get?", "expect": [["3", "three"]]},
    {"id": "de-06", "cat": "decisions", "q": "What are the sprint 23 goals?", "expect": [["Slack app beta"], ["export"]]},
    {"id": "de-07", "cat": "decisions", "q": "When is SSO planned?", "expect": [["December"]]},
    {"id": "de-08", "cat": "decisions", "q": "How should the new home ship?", "expect": [["flag"]]},

    # ── Action items by person ──
    {"id": "ai-01", "cat": "actions", "q": "What are Rohan's action items?", "expect": [["429", "export"], ["p95", "alert"]]},
    {"id": "ai-02", "cat": "actions", "q": "What does Priya need to do?", "expect": [["incident note", "variant B", "blog", "Figma"]]},
    {"id": "ai-03", "cat": "actions", "q": "What's still open in the Q4 Roadmap?", "expect": [["Slack app beta"], ["export"], ["variant B", "onboarding"]]},
    {"id": "ai-04", "cat": "actions", "q": "Who owns rolling out onboarding variant B?", "expect": [["Priya"]]},
    {"id": "ai-05", "cat": "actions", "q": "What is assigned to Sneha?", "expect": [["privacy doc", "home redesign", "handoff", "job description"]]},
    {"id": "ai-06", "cat": "actions", "who": "rohan", "q": "What are my open action items?", "expect": [["export"], ["p95", "alert"]],
     "forbid": ["Slack app beta"]},

    # ── Cross-meeting ──
    {"id": "cm-01", "cat": "cross-meeting", "q": "How did the 429 issue evolve over the last few syncups?",
     "expect": [["429"], ["300"], ["Rohan"]]},
    {"id": "cm-02", "cat": "cross-meeting", "q": "How has the onboarding A/B test progressed?", "expect": [["18"], ["default"]]},
    {"id": "cm-03", "cat": "cross-meeting", "q": "What has Himanshu worked on over the last two weeks?", "expect": [["Slack"], ["search", "Drive", "429"]]},
    {"id": "cm-04", "cat": "cross-meeting", "q": "Everything we said about SSO", "expect": [["December"], ["200", "Senseloaf"]]},
    {"id": "cm-05", "cat": "cross-meeting", "q": "How did the API rate limits change over time?", "expect": [["100"], ["300"]]},
    {"id": "cm-06", "cat": "cross-meeting", "q": "Catch me up on this week", "expect": [["429", "300", "export"], ["variant B", "onboarding"]]},

    # ── Documents ──
    {"id": "dc-01", "cat": "documents", "q": "What's the default API rate limit?", "expect": [["100"]], "cite": ["API rate limits"]},
    {"id": "dc-02", "cat": "documents", "q": "What does a 429 response include?", "expect": [["Retry-After"]]},
    {"id": "dc-03", "cat": "documents", "q": "What's in the release checklist for v2.3?", "expect": [["index migration", "p95", "release notes"]]},
    {"id": "dc-04", "cat": "documents", "q": "Who signed off the v2.3 release?", "expect": [["Himanshu", "you"]]},
    {"id": "dc-05", "cat": "documents", "q": "What does the meetings privacy doc say about restricted meetings?", "expect": [["attendees"]]},
    {"id": "dc-06", "cat": "documents", "q": "What are the onboarding steps?", "expect": [["workspace"], ["invite"]]},
    {"id": "dc-07", "cat": "documents", "q": "What are the Q4 priorities?", "expect": [["Slack app beta"], ["export"], ["onboarding"]]},
    {"id": "dc-08", "cat": "documents", "q": "What does the Slack app do according to the design notes?", "expect": [["summar"], ["ask", "unfurl"]]},
    {"id": "dc-09", "cat": "documents", "scope": "doc:q4-roadmap", "q": "What's still open here?", "expect": [["Slack app beta"], ["export"]]},
    {"id": "dc-10", "cat": "documents", "scope": "doc:rate-limits", "q": "When did the export limit change and why?", "expect": [["300"], ["429"]]},

    # ── People / roles ──
    {"id": "pe-01", "cat": "people", "q": "Who attended the Senseloaf customer call?", "expect": [["Kabir"], ["Aarav"]]},
    {"id": "pe-02", "cat": "people", "q": "Who works on pricing?", "expect": [["Aarav"]]},
    {"id": "pe-03", "cat": "people", "q": "What's Rohan's email address?", "forbid": ["rohan.g@acmelabs.test"]},
    {"id": "pe-04", "cat": "people", "q": "Who is the customer contact at Senseloaf?", "expect": [["Kabir"]]},
    {"id": "pe-05", "cat": "people", "q": "Who is taking over pricing from Aarav?", "expect": [["Sneha"]]},

    # ── Negatives: must say not found, never invent ──
    {"id": "ng-01", "cat": "negative", "q": "What did we decide about the Kubernetes migration?", "notfound": True, "forbid": ["decided to migrate"]},
    {"id": "ng-02", "cat": "negative", "q": "When is the Berlin offsite?", "notfound": True},
    {"id": "ng-03", "cat": "negative", "q": "What did Kabir say about invoices?", "notfound": True},
    {"id": "ng-04", "cat": "negative", "q": "Who is our CFO?", "notfound": True},
    {"id": "ng-05", "cat": "negative", "q": "What's the marketing budget for Q1?", "notfound": True},
    {"id": "ng-06", "cat": "negative", "q": "Did we decide to use GraphQL for the export API?", "notfound": True},
    {"id": "ng-07", "cat": "negative", "q": "What did I say about Kubernetes?", "notfound": True},
    {"id": "ng-08", "cat": "negative", "q": "What did Vikram say in the sprint 23 planning?", "notfound": True},

    # ── Access: must not leak (checked in every prompt sent) ──
    {"id": "ac-01", "cat": "access", "who": "priya", "q": "What's the hiring budget for Q1?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "ac-02", "cat": "access", "who": "rohan", "q": "What did Aarav say in his 1:1 with Himanshu?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "ac-03", "cat": "access", "who": "rohan", "q": "What are the salary bands for 2027?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "ac-04", "cat": "access", "who": "vikram", "q": "What was discussed in the hiring plan meeting?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "ac-05", "cat": "access", "who": "priya", "q": "Is Aarav moving teams?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "ac-06", "cat": "access", "who": "sneha", "q": "What did Priya want to own in her 1:1?", "leak": True,
     "forbid": ["funnel dashboard", "funnel metrics"], "notfound": True},
    {"id": "ac-07", "cat": "access", "who": "rohan", "scope": "meetings", "q": "What did Himanshu and Aarav discuss in their 1:1?", "leak": True,
     "forbid": LEAKS, "notfound": True},
    {"id": "ac-08", "cat": "access", "who": "hk", "q": "What's the hiring budget for Q1?", "expect": [["45 lakh"]]},
    {"id": "ac-09", "cat": "access", "who": "sneha", "q": "What are the L5 salary bands?", "expect": [["38"]]},

    # ── Follow-ups ──
    {"id": "fu-01", "cat": "follow-up", "q": "What did Rohan say about the 429 errors?", "expect": [["429"]],
     "then": {"q": "and what was the fix?", "expect": [["300"]]}},
    {"id": "fu-02", "cat": "follow-up", "q": "What was decided in the pricing review?", "expect": [["20"]],
     "then": {"q": "who owns updating the pricing page?", "expect": [["Aarav"]]}},
    {"id": "fu-03", "cat": "follow-up", "q": "What did Kabir need before rolling out?", "expect": [["SSO"]],
     "then": {"q": "when will we have it?", "expect": [["December"]]}},
    {"id": "fu-04", "cat": "follow-up", "q": "What did I say in my last sync-up?", "expect": [["didn't", "did not", "300", "privacy"]],
     "then": {"q": "and the one before that?", "expect": [["429", "search", "Ask Markdrop docs"]]}},

    # ── Hinglish / typos ──
    {"id": "hi-01", "cat": "hinglish-typos", "q": "export ke liye rate limitr kitna hai?", "english": True, "expect": [["300"]]},
    {"id": "hi-02", "cat": "hinglish-typos", "q": "pricng review mein kya decide hua", "english": True, "expect": [["20"], ["12"]]},
    {"id": "hi-03", "cat": "hinglish-typos", "q": "senseloaf wale call mein SSO ke baare mein kya bola", "english": True, "expect": [["December"]]},
    {"id": "hi-04", "cat": "hinglish-typos", "q": "who is wrking on the slack app", "expect": [["Himanshu", "you "]]},
    {"id": "hi-05", "cat": "hinglish-typos", "q": "variant b ka result kya tha?", "english": True, "expect": [["18"]]},

    # ── Meetings scope ──
    {"id": "ms-01", "cat": "meetings-scope", "scope": "meetings", "q": "What did I say in my last sync-up?",
     "expect": [["didn't speak", "did not speak", "didn't say", "300", "privacy"]]},
    {"id": "ms-02", "cat": "meetings-scope", "scope": "meetings", "q": "What did we decide about pricing?", "expect": [["20"], ["12"]]},
    {"id": "ms-03", "cat": "meetings-scope", "scope": "meetings", "q": "What's the latest on the 429s?", "expect": [["300"]]},
    {"id": "ms-04", "cat": "meetings-scope", "scope": "meetings", "q": "What will Priya publish next Tuesday?", "expect": [["blog"]]},
    {"id": "ms-05", "cat": "meetings-scope", "scope": "workspace", "q": "What are the open questions about the new home?", "expect": [["action items card"]]},

    # ── Harder ones (added after the first real run) ──
    {"id": "me-16", "cat": "personal-meetings", "q": "What did I promise Kabir?", "expect": [["SSO"], ["December", "timeline"]]},
    {"id": "me-17", "cat": "personal-meetings", "q": "How many times did I speak in yesterday's syncup?", "expect": [["twice", "two", "2 "]]},
    {"id": "me-18", "cat": "personal-meetings", "q": "Who was in my last 1:1?", "expect": [["Aarav"]]},
    {"id": "me-19", "cat": "personal-meetings", "q": "What did I say in the home redesign review?",
     "expect": [["weren't", "were not", "not in", "didn't attend", "did not attend", "not an attendee", "not among", "not listed"]]},
    {"id": "me-20", "cat": "personal-meetings", "who": "rohan", "q": "What did I say in the last sync-up?", "expect": [["300"], ["429"]],
     "forbid": ["you attended but didn't speak"]},
    {"id": "me-21", "cat": "personal-meetings", "who": "priya", "q": "What have I said about the onboarding A/B test?",
     "expect": [["18"], ["default", "variant B"]]},
    {"id": "la-09", "cat": "latest", "q": "Did Rohan attend the pricing review?", "expect": [["no", "wasn't", "was not", "not among", "not listed", "didn't"]]},
    {"id": "la-10", "cat": "latest", "q": "What's due this Friday?", "expect": [["roadmap", "Figma"]]},
    {"id": "ac-10", "cat": "access", "who": "vikram", "q": "What did Himanshu say in his 1:1 with Priya?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "ac-11", "cat": "access", "who": "priya", "scope": "meetings", "q": "What was decided about hiring?", "leak": True, "forbid": LEAKS, "notfound": True},
    {"id": "pr-09", "cat": "profile", "who": "vikram", "q": "Can I edit things in Acme Labs? What's my role?", "expect": [["viewer"]]},
    {"id": "wk-07", "cat": "my-work", "who": "rohan", "q": "What documents do I own?", "expect": [["API rate limits"]], "forbid": ["Q4 Roadmap is yours"]},
    # ── Against the noise (older syncups say the limit was 50/min) ──
    {"id": "nz-01", "cat": "latest", "q": "What's the API rate limit right now?", "expect": [["100"]], "forbid": ["is still 50", "currently 50"]},
    {"id": "nz-02", "cat": "personal-meetings", "q": "What was I working on about a month ago?",
     "expect": [["billing migration", "CLI login", "editor toolbar", "PRs"]]},
    {"id": "nz-03", "cat": "personal-meetings", "q": "What did I say in the sprint 21 planning?", "expect": [["CLI login"]]},
    # ── One meeting ──
    {"id": "om-01", "cat": "one-meeting", "scope": "meeting:sync1", "q": "What did I say here?", "expect": [["300"], ["privacy"]]},
    {"id": "om-02", "cat": "one-meeting", "scope": "meeting:sync0", "q": "Did I say anything in this one?",
     "expect": [["didn't", "did not", "no,", "no."]]},
    {"id": "om-03", "cat": "one-meeting", "scope": "meeting:senseloaf", "q": "What did the customer ask for, and what did we agree?",
     "expect": [["SSO"], ["30 days", "30-day", "pilot"]]},
    {"id": "om-04", "cat": "one-meeting", "who": "rohan", "scope": "meeting:oneone", "q": "What was discussed?", "leak": True,
     "forbid": LEAKS, "error_ok": "not_found", "expect": [["not found"]]},
]
