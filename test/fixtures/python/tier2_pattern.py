def classify(value: str) -> str:
    match value:
        case 'new':
            return 'pending'
        case 'done' | 'closed':
            return 'complete'
        case _:
            return 'unknown'
