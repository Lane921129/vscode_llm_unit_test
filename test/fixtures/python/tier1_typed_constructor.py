class BytePrefix:
    def __init__(self, prefix):
        self.prefix = prefix

    def join(self, parts):
        return self.prefix + parts[0]


def examples():
    return BytePrefix(b'A').join((b'Z',)), BytePrefix(b'B').join((b'Z',))
