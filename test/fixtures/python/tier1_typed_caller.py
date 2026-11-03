def combine(data):
    return data[(1, 2)][0] + len(data[3])


def examples():
    return combine({(1, 2): (4,), 3: b'\x00A'}), combine({(1, 2): (7,), 3: b'XYZ'})
