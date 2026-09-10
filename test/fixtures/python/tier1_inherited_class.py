class PrefixBase:
    DEFAULT_PREFIX = 'item'

    def __init__(self, prefix: str):
        self.prefix = prefix


class InheritedLabeler(PrefixBase):
    def render(self, value: str) -> str:
        return f'{self.prefix}:{value}'


def render_example() -> str:
    return InheritedLabeler('label').render('value')
