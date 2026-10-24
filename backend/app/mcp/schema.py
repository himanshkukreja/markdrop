"""Validate tool arguments against the subset of JSON Schema the tools use.

Supported keywords: type (string, integer, number, boolean, object, array,
or a list of them), enum, minLength, maxLength, pattern, minimum, maximum,
required and properties. Properties the schema doesn't name are ignored rather
than refused: models add stray keys often enough that rejecting them would
only cost a retry.
"""

from __future__ import annotations

import re
from typing import Any

_TYPES = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "null": lambda v: v is None,
}


def validate(schema: dict, value: Any, path: str = "arguments") -> str | None:
    """The first problem with `value`, as a sentence, or None when it fits."""
    expected = schema.get("type")
    if expected is not None:
        kinds = expected if isinstance(expected, list) else [expected]
        if not any(_TYPES[k](value) for k in kinds):
            return f"{path} must be {' or '.join(kinds)}."
    if "enum" in schema and value not in schema["enum"]:
        options = ", ".join(f'"{o}"' for o in schema["enum"])
        return f"{path} must be one of {options}."
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            return f"{path} can't be empty." if schema["minLength"] == 1 else (
                f"{path} must be at least {schema['minLength']} characters."
            )
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            return f"{path} is too long (at most {schema['maxLength']:,} characters)."
        if "pattern" in schema and not re.search(schema["pattern"], value):
            return f"{path} has an invalid format."
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            return f"{path} must be at least {schema['minimum']}."
        if "maximum" in schema and value > schema["maximum"]:
            return f"{path} must be at most {schema['maximum']}."
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value or value[key] is None:
                return f"{key} is required."
        for key, sub in (schema.get("properties") or {}).items():
            if key in value and value[key] is not None:
                problem = validate(sub, value[key], key)
                if problem:
                    return problem
    return None
