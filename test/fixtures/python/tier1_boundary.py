def clamp(value: int) -> str:
    if value < 0:
        return 'below'
    if value > 100:
        return 'above'
    return 'inside'
