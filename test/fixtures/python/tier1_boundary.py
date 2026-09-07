def clamp(value: int) -> int:
    if value < 0:
        return 0
    if value > 100:
        return 100
    return value
