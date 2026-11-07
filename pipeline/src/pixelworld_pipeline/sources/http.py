"""HTTP helpers: a descriptive User-Agent, retries, and range-read file objects."""

from __future__ import annotations

import io
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "pixelworld-pipeline/0.1 (+https://github.com/alexngai/pixelworld)"
REPO = Path(__file__).resolve().parents[4]
CACHE_ROOT = REPO / "pipeline" / ".cache"


def get(
    url: str, headers: dict[str, str] | None = None, timeout: float = 120, tries: int = 4
) -> bytes:
    """GET with a project User-Agent and exponential backoff on transient errors."""
    h = {"User-Agent": USER_AGENT, **(headers or {})}
    delay = 2.0
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=h), timeout=timeout
            ) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            code = getattr(e, "code", None)
            if code is not None and code < 500 and code != 429:
                raise
            if attempt == tries - 1:
                raise
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


class HttpRangeFile(io.RawIOBase):
    """Seekable, read-only file over HTTP range requests (for Parquet footers/row groups)."""

    def __init__(self, url: str, size: int):
        self.url = url
        self.size = size
        self.pos = 0
        self.bytes_fetched = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            self.pos = offset
        elif whence == 1:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        data = get(self.url, {"Range": f"bytes={self.pos}-{self.pos + n - 1}"})
        self.pos += len(data)
        self.bytes_fetched += len(data)
        return data

    def readinto(self, b) -> int:  # type: ignore[override]
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)
