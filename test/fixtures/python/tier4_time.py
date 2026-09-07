from datetime import datetime


def day_stamp() -> str:
    return datetime.now().strftime('%Y-%m-%d')
