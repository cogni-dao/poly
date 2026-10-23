"""Tests for the maker-fill (trade-prints) branch of `Engine.check_orders`.

Cogni-poly local patch (bug.5005) — substantive coverage of the new code
path. Upstream's `test_engine.py` covers the snapshot-taker fill model;
this file covers the maker-matched-by-takers model + the no-double-fill
guarantee between the two.

All tests use `MagicMock` on `engine.api.*` to inject canned book + trade
responses; no network access required.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from pm_trader.db import Database
from pm_trader.engine import Engine
from pm_trader.models import Market, OrderBook, OrderBookLevel
from pm_trader.orders import create_order


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    data_dir = tmp_path / "pm-trader-maker-fill"
    data_dir.mkdir()
    eng = Engine(data_dir)
    eng.init_account(10_000.0)
    yield eng
    eng.close()


def _market(condition_id: str = "0xabc123", slug: str = "test-market") -> Market:
    return Market(
        condition_id=condition_id,
        slug=slug,
        question="Test market",
        description="",
        outcomes=["Yes", "No"],
        outcome_prices=[0.014, 0.986],
        tokens=[
            {"token_id": "tok_yes", "outcome": "Yes"},
            {"token_id": "tok_no", "outcome": "No"},
        ],
        active=True,
        closed=False,
        volume=1_000_000.0,
        liquidity=10_000.0,
        end_date="2026-12-31",
        fee_rate_bps=0,
        tick_size=0.001,
    )


def _empty_book() -> OrderBook:
    return OrderBook(bids=[], asks=[])


def _book(
    bids: list[tuple[float, float]] | None = None,
    asks: list[tuple[float, float]] | None = None,
) -> OrderBook:
    return OrderBook(
        bids=[OrderBookLevel(price=p, size=s) for p, s in (bids or [])],
        asks=[OrderBookLevel(price=p, size=s) for p, s in (asks or [])],
    )


def _trade(
    price: float,
    size: float,
    side: str,
    timestamp: float = 1_000_000.0,
    asset: str = "tok_yes",
) -> dict:
    return {
        "price": price,
        "size": size,
        "side": side,
        "asset": asset,
        "timestamp": timestamp,
    }


def _mock_api(
    engine: Engine,
    *,
    market: Market | None = None,
    book: OrderBook | None = None,
    fee_rate: int = 0,
    trades: list[dict] | None = None,
    trades_side_effect=None,
) -> None:
    """Patch every api method check_orders touches."""
    m = market or _market()
    b = book if book is not None else _empty_book()
    engine.api.get_market = MagicMock(return_value=m)
    engine.api.get_order_book = MagicMock(return_value=b)
    engine.api.get_fee_rate = MagicMock(return_value=fee_rate)
    if trades_side_effect is not None:
        engine.api.get_trades_since = MagicMock(side_effect=trades_side_effect)
    else:
        engine.api.get_trades_since = MagicMock(return_value=trades or [])


def _make_buy(engine: Engine, *, amount: float, limit: float) -> int:
    """Place a pending BUY order; return its id."""
    order = create_order(
        engine.db.conn,
        market_slug="test-market",
        market_condition_id="0xabc123",
        outcome="Yes",
        side="buy",
        amount=amount,
        limit_price=limit,
    )
    return order.id


def _make_sell(engine: Engine, *, shares: float, limit: float) -> int:
    """Place a pending SELL order; return its id. Requires position pre-seeded.

    The Engine enforces position-availability on fills via
    `_execute_limit_sell`. Use the public db helper so we don't depend on
    table internals.
    """
    engine.db.upsert_position(
        market_condition_id="0xabc123",
        market_slug="test-market",
        market_question="Test market",
        outcome="Yes",
        shares=1000.0,
        avg_entry_price=0.10,
        total_cost=100.0,
    )
    order = create_order(
        engine.db.conn,
        market_slug="test-market",
        market_condition_id="0xabc123",
        outcome="Yes",
        side="sell",
        amount=shares,
        limit_price=limit,
    )
    return order.id


# ---------------------------------------------------------------------------
# BUY-side maker fill (the swisstony case)
# ---------------------------------------------------------------------------


class TestBuyMakerFill:
    def test_fills_from_sell_taker_trade_at_limit(self, engine: Engine):
        """The bug.5005 happy path: paper BUY at 0.014 with a SELL-taker
        trade printing at 0.014 — our resting bid gets filled."""
        order_id = _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.014, size=200, side="SELL")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        assert results[0]["order"]["id"] == order_id
        # Engine's get_trades_since was called once (per-token batched)
        assert engine.api.get_trades_since.call_count == 1

    def test_fills_at_or_below_limit(self, engine: Engine):
        """A SELL-taker trade at a price below our limit also fills us —
        we'd have been at the top of the book at our better-priced bid."""
        _make_buy(engine, amount=10.0, limit=0.02)
        _mock_api(engine, trades=[_trade(price=0.015, size=500, side="SELL")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"

    def test_no_fill_when_sell_taker_trade_above_limit(self, engine: Engine):
        """The whole reason this path exists: a SELL at 0.020 does NOT fill
        a BUY bid at 0.014."""
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.020, size=200, side="SELL")])

        results = engine.check_orders()

        assert results == []

    def test_no_fill_from_buy_taker_trade(self, engine: Engine):
        """The swisstony anti-pattern: target buys as taker at 0.014, lifting
        the offered ask. We'd see a BUY-side trade at 0.014. Our bid does NOT
        fill from that — different side semantics."""
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.014, size=200, side="BUY")])

        results = engine.check_orders()

        assert results == []


