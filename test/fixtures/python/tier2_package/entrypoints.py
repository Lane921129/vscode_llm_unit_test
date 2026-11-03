from .consumer import format_label
from . import consumer


def render_primary() -> str:
    return format_label('  Alpha  ')


def render_secondary() -> str:
    return format_label('Beta')


def render_module_reference() -> str:
    return consumer.format_label('Gamma')
