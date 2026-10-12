"""Source-guided pairs exercise each side of a direct parameter relation."""


def ordered_span(low: int, high: int) -> int:
    if low < high:
        return high - low + 1
    return 0
