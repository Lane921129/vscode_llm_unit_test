import sqlite3


def insert_value(connection: sqlite3.Connection, value: str) -> int:
    with connection:
        cursor = connection.execute('insert into entries(value) values (?)', (value,))
    return cursor.rowcount
