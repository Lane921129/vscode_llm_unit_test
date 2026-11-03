"""Both the absent value and real container must execute successfully."""
from typing import Optional


def optional_width(values: Optional[list[int]]) -> int:
    if values is None:
        return -1
    return len(values)
