def read_first_line(path: str) -> str:
    with open(path, encoding='utf-8') as handle:
        return handle.readline().strip()
