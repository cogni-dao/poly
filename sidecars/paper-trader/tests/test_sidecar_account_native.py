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

    def join(self, timeout=None):
        pass


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
    # Isolate account initialization contention from first-ever WAL/schema setup.
    seed_native(native, account=False)
    assert snapshot(native)["account"] == []
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


# bug.5043: native execution and receipt publication share one account lock.
from unittest.mock import MagicMock

from pm_trader.api import PolymarketClient
from pm_trader.models import Market, OrderBook, OrderBookLevel, OrderRejectedError
from pm_trader.orders import create_order, get_order


@pytest.fixture
def active(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(
        server, "threading", types.SimpleNamespace(
            Thread=RecordingThread, Lock=threading.Lock, Event=threading.Event
        ),
    )
    def no_network(*args, **kwargs):
        pytest.fail("native fixture must not contact a provider")
    monkeypatch.setattr(httpx.Client, "request", no_network)
    registry = server.SidecarRegistry()
    registry.start()
    account = registry.get_or_create(ACCOUNT, SEED)
    market = Market(
        condition_id="0xabc123", slug="test-market", question="Test?", description="",
        outcomes=["Yes", "No"], outcome_prices=[0.5, 0.5],
        tokens=[{"token_id": "yes-token", "outcome": "Yes"}, {"token_id": "no-token", "outcome": "No"}],
        active=True, closed=False,
    )
    account.engine.api.get_market = MagicMock(return_value=market)
    account.engine.api.get_order_book = MagicMock(return_value=OrderBook(bids=[], asks=[]))
    account.engine.api.get_trades_since = MagicMock(return_value=[])
    account.engine.api.get_fee_rate = MagicMock(return_value=100)
    yield registry, account
    registry.stop()


def request(**changes):
    fields = dict(
        account_id=ACCOUNT, starting_balance_usdc=SEED, client_order_id="native-atomic-client",
        market_id="test-market", outcome="Yes", side="BUY", size_usdc=10, limit_price=0.5,
    )
    fields.update(changes)
    return server.PlaceOrderRequest(**fields)


def durable_account(account):
    with sqlite3.connect(account.engine.db.db_path) as conn:
        return {
            table: conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in TABLES
        }


def tick(account, monkeypatch):
    # Exercise the actual loop once, including its lock/exception/stop boundary.
    waits = iter((False, True))
    monkeypatch.setattr(account._stop, "wait", lambda _: next(waits))
    account._fill_loop()


def crossing(account, path="snapshot", side="buy"):
    account.engine.api.get_order_book.return_value = OrderBook(
        bids=[OrderBookLevel(price=0.5, size=100)],
        asks=[OrderBookLevel(price=0.5, size=100)],
    )
    account.engine.api.get_trades_since.return_value = [
        {"side": "SELL" if side == "buy" else "BUY", "price": 0.5,
         "size": 100, "timestamp": 1000000}
    ] if path == "maker" else []


def assert_all_entries_refuse(account, oid):
    calls = (
        lambda: account.place(request(outcome="0", token_id="yes-token")),
        lambda: account.cancel(oid), lambda: account.get(oid),
        account.list_open_orders, account.balance, account.portfolio,
        lambda: account.history(10),
    )
    for call in calls:
        with pytest.raises(HTTPException) as error:
            call()
        assert error.value.status_code == 503
        assert error.value.detail == "paper_account_unavailable"


class OutcomeConnection:
    def __init__(self, real, fault):
        self.real = real
        self.fault = fault
        self.rollbacks = 0
        self.closes = 0
    def __getattr__(self, name):
        return getattr(self.real, name)
    def commit(self):
        if self.fault == "commit_then_raise":
            self.real.commit()
        if self.fault in ("commit_then_raise", "commit_failure"):
            raise sqlite3.OperationalError(self.fault)
        return self.real.commit()
    def rollback(self):
        self.rollbacks += 1
        if self.fault == "rollback_failure":
            raise sqlite3.OperationalError(self.fault)
        return self.real.rollback()
    def close(self):
        self.closes += 1
        if self.fault == "close_failure":
            raise sqlite3.OperationalError(self.fault)
        return self.real.close()


@pytest.mark.parametrize("path", ["maker", "snapshot"])
@pytest.mark.parametrize("side", ["buy", "sell"])
@pytest.mark.parametrize("fault", ["commit_then_raise", "commit_failure", "rollback_failure", "close_failure"])
def test_ambiguous_native_effects_stop_same_account_and_never_mint_zero(active, monkeypatch, path, side, fault):
    registry, account = active
    if side == "sell":
        account.engine.db.upsert_position(
            market_condition_id="0xabc123", market_slug="test-market", market_question="Test?",
            outcome="yes", shares=100, avg_entry_price=0.5, total_cost=50,
        )
    oid = account.place(request(side=side.upper(), size_usdc=10 if side == "buy" else 20)).order_id
    before = durable_account(account)
    crossing(account, path, side)
    real = account.engine.db.conn
    if fault in ("rollback_failure", "close_failure"):
        real.execute(
            "CREATE TRIGGER fail_fill BEFORE UPDATE OF status ON limit_orders "
            "WHEN NEW.status='filled' BEGIN SELECT RAISE(ABORT, 'before mark'); END"
        )
        real.commit()
    proxy = OutcomeConnection(real, fault)
    if fault == "close_failure":
        # An uncaught mutation error reaches cleanup; cleanup itself also fails.
        def mutation_error():
            account.engine.db.conn.execute("UPDATE account SET cash=1")
            raise RuntimeError("uncaught native mutation")
        monkeypatch.setattr(account.engine, "check_orders", mutation_error)
    account.engine.db._conn = proxy
    try:
        tick(account, monkeypatch)
        assert account._stop.is_set()
        assert proxy.closes == 1
        assert_all_entries_refuse(account, oid)
        assert registry.get_or_create(ACCOUNT, SEED) is account
        with pytest.raises(HTTPException):
            account.start()
        assert account.orders[oid].fees_usdc is None
        assert account.orders[oid].status == "open"
        after = durable_account(account)
        if fault == "commit_then_raise":
            assert after != before
            assert len(after["trades"]) == 1
            assert after["limit_orders"][0][9] == "filled"
            assert after["account"][0][2] == pytest.approx(89.95 if side == "buy" else 109.9)
        else:
            assert after == before
        # A later tick is also refused and cannot invoke native work.
        monkeypatch.setattr(account.engine, "check_orders", MagicMock(side_effect=AssertionError("stopped")))
        tick(account, monkeypatch)
        account.engine.check_orders.assert_not_called()
        assert durable_account(account) == after
        # Another tenant remains independent.
        healthy = registry.get_or_create("other-native-account", SEED)
        assert healthy is not account and not healthy._stop.is_set()
    finally:
        account.engine.db._conn = real
        try:
            real.rollback()
        except sqlite3.ProgrammingError:  # A successful close already discarded the failed unit.
            pass


@pytest.mark.parametrize("publication", ["fill_fields", "shadow_update", "receipt"])
def test_committed_fill_publication_failure_withholds_all_later_reads(active, monkeypatch, publication):
    _, account = active
    oid = account.place(request()).order_id
    crossing(account)
    real_check = account.engine.check_orders
    if publication == "fill_fields":
        def corrupt_result():
            result = real_check()
            del result[0]["fill"]["fee"]
            return result
        monkeypatch.setattr(account.engine, "check_orders", corrupt_result)
    elif publication == "shadow_update":
        class FailingExtra(dict):
            def update(self, *_args, **_kwargs):
                raise RuntimeError("shadow publication failed")
        account.orders[oid].extra = FailingExtra(account.orders[oid].extra)
    else:
        monkeypatch.setattr(server, "_to_receipt", lambda _: (_ for _ in ()).throw(RuntimeError("receipt failed")))
    tick(account, monkeypatch)
    assert account._stop.is_set()
    assert_all_entries_refuse(account, oid)
    after = durable_account(account)
    assert after["account"][0][2] == pytest.approx(89.95)
    assert len(after["trades"]) == len(after["positions"]) == 1
    assert after["limit_orders"][0][9] == "filled"


def test_dirty_entry_precedes_actual_gtd_expiry_cache_miss_and_all_entries(active, monkeypatch):
    _, account = active
    oid = account.place(request()).order_id
    engine = account.engine
    expired = create_order(
        engine.db.conn, market_slug="test-market", market_condition_id="0xabc123",
        outcome="yes", side="buy", amount=10, limit_price=0.5,
        order_type="gtd", expires_at="2000-01-01T00:00:00Z",
    )
    # Use the REAL native cache-miss -> provider response -> set_cache path.
    gamma = MagicMock(return_value=[{
        "conditionId": "0xabc123", "slug": "test-market", "question": "Test?",
        "outcomes": '["Yes","No"]', "outcomePrices": '["0.5","0.5"]',
        "clobTokenIds": '["yes-token","no-token"]', "active": True, "closed": False,
    }])
    monkeypatch.setattr(engine.api, "_gamma_get", gamma)
    monkeypatch.setattr(engine.api, "get_market", types.MethodType(PolymarketClient.get_market, engine.api))
    assert engine.db.get_cache("market:test-market") is None
    before = durable_account(account)
    engine.db.conn.execute("UPDATE account SET cash=1")
    real = engine.db.conn
    closed = MagicMock(side_effect=AssertionError("must not close caller transaction"))
    monkeypatch.setattr(engine, "close", closed)
    tick(account, monkeypatch)
    assert account._stop.is_set()
    assert_all_entries_refuse(account, oid)
    gamma.assert_not_called()
    closed.assert_not_called()
    assert real.in_transaction and engine.db.get_account().cash == 1
    assert get_order(real, expired.id).status == "pending"
    assert engine.db.get_cache("market:test-market") is None
    assert durable_account(account) == before
    real.rollback()
    assert durable_account(account) == before
    # Native clean controls really execute both paths; stopped Sidecar stays stopped.
    assert engine.check_orders()[0]["action"] == "expired"
    assert gamma.call_count == 1
    assert engine.db.get_cache("market:test-market") is not None
    assert_all_entries_refuse(account, oid)
    monkeypatch.undo()  # Restore real close before fixture cleanup.


@pytest.mark.parametrize("entry", ["place", "cancel", "get", "list", "balance", "portfolio", "history"])
def test_every_entry_checks_dirty_before_provider_or_shadow(active, monkeypatch, entry):
    _, account = active
    oid = account.place(request()).order_id
    before = durable_account(account)
    account.engine.db.conn.execute("UPDATE account SET cash=1")
    provider = MagicMock(side_effect=AssertionError("provider before dirty guard"))
    monkeypatch.setattr(account.engine.api, "get_market", provider)
    calls = {
        "place": lambda: account.place(request(outcome="0", token_id="yes-token")),
        "cancel": lambda: account.cancel(oid), "get": lambda: account.get(oid),
        "list": account.list_open_orders, "balance": account.balance,
        "portfolio": account.portfolio, "history": lambda: account.history(10),
    }
    with pytest.raises(HTTPException) as error:
        calls[entry]()
    assert error.value.status_code == 503
    provider.assert_not_called()
    assert account._stop.is_set() and account.engine.db.conn.in_transaction
    assert durable_account(account) == before
    account.engine.db.conn.rollback()
    assert_all_entries_refuse(account, oid)


def test_healthy_cancel_publishes_known_zero_only_once(active):
    _, account = active
    oid = account.place(request()).order_id
    assert account.get(oid).fees_usdc is None
    account.cancel(oid)
    receipt = account.get(oid)
    assert receipt.status == "canceled" and receipt.fees_usdc == 0
    assert receipt.filled_size_usdc == 0
    assert receipt.fill_price is None and receipt.total_shares is None
    assert account.list_open_orders() == []
    with pytest.raises(HTTPException) as error:
        account.cancel(oid)
    assert error.value.status_code == 404
    assert account.get(oid).fees_usdc == 0
    assert durable_account(account)["account"][0][2] == SEED
    assert durable_account(account)["trades"] == []


@pytest.mark.parametrize("evidence", ["positive", "partial", "price", "fee", "filled", "prior_cancel", "foreign", "unmapped"])
def test_conflicting_repeated_foreign_and_unmapped_cancel_never_upgrade_zero(active, evidence):
    _, account = active
    oid = account.place(request()).order_id
    st = account.orders[oid]
    if evidence == "positive": st.filled_size_usdc = 1
    elif evidence == "partial": st.total_shares = 1
    elif evidence == "price": st.fill_price = 0.5
    elif evidence == "fee": st.fees_usdc = 0.1
    elif evidence == "filled": st.status = "filled"
    elif evidence == "prior_cancel": st.status = "canceled"
    elif evidence == "unmapped": del account.orders[oid]
    cancel_id = oid.replace(server.BOOT_ID, "foreign-boot") if evidence == "foreign" else oid
    if evidence in ("foreign", "unmapped", "filled", "prior_cancel"):
        with pytest.raises(HTTPException) as error:
            account.cancel(cancel_id)
        assert error.value.status_code == 404
        assert get_order(account.engine.db.conn, 1).status == "pending"
    else:
        account.cancel(cancel_id)
    assert st.fees_usdc == (0.1 if evidence == "fee" else None)


@pytest.mark.parametrize("failure", ["native", "shadow"])
def test_failed_cancellation_stops_without_zero_authority(active, monkeypatch, failure):
    _, account = active
    oid = account.place(request()).order_id
    if failure == "native":
        account.engine.db.conn.execute(
            "CREATE TRIGGER deny_cancel BEFORE UPDATE OF status ON limit_orders "
            "WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'cancel failed'); END"
        )
        account.engine.db.conn.commit()
    else:
        class FailExtra(dict):
            def update(self, *_args): raise RuntimeError("cancel publication")
        account.orders[oid].extra = FailExtra(account.orders[oid].extra)
    with pytest.raises(HTTPException) as error:
        account.cancel(oid)
    assert error.value.status_code == 503
    assert account.orders[oid].fees_usdc is None
    assert_all_entries_refuse(account, oid)
    assert durable_account(account)["trades"] == []


def test_readyz_reflects_sticky_stop_before_thread_exits(active, monkeypatch):
    registry, account = active
    monkeypatch.setattr(server, "sidecars", registry)
    monkeypatch.setattr(account._fill_thread, "is_alive", lambda: True)
    assert server.readyz() == {"status": "ok"}
    account._stop.set()
    with pytest.raises(HTTPException) as error:
        server.readyz()
    assert error.value.status_code == 503


@pytest.mark.parametrize("path", ["maker", "snapshot"])
def test_known_rollback_keeps_same_sidecar_healthy_for_exactly_one_retry(active, monkeypatch, path):
    _, account = active
    oid = account.place(request()).order_id
    crossing(account, path)
    conn = account.engine.db.conn
    conn.execute(
        "CREATE TRIGGER known_rollback AFTER INSERT ON trades "
        "BEGIN SELECT RAISE(ABORT,'retry'); END"
    )
    conn.commit()
    before = durable_account(account)
    tick(account, monkeypatch)
    assert not account._stop.is_set()
    assert account.get(oid).status == "open"
    assert durable_account(account) == before
    conn.execute("DROP TRIGGER known_rollback")
    conn.commit()
    tick(account, monkeypatch)
    receipt = account.get(oid)
    assert receipt.status == "filled" and receipt.fees_usdc == pytest.approx(0.05)
    assert receipt.filled_size_usdc == 10 and receipt.total_shares == 20
    assert len(durable_account(account)["trades"]) == 1
    with pytest.raises(HTTPException) as error:
        account.cancel(oid)
    assert error.value.status_code == 404
    assert account.get(oid).fees_usdc == pytest.approx(0.05)
    tick(account, monkeypatch)
    assert len(durable_account(account)["trades"]) == 1


def test_placement_maps_before_native_tick_can_enter(active, monkeypatch):
    _, account = active
    native_done = threading.Event()
    publish = threading.Event()
    tick_entered = threading.Event()
    results = {}
    original_state = server.OrderState
    original_check = account.engine.check_orders
    def pause_mapping(**fields):
        native_done.set()
        assert publish.wait(3)
        return original_state(**fields)
    def check():
        tick_entered.set()
        assert len(account.orders) == 1
        return original_check()
    monkeypatch.setattr(server, "OrderState", pause_mapping)
    monkeypatch.setattr(account.engine, "check_orders", check)
    crossing(account)
    def place():
        try: results["place"] = account.place(request())
        except Exception as error: results["place"] = error
    placer = threading.Thread(target=place)
    placer.start()
    try:
        assert native_done.wait(3)
        assert_lock_held(account.lock)
        assert len(durable_account(account)["limit_orders"]) == 1
        worker = threading.Thread(target=lambda: tick(account, monkeypatch))
        worker.start()
        assert not tick_entered.wait(0.05)
    finally:
        publish.set()
    placer.join(timeout=3)
    worker.join(timeout=3)
    assert not placer.is_alive() and not worker.is_alive()
    assert isinstance(results["place"], server.OrderReceipt)
    assert tick_entered.is_set() and not account._stop.is_set()
    assert account.get(results["place"].order_id).status == "filled"
    assert len(durable_account(account)["trades"]) == 1


@pytest.mark.parametrize("operation", ["get", "list", "cancel"])
def test_fill_publication_holds_same_lock_against_reads_and_cancellation(active, monkeypatch, operation):
    _, account = active
    oid = account.place(request()).order_id
    crossing(account)
    native_done = threading.Event()
    publish = threading.Event()
    attempting = threading.Event()
    completed = threading.Event()
    results = {}
    original_receipt = server._to_receipt
    def pause_receipt(st):
        if threading.current_thread().name == "native-publisher":
            native_done.set()
            assert publish.wait(3)
        return original_receipt(st)
    monkeypatch.setattr(server, "_to_receipt", pause_receipt)
    worker = threading.Thread(target=lambda: tick(account, monkeypatch), name="native-publisher")
    worker.start()
    reader = None
    try:
        assert native_done.wait(3)
        assert_lock_held(account.lock)
        assert durable_account(account)["limit_orders"][0][9] == "filled"
        def read():
            attempting.set()
            try:
                results["read"] = {
                    "get": lambda: account.get(oid), "list": account.list_open_orders,
                    "cancel": lambda: account.cancel(oid),
                }[operation]()
            except Exception as error:
                results["read"] = error
            finally:
                completed.set()
        reader = threading.Thread(target=read)
        reader.start()
        assert attempting.wait(3)
        assert not completed.wait(0.05)
    finally:
        publish.set()
    worker.join(timeout=3)
    if reader is not None: reader.join(timeout=3)
    assert not worker.is_alive() and reader is not None and not reader.is_alive()
    assert not account._stop.is_set()
    if operation == "get":
        assert results["read"].status == "filled"
        assert results["read"].fees_usdc == pytest.approx(0.05)
        assert results["read"].total_shares == 20
    elif operation == "list": assert results["read"] == []
    else:
        assert isinstance(results["read"], HTTPException)
        assert results["read"].status_code == 404
    assert len(durable_account(account)["trades"]) == 1


def test_cancel_publication_holds_lock_until_known_zero_receipt(active, monkeypatch):
    _, account = active
    oid = account.place(request()).order_id
    committed = threading.Event()
    publish = threading.Event()
    completed = threading.Event()
    original_cancel = account.engine.cancel_limit_order
    result = {}
    def pause_cancel(int_id):
        value = original_cancel(int_id)
        committed.set()
        assert publish.wait(3)
        return value
    monkeypatch.setattr(account.engine, "cancel_limit_order", pause_cancel)
    canceller = threading.Thread(target=lambda: account.cancel(oid))
    canceller.start()
    reader = None
    try:
        assert committed.wait(3)
        assert_lock_held(account.lock)
        def read():
            result["receipt"] = account.get(oid)
            completed.set()
        reader = threading.Thread(target=read)
        reader.start()
        assert not completed.wait(0.05)
    finally:
        publish.set()
    canceller.join(timeout=3)
    if reader is not None: reader.join(timeout=3)
    assert not canceller.is_alive() and reader is not None and not reader.is_alive()
    assert result["receipt"].status == "canceled"
    assert result["receipt"].fees_usdc == 0
    assert durable_account(account)["trades"] == []


def assert_lock_held(lock):
    acquired = lock.acquire(blocking=False)
    if acquired:
        lock.release()
    assert not acquired


@pytest.mark.parametrize("side", ["BUY", "SELL"])
def test_native_cancel_preserves_canonical_receipt_envelope(active, side):
    _, account = active
    intent = request(
        market_id="prediction-market:polymarket:0xabc123",
        token_id="yes-token", outcome="0", side=side,
    )
    placed = account.place(intent)
    oid = placed.order_id
    before_extra = dict(account.orders[oid].extra)
    before_native = durable_account(account)
    assert placed.attributes["market"] == intent.market_id
    assert placed.attributes["tokenId"] == intent.token_id
    assert placed.attributes["side"] == side
    assert placed.attributes["outcome"] == intent.outcome
    assert placed.attributes["price"] == intent.limit_price
    assert placed.attributes["originalSize"] == intent.size_usdc / intent.limit_price
    assert placed.attributes["upstream_id"] == oid
    assert placed.client_order_id == intent.client_order_id
    assert placed.fees_usdc is None

    account.cancel(oid)
    receipt = account.get(oid)
    assert receipt.order_id == placed.order_id
    assert receipt.client_order_id == placed.client_order_id
    assert receipt.submitted_at == placed.submitted_at
    assert receipt.attributes == {**placed.attributes, "upstream_status": "cancelled"}
    assert account.orders[oid].extra == {**before_extra, "status": "cancelled"}
    assert receipt.status == "canceled" and receipt.fees_usdc == 0.0
    assert receipt.filled_size_usdc == 0.0
    assert receipt.fill_price is None and receipt.total_shares is None
    assert receipt.attributes["sizeMatched"] == 0.0
    assert account.list_open_orders() == []
    after_native = durable_account(account)
    for table in ("account", "trades", "positions", "market_cache"):
        assert after_native[table] == before_native[table]
    assert after_native["account"][0][2] == SEED
    assert after_native["trades"] == after_native["positions"] == []
    assert get_order(account.engine.db.conn, 1).status == "cancelled"

    with pytest.raises(HTTPException) as error:
        account.cancel(oid)
    assert error.value.status_code == 404
    assert account.get(oid) == receipt
    assert durable_account(account) == after_native


@pytest.mark.parametrize("valid_side", ["BUY", "buy", "SELL", "sell"])
@pytest.mark.parametrize("invalid", [
    {"size_usdc": 0.1}, {"side": "INVALID"}, {"limit_price": 1.0},
])
def test_definite_native_input_rejection_preserves_healthy_account(active, monkeypatch, valid_side, invalid):
    registry, account = active
    monkeypatch.setattr(server, "sidecars", registry)
    monkeypatch.setattr(account._fill_thread, "is_alive", lambda: True)
    placed = account.place(request(side=valid_side))
    before = durable_account(account)
    assert len(before["limit_orders"]) == 1
    assert before["trades"] == [] and before["positions"] == []
    assert before["account"][0][1:3] == (SEED, SEED)
    with pytest.raises(HTTPException) as error:
        account.place(request(**invalid))
    assert isinstance(error.value.__cause__, OrderRejectedError)
    assert error.value.status_code == 502
    assert error.value.detail == server.ERROR_UPSTREAM_ENGINE_FAILED
    assert durable_account(account) == before
    assert not account._stop.is_set()
    assert not account.engine.db.conn.in_transaction
    assert registry.get_or_create(ACCOUNT, SEED) is account
    assert account.get(placed.order_id) == placed
    assert account.list_open_orders() == [placed]
    assert account.balance()["cash"] == SEED
    assert server.readyz() == {"status": "ok"}
    account.cancel(placed.order_id)
    canceled = account.get(placed.order_id)
    assert canceled.status == "canceled" and canceled.fees_usdc == 0
    assert account.list_open_orders() == []
    after = durable_account(account)
    assert after["limit_orders"][0][9] == "cancelled"
    for table in ("account", "trades", "positions", "market_cache"):
        assert after[table] == before[table]
    assert server.readyz() == {"status": "ok"}


@pytest.mark.parametrize("publication", ["shadow", "receipt"])
def test_late_native_rejection_type_cannot_disguise_committed_placement(active, monkeypatch, publication):
    _, account = active
    before = durable_account(account)
    def fail(*_args, **_kwargs):
        raise OrderRejectedError("publication failed after native order commit")
    if publication == "shadow":
        class FailingOrders(dict):
            def __setitem__(self, *_args):
                fail()
        account.orders = FailingOrders()
    else:
        monkeypatch.setattr(server, "_to_receipt", fail)
    with pytest.raises(HTTPException) as error:
        account.place(request())
    assert error.value.status_code == 503
    assert error.value.detail == "paper_account_unavailable"
    assert isinstance(error.value.__cause__, OrderRejectedError)
    assert account._stop.is_set()
    after = durable_account(account)
    assert len(after["limit_orders"]) == len(before["limit_orders"]) + 1
    assert after["limit_orders"][0][9] == "pending"
    for table in ("account", "trades", "positions", "market_cache"):
        assert after[table] == before[table]
    oid = server._externalize(account.account_key, after["limit_orders"][0][0])
    assert_all_entries_refuse(account, oid)


@pytest.mark.parametrize("invalid", [
    {"size_usdc": 0.1}, {"side": "INVALID"}, {"limit_price": 1.0},
])
def test_definite_invalid_input_cannot_bypass_dirty_entry(active, invalid):
    _, account = active
    oid = account.place(request()).order_id
    before = durable_account(account)
    account.engine.db.conn.execute("UPDATE account SET cash=1")
    with pytest.raises(HTTPException) as error:
        account.place(request(**invalid))
    assert error.value.status_code == 503
    assert error.value.detail == "paper_account_unavailable"
    assert account._stop.is_set() and account.engine.db.conn.in_transaction
    assert durable_account(account) == before
    account.engine.db.conn.rollback()
    assert_all_entries_refuse(account, oid)


@pytest.mark.parametrize("error_type", [ValueError, sqlite3.OperationalError])
def test_uncertain_native_placement_failure_retains_committed_order_and_withholds(active, monkeypatch, error_type):
    _, account = active
    before = durable_account(account)
    place = account.engine.place_limit_order
    def commit_then_fail(**kwargs):
        place(**kwargs)
        raise error_type("native placement result unavailable")
    monkeypatch.setattr(account.engine, "place_limit_order", commit_then_fail)
    with pytest.raises(HTTPException) as error:
        account.place(request())
    assert error.value.status_code == 503
    assert error.value.detail == "paper_account_unavailable"
    assert isinstance(error.value.__cause__, error_type)
    after = durable_account(account)
    assert len(after["limit_orders"]) == len(before["limit_orders"]) + 1
    assert after["limit_orders"][0][9] == "pending"
    for table in ("account", "trades", "positions", "market_cache"):
        assert after[table] == before[table]
    oid = server._externalize(account.account_key, after["limit_orders"][0][0])
    assert_all_entries_refuse(account, oid)
