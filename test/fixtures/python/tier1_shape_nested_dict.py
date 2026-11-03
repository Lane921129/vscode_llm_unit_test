"""Source-guided nested container input without prescribed keys."""


def nested_width(groups: dict[str, list[int]]) -> int:
    return sum(len(values) for values in groups.values()) + 1
