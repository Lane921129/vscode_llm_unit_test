"""Length boundaries must remain list inputs instead of becoming scalars."""


def width_band(values: list[int]) -> int:
    if len(values) < 2:
        return 0
    return len(values)
