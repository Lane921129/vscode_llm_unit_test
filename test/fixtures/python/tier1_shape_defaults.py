"""An omitted argument is distinct from an explicitly supplied candidate."""


def format_default(value: int = 2, *, suffix: str = 'x') -> str:
    return str(value) + suffix
