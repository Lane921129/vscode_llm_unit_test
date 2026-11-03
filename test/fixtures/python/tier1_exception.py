def require_value(value: str) -> str:
    if not value:
        # This corpus case covers exception type and branch behavior. Message
        # mutation survivors are exercised separately in tier1Integration.
        raise ValueError()
    return value.strip()
