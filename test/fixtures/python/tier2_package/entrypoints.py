from .consumer import format_label


def render_primary() -> str:
    return format_label('  Alpha  ')


def render_secondary() -> str:
    return format_label('Beta')
