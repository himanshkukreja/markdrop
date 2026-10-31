"""Starting content for a new docs site: blank, or one of three small templates.

Pages are Markdown in the engine's directive format (callouts, steps, cards,
tabs: see frontend/content/docs). Each template is a list of groups, and each
group lists its pages in order; the home page ("/") is outside the sidebar.
"""

from __future__ import annotations

TEMPLATES = ("product", "api", "helpcenter")

HOME_BLANK = {
    "path": "/",
    "title": "Welcome",
    "description": "Start here.",
    "markdown": (
        "This is the home page of your new guide. Edit it, add pages in the sidebar, and choose\n"
        "**Publish** when you're ready. Nothing is public until you publish.\n"
    ),
}

_PRODUCT = {
    "home": {
        "path": "/",
        "title": "Product guide",
        "description": "Everything you need to get started and get the most out of the product.",
        "markdown": (
            "Welcome. This guide explains how to set the product up, use it every day, and fix things\n"
            "when they go wrong.\n\n"
            "::::cards\n"
            ":::card[Quickstart]{href=\"/getting-started/quickstart\" icon=\"zap\"}\n"
            "Set up and see your first result in five minutes.\n"
            ":::\n"
            ":::card[Guides]{href=\"/guides/basics\" icon=\"doc\"}\n"
            "Step-by-step guides for everyday tasks.\n"
            ":::\n"
            ":::card[FAQ]{href=\"/help/faq\" icon=\"info\"}\n"
            "Answers to the questions people ask most.\n"
            ":::\n"
            "::::\n"
        ),
    },
    "groups": [
        ("Getting started", [
            {"path": "/getting-started/introduction", "title": "Introduction",
             "description": "What the product does and who it's for.",
             "markdown": (
                 "Describe the product in two or three sentences: the problem it solves, and for whom.\n\n"
                 "## Key ideas\n\n"
                 "- **First idea.** One sentence about it.\n"
                 "- **Second idea.** One sentence about it.\n"
             )},
            {"path": "/getting-started/quickstart", "title": "Quickstart",
             "description": "Set up and see your first result in five minutes.",
             "markdown": (
                 "::::steps\n"
                 "### Create an account\n"
                 "Sign up and confirm your email address.\n\n"
                 "### Connect your data\n"
                 "Choose **Settings › Connections** and add your first source.\n\n"
                 "### See the result\n"
                 "Open the dashboard. Your data appears within a minute.\n"
                 "::::\n\n"
                 ":::tip\n"
                 "Stuck? See the [FAQ](/help/faq).\n"
                 ":::\n"
             )},
        ]),
        ("Guides", [
            {"path": "/guides/basics", "title": "The basics",
             "description": "The everyday tasks, one at a time.",
             "markdown": (
                 "## Do the first thing\n\n"
                 "Explain the task in a few steps.\n\n"
                 ":::note\n"
                 "Callouts like this one highlight something readers shouldn't miss.\n"
                 ":::\n"
             )},
        ]),
        ("Help", [
            {"path": "/help/faq", "title": "FAQ",
             "description": "Answers to the questions people ask most.",
             "markdown": (
                 ":::details[How much does it cost?]\n"
                 "Explain your pricing, or link to it.\n"
                 ":::\n\n"
                 ":::details[How do I get help?]\n"
                 "Tell readers how to reach you.\n"
                 ":::\n"
             )},
            {"path": "/help/release-notes", "title": "Release notes",
             "description": "What changed, newest first.",
             "markdown": (
                 "## Version 1.0\n\n"
                 "- First release.\n"
             )},
        ]),
    ],
}

