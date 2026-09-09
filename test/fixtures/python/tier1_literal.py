from typing import Literal


def decorate(stage: Literal['draft', 'published']) -> str:
    return '[' + stage + ']'
