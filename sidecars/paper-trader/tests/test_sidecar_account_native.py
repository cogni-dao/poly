# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""First-open safety using the real vendored Engine and committed SQLite.

Run in a separate process from test_sidecar_smoke (which installs a fake
pm_trader module). Only the background scheduler is replaced: no market reads,
fill checks, replay or reset are needed to open an account safely.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import types
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from pm_trader.db import Database
from pm_trader.engine import Engine

import server

ACCOUNT = "native-preservation-account"
SEED = 100.0
TABLES = ("account", "trades", "positions", "limit_orders", "market_cache")


class RecordingThread:
    instances = []

    def __init__(self, *, target, daemon, name):
        self.target = target
        self.started = False
        self.instances.append(self)

    def start(self):
        self.started = True

    def is_alive(self):
        return False


@pytest.fixture
def native(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(RecordingThread, "instances", [])
    monkeypatch.setattr(
        server, "threading",
        types.SimpleNamespace(
            Thread=RecordingThread, Lock=threading.Lock, Event=threading.Event
        ),
    )

    def forbidden(*_args, **_kwargs):
        pytest.fail("startup must not execute, reset, replay or contact a provider")

    for method in ("check_orders", "place_limit_order", "cancel_limit_order", "reset", "get_history"):
        monkeypatch.setattr(Engine, method, forbidden)
    monkeypatch.setattr(httpx.Client, "request", forbidden)
    caplog.set_level(logging.INFO, logger=server.log.name)
    return tmp_path


def db_path(root):
    return root / server._account_key(ACCOUNT) / "paper.db"


def snapshot(root):
    with sqlite3.connect(db_path(root)) as conn:
        return {
            table: conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in TABLES
        }


def seed_native(root, *, cash=74.0, account=True):
    engine = Engine(root / server._account_key(ACCOUNT))
    conn = engine.db.conn
    if account:
        engine.init_account(SEED)
        conn.execute(
            "UPDATE account SET cash = ?, created_at = '2026-10-01 01:02:03'", (cash,)
        )
    conn.commit()
    engine.close()


def add_row(root, table, *, status="filled", order_type="gtc", expires_at=None):
    with sqlite3.connect(db_path(root)) as conn:
        if table == "trades":
            conn.execute(
                """INSERT INTO trades
                (market_condition_id, market_slug, market_question, outcome,
                 side, avg_price, amount_usd, shares, fee_rate_bps, fee, created_at)
                VALUES ('condition', 'market', 'Question?', 'Yes', 'buy',
                        0.5, 25, 50, 0, 1, '2026-10-01 01:02:04')"""
            )
        elif table == "positions":
            conn.execute(
                """INSERT INTO positions
                (market_condition_id, market_slug, market_question, outcome,
                 shares, avg_entry_price, total_cost)
                VALUES ('condition', 'market', 'Question?', 'Yes', 50, 0.5, 25)"""
            )
        elif table == "limit_orders":
            conn.execute(
                """INSERT INTO limit_orders
                (market_slug, market_condition_id, outcome, side, amount,
                 limit_price, order_type, expires_at, status, created_at, filled_at)
                VALUES ('market', 'condition', 'Yes', 'buy', 25, 0.5,
                        ?, ?, ?, '2026-10-01 01:02:03', '2026-10-01 01:02:04')""",
                (order_type, expires_at, status),
            )
        elif table == "market_cache":
            conn.execute(
                "INSERT INTO market_cache VALUES (?, ?, ?)",
                ("condition", '{"price":0.5}', "2026-10-01 01:02:03"),
            )
        else:
            raise AssertionError(table)


def assert_denied(registry, caplog, *, seed=SEED, status=503):
    caplog.clear()
    prior_threads = list(RecordingThread.instances)
    with pytest.raises(HTTPException) as error:
        registry.get_or_create(ACCOUNT, seed)
    assert error.value.status_code == status
    assert error.value.detail == (
        "account_seed_mismatch" if status == 409 else "paper_account_unavailable"
    )
    assert ACCOUNT not in registry.accounts
    assert RecordingThread.instances == prior_threads
    assert not any(
        getattr(record, "event", None) == server.EVENT_SIDECAR_STARTED
        for record in caplog.records
    )


def test_empty_initializes_once_and_reopen_preserves_clock(native, monkeypatch):
    registry = server.SidecarRegistry()
    account = registry.get_or_create(ACCOUNT, SEED)
    assert isinstance(account.engine, Engine)
    assert account._fill_thread.started
    before = snapshot(native)
    assert before["account"][0][1:3] == (SEED, SEED)
    assert before["account"][0][3]
    registry.stop()

    def no_reset(*_args, **_kwargs):
        pytest.fail("reopen must not call the vendor reset-style initializer")

    monkeypatch.setattr(Engine, "init_account", no_reset)
    reopened = server.SidecarRegistry()
    reopened.get_or_create(ACCOUNT, SEED)
    assert snapshot(native) == before
    reopened.stop()


@pytest.mark.parametrize("cash", [74.0, 0.0, -1.0])
def test_matching_seed_preserves_all_native_rows(native, monkeypatch, cash):
    seed_native(native, cash=cash)
    for table in ("trades", "positions", "market_cache"):
        add_row(native, table)
    for status in ("filled", "cancelled", "rejected", "expired"):
        add_row(native, "limit_orders", status=status)
    before = snapshot(native)

    def no_reset(*_args, **_kwargs):
        pytest.fail("existing cash and clock must survive")

    monkeypatch.setattr(Engine, "init_account", no_reset)
    registry = server.SidecarRegistry()
    account = registry.get_or_create(ACCOUNT, SEED)
    assert account._fill_thread.started
    assert snapshot(native) == before
    registry.stop()


def test_seed_mismatch_same_process_and_fresh_registry(native, caplog):
    seed_native(native)
    before = snapshot(native)
    registry = server.SidecarRegistry()
    resident = registry.get_or_create(ACCOUNT, SEED)
    with pytest.raises(HTTPException) as error:
        registry.get_or_create(ACCOUNT, SEED + 1)
    assert error.value.status_code == 409
    assert registry.accounts[ACCOUNT] is resident
    assert snapshot(native) == before
    registry.stop()
    assert_denied(server.SidecarRegistry(), caplog, seed=SEED + 1, status=409)
    assert snapshot(native) == before


@pytest.mark.parametrize("table", ["trades", "positions", "limit_orders", "market_cache"])
def test_orphan_native_state_is_never_reseeded(native, caplog, table):
    seed_native(native, account=False)
    add_row(native, table)
    before = snapshot(native)
    assert before["account"] == []
    assert_denied(server.SidecarRegistry(), caplog)
    assert snapshot(native) == before


@pytest.mark.parametrize(
    "order_type,expiry", [("gtc", None), ("gtd", "2000-01-01T00:00:00+00:00")]
)
def test_pending_even_expired_by_clock_does_not_execute(native, caplog, order_type, expiry):
    seed_native(native)
    add_row(native, "limit_orders", status="pending", order_type=order_type, expires_at=expiry)
    before = snapshot(native)
    assert_denied(server.SidecarRegistry(), caplog)
    assert snapshot(native) == before


@pytest.mark.parametrize("cash", [float("inf"), float("-inf"), "corrupt"])
def test_corrupt_or_nonfinite_cash_unavailable_without_reset(native, caplog, cash):
    seed_native(native, cash=cash)
    before = snapshot(native)
    assert_denied(server.SidecarRegistry(), caplog)
    assert snapshot(native) == before


def test_initialization_error_closes_engine_without_thread_or_publication(native, caplog, monkeypatch):
    closed = []
    failed_accounts = []
    original_start = server.Sidecar.start

    def start(account):
        failed_accounts.append(account)
        return original_start(account)

    monkeypatch.setattr(server.Sidecar, "start", start)
    original_close = Engine.close

    def close(engine):
        closed.append(engine)
        original_close(engine)

    def fail_init(engine, balance):
        raise RuntimeError("initialization unavailable")

    monkeypatch.setattr(Engine, "close", close)
    monkeypatch.setattr(Engine, "init_account", fail_init)
    assert_denied(server.SidecarRegistry(), caplog)
    assert len(closed) == 1
    assert closed[0].db._conn is None
    assert len(failed_accounts) == 1
    assert failed_accounts[0].engine is None
    assert failed_accounts[0]._fill_thread is None
    assert snapshot(native)["account"] == []


def test_actual_sqlite_write_failure_rolls_back_and_closes(native, caplog, monkeypatch):
    seed_native(native, account=False)
    with sqlite3.connect(db_path(native)) as conn:
        conn.execute(
            """CREATE TRIGGER deny_account BEFORE INSERT ON account
            BEGIN SELECT RAISE(ABORT, 'native account initialization rejected'); END"""
        )
    before = snapshot(native)
    closed = []
    original_close = Engine.close

    def close(engine):
        closed.append(engine)
        assert not engine.db.conn.in_transaction
        original_close(engine)

    monkeypatch.setattr(Engine, "close", close)
    assert_denied(server.SidecarRegistry(), caplog)
    assert len(closed) == 1
    assert snapshot(native) == before


def test_failure_after_native_commit_withholds_account_without_claiming_rollback(native, caplog, monkeypatch):
    original_init = Engine.init_account

    def initialize_then_fail(engine, balance):
        original_init(engine, balance)
        raise RuntimeError("failure after vendor commit")

    monkeypatch.setattr(Engine, "init_account", initialize_then_fail)
    assert_denied(server.SidecarRegistry(), caplog)
    assert snapshot(native)["account"][0][1:3] == (SEED, SEED)


def test_cleanup_failure_does_not_replace_mismatch(native, caplog, monkeypatch):
    seed_native(native)
    before = snapshot(native)
    original_close = Engine.close
    closed = []

    def close(engine):
        closed.append(engine)
        original_close(engine)
        raise RuntimeError("cleanup also failed")

    monkeypatch.setattr(Engine, "close", close)
    assert_denied(server.SidecarRegistry(), caplog, seed=SEED + 1, status=409)
    assert len(closed) == 1
    assert snapshot(native) == before


def test_constructor_failure_is_unavailable_and_unpublished(native, caplog, monkeypatch):
    def fail_constructor(engine, data_dir):
        raise sqlite3.OperationalError("cannot open native database")

    monkeypatch.setattr(Engine, "__init__", fail_constructor)
    assert_denied(server.SidecarRegistry(), caplog)


@pytest.mark.parametrize("follower_seed", [SEED, SEED + 1])
def test_concurrent_native_openers_do_not_replace_winner(native, monkeypatch, follower_seed):
    # Both real Engines finish native schema setup BEFORE the winner starts
    # its write transaction. Trace confirms the follower actually attempts
    # BEGIN IMMEDIATE while the winner still owns the SQLite write lock.
    constructed = threading.Barrier(2, timeout=3)
    winner_locked = threading.Event()
    contender_begin = threading.Event()
    original_constructor = Engine.__init__
    original_get = Database.get_account
    original_init = Engine.init_account
    initializations = []
    results = {}
    registries = [server.SidecarRegistry(), server.SidecarRegistry()]

    def construct(engine, data_dir):
        original_constructor(engine, data_dir)
        follower = threading.current_thread().name == "native-follower"
        if follower:
            engine.db.conn.set_trace_callback(
                lambda sql: contender_begin.set() if sql == "BEGIN IMMEDIATE" else None
            )
        constructed.wait()
        if follower:
            assert winner_locked.wait(3)

    def get_account(db):
        account = original_get(db)
        if account is None and threading.current_thread().name == "native-winner":
            assert db.conn.in_transaction
            winner_locked.set()
            assert contender_begin.wait(3)
        return account

    def initialize(engine, balance):
        initializations.append(balance)
        return original_init(engine, balance)

    monkeypatch.setattr(Engine, "__init__", construct)
    monkeypatch.setattr(Database, "get_account", get_account)
    monkeypatch.setattr(Engine, "init_account", initialize)

    def open_account(index, seed):
        try:
            results[index] = registries[index].get_or_create(ACCOUNT, seed)
        except Exception as error:
            results[index] = error

    threads = [
        threading.Thread(target=open_account, args=(0, SEED), name="native-winner"),
        threading.Thread(target=open_account, args=(1, follower_seed), name="native-follower"),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=8)
        assert not thread.is_alive()
    assert winner_locked.is_set() and contender_begin.is_set()
    assert isinstance(results[0], server.Sidecar)
    assert initializations == [SEED]
    if follower_seed == SEED:
        assert isinstance(results[1], server.Sidecar)
    else:
        assert isinstance(results[1], HTTPException)
        assert results[1].status_code == 409
        assert ACCOUNT not in registries[1].accounts
    assert snapshot(native)["account"][0][1:3] == (SEED, SEED)
    for registry in registries:
        registry.stop()
