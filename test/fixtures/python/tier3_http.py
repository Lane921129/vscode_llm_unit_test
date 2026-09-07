import httpx as transport


def fetch_status(url: str) -> int:
    response = transport.get(url)
    return response.status_code
