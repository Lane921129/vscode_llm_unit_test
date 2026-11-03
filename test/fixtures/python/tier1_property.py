class Temperature:
    def __init__(self, value: int = 0):
        self._value = value

    @property
    def value(self) -> int:
        return self._value

    @value.setter
    def value(self, new_value: int) -> None:
        self._value = new_value
