def require_value(value: str) -> str:
    if not value:
        raise ValueError('value is required')
    return value.strip()