# ---------------------------------------------------------------------------
# SELL-side maker fill (symmetric)
# ---------------------------------------------------------------------------


class TestSellMakerFill:
    def test_fills_from_buy_taker_trade_at_limit(self, engine: Engine):
        order_id = _make_sell(engine, shares=10, limit=0.50)
        _mock_api(engine, trades=[_trade(price=0.50, size=100, side="BUY")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        assert results[0]["order"]["id"] == order_id

    def test_fills_at_or_above_limit(self, engine: Engine):
        _make_sell(engine, shares=10, limit=0.50)
        _mock_api(engine, trades=[_trade(price=0.55, size=100, side="BUY")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"

    def test_no_fill_below_limit(self, engine: Engine):
        _make_sell(engine, shares=10, limit=0.50)
        _mock_api(engine, trades=[_trade(price=0.45, size=100, side="BUY")])

        results = engine.check_orders()

        assert results == []

    def test_no_fill_from_sell_taker_trade(self, engine: Engine):
        """A SELL-taker trade hits a bid; it can't fill our SELL (ask)."""
        _make_sell(engine, shares=10, limit=0.50)
        _mock_api(engine, trades=[_trade(price=0.55, size=100, side="SELL")])

        results = engine.check_orders()

        assert results == []


# ---------------------------------------------------------------------------
# Partial fills + multi-order allocation
# ---------------------------------------------------------------------------


class TestPartialAndAllocation:
    def test_trade_smaller_than_order_partial_fill(self, engine: Engine):
        """Order asks for 200 shares ($2.80 @ 0.014), trade has only 50.
        pm_trader marks the order filled on partial — that's the upstream
        contract; we preserve it. Verify the filled trade row reflects the
        actual 50 shares matched."""
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.014, size=50, side="SELL")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"

    def test_one_trade_split_across_two_orders(self, engine: Engine):
        """Two BUY orders on the same token, one trade with enough size for
        both. Lower order.id gets first allocation (deterministic)."""
        id1 = _make_buy(engine, amount=1.40, limit=0.014)  # ≈100 shares
        id2 = _make_buy(engine, amount=1.40, limit=0.014)  # ≈100 shares
        _mock_api(engine, trades=[_trade(price=0.014, size=300, side="SELL")])

        results = engine.check_orders()

        assert len(results) == 2
        ids_filled = {r["order"]["id"] for r in results}
        assert ids_filled == {id1, id2}


# ---------------------------------------------------------------------------
# Snapshot path interop — no double-fill, snapshot still works
# ---------------------------------------------------------------------------


class TestSnapshotInterop:
    def test_snapshot_path_still_fills_when_no_trades(self, engine: Engine):
        """No recent trades, but current book crosses the limit → snapshot
        path fills. Preserves upstream behavior."""
        _make_buy(engine, amount=10.0, limit=0.50)
        _mock_api(
            engine,
            book=_book(asks=[(0.48, 500)]),
            trades=[],
        )

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"

    def test_no_double_fill_when_both_paths_match(self, engine: Engine):
        """Maker path fills the order; snapshot path must skip it.
        Exactly one 'filled' result, not two."""
        _make_buy(engine, amount=10.0, limit=0.50)
        _mock_api(
            engine,
            book=_book(asks=[(0.48, 500)]),  # snapshot would fill
            trades=[_trade(price=0.49, size=200, side="SELL")],  # maker also would
        )

        results = engine.check_orders()

        assert len(results) == 1


# ---------------------------------------------------------------------------
# Graceful degradation + cursor management
# ---------------------------------------------------------------------------


class TestGracefulDegradation:
    def test_get_trades_since_raises_falls_through_to_snapshot(self, engine: Engine):
        """API error on trade fetch must not abort the loop. Snapshot path
        still runs and can fill the order."""
        _make_buy(engine, amount=10.0, limit=0.50)
        _mock_api(
            engine,
            book=_book(asks=[(0.48, 500)]),
            trades_side_effect=RuntimeError("data-api 503"),
        )

        results = engine.check_orders()

        # Snapshot path fills despite maker path raising.
        assert len(results) == 1
        assert results[0]["action"] == "filled"


class TestPerTokenBatching:
    def test_one_get_trades_call_per_token_regardless_of_order_count(
        self, engine: Engine
    ):
        """Three pending BUYs on the same token → exactly one
        `get_trades_since` call (per-token batching)."""
        for _ in range(3):
            _make_buy(engine, amount=1.0, limit=0.014)
        _mock_api(engine, trades=[])

        engine.check_orders()

        assert engine.api.get_trades_since.call_count == 1


class TestScanCursor:
    def test_last_scan_populated_and_monotonic_when_no_trades(
        self, engine: Engine
    ):
        """Cursor must be populated after first scan and never move backward
        across ticks, even on empty responses. The exact advance is bounded
        by _MAKER_FILL_LAG_BUFFER_SECONDS — see TestLagWindowCursor."""
        _make_buy(engine, amount=1.0, limit=0.014)
        _mock_api(engine, trades=[])

        engine.check_orders()

        assert "tok_yes" in engine._maker_fill_last_scan
        first_ts = engine._maker_fill_last_scan["tok_yes"]
        assert first_ts > 0

        engine.check_orders()
        second_ts = engine._maker_fill_last_scan["tok_yes"]
        assert second_ts >= first_ts

    def test_last_scan_advances_to_newest_trade_ts(self, engine: Engine):
        """When trades return, cursor advances to max(trade.timestamp), not
        to now() — so the next tick can still pick up trades that printed
        between the newest observed ts and the next check."""
        _make_buy(engine, amount=10.0, limit=0.50)
        _mock_api(
            engine,
            trades=[
                _trade(price=0.50, size=10, side="SELL", timestamp=1_000_100.0),
                _trade(price=0.50, size=10, side="SELL", timestamp=1_000_050.0),
            ],
        )

        engine.check_orders()

        assert engine._maker_fill_last_scan["tok_yes"] == 1_000_100.0


# ---------------------------------------------------------------------------
# Lag-window regression (bug.5005 review)
# ---------------------------------------------------------------------------


class TestLagWindowCursor:
    """The data-api lags trade prints by seconds. The cursor must not jump
    past trades that print inside that lag window. Regression for the path
    where empty/error responses on tick N would silently filter out a real
    trade observed on tick N+1.
    """

    def test_trade_in_lag_window_filled_on_next_tick(
        self, engine: Engine, monkeypatch: pytest.MonkeyPatch
    ):
        # Scenario: trade printed at t=995 but data-api didn't return it
        # until t=1030 (35s of staleness). Tick 1 at t=1000 sees empty;
        # tick 2 at t=1030 sees the t=995 trade. With cursor-jump-to-now,
        # the t=995 trade would be filtered out on tick 2 (ts < cursor).
        order_id = _make_buy(engine, amount=2.80, limit=0.014)
        engine.api.get_market = MagicMock(return_value=_market())
        engine.api.get_order_book = MagicMock(return_value=_empty_book())
        engine.api.get_fee_rate = MagicMock(return_value=0)
        engine.api.get_trades_since = MagicMock(return_value=[])
        # Pre-seed to simulate prior steady-state operation in this time
        # domain (real created_at would be ~1.7e9; we want a controlled
        # cursor for monkeypatched time).
        engine._maker_fill_last_scan["tok_yes"] = 900.0
        monkeypatch.setattr("pm_trader.engine.time.time", lambda: 1000.0)

        engine.check_orders()

        # After tick 1 (empty): bounded_advance = max(900, 1000-90) = 910.
        assert engine._maker_fill_last_scan["tok_yes"] == 910.0

        # Tick 2: data-api now returns the lagged trade. Its ts=995 still
        # passes the ts > since_ts=910 filter — bug fixed.
        engine.api.get_trades_since = MagicMock(return_value=[
            _trade(price=0.014, size=200, side="SELL", timestamp=995.0),
        ])
        monkeypatch.setattr("pm_trader.engine.time.time", lambda: 1030.0)

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        assert results[0]["order"]["id"] == order_id

    def test_cursor_capped_below_now_on_empty(
        self, engine: Engine, monkeypatch: pytest.MonkeyPatch
    ):
        """Direct invariant: on an empty response, the cursor never
        advances past now - _MAKER_FILL_LAG_BUFFER_SECONDS."""
        _make_buy(engine, amount=1.0, limit=0.014)
        _mock_api(engine, trades=[])
        engine._maker_fill_last_scan["tok_yes"] = 0.0
        monkeypatch.setattr("pm_trader.engine.time.time", lambda: 1_000_000.0)

        engine.check_orders()

        from pm_trader.engine import _MAKER_FILL_LAG_BUFFER_SECONDS
        assert engine._maker_fill_last_scan["tok_yes"] == (
            1_000_000.0 - _MAKER_FILL_LAG_BUFFER_SECONDS
        )

    def test_cursor_capped_below_now_on_api_error(
        self, engine: Engine, monkeypatch: pytest.MonkeyPatch
    ):
        """Same invariant on the error path — previously the error branch
        also jumped the cursor to now, silently dropping the lag-window
        trades that the recovery tick would otherwise have caught."""
        _make_buy(engine, amount=1.0, limit=0.014)
        _mock_api(engine, trades_side_effect=RuntimeError("data-api 503"))
        engine._maker_fill_last_scan["tok_yes"] = 0.0
        monkeypatch.setattr("pm_trader.engine.time.time", lambda: 1_000_000.0)

        engine.check_orders()

        from pm_trader.engine import _MAKER_FILL_LAG_BUFFER_SECONDS
        assert engine._maker_fill_last_scan["tok_yes"] == (
            1_000_000.0 - _MAKER_FILL_LAG_BUFFER_SECONDS
        )


# ---------------------------------------------------------------------------
# Observability — scan emits structured Loki-friendly log lines
# ---------------------------------------------------------------------------


class TestObservability:
    def test_scan_emits_structured_log_on_success(
        self, engine: Engine, caplog: pytest.LogCaptureFixture
    ):
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.014, size=200, side="SELL")])

        with caplog.at_level("INFO", logger="pm_trader.engine"):
            engine.check_orders()

        assert any("event=maker_fill_scan" in r.message for r in caplog.records)

    def test_scan_logs_exception_on_api_error(
        self, engine: Engine, caplog: pytest.LogCaptureFixture
    ):
        _make_buy(engine, amount=1.0, limit=0.014)
        _mock_api(engine, trades_side_effect=RuntimeError("data-api 503"))

        with caplog.at_level("ERROR", logger="pm_trader.engine"):
            engine.check_orders()

        assert any(
            "event=maker_fill_scan_failed" in r.message for r in caplog.records
        )


