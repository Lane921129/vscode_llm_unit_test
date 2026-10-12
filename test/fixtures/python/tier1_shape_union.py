"""Both declared scalar alternatives must supply successful observations."""
from typing import Union


def render_choice(value: Union[int, str]) -> str:
    return str(value) + '!'
