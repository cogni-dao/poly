"""Trade execution engine for pm-trader.

Orchestrates the full buy/sell/resolve workflow by wiring together
the API client, order book simulator, and database layer.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path

from pm_trader.api import PolymarketClient

# Cogni-poly local patch (bug.5005). Module logger for the maker-fill branch
# — the sidecar's stdout is harvested by Alloy → Loki, so structured single-
# line `event=<verb>` records are the operational signal we get.
_log = logging.getLogger(__name__)

# Cogni-poly local patch (bug.5005). When the trade-prints scan returns empty
# or errors, the per-token cursor advances no farther than ``now - LAG``. This
# guards the silent-miss path: data-api lags trades by seconds; if we jumped
# the cursor to ``now`` on every empty response, a trade that printed during
# the lag window would be filtered out (``ts <= since_ts``) on the very next
# tick and never matched. 90s ≈ 3 × default 30s fill-loop period — enough
# headroom for data-api's typical staleness without unbounded window growth.
_MAKER_FILL_LAG_BUFFER_SECONDS = 90.0
from pm_trader.db import Database
from pm_trader.models import (
    Account,
    AmbiguousResolutionError,
    ApiError,
    InsufficientBalanceError,
    InvalidOutcomeError,
    MarketClosedError,
    NoPositionError,
    NotInitializedError,
    OrderBook,
    OrderBookLevel,
    OrderRejectedError,
    Position,
    ResolveResult,
    Trade,
    TradeResult,
)
from pm_trader.orders import (
    LimitOrder,
    cancel_order,
    create_order,
    expire_orders,
    get_pending_orders,
    init_orders_schema,
    mark_filled,
    reject_order,
    should_fill,
)
from pm_trader.orderbook import simulate_buy_fill, simulate_sell_fill

MIN_ORDER_USD = 1.0  # Polymarket minimum order size

# Errors that indicate an order is permanently unfillable (not transient)
_PERMANENT_ORDER_ERRORS = (
    OrderRejectedError,
    InsufficientBalanceError,
    InvalidOutcomeError,
    MarketClosedError,
    NoPositionError,
)


class Engine:
    """Paper trading engine — 1:1 faithful to Polymarket execution."""

    def __init__(self, data_dir: Path) -> None:
        self.db = Database(data_dir)
        self.db.init_schema()
        init_orders_schema(self.db.conn)
        self.api = PolymarketClient(self.db)
        # Cogni-poly local patch (bug.5005): per-token cursor for the
        # maker-fill (trade-prints) branch of `check_orders`. Volatile —
        # rebuilt on pod restart from order.created_at for any pending
        # order on the token, see `_apply_maker_fills`.
        self._maker_fill_last_scan: dict[str, float] = {}

    def close(self) -> None:
        self.api.close()
        self.db.close()

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------

    def init_account(self, balance: float = 10_000.0) -> Account:
        return self.db.init_account(balance)

    def get_account(self) -> Account:
        account = self.db.get_account()
        if account is None:
            raise NotInitializedError()
        return account

    def reset(self) -> None:
        self.db.reset()
        init_orders_schema(self.db.conn)

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------

    def _require_account(self) -> Account:
        return self.get_account()

    @staticmethod
    def _validate_outcome(outcome: str, market=None) -> str:
        """Validate and normalize outcome against the market's actual outcomes.

        When market is provided, verifies the outcome exists in that market.
        Without market, only normalizes (caller is responsible for validation).
        """
        outcome = outcome.lower().strip()
        if not outcome:
            raise InvalidOutcomeError(outcome)
        if market is not None:
            valid = [o.lower() for o in market.outcomes]
            if outcome not in valid:
                raise InvalidOutcomeError(outcome, valid)
        return outcome

    # ------------------------------------------------------------------
    # BUY — spend USD, receive shares
    # ------------------------------------------------------------------

    def buy(
        self,
        slug_or_id: str,
        outcome: str,
        amount_usd: float,
        order_type: str = "fok",
    ) -> TradeResult:
        """Execute a buy order: spend amount_usd to receive shares.

        Walks the real order book ASK side level-by-level.
        """
        account = self._require_account()

        if amount_usd < MIN_ORDER_USD:
            raise OrderRejectedError(
                f"Minimum order size is ${MIN_ORDER_USD:.2f}"
            )

        # Fetch market and validate outcome against actual market outcomes
        market = self.api.get_market(slug_or_id)
        outcome = self._validate_outcome(outcome, market)

        # Fetch live order book and fee rate
        token_id = market.get_token_id(outcome)
        book = self.api.get_order_book(token_id)
        fee_rate_bps = self.api.get_fee_rate(token_id)

        if market.closed:
            raise MarketClosedError(market.slug)

        # Simulate fill against the real order book
        fill = simulate_buy_fill(book, amount_usd, fee_rate_bps, order_type)

        if not fill.filled and not fill.is_partial:
            raise OrderRejectedError(
                "Insufficient liquidity in order book (FOK rejected)"
            )

        # Check cash: need total_cost + fee
        total_outflow = fill.total_cost + fill.fee
        if total_outflow > account.cash:
            raise InsufficientBalanceError(
                required=total_outflow, available=account.cash
            )

        # Update cash
        new_cash = account.cash - total_outflow
        self.db.update_cash(new_cash)

        # Record trade
        trade = self.db.insert_trade(
            market_condition_id=market.condition_id,
            market_slug=market.slug,
            market_question=market.question,
            outcome=outcome,
            side="buy",
            order_type=order_type,
            avg_price=fill.avg_price,
            amount_usd=fill.total_cost,
            shares=fill.total_shares,
            fee_rate_bps=fee_rate_bps,
            fee=fill.fee,
            slippage=fill.slippage_bps,
            levels_filled=fill.levels_filled,
            is_partial=fill.is_partial,
        )

        # Update position
        self._update_position_after_buy(
            market=market,
            outcome=outcome,
            new_shares=fill.total_shares,
            cost=fill.total_cost + fill.fee,
            avg_fill_price=fill.avg_price,
        )

        updated_account = self.get_account()
        return TradeResult(trade=trade, account=updated_account)

    def _update_position_after_buy(
        self,
        *,
        market,
        outcome: str,
        new_shares: float,
        cost: float,
        avg_fill_price: float,
    ) -> None:
        """Update or create position after a buy."""
        existing = self.db.get_position(market.condition_id, outcome)
        if existing and existing.shares > 0:
            total_shares = existing.shares + new_shares
            total_cost = existing.total_cost + cost
            avg_entry = total_cost / total_shares if total_shares > 0 else 0.0
        else:
            total_shares = new_shares
            total_cost = cost
            avg_entry = avg_fill_price

        self.db.upsert_position(
            market_condition_id=market.condition_id,
            market_slug=market.slug,
            market_question=market.question,
            outcome=outcome,
            shares=total_shares,
            avg_entry_price=avg_entry,
            total_cost=total_cost,
            realized_pnl=existing.realized_pnl if existing else 0.0,
        )

    # ------------------------------------------------------------------
    # SELL — sell shares, receive USD
    # ------------------------------------------------------------------

    def sell(
        self,
        slug_or_id: str,
        outcome: str,
        shares: float,
        order_type: str = "fok",
    ) -> TradeResult:
        """Execute a sell order: sell shares to receive USD.

        Walks the real order book BID side level-by-level.
        """
        account = self._require_account()

        # Fetch market and validate outcome against actual market outcomes
        market = self.api.get_market(slug_or_id)
        outcome = self._validate_outcome(outcome, market)
        position = self.db.get_position(market.condition_id, outcome)
        if position is None or position.shares <= 0:
            raise NoPositionError(market.slug, outcome)

        if shares > position.shares:
            raise OrderRejectedError(
                f"Cannot sell {shares:.4f} shares, only hold {position.shares:.4f}"
            )

        if market.closed:
            raise MarketClosedError(market.slug)

        # Fetch live book and fee rate
        token_id = market.get_token_id(outcome)
        book = self.api.get_order_book(token_id)
        fee_rate_bps = self.api.get_fee_rate(token_id)

        # Simulate fill against the real order book
        fill = simulate_sell_fill(book, shares, fee_rate_bps, order_type)

        if not fill.filled and not fill.is_partial:
            raise OrderRejectedError(
                "Insufficient liquidity in order book (FOK rejected)"
            )

        # Net proceeds = gross - fee
        net_proceeds = fill.total_cost - fill.fee

        # Update cash
        new_cash = account.cash + net_proceeds
        self.db.update_cash(new_cash)

        # Record trade
        trade = self.db.insert_trade(
            market_condition_id=market.condition_id,
            market_slug=market.slug,
            market_question=market.question,
            outcome=outcome,
            side="sell",
            order_type=order_type,
            avg_price=fill.avg_price,
            amount_usd=fill.total_cost,
            shares=fill.total_shares,
            fee_rate_bps=fee_rate_bps,
            fee=fill.fee,
            slippage=fill.slippage_bps,
            levels_filled=fill.levels_filled,
            is_partial=fill.is_partial,
        )

        # Update position
        self._update_position_after_sell(
            market=market,
            outcome=outcome,
            sold_shares=fill.total_shares,
            proceeds=net_proceeds,
        )

        updated_account = self.get_account()
        return TradeResult(trade=trade, account=updated_account)

    def _update_position_after_sell(
        self,
        *,
        market,
        outcome: str,
        sold_shares: float,
        proceeds: float,
    ) -> None:
        """Update position after a sell."""
        existing = self.db.get_position(market.condition_id, outcome)
        if existing is None:
            return

        remaining_shares = existing.shares - sold_shares
        # Cost basis of sold portion
        cost_of_sold = (
            existing.avg_entry_price * sold_shares
            if existing.shares > 0
            else 0.0
        )
        realized_pnl = existing.realized_pnl + (proceeds - cost_of_sold)
        remaining_cost = existing.total_cost - cost_of_sold

        self.db.upsert_position(
            market_condition_id=market.condition_id,
            market_slug=market.slug,
            market_question=market.question,
            outcome=outcome,
            shares=max(remaining_shares, 0.0),
            avg_entry_price=existing.avg_entry_price,
            total_cost=max(remaining_cost, 0.0),
            realized_pnl=realized_pnl,
        )

    # ------------------------------------------------------------------
    # Portfolio
    # ------------------------------------------------------------------

    def get_portfolio(self) -> list[dict]:
        """Return open positions with live prices and unrealized P&L."""
        self._require_account()
        positions = self.db.get_open_positions()
        result = []
        for pos in positions:
            try:
                token_id = self._get_token_id_for_position(pos)
                live_price = self.api.get_midpoint(token_id)
            except Exception:
                live_price = 0.0

            result.append({
                "market_slug": pos.market_slug,
                "market_question": pos.market_question,
                "outcome": pos.outcome,
                "shares": pos.shares,
                "avg_entry_price": pos.avg_entry_price,
                "total_cost": pos.total_cost,
                "live_price": live_price,
                "current_value": pos.current_value(live_price),
                "unrealized_pnl": pos.unrealized_pnl(live_price),
                "percent_pnl": pos.percent_pnl(live_price),
            })
        return result

    def _get_token_id_for_position(self, pos: Position) -> str:
        """Resolve a position to its token_id for price lookups."""
        market = self.api.get_market(pos.market_slug)
        return market.get_token_id(pos.outcome)

    # ------------------------------------------------------------------
    # Balance
    # ------------------------------------------------------------------

    def get_balance(self) -> dict:
        """Return cash, positions value, and total account value."""
        account = self._require_account()
        portfolio = self.get_portfolio()
        positions_value = sum(p["current_value"] for p in portfolio)
        return {
            "cash": account.cash,
            "starting_balance": account.starting_balance,
            "positions_value": positions_value,
            "total_value": account.cash + positions_value,
            "pnl": (account.cash + positions_value) - account.starting_balance,
        }

    # ------------------------------------------------------------------
    # Trade history
    # ------------------------------------------------------------------

    def get_history(self, limit: int = 50) -> list[Trade]:
        """Return recent trades."""
        self._require_account()
        return self.db.get_trades(limit)

    # ------------------------------------------------------------------
    # Limit orders (GTC / GTD)
    # ------------------------------------------------------------------

    def place_limit_order(
        self,
        slug_or_id: str,
        outcome: str,
        side: str,
        amount: float,
        limit_price: float,
        order_type: str = "gtc",
        expires_at: str | None = None,
    ) -> dict:
        """Place a GTC or GTD limit order."""
        self._require_account()
        if side not in ("buy", "sell"):
            raise OrderRejectedError(f"Invalid side: {side!r}")
        if not (0 < limit_price < 1):
            raise OrderRejectedError(f"Limit price must be between 0 and 1, got {limit_price}")
        if order_type not in ("gtc", "gtd"):
            raise OrderRejectedError(f"Invalid order_type: {order_type!r}. Must be 'gtc' or 'gtd'.")
        if order_type == "gtd" and not expires_at:
            raise OrderRejectedError("GTD orders require expires_at timestamp")
        if side == "buy" and amount < MIN_ORDER_USD:
            raise OrderRejectedError(f"Minimum buy order size is ${MIN_ORDER_USD:.2f}, got ${amount:.2f}")

        market = self.api.get_market(slug_or_id)
        outcome = self._validate_outcome(outcome, market)
        order = create_order(
            self.db.conn,
            market_slug=market.slug,
            market_condition_id=market.condition_id,
            outcome=outcome,
            side=side,
            amount=amount,
            limit_price=limit_price,
            order_type=order_type,
            expires_at=expires_at,
        )
        return _order_to_dict(order)

    def get_pending_orders(self) -> list[dict]:
        """Return all pending limit orders."""
        orders = get_pending_orders(self.db.conn)
        return [_order_to_dict(o) for o in orders]

    def cancel_limit_order(self, order_id: int) -> dict | None:
        """Cancel a pending limit order."""
        order = cancel_order(self.db.conn, order_id)
        if order is None:
            return None
        return _order_to_dict(order)

    def check_orders(self) -> list[dict]:
        """Check all pending orders against live prices and execute fills.

        This is the agent-callable trigger. Call it periodically.
        Returns list of filled/expired orders.

        Two-pass fill model:

        1. **Maker-fill pre-pass** (Cogni-poly local patch, bug.5005). For each
           pending order, scan Polymarket trade prints on its tokenId since
           the last poll. Any trade that crosses our limit (BUY: SELL-taker
           trade at price ≤ limit; SELL: BUY-taker trade at price ≥ limit)
           fills the order at ``order.limit_price`` for ``min(remaining_intent,
           trade.size)`` (bug.5016 — paper must not pocket free price
           improvement past its own quote).

        2. **Snapshot taker pass** (upstream behavior, Cogni-poly patched).
           For orders not filled by the pre-pass, check the current orderbook:
           BUY orders fill when current best_ask ≤ limit, SELL orders fill when
           best_bid ≥ limit. Fills clear at ``order.limit_price`` for the total
           size at crossing levels (bug.5016). Guarantees no "price-through"
           fills.
        """
        self._require_account()
        results = []

        # First expire any GTD orders past their deadline
        expired = expire_orders(self.db.conn)
        for o in expired:
            results.append({"order": _order_to_dict(o), "action": "expired"})

        # Cogni-poly local patch (bug.5005): maker-fill pre-pass — fill orders
        # matched by ambient taker flow during the polling interval. Orders
        # filled here are skipped by the snapshot loop below.
        pending = get_pending_orders(self.db.conn)
        try:
            filled_via_maker = self._apply_maker_fills(pending, results)
        except Exception:
            # Don't let maker-fill failures abort the loop — snapshot path
            # still runs for every order this tick. Log the exception so a
            # consistently-throwing maker pass surfaces in Loki rather than
            # silently degrading paper fill rate.
            _log.exception("event=maker_fill_pass_failed pending=%d", len(pending))
            filled_via_maker = set()

        # Snapshot taker pass (upstream behavior).
        for order in pending:
            if order.id in filled_via_maker:
                continue
            try:
                market = self.api.get_market(order.market_slug)
                token_id = market.get_token_id(order.outcome)
                book = self.api.get_order_book(token_id)
                fee_rate_bps = self.api.get_fee_rate(token_id)

                # Cogni-poly local patch (bug.5016). When the snapshot crosses
                # our limit, fill at ``order.limit_price``, not at the observed
                # best-ask/best-bid. As the resting maker, our quote would have
                # been hit at the limit — paper must not pocket free price
                # improvement no real CLOB would have granted. Fill size is
                # bounded by the total liquidity at crossing levels: at least
                # that much taker flow must have crossed us during the poll.
                if order.side == "buy":
                    crossing_size = sum(
                        l.size for l in book.asks if l.price <= order.limit_price
                    )
                    if crossing_size <= 0:
                        continue
                    syn_book = OrderBook(
                        bids=[],
                        asks=[OrderBookLevel(
                            price=order.limit_price, size=crossing_size,
                        )],
                    )
                    # max_price/min_price dropped: syn_book has a single level
                    # already at limit_price, so the simulator's price guard
                    # could never trip.
                    fill = simulate_buy_fill(
                        syn_book, order.amount, fee_rate_bps, "fak",
                    )
                else:
                    crossing_size = sum(
                        l.size for l in book.bids if l.price >= order.limit_price
                    )
                    if crossing_size <= 0:
                        continue
                    syn_book = OrderBook(
                        bids=[OrderBookLevel(
                            price=order.limit_price, size=crossing_size,
                        )],
                        asks=[],
                    )
                    fill = simulate_sell_fill(
                        syn_book, order.amount, fee_rate_bps, "fak",
                    )

                if not fill.filled and not fill.is_partial:
                    continue  # No fillable liquidity within limit

                # Execute the fill through normal trade recording
                if order.side == "buy":
                    trade = self._execute_limit_buy(market, order, fill, fee_rate_bps)
                else:
                    trade = self._execute_limit_sell(market, order, fill, fee_rate_bps)

                updated = mark_filled(self.db.conn, order.id)
                # bug.5018 — surface realized fill data on the result entry so
                # the sidecar's fill loop can populate OrderReceipt.fill_price
                # / total_shares / fees_usdc without a follow-up history lookup.
                results.append({
                    "order": _order_to_dict(updated),
                    "action": "filled",
                    "fill": {
                        "avg_price": trade.avg_price,
                        "total_shares": trade.shares,
                        "fee": trade.fee,
                        "amount_usd": trade.amount_usd,
                    },
                })
            except _PERMANENT_ORDER_ERRORS as e:
                # Permanent failure — mark rejected so it's not retried
                updated = reject_order(self.db.conn, order.id)
                results.append({
                    "order": _order_to_dict(updated),
                    "action": "rejected",
                    "reason": str(e),
                })
            except Exception:
                continue  # Transient errors (network, API) — retry next check

        return results

    # ------------------------------------------------------------------
    # Maker-fill pre-pass (Cogni-poly local patch, bug.5005)
    # ------------------------------------------------------------------

    def _apply_maker_fills(
        self, pending: list[LimitOrder], results: list[dict]
    ) -> set[int]:
        """Match pending limits against recent taker trade prints.

        For each tokenId with pending orders, do **one** ``get_trades_since``
        call (per-token batching). For each crossing trade — BUY-taker at
        price ≥ a pending SELL's limit, SELL-taker at price ≤ a pending BUY's
        limit — synthesize a 1-level book at the trade's price+size and
        feed it through the existing ``simulate_buy_fill`` /
        ``simulate_sell_fill`` so all fee math, partial-fill semantics, and
        FillResult shape stay consistent with the snapshot path.

        Returns the set of order ids filled or rejected this pass — the
        caller skips them in the snapshot loop so no order can be matched
        by both paths in one tick (NO_DOUBLE_FILL invariant, bug.5005).

        Failures inside this method are bounded — caught at the outer
        ``check_orders`` try/except so a flaky data-api never aborts the
        loop. Per-token failures fall through to the snapshot path.
        """
        filled_ids: set[int] = set()
        if not pending:
            return filled_ids

        now_ts = time.time()

        # Per-token batching — collect orders on the same (market_slug,
        # outcome). One ``get_trades_since`` call per token regardless of
        # how many tenants are mirroring the same target into that token.
        by_market: dict[tuple[str, str], list[LimitOrder]] = {}
        for order in pending:
            by_market.setdefault(
                (order.market_slug, order.outcome), []
            ).append(order)

        for (market_slug, outcome), orders in by_market.items():
            try:
                market = self.api.get_market(market_slug)
                token_id = market.get_token_id(outcome)
                fee_rate_bps = self.api.get_fee_rate(token_id)
            except Exception:
                # Snapshot path will retry on this token; we just skip
                # the maker pre-pass for it this tick.
                _log.exception(
                    "event=maker_fill_resolve_failed market_slug=%s outcome=%s",
                    market_slug, outcome,
                )
                continue

            # Seed the per-token scan cursor from the oldest pending order
            # so a pod restart (which wipes _maker_fill_last_scan) doesn't
            # silently skip the trade window between order placement and
            # restart.
            if token_id not in self._maker_fill_last_scan:
                self._maker_fill_last_scan[token_id] = (
                    self._oldest_pending_created_ts(orders)
                )
            since_ts = self._maker_fill_last_scan[token_id]

            # On empty/error responses, the cursor advances no farther than
            # ``now - LAG``. Jumping to ``now`` would silently filter out any
            # trade that printed during the data-api's own staleness window
            # (``ts <= since_ts`` on the next tick). The floor keeps the
            # window growth bounded while preserving the lag headroom.
            bounded_advance = max(since_ts, now_ts - _MAKER_FILL_LAG_BUFFER_SECONDS)

            try:
                trades = self.api.get_trades_since(
                    condition_id=market.condition_id,
                    token_id=token_id,
                    since_ts=since_ts,
                )
            except Exception:
                # Data-API down or rate-limited. Advance the cursor by the
                # bounded amount, then fall through to snapshot for this
                # token. Log so persistent failures show up in Loki.
                _log.exception(
                    "event=maker_fill_scan_failed token_id=%s condition_id=%s since_ts=%.3f",
                    token_id, market.condition_id, since_ts,
                )
                self._maker_fill_last_scan[token_id] = bounded_advance
                continue

            _log.info(
                "event=maker_fill_scan token_id=%s condition_id=%s since_ts=%.3f "
                "trades=%d orders=%d",
                token_id, market.condition_id, since_ts, len(trades), len(orders),
            )

            # Cogni-poly local patch (bug.5005). When trades are present and
            # zero orders fill (the observed candidate-a steady state as of
            # 2026-05-17), we need to distinguish "filter rejected a real
            # crossing trade" (code bug) from "no trade ever crossed our
            # limits" (market structure). Pre-compute the (order × trade)
            # cross-product classification + emit one bounded summary so the
            # main matching loop's silence becomes diagnosable. Counts only
            # plus one anonymous sample of each side; trade/limit prices are
            # public market data, not PII.
            if trades:
                xprod = {"would_match": 0, "side_mismatch": 0, "wrong_price": 0}
                for o in orders:
                    expected_taker = "SELL" if o.side == "buy" else "BUY"
                    for t in trades:
                        if t["side"] != expected_taker:
                            xprod["side_mismatch"] += 1
                            continue
                        crossed = (
                            (o.side == "buy" and t["price"] <= o.limit_price)
                            or (o.side == "sell" and t["price"] >= o.limit_price)
                        )
                        if not crossed:
                            xprod["wrong_price"] += 1
                            continue
                        xprod["would_match"] += 1
                sample_o = min(orders, key=lambda o: o.id)
                sample_t = trades[0]
                _log.info(
                    "event=maker_fill_scan_detail token_id=%s "
                    "would_match=%d side_mismatch=%d wrong_price=%d "
                    "sample_order_side=%s sample_order_limit=%.4f "
                    "sample_trade_side=%s sample_trade_price=%.4f "
                    "sample_trade_size=%.4f",
                    token_id,
                    xprod["would_match"], xprod["side_mismatch"], xprod["wrong_price"],
                    sample_o.side, sample_o.limit_price,
                    sample_t["side"], sample_t["price"], sample_t["size"],
                )

            # With trades, advance to the newest observed ts (next tick's
            # ``ts > since_ts`` filter catches anything newer). Without
            # trades, use the bounded advance so a lagged trade in the
            # data-api's staleness window isn't filtered out next tick.
            if trades:
                self._maker_fill_last_scan[token_id] = max(
                    t["timestamp"] for t in trades
                )
            else:
                self._maker_fill_last_scan[token_id] = bounded_advance
                continue

            # Walk trades oldest-first so newer trades on the same token
            # can still match an order the older trade only partially
            # exhausted. Deterministic intra-tick allocation: trade size is
            # consumed across orders sorted by order.id (no queue position
            # modeling — same simplification as the snapshot path).
            trades_sorted = sorted(trades, key=lambda t: t["timestamp"])
            for trade in trades_sorted:
                t_price = trade["price"]
                t_side = trade["side"]
                remaining_trade_size = trade["size"]

                for order in sorted(orders, key=lambda o: o.id):
                    if order.id in filled_ids:
                        continue
                    if remaining_trade_size <= 0:
                        break

                    # Side semantics: taker side opposite of resting limit.
                    # See `api.get_trades_since` docstring.
                    #
                    # Cogni-poly local patch (bug.5016). The synthesized 1-level
                    # book is built at ``order.limit_price``, NOT ``t_price``.
                    # As the resting maker, our quote held queue priority at the
                    # limit and would have been hit at the limit — the taker
                    # never sees a price improvement past our quote. Sizing the
                    # synthesized level at ``remaining_trade_size`` still caps
                    # fills to the taker volume that actually crossed.
                    if order.side == "buy":
                        if t_side != "SELL" or t_price > order.limit_price:
                            continue
                        syn_book = OrderBook(
                            bids=[],
                            asks=[
                                OrderBookLevel(
                                    price=order.limit_price,
                                    size=remaining_trade_size,
                                )
                            ],
                        )
                        fill = simulate_buy_fill(
                            syn_book,
                            order.amount,
                            fee_rate_bps,
                            "fak",
                            max_price=order.limit_price,
                        )
                    else:
                        if t_side != "BUY" or t_price < order.limit_price:
                            continue
                        syn_book = OrderBook(
                            bids=[
                                OrderBookLevel(
                                    price=order.limit_price,
                                    size=remaining_trade_size,
                                )
                            ],
                            asks=[],
                        )
                        fill = simulate_sell_fill(
                            syn_book,
                            order.amount,
                            fee_rate_bps,
                            "fak",
                            min_price=order.limit_price,
                        )

                    if not fill.filled and not fill.is_partial:
                        continue

                    # Execute through the same recording path as snapshot
                    # fills so trade rows, position deltas, and cash
                    # accounting are identical in shape.
                    try:
                        if order.side == "buy":
                            trade = self._execute_limit_buy(
                                market, order, fill, fee_rate_bps
                            )
                        else:
                            trade = self._execute_limit_sell(
                                market, order, fill, fee_rate_bps
                            )
                        updated = mark_filled(self.db.conn, order.id)
                        filled_ids.add(order.id)
                        # bug.5018 — see snapshot pass above; same shape.
                        results.append({
                            "order": _order_to_dict(updated),
                            "action": "filled",
                            "fill": {
                                "avg_price": trade.avg_price,
                                "total_shares": trade.shares,
                                "fee": trade.fee,
                                "amount_usd": trade.amount_usd,
                            },
                        })
                    except _PERMANENT_ORDER_ERRORS as e:
                        updated = reject_order(self.db.conn, order.id)
                        # Mark as handled so the snapshot path doesn't retry
                        # and double-reject.
                        filled_ids.add(order.id)
                        results.append({
                            "order": _order_to_dict(updated),
                            "action": "rejected",
                            "reason": str(e),
                        })
                    except Exception:
                        # Transient — leave the order unfilled, snapshot
                        # path may pick it up this tick or it'll be retried
                        # next tick. Log so we can tell "every tick throws"
                        # from "no crossing trades."
                        _log.exception(
                            "event=maker_fill_execute_failed order_id=%d token_id=%s",
                            order.id, token_id,
                        )
                        continue

                    remaining_trade_size -= fill.total_shares

        return filled_ids

    @staticmethod
    def _oldest_pending_created_ts(orders: list[LimitOrder]) -> float:
        """Convert oldest pending order's ``created_at`` to unix seconds.

        Used to seed the per-token maker-fill scan cursor on the first
        ``check_orders`` call after process start (the cursor is in-memory
        only). Returns ``0.0`` if every order has an unparseable
        ``created_at`` — the subsequent ``get_trades_since`` call will
        bound the window via Polymarket's own limit parameter.
        """
        oldest: float | None = None
        for o in orders:
            raw = o.created_at
            if not raw:
                continue
            try:
                ts = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
            except (ValueError, AttributeError):
                continue
            if oldest is None or ts < oldest:
                oldest = ts
        return oldest if oldest is not None else 0.0

    def _execute_limit_buy(self, market, order, fill, fee_rate_bps: int):
        """Record a limit buy fill using a pre-computed FillResult.

        Returns the inserted Trade so callers (`check_orders` result entries,
        bug.5018) can surface realized fill data on the wire.
        """
        account = self._require_account()
        total_outflow = fill.total_cost + fill.fee
        if total_outflow > account.cash:
            raise InsufficientBalanceError(
                required=total_outflow, available=account.cash,
            )
        self.db.update_cash(account.cash - total_outflow)
        trade = self.db.insert_trade(
            market_condition_id=market.condition_id,
            market_slug=market.slug,
            market_question=market.question,
            outcome=order.outcome,
            side="buy",
            order_type="fak",
            avg_price=fill.avg_price,
            amount_usd=fill.total_cost,
            shares=fill.total_shares,
            fee_rate_bps=fee_rate_bps,
            fee=fill.fee,
            slippage=fill.slippage_bps,
            levels_filled=fill.levels_filled,
            is_partial=fill.is_partial,
        )
        self._update_position_after_buy(
            market=market,
            outcome=order.outcome,
            new_shares=fill.total_shares,
            cost=fill.total_cost + fill.fee,
            avg_fill_price=fill.avg_price,
        )
        return trade

    def _execute_limit_sell(self, market, order, fill, fee_rate_bps: int):
        """Record a limit sell fill using a pre-computed FillResult.

        Returns the inserted Trade so callers (`check_orders` result entries,
        bug.5018) can surface realized fill data on the wire.
        """
        account = self._require_account()
        position = self.db.get_position(market.condition_id, order.outcome)
        if position is None or position.shares <= 0:
            raise NoPositionError(market.slug, order.outcome)
        if fill.total_shares > position.shares:
            raise OrderRejectedError(
                f"Cannot sell {fill.total_shares:.4f} shares, "
                f"only hold {position.shares:.4f}"
            )
        net_proceeds = fill.total_cost - fill.fee
        self.db.update_cash(account.cash + net_proceeds)
        trade = self.db.insert_trade(
            market_condition_id=market.condition_id,
            market_slug=market.slug,
            market_question=market.question,
            outcome=order.outcome,
            side="sell",
            order_type="fak",
            avg_price=fill.avg_price,
            amount_usd=fill.total_cost,
            shares=fill.total_shares,
            fee_rate_bps=fee_rate_bps,
            fee=fill.fee,
            slippage=fill.slippage_bps,
            levels_filled=fill.levels_filled,
            is_partial=fill.is_partial,
        )
        self._update_position_after_sell(
            market=market,
            outcome=order.outcome,
            sold_shares=fill.total_shares,
            proceeds=net_proceeds,
        )
        return trade

    def watch_prices(
        self, slugs_or_ids: list[str], outcomes: list[str] | None = None,
    ) -> list[dict]:
        """Fetch live midpoint prices for given markets.

        Agent calls this to monitor prices before deciding to trade.
        """
        results = []
        if outcomes is None:
            outcomes = ["yes"]
        for slug in slugs_or_ids:
            try:
                market = self.api.get_market(slug)
            except Exception:
                continue  # Market not found or API error
            for outcome in outcomes:
                outcome = outcome.lower()
                token_id = market.get_token_id(outcome)  # raises ValueError for invalid
                try:
                    mid = self.api.get_midpoint(token_id)
                except Exception:
                    continue  # API error fetching price
                results.append({
                    "market_slug": market.slug,
                    "outcome": outcome,
                    "midpoint": mid,
                    "condition_id": market.condition_id,
                })
        return results

    # ------------------------------------------------------------------
    # Resolution
    # ------------------------------------------------------------------

    def resolve_market(self, slug_or_id: str) -> list[ResolveResult]:
        """Resolve a market's positions, paying out $1/share for winner."""
        account = self._require_account()
        market = self.api.get_market(slug_or_id)

        if not market.closed:
            raise MarketClosedError(
                f"{market.slug} is not yet closed/resolved"
            )

        positions = self.db.get_positions_for_market(market.condition_id)
        if not positions:
            raise NoPositionError(market.slug, "any")

        winning_outcome = _determine_winner(market)

        results = []
        for pos in positions:
            if pos.is_resolved or pos.shares <= 0:
                continue

            if pos.outcome == winning_outcome:
                payout = pos.shares * 1.0
            else:
                payout = 0.0

            resolved_pos = self.db.resolve_position(
                market.condition_id, pos.outcome, payout
            )

            # Add payout to cash
            account = self.get_account()
            new_cash = account.cash + payout
            self.db.update_cash(new_cash)
            account = self.get_account()

            results.append(ResolveResult(
                position=resolved_pos,
                payout=payout,
                account=account,
            ))

        return results

    def resolve_all(self) -> list[ResolveResult]:
        """Resolve all open positions in closed markets.

        Skips markets that fail due to transient API/network errors.
        Raises on permanent resolution failures (e.g. ambiguous outcomes).
        """
        self._require_account()
        positions = self.db.get_open_positions()
        all_results = []

        seen_markets: set[str] = set()
        for pos in positions:
            if pos.market_condition_id in seen_markets:
                continue
            try:
                market = self.api.get_market(pos.market_slug)
                if market.closed:
                    seen_markets.add(pos.market_condition_id)
                    results = self.resolve_market(pos.market_slug)
                    all_results.extend(results)
            except (ApiError, ConnectionError, TimeoutError, OSError):
                continue  # Transient — retry on next call

        return all_results


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _determine_winner(market) -> str:
    """Determine the winning outcome from a resolved market's prices.

    Raises SimError if no outcome has price >= 0.99, preventing silent
    zero-payout on ambiguous or partially-resolved markets.
    """
    for i, outcome in enumerate(market.outcomes):
        price = market.outcome_prices[i] if i < len(market.outcome_prices) else 0.0
        if price >= 0.99:
            return outcome.lower()
    prices = dict(zip(market.outcomes, market.outcome_prices))
    raise AmbiguousResolutionError(market.slug, prices)


def _order_to_dict(order) -> dict:
    """Convert a LimitOrder to a JSON-safe dict."""
    return {
        "id": order.id,
        "market_slug": order.market_slug,
        "market_condition_id": order.market_condition_id,
        "outcome": order.outcome,
        "side": order.side,
        "amount": order.amount,
        "limit_price": order.limit_price,
        "order_type": order.order_type,
        "expires_at": order.expires_at,
        "status": order.status,
        "created_at": order.created_at,
        "filled_at": order.filled_at,
    }
