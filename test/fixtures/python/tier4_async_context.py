import aiohttp


async def read_payload(session: aiohttp.ClientSession, url: str) -> str:
    async with session.get(url) as response:
        return await response.text()
