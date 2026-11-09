"""HTTP client for a paired forecast engine."""

from typing import Any

from aiohttp import ClientError, ClientSession, ClientTimeout
from yarl import URL


class EngineError(Exception):
    """Engine request failed."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def normalize_url(value: str) -> str:
    try:
        url = URL(value.strip())
        valid = (
            url.scheme in {"http", "https"}
            and url.host
            and url.port
            and not url.user
            and not url.password
            and not url.query
            and not url.fragment
        )
    except ValueError as error:
        raise EngineError("Enter a valid HTTP or HTTPS engine URL") from error
    if not valid:
        raise EngineError("Enter a valid HTTP or HTTPS engine URL")
    return str(url).rstrip("/")


class Engine:
    def __init__(self, session: ClientSession, url: str, token: str):
        self.session = session
        self.url = url
        self.token = token

    async def request(self, method: str, path: str, payload: dict | None = None) -> Any:
        try:
            async with self.session.request(
                method,
                self.url + "/v1" + path,
                headers={"Authorization": f"Bearer {self.token}"},
                json=payload,
                timeout=ClientTimeout(total=18),
                allow_redirects=False,
            ) as response:
                if response.status == 401:
                    raise EngineError("The engine rejected its pairing token", 401)
                if response.status >= 400:
                    message = await response.json(content_type=None)
                    detail = message.get("detail") if isinstance(message, dict) else None
                    raise EngineError(
                        detail
                        if isinstance(detail, str)
                        else f"Engine request failed ({response.status})",
                        response.status,
                    )
                return await response.json()
        except (ClientError, OSError, TimeoutError, ValueError) as error:
            raise EngineError("Could not reach the Local Forecast engine") from error

    async def health(self) -> dict:
        result = await self.request("GET", "/health")
        if (
            not isinstance(result, dict)
            or result.get("api") != 1
            or not isinstance(result.get("id"), str)
        ):
            raise EngineError("This engine does not support API v1")
        return result
