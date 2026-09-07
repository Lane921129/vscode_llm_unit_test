from .helper import normalize


def format_label(value: str) -> str:
    return f'label:{normalize(value)}'