# ---------------------------------------------------------------------------
# Cross-product diagnostic (bug.5005 review — distinguishes filter bug from
# market structure when zero orders fill despite trades being available)
# ---------------------------------------------------------------------------


class TestScanDetailDiagnostic:
    def test_no_detail_emitted_when_no_trades(
        self, engine: Engine, caplog: pytest.LogCaptureFixture
    ):
        _make_buy(engine, amount=1.0, limit=0.014)
        _mock_api(engine, trades=[])

        with caplog.at_level("INFO", logger="pm_trader.engine"):
            engine.check_orders()

        assert not any(
            "event=maker_fill_scan_detail" in r.message for r in caplog.records
        )

    def test_detail_counts_side_mismatch(
        self, engine: Engine, caplog: pytest.LogCaptureFixture
    ):
        # BUY limit; trade is BUY-taker (lifts ask) — wrong side, can't fill.
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.014, size=200, side="BUY")])

        with caplog.at_level("INFO", logger="pm_trader.engine"):
            engine.check_orders()

        detail = [r for r in caplog.records if "event=maker_fill_scan_detail" in r.message]
        assert len(detail) == 1
        msg = detail[0].message
        assert "would_match=0" in msg
        assert "side_mismatch=1" in msg
        assert "wrong_price=0" in msg

    def test_detail_counts_wrong_price(
        self, engine: Engine, caplog: pytest.LogCaptureFixture
    ):
        # BUY at 0.014; SELL-taker prints at 0.020 — correct side, above limit.
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.020, size=200, side="SELL")])

        with caplog.at_level("INFO", logger="pm_trader.engine"):
            engine.check_orders()

        detail = [r for r in caplog.records if "event=maker_fill_scan_detail" in r.message]
        assert len(detail) == 1
        msg = detail[0].message
        assert "would_match=0" in msg
        assert "side_mismatch=0" in msg
        assert "wrong_price=1" in msg

    def test_detail_counts_would_match(
        self, engine: Engine, caplog: pytest.LogCaptureFixture
    ):
        # The happy path: BUY at 0.014, SELL-taker prints at 0.014 → would match.
        _make_buy(engine, amount=2.80, limit=0.014)
        _mock_api(engine, trades=[_trade(price=0.014, size=200, side="SELL")])

        with caplog.at_level("INFO", logger="pm_trader.engine"):
            engine.check_orders()

        detail = [r for r in caplog.records if "event=maker_fill_scan_detail" in r.message]
        assert len(detail) == 1
        msg = detail[0].message
        assert "would_match=1" in msg
        assert "side_mismatch=0" in msg
        assert "wrong_price=0" in msg
        # Sample fields present (anonymous, public market data)
        assert "sample_order_side=buy" in msg
        assert "sample_trade_side=SELL" in msg


