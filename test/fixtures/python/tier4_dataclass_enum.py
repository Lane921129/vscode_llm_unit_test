from dataclasses import dataclass
from enum import Enum


class State(Enum):
    READY = 'ready'
    PAUSED = 'paused'


@dataclass
class Item:
    state: State
    count: int


def describe(item: Item) -> dict:
    return {'state': item.state.value, 'count': item.count}
