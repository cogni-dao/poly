"""Optional action lifetime for native paper operations (Cogni bug.5568).

One received epoch deadline becomes a monotonic budget. It never changes a
shared HTTP client or another account's connection. Ordinary calls omit it.
"""

from __future__ import annotations

import time
import sqlite3
from contextlib import contextmanager
from threading import Lock
from typing import Iterator


class ActionDeadline:
    def __init__(self, epoch_ms: int) -> None:
        self.epoch_ms = epoch_ms
        self.monotonic_end = time.monotonic() + max(0, epoch_ms / 1000 - time.time())

    def expired(self) -> bool:
        return time.monotonic() >= self.monotonic_end or time.time() * 1000 >= self.epoch_ms

    def remaining(self) -> float:
        remaining = min(self.monotonic_end - time.monotonic(), self.epoch_ms / 1000 - time.time())
        if remaining <= 0:
            raise TimeoutError("paper_action_expired")
        return remaining


@contextmanager
def action_lock(lock: Lock, deadline: ActionDeadline | None) -> Iterator[None]:
    acquired = lock.acquire() if deadline is None else lock.acquire(timeout=deadline.remaining())
    if not acquired:
        raise TimeoutError("paper_action_expired")
    try:
        if deadline is not None:
            deadline.remaining()
        yield
    finally:
        lock.release()


@contextmanager
def sqlite_lifetime(conn: sqlite3.Connection | None, deadline: ActionDeadline | None) -> Iterator[None]:
    """Scope native SQLite read/lock waits to one account operation."""
    if deadline is None:
        yield
        return
    assert conn is not None
    remaining_ms = int(deadline.remaining() * 1000)
    previous_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    conn.execute(f"PRAGMA busy_timeout={remaining_ms}")
    conn.set_progress_handler(lambda: int(deadline.expired()), 1)
    try:
        yield
    finally:
        conn.set_progress_handler(None, 0)
        conn.execute(f"PRAGMA busy_timeout={previous_timeout}")


@contextmanager
def sqlite_transaction(conn: sqlite3.Connection, deadline: ActionDeadline | None) -> Iterator[None]:
    """Acquire write authority within the action lifetime; fence mutation/commit.

    Ordinary callers retain their existing transaction and commit behavior.
    Bounded callers must check before each mutation and commit in this scope.
    """
    with sqlite_lifetime(conn, deadline):
        try:
            if deadline is not None:
                conn.execute("BEGIN IMMEDIATE")
                deadline.remaining()
            yield
        except BaseException:
            if deadline is not None:
                conn.set_progress_handler(None, 0)
                conn.rollback()
            raise


def execute_schema(conn: sqlite3.Connection, sql: str, deadline: ActionDeadline | None) -> None:
    """Run the existing schema without executescript's implicit pre-commit."""
    if deadline is None:
        conn.executescript(sql)
        return
    for statement in sql.split(";"):
        if statement.strip():
            deadline.remaining()
            conn.execute(statement)
