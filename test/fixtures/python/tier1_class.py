class Labeler:
    def __init__(self, prefix: str):
        self.prefix = prefix

    def render(self, value: str) -> str:
        return f'{self.prefix}:{value}'


def render_example() -> str:
    return Labeler('label').render('value')
