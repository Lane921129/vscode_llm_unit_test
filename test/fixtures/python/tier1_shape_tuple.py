"""Source-guided fixed tuple with two different element types."""


def combine_pair(pair: tuple[int, str]) -> int:
    return pair[0] + len(pair[1]) + 1
