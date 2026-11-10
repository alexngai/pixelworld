"""Build progress on stderr: a line per stage as it starts, with the time so
far, and the stages' own notes indented under it. stdout stays free for the
report (`pixelworld build --json`).

    [   0.0 s] terrain: elevation and land cover
    [   1.9 s] roads and rivers
               snap: 502/730 road edges made octilinear, nodes moved p99 1.78 cells

The stage functions call `stage()` and `log()`; `run()` times a whole build.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

INDENT = " " * 11


class Stages:
    """The stages of one build and how long each took."""

    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.times: dict[str, float] = {}
        self.current: str | None = None
        self._started = self.t0

    def start(self, name: str, detail: str = "") -> None:
        self.end()
        self.current, self._started = name, time.monotonic()
        _write(f"[{self._started - self.t0:6.1f} s] {name}{': ' + detail if detail else ''}")

    def end(self) -> None:
        if self.current is not None:
            took = time.monotonic() - self._started
            self.times[self.current] = self.times.get(self.current, 0.0) + took
            self.current = None

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.t0

    def summary(self) -> str:
        """`terrain 1.2 s, ways 0.4 s, …`: the stages that took a tenth of a
        second or more, longest first."""
        items = sorted(self.times.items(), key=lambda kv: -kv[1])
        return ", ".join(f"{name} {t:.1f} s" for name, t in items if t >= 0.05) or "none"


_current: ContextVar[Stages | None] = ContextVar("pixelworld_stages", default=None)


def _write(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def log(message: str) -> None:
    """A note from the stage running now (counts, what was skipped)."""
    _write((INDENT if _current.get() is not None else "") + message)


def stage(name: str, detail: str = "") -> None:
    """Start the next stage of the build running now (nothing outside one)."""
    stages = _current.get()
    if stages is not None:
        stages.start(name, detail)


def current_stage() -> str | None:
    stages = _current.get()
    return stages.current if stages is not None else None


@contextmanager
def run() -> Iterator[Stages]:
    """Time the stages of one build; nested runs join the outer one."""
    outer = _current.get()
    if outer is not None:
        yield outer
        return
    stages = Stages()
    token = _current.set(stages)
    try:
        yield stages
    except BaseException:
        # `current` keeps the stage that failed, for the message
        _current.reset(token)
        raise
    stages.end()
    _current.reset(token)