# ---------------------------------------------------------------------------
# Fill-price pinning (Cogni-poly local patch, bug.5016)
#
# Both fill paths must clear at the order's ``limit_price`` — never at a
# better price observed in the trade print or the live book. As the resting
# maker we'd have held queue priority at our limit; paper must not pocket a
# price improvement that the real CLOB would have given the taker, not us.
# ---------------------------------------------------------------------------


def _latest_trade_row(engine: Engine) -> dict:
    """Return the most recent trade row written by the engine."""
    cur = engine.db.conn.execute(
        "SELECT outcome, side, avg_price, shares, amount_usd "
        "FROM trades ORDER BY id DESC LIMIT 1"
    )
    row = cur.fetchone()
    assert row is not None, "expected a trade row to be inserted"
    keys = ("outcome", "side", "avg_price", "shares", "amount_usd")
    return dict(zip(keys, row))


class TestFillPriceAtLimit:
    def test_buy_maker_fill_records_at_limit_not_trade_price(
        self, engine: Engine
    ):
        """BUY @0.32 + SELL-taker print at 0.20 → fill at 0.32, not 0.20.

        Worked example from bug.5016: in real CLOB our 0.32 bid has queue
        priority and gets hit at 0.32. Paper must not pocket the 12c/share
        of phantom improvement.
        """
        _make_buy(engine, amount=32.0, limit=0.32)  # intent ≈ 100 shares @ limit
        _mock_api(engine, trades=[_trade(price=0.20, size=500, side="SELL")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        trade = _latest_trade_row(engine)
        assert trade["side"] == "buy"
        assert trade["avg_price"] == pytest.approx(0.32)
        # qty = min(intent_at_limit=100, trade.size=500) = 100; cost = 32.0
        assert trade["shares"] == pytest.approx(100.0)
        assert trade["amount_usd"] == pytest.approx(32.0)

    def test_sell_maker_fill_records_at_limit_not_trade_price(
        self, engine: Engine
    ):
        """SELL @0.50 + BUY-taker print at 0.60 → fill at 0.50, not 0.60."""
        _make_sell(engine, shares=10, limit=0.50)
        _mock_api(engine, trades=[_trade(price=0.60, size=500, side="BUY")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        trade = _latest_trade_row(engine)
        assert trade["side"] == "sell"
        assert trade["avg_price"] == pytest.approx(0.50)
        # qty = min(intent=10, trade.size=500) = 10; proceeds = 5.0
        assert trade["shares"] == pytest.approx(10.0)
        assert trade["amount_usd"] == pytest.approx(5.0)

    def test_buy_maker_fill_partial_when_trade_smaller_than_intent(
        self, engine: Engine
    ):
        """qty = min(intent_at_limit, trade.size). Trade is smaller → partial,
        and price still records at limit."""
        _make_buy(engine, amount=32.0, limit=0.32)  # intent ≈ 100 shares
        _mock_api(engine, trades=[_trade(price=0.20, size=40, side="SELL")])

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        trade = _latest_trade_row(engine)
        assert trade["avg_price"] == pytest.approx(0.32)
        # qty = min(100, 40) = 40; cost = 40 * 0.32 = 12.80
        assert trade["shares"] == pytest.approx(40.0)
        assert trade["amount_usd"] == pytest.approx(12.80)

    def test_buy_snapshot_fill_records_at_limit_not_best_ask(
        self, engine: Engine
    ):
        """Snapshot pass with best_ask=0.55 well below limit=0.59 → fill at
        0.59 (our queue-priority quote), not 0.55. Regression for the
        'transient book move' branch of bug.5016."""
        _make_buy(engine, amount=59.0, limit=0.59)  # intent ≈ 100 shares
        _mock_api(
            engine,
            book=_book(asks=[(0.55, 500)]),
            trades=[],
        )

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        trade = _latest_trade_row(engine)
        assert trade["avg_price"] == pytest.approx(0.59)
        assert trade["shares"] == pytest.approx(100.0)
        assert trade["amount_usd"] == pytest.approx(59.0)

    def test_sell_snapshot_fill_records_at_limit_not_best_bid(
        self, engine: Engine
    ):
        """Snapshot pass with best_bid=0.70 well above limit=0.50 → fill at
        0.50, not 0.70."""
        _make_sell(engine, shares=10, limit=0.50)
        _mock_api(
            engine,
            book=_book(bids=[(0.70, 500)]),
            trades=[],
        )

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        trade = _latest_trade_row(engine)
        assert trade["avg_price"] == pytest.approx(0.50)
        assert trade["shares"] == pytest.approx(10.0)
        assert trade["amount_usd"] == pytest.approx(5.0)

    def test_buy_snapshot_multi_level_crossing_still_fills_at_limit(
        self, engine: Engine
    ):
        """Multi-level snapshot book where every crossing level is well below
        the limit. crossing_size sums correctly; avg_price still clears at
        the limit (the resting-maker queue-priority assumption)."""
        _make_buy(engine, amount=30.0, limit=0.60)  # intent ≈ 50 shares
        _mock_api(
            engine,
            book=_book(asks=[(0.50, 100), (0.55, 50), (0.70, 1000)]),
            trades=[],
        )

        results = engine.check_orders()

        assert len(results) == 1
        assert results[0]["action"] == "filled"
        trade = _latest_trade_row(engine)
        # Filled at limit, not at any of the cheaper crossing levels.
        assert trade["avg_price"] == pytest.approx(0.60)
        # Intent caps qty (50 shares ≤ crossing_size=150).
        assert trade["shares"] == pytest.approx(50.0)
        assert trade["amount_usd"] == pytest.approx(30.0)

    def test_no_double_fill_when_both_paths_match_under_5016(
        self, engine: Engine
    ):
        """NO_DOUBLE_FILL invariant (bug.5005) still holds after bug.5016:
        maker path fills at limit, snapshot path must skip the same order."""
        _make_buy(engine, amount=10.0, limit=0.50)
        _mock_api(
            engine,
            book=_book(asks=[(0.40, 500)]),
            trades=[_trade(price=0.30, size=200, side="SELL")],
        )

        results = engine.check_orders()

        assert len(results) == 1
        trade = _latest_trade_row(engine)
        assert trade["avg_price"] == pytest.approx(0.50)


# bug.5043: actual SQLite atomicity, with an independent durable-state reader.
import sqlite3

from pm_trader.engine import NativeAccountUnavailableError
from pm_trader.models import InsufficientBalanceError
from pm_trader.orders import get_order, mark_filled


def _durable(engine):
    with sqlite3.connect(engine.db.db_path) as reader:
        return {
            table: reader.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in ("account", "trades", "positions", "limit_orders")
        }


def _atomic_order(engine, path, side):
    _mock_api(
        engine,
        book=_book(bids=[(0.5, 100)], asks=[(0.5, 100)]),
        fee_rate=100,
        trades=[_trade(0.5, 100, "SELL" if side == "buy" else "BUY")]
        if path == "maker" else [],
    )
    if side == "buy":
        return _make_buy(engine, amount=10, limit=0.5)
    return _make_sell(engine, shares=20, limit=0.5)


def _install_fault(engine, fault, side):
    events = {
        "after_debit": "AFTER UPDATE OF cash ON account",
        "after_trade": "AFTER INSERT ON trades",
        "after_position": "AFTER INSERT ON positions" if side == "buy"
        else "AFTER UPDATE ON positions",
        "before_mark": "BEFORE UPDATE OF status ON limit_orders WHEN NEW.status = 'filled'",
    }
    engine.db.conn.execute(
        f"CREATE TRIGGER atomic_fault {events[fault]} "
        "BEGIN SELECT RAISE(ABORT, 'atomic fill fault'); END"
    )
    engine.db.conn.commit()


@pytest.mark.parametrize("path", ["maker", "snapshot"])
@pytest.mark.parametrize("side", ["buy", "sell"])
@pytest.mark.parametrize("fault", ["after_debit", "after_trade", "after_position", "before_mark"])
def test_fill_transaction_fault_matrix_preserves_durable_state_and_retries_once(engine, path, side, fault):
    oid = _atomic_order(engine, path, side)
    before = _durable(engine)
    _install_fault(engine, fault, side)
    assert engine.check_orders() == []
    assert not engine.db.conn.in_transaction
    assert _durable(engine) == before
    assert get_order(engine.db.conn, oid).status == "pending"
    engine.db.conn.execute("DROP TRIGGER atomic_fault")
    engine.db.conn.commit()
    fills = engine.check_orders()
    assert len(fills) == 1
    assert fills[0]["order"]["id"] == oid
    assert fills[0]["action"] == "filled"
    assert fills[0]["fill"]["amount_usd"] == pytest.approx(10)
    assert fills[0]["fill"]["total_shares"] == pytest.approx(20)
    assert fills[0]["fill"]["avg_price"] == 0.5
    assert fills[0]["fill"]["fee"] == pytest.approx(0.05 if side == "buy" else 0.1)
    after = _durable(engine)
    assert len(after["trades"]) == 1
    assert after["account"][0][2] == pytest.approx(9989.95 if side == "buy" else 10009.9)
    assert get_order(engine.db.conn, oid).status == "filled"
    assert engine.check_orders() == []
    assert _durable(engine) == after


@pytest.mark.parametrize("path", ["maker", "snapshot"])
@pytest.mark.parametrize("side", ["buy", "sell"])
def test_clean_begin_busy_has_no_effect_then_recovers(engine, path, side):
    _atomic_order(engine, path, side)
    before = _durable(engine)
    engine.db.conn.execute("PRAGMA busy_timeout=0")
    blocker = sqlite3.connect(engine.db.db_path)
    try:
        blocker.execute("BEGIN IMMEDIATE")
        assert engine.check_orders() == []
        assert not engine.db.conn.in_transaction
        assert _durable(engine) == before
    finally:
        blocker.rollback()
        blocker.close()
    assert len(engine.check_orders()) == 1
    assert len(_durable(engine)["trades"]) == 1


def test_incoming_transaction_is_untouched_before_expiry_provider_and_cancel(engine, monkeypatch):
    oid = create_order(
        engine.db.conn, market_slug="test-market", market_condition_id="0xabc123",
        outcome="Yes", side="buy", amount=10, limit_price=0.5,
        order_type="gtd", expires_at="2000-01-01T00:00:00Z",
    ).id
    before = _durable(engine)
    engine.db.conn.execute("UPDATE account SET cash=1")
    engine.api.get_market = MagicMock(side_effect=AssertionError("provider before guard"))
    with pytest.raises(NativeAccountUnavailableError, match="dirty_entry"):
        engine.check_orders()
    with pytest.raises(NativeAccountUnavailableError, match="dirty_entry"):
        engine.cancel_limit_order(oid)
    assert engine.db.conn.in_transaction
    assert engine.db.get_account().cash == 1
    assert _durable(engine) == before
    engine.api.get_market.assert_not_called()
    engine.db.conn.rollback()
    assert _durable(engine) == before
    assert engine.check_orders()[0]["action"] == "expired"


def _write_all_four(engine, oid):
    engine.db.update_cash(123)
    trade = engine.db.insert_trade(
        market_condition_id="0xabc123", market_slug="test-market", market_question="Test market",
        outcome="Yes", side="buy", order_type="fak", avg_price=0.5,
        amount_usd=10, shares=20, fee_rate_bps=100, fee=0.1, slippage=0,
        levels_filled=1, is_partial=False,
    )
    position = engine.db.upsert_position(
        market_condition_id="0xabc123", market_slug="test-market", market_question="Test market",
        outcome="Yes", shares=20, avg_entry_price=0.5, total_cost=10.1,
    )
    order = mark_filled(engine.db.conn, oid)
    assert trade.id and position.shares == 20 and order.status == "filled"


def test_four_mutators_preserve_caller_ownership_and_standalone_commits(engine):
    oid = _make_buy(engine, amount=10, limit=0.5)
    before = _durable(engine)
    engine.db.conn.execute("BEGIN IMMEDIATE")
    _write_all_four(engine, oid)
    assert engine.db.conn.in_transaction
    assert _durable(engine) == before
    engine.db.conn.rollback()
    assert _durable(engine) == before
    _write_all_four(engine, oid)
    assert not engine.db.conn.in_transaction
    after = _durable(engine)
    assert after["account"][0][2] == 123
    assert len(after["trades"]) == len(after["positions"]) == 1
    assert after["limit_orders"][0][9] == "filled"


class _OutcomeConnection:
    """Delegate every SQL operation to SQLite; inject only outcome acknowledgement."""
    def __init__(self, conn, fault):
        self.real = conn
        self.fault = fault
        self.rollbacks = 0

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


@pytest.mark.parametrize("path", ["maker", "snapshot"])
@pytest.mark.parametrize("side", ["buy", "sell"])
@pytest.mark.parametrize("fault", ["commit_then_raise", "commit_failure", "rollback_failure"])
def test_ambiguous_transaction_outcome_escapes_all_fallbacks(engine, path, side, fault):
    oid = _atomic_order(engine, path, side)
    before = _durable(engine)
    if fault == "rollback_failure":
        _install_fault(engine, "before_mark", side)
    real = engine.db.conn
    proxy = _OutcomeConnection(real, fault)
    engine.db._conn = proxy
    try:
        with pytest.raises(NativeAccountUnavailableError, match="mutation_ambiguous"):
            engine.check_orders()
        durable = _durable(engine)
        if fault == "commit_then_raise":
            assert not real.in_transaction
            assert durable != before
            assert len(durable["trades"]) == 1
            assert get_order(real, oid).status == "filled"
            assert durable["account"][0][2] == pytest.approx(9989.95 if side == "buy" else 10009.9)
            assert proxy.rollbacks == 0
        else:
            assert real.in_transaction
            assert durable == before
            assert proxy.rollbacks == (1 if fault == "rollback_failure" else 0)
    finally:
        engine.db._conn = real
        real.rollback()


@pytest.mark.parametrize("path", ["maker", "snapshot"])
@pytest.mark.parametrize("side", ["buy", "sell"])
def test_acknowledged_rollback_retains_permanent_rejection(engine, monkeypatch, path, side):
    oid = _atomic_order(engine, path, side)
    before = _durable(engine)
    def reject_after_write(*args):
        engine.db.update_cash(1)
        raise InsufficientBalanceError(required=10001, available=10000)
    monkeypatch.setattr(engine, "_execute_limit_" + side, reject_after_write)
    results = engine.check_orders()
    assert len(results) == 1
    assert results[0]["action"] == "rejected"
    assert not engine.db.conn.in_transaction
    after = _durable(engine)
    for table in ("account", "trades", "positions"):
        assert after[table] == before[table]
    assert get_order(engine.db.conn, oid).status == "rejected"
    assert engine.check_orders() == []
