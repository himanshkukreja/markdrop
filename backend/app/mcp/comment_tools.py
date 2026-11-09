"""MCP tools for comments (Track A; CONTRACT §12): list_comments, get_thread, add_comment, reply_comment,
resolve_comment, reopen_comment, assign_thread, react_comment, set_comment_settings."""

from __future__ import annotations

from app.mcp.tools import Tool

COMMENT_TOOLS: list[Tool] = []