# The API reference template: written pages for the parts an OpenAPI file doesn't say (getting a
# key, errors), and the endpoint pages generated from a sample description (Northwind,
# app/assets/northwind-openapi.json, stored when the guide is created: services/docs_api_spec.py
# seed_sample) under /api-reference. Replace it in Settings › API reference.
_API = {
    "home": {
        "path": "/",
        "title": "API reference",
        "description": "Build on the API: authentication, errors and every endpoint.",
        "markdown": (
            "The API is organised around REST. It accepts JSON request bodies, returns JSON, and uses\n"
            "standard HTTP status codes.\n\n"
            "::::cards\n"
            ":::card[Endpoints]{href=\"/api-reference\" icon=\"code\"}\n"
            "Every endpoint, with parameters, responses, code samples and Try it.\n"
            ":::\n"
            ":::card[Authentication]{href=\"/api/authentication\" icon=\"lock\"}\n"
            "Create a key and send it with every request.\n"
            ":::\n"
            ":::card[Errors]{href=\"/api/errors\" icon=\"alert\"}\n"
            "What each status code means and what to do.\n"
            ":::\n"
            "::::\n"
        ),
    },
    "groups": [
        ("Overview", [
            {"path": "/api/authentication", "title": "Authentication",
             "description": "Create an API key and send it as a Bearer token.",
             "markdown": (
                 "Send your token in the `Authorization` header of every request.\n\n"
                 "::::tabs{sync=\"lang\"}\n"
                 ":::tab[curl]\n"
                 "```bash\n"
                 "curl https://api.northwind.example/v1/orders \\\n"
                 "  -H \"Authorization: Bearer $API_TOKEN\"\n"
                 "```\n"
                 ":::\n"
                 ":::tab[JavaScript]\n"
                 "```js\n"
                 "const res = await fetch(\"https://api.northwind.example/v1/orders\", {\n"
                 "  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },\n"
                 "});\n"
                 "```\n"
                 ":::\n"
                 "::::\n\n"
                 ":::warning\n"
                 "Keep tokens secret. Never put them in code that runs in a browser.\n"
                 ":::\n\n"
                 "Every endpoint is in the [API reference](/api-reference).\n"
             )},
            {"path": "/api/errors", "title": "Errors",
             "description": "Status codes and the error body.",
             "markdown": (
                 "| Status | Meaning |\n"
                 "| --- | --- |\n"
                 "| 400 | The request is malformed. |\n"
                 "| 401 | The token is missing or wrong. |\n"
                 "| 404 | The resource doesn't exist. |\n"
                 "| 429 | Too many requests. Wait and retry. |\n"
             )},
        ]),
    ],
}

_HELPCENTER = {
    "home": {
        "path": "/",
        "title": "Help center",
        "description": "Search for an answer, or browse by topic.",
        "markdown": (
            "How can we help? Search above, or pick a topic.\n\n"
            "::::cards\n"
            ":::card[Account and billing]{href=\"/account/change-email\" icon=\"user\"}\n"
            "Sign-in, email, invoices and plans.\n"
            ":::\n"
            ":::card[Troubleshooting]{href=\"/troubleshooting/cant-sign-in\" icon=\"info\"}\n"
            "Fixes for the most common problems.\n"
            ":::\n"
            "::::\n"
        ),
    },
    "groups": [
        ("Account and billing", [
            {"path": "/account/change-email", "title": "Change your email address",
             "description": "Update the address you sign in with.",
             "markdown": (
                 "::::steps\n"
                 "### Open your settings\n"
                 "Choose your name in the top corner, then **Settings**.\n\n"
                 "### Edit your email\n"
                 "Type the new address and choose **Save**. We send a confirmation link to it.\n"
                 "::::\n"
             )},
            {"path": "/account/invoices", "title": "Download an invoice",
             "description": "Find past invoices and receipts.",
             "markdown": "Go to **Settings › Billing** and choose **Download** next to the invoice.\n"},
        ]),
        ("Troubleshooting", [
            {"path": "/troubleshooting/cant-sign-in", "title": "I can't sign in",
             "description": "What to check when signing in fails.",
             "markdown": (
                 "- Check that you're using the address you signed up with.\n"
                 "- Look in your spam folder for the sign-in email.\n\n"
                 ":::note\n"
                 "Still stuck? Contact support and tell us what you tried.\n"
                 ":::\n"
             )},
        ]),
    ],
}

_BY_ID = {"product": _PRODUCT, "api": _API, "helpcenter": _HELPCENTER}
PRESET_FOR = {"product": "clean", "api": "technical", "helpcenter": "helpcenter"}


def pages_for(template: str | None) -> tuple[dict, list[tuple[str, list[dict]]]]:
    """(home page, [(group name, [page, …]), …]) for a template; blank for None."""
    if template is None:
        return dict(HOME_BLANK), []
    t = _BY_ID[template]
    return dict(t["home"]), [(name, [dict(p) for p in pages]) for name, pages in t["groups"]]
