# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
poly-paper-sidecar v0 — FastAPI wrapper over agent-next/polymarket-paper-trader.

Contract (consumed by the cogni TS PaperAdapter at
`@cogni/poly-market-provider/adapters/paper`):

  GET  /healthz                       — liveness (process up)
  GET  /readyz                        — readiness (fill loop alive)
  GET  /version                       — { buildSha, upstreamPaperTraderSha }
  POST /place-order                   — PlaceOrderRequest → OrderReceipt
  POST /orders/{order_id}/cancel      — 204 on cancel, 404 idempotent
  GET  /orders/{order_id}             — 200 OrderReceipt | 404 not_found

Design (see work/projects/proj.poly-paper-trading.md § "Design — PR 3"):

- One Engine per pod, instantiated at lifespan startup.
- A single `threading.Lock` guards every Engine call. Background fill-poll
  thread acquires the same lock — there are no concurrent Engine calls.
- FastAPI handlers are sync `def` (not `async def`) so they run in FastAPI's
  internal threadpool — no `asyncio.to_thread` plumbing needed.
- In-memory `OrderState` map keyed by upstream order id holds enough to map
  back to the cogni `OrderReceipt` shape (including the client_order_id we
  need to echo back). Pod restart wipes this — by design for v0; the cogni
  reconciler treats orphan pending rows the same as a CLOB outage would.
- bug.5018 — `filled_size_usdc` is the REALIZED USDC notional from the
  engine's `Trade.amount_usd`. `fill_price` / `total_shares` / `fees_usdc`
  carry the matching realized values. Populated ONLY on `status="filled"`.
  Receipts for non-filled statuses leave them unset; the FastAPI routes
  serialize with `response_model_exclude_none=True` so the wire OMITS those
  keys (the cogni TS `OrderReceiptSchema` accepts missing/undefined, not
  `null`). NEVER echo `intent.size_usdc` as realized.

This file deliberately writes NO fill logic. All matching, fee math, and
book-walk happens inside `pm_trader.Engine`. If upstream is wrong, file
upstream and bump `UPSTREAM_PAPER_TRADER_SHA`.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

# SQLite default: a connection can only be used in the thread that created it.
# pm_trader.Engine opens its SQLite connection in its constructor (called on
# the lifespan thread), but our handlers run on FastAPI's threadpool and the
# fill loop runs on a daemon thread — all different from the lifespan thread.
# The global asyncio.Lock^W threading.Lock in Sidecar already serialises every
# Engine call, so the "unsafe cross-thread" SQLite condition isn't actually
# concurrent. Monkey-patch sqlite3.connect to disable the thread-affinity
# check BEFORE pm_trader is imported so the engine's connection allows
# cross-thread use under our lock. SQLite WAL handles file-level consistency.
_orig_sqlite_connect = sqlite3.connect


def _connect_no_thread_check(*args: Any, **kwargs: Any) -> sqlite3.Connection:
    kwargs.setdefault("check_same_thread", False)
    return _orig_sqlite_connect(*args, **kwargs)


sqlite3.connect = _connect_no_thread_check  # type: ignore[assignment]

from fastapi import FastAPI, HTTPException, Response  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

# ─── Config (env-driven; defaults sourced from Dockerfile ENV) ──────────────

DATA_DIR = Path(os.environ.get("PM_TRADER_DATA_DIR", "/tmp/pm_trader"))
ACCOUNT = os.environ.get("PM_TRADER_ACCOUNT", "cogni-paper")
STARTING_BALANCE_USDC = float(
    os.environ.get("PM_TRADER_STARTING_BALANCE_USDC", "1000000")
)
CHECK_ORDERS_INTERVAL_SECONDS = float(
    os.environ.get("PAPER_CHECK_ORDERS_INTERVAL_SECONDS", "30")
)
BUILD_SHA = os.environ.get("BUILD_SHA", "unknown")
UPSTREAM_PAPER_TRADER_SHA = os.environ.get("UPSTREAM_PAPER_TRADER_SHA", "unknown")

# Multi-node identity (docs/spec/observability.md § Multi-Node Identity). The
# sidecar is currently poly-specific (no envFrom on its container patch); if
# this image is ever generalised, lift NODE_ID into the ConfigMap and read
# from env. Hardcoded for now keeps every log + Loki query node-discriminable
# without a wider overlay change.
NODE_ID = os.environ.get("NODE_ID", "poly")
SERVICE_NAME = "poly-paper-sidecar"

# Per-process boot prefix for externally-visible order_ids. Upstream
# `pm_trader.Engine` assigns autoincrement SQLite ids that reset to 1 on every
# pod restart (data_dir lives under /tmp). Cogni persists the returned
# `order_id` in `poly_copy_trade_fills.order_id` behind a partial unique index
# (`poly_copy_trade_fills_order_id_unique`); without a per-boot prefix, the
# second pod after a restart silently collides with the first pod's rows and
# every paper fill errors out at the cogni-side UPDATE.
BOOT_ID = uuid.uuid4().hex[:12]


def _externalize(upstream_id: Any) -> str:
    return f"{BOOT_ID}-{upstream_id}"


def _to_upstream_int(external_id: str) -> Optional[int]:
    """Recover the upstream int id for a cancel/get path. Returns None if the
    id was issued by a different process (different BOOT_ID) or is malformed —
    callers translate that to 404, matching the behaviour for an unknown id."""
    prefix = f"{BOOT_ID}-"
    if not external_id.startswith(prefix):
        return None
    raw = external_id[len(prefix):]
    try:
        return int(raw)
    except ValueError:
        return None


# Cogni `market_id` is `"prediction-market:polymarket:<conditionId>"`
# (nodes/poly/packages/market-provider/src/adapters/polymarket/polymarket.normalize-fill.ts:79).
# Upstream `Engine.place_limit_order(slug_or_id, ...)` accepts a Polymarket slug
# OR conditionId. We strip the cogni prefix and pass the bare conditionId.
MARKET_ID_PREFIX = "prediction-market:polymarket:"

# Upstream LimitOrder.status (from pm_trader.orders) maps to cogni's OrderStatus.
# Cogni `OrderStatus` enum: open|filled|cancelled|expired (we collapse expired
# into cancelled — the reconciler treats them identically).
UPSTREAM_TO_COGNI_STATUS = {
    "pending": "open",
    "filled": "filled",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "expired": "cancelled",
}

# ─── Event registry (mirrors nodes/poly/app/src/shared/observability/events) ─
# Convention: `adapter.<dep>.<verb>` per the repo's `EVENT_NAMES` registry.
# Listed here so callsites don't inline strings (per observability spec). If
# this sidecar were a TS service, these would live in its events.ts.

EVENT_SIDECAR_STARTED = "adapter.paper_sidecar.started"
EVENT_PLACE_COMPLETE = "adapter.paper_sidecar.place_order.complete"
EVENT_PLACE_ERROR = "adapter.paper_sidecar.place_order.error"
EVENT_CANCEL_COMPLETE = "adapter.paper_sidecar.cancel_order.complete"
EVENT_CANCEL_ERROR = "adapter.paper_sidecar.cancel_order.error"
EVENT_FILL_LOOP_TICK = "adapter.paper_sidecar.fill_loop.tick_complete"
EVENT_FILL_LOOP_ERROR = "adapter.paper_sidecar.fill_loop.error"
EVENT_ORDER_FILLED = "adapter.paper_sidecar.order_filled"
EVENT_FILL_LOOP_DROPPED = "adapter.paper_sidecar.fill_loop.result_dropped"

# Error code enum — every error log includes one of these so Loki/dashboards
# can distinguish timeout vs upstream-bug vs our-bug vs market-not-found.
ERROR_UPSTREAM_ENGINE_FAILED = "upstream_engine_failed"
ERROR_UPSTREAM_NO_ORDER_ID = "upstream_no_order_id"
ERROR_NOT_FOUND = "not_found"
ERROR_INVALID_ORDER_ID = "invalid_order_id"
ERROR_FILL_LOOP_ITERATION = "fill_loop_iteration_failed"
ERROR_FILL_LOOP_UNMAPPED_ID = "fill_loop_result_unmapped_id"


# ─── Structured JSON logging — one JSON object per line for Alloy → Loki ────
#
# Required base fields per docs/spec/observability.md § Multi-Node Identity:
#   - `nodeId` for cross-node disambiguation
#   - `service` for Loki `{service="..."}` filter
#   - `event` for stable event-name queries
# The cogni TS adapter (`PaperAdapter`) carries `client_order_id` through every
# request — including it here as a structured field lets Grafana join sidecar
# logs to TS Pino logs on the same `client_order_id`.

_BASE_FIELDS = {"nodeId": NODE_ID, "service": SERVICE_NAME, "bootId": BOOT_ID}


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            **_BASE_FIELDS,
        }
        # Merge any `extra={...}` fields passed at the call site.
        for k, v in record.__dict__.items():
            if k in {
                "name",
                "msg",
                "args",
                "levelname",
                "levelno",
                "pathname",
                "filename",
                "module",
                "exc_info",
                "exc_text",
                "stack_info",
                "lineno",
                "funcName",
                "created",
                "msecs",
                "relativeCreated",
                "thread",
                "threadName",
                "processName",
                "process",
                "message",
                "taskName",
            }:
                continue
            out[k] = v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


_handler = logging.StreamHandler()
_handler.setFormatter(_JsonFormatter())
logging.root.handlers = [_handler]
logging.root.setLevel(os.environ.get("PINO_LOG_LEVEL", "info").upper())
log = logging.getLogger("poly-paper-sidecar")


# ─── Wire schemas (Pydantic) ────────────────────────────────────────────────


class PlaceOrderRequest(BaseModel):
    """Mirrors `PlaceOrderRequestSchema` in nodes/poly/packages/market-provider/
    src/adapters/paper/paper.adapter.ts:80."""

    client_order_id: str = Field(..., min_length=1)
    market_id: str = Field(..., min_length=1)
    token_id: Optional[str] = None
    outcome: str = Field(..., min_length=1)
    side: str  # "BUY" | "SELL"
    size_usdc: float = Field(..., gt=0)
    limit_price: float = Field(..., gt=0)
    attributes: Optional[dict[str, Any]] = None


class OrderReceipt(BaseModel):
    """Mirrors `OrderReceiptSchema` in nodes/poly/packages/market-provider/
    src/domain/order.ts:134. fill_price / total_shares / fees_usdc are
    populated only on realized fills (status=filled) per bug.5018."""

    order_id: str
    client_order_id: str
    status: str
    filled_size_usdc: float
    fill_price: Optional[float] = None
    total_shares: Optional[float] = None
    fees_usdc: Optional[float] = None
    submitted_at: str
    attributes: Optional[dict[str, Any]] = None


# ─── Per-order in-memory shadow state ───────────────────────────────────────


class OrderState:
    """Everything we need to construct an `OrderReceipt` from an order id.

    The upstream Engine doesn't track our `client_order_id` — we keep the
    mapping here. Volatile by design (pod restart wipes); the cogni reconciler
    closes orphan pending rows after its grace window.
    """

    __slots__ = (
        "upstream_id",
        "client_order_id",
        "intent_size_usdc",
        "status",
        "filled_size_usdc",
        "fill_price",
        "total_shares",
        "fees_usdc",
        "submitted_at",
        "extra",
    )

    def __init__(
        self,
        *,
        upstream_id: str,
        client_order_id: str,
        intent_size_usdc: float,
        status: str,
        filled_size_usdc: float,
        submitted_at: str,
        extra: dict[str, Any],
        fill_price: Optional[float] = None,
        total_shares: Optional[float] = None,
        fees_usdc: Optional[float] = None,
    ) -> None:
        self.upstream_id = upstream_id
        self.client_order_id = client_order_id
        self.intent_size_usdc = intent_size_usdc
        self.status = status
        self.filled_size_usdc = filled_size_usdc
        self.fill_price = fill_price
        self.total_shares = total_shares
        self.fees_usdc = fees_usdc
        self.submitted_at = submitted_at
        self.extra = extra


def _to_receipt(st: OrderState) -> OrderReceipt:
    return OrderReceipt(
        order_id=st.upstream_id,
        client_order_id=st.client_order_id,
        status=st.status,
        filled_size_usdc=st.filled_size_usdc,
        fill_price=st.fill_price,
        total_shares=st.total_shares,
        fees_usdc=st.fees_usdc,
        submitted_at=st.submitted_at,
        attributes={
            "upstream_status": st.extra.get("status"),
            "upstream_id": st.upstream_id,
        },
    )


def _resolve_slug_or_id(req: PlaceOrderRequest) -> str:
    """Map cogni `market_id` → upstream `slug_or_id` (conditionId or slug)."""
    if req.market_id.startswith(MARKET_ID_PREFIX):
        return req.market_id[len(MARKET_ID_PREFIX) :]
    if req.attributes and isinstance(req.attributes.get("condition_id"), str):
        return req.attributes["condition_id"]
    # Last resort — pass through verbatim. Upstream will 4xx if it can't resolve.
    return req.market_id


# ─── Sidecar — wraps Engine + lifespan + lock + fill loop ───────────────────


class Sidecar:
    def __init__(self) -> None:
        self.engine: Optional[Any] = None  # pm_trader.engine.Engine
        self.lock = threading.Lock()
        self.orders: dict[str, OrderState] = {}
        self._fill_thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        from pm_trader.engine import Engine

        # Reset stop flag so a restarted lifespan (e.g. across tests) gets a
        # fresh thread that doesn't see a stale set-event and exit immediately.
        self._stop.clear()

        account_dir = DATA_DIR / ACCOUNT
        account_dir.mkdir(parents=True, exist_ok=True)
        self.engine = Engine(data_dir=account_dir)
        # Idempotent — already-initialized accounts re-init harmlessly OR raise;
        # we accept either and move on.
        try:
            self.engine.init_account(balance=STARTING_BALANCE_USDC)
        except Exception:
            # Idempotent — already-initialised accounts may raise; not an error.
            pass

        self._fill_thread = threading.Thread(
            target=self._fill_loop, daemon=True, name="paper-fill-loop"
        )
        self._fill_thread.start()
        log.info(
            "sidecar started",
            extra={
                "event": EVENT_SIDECAR_STARTED,
                "account": ACCOUNT,
                "data_dir": str(account_dir),
                "check_interval_s": CHECK_ORDERS_INTERVAL_SECONDS,
                "upstream_sha": UPSTREAM_PAPER_TRADER_SHA[:12],
                "build_sha": BUILD_SHA[:12],
            },
        )

    def stop(self) -> None:
        self._stop.set()
        if self._fill_thread and self._fill_thread.is_alive():
            self._fill_thread.join(timeout=5)
        if self.engine is not None:
            try:
                self.engine.close()
            except Exception:
                pass

    def _fill_loop(self) -> None:
        """Polls `engine.check_orders()` on a fixed interval. Without this,
        resting paper limits never transition to filled. Emits a per-tick
        heartbeat so Loki has a presence signal (per observability self-check
        #4: explicit failure logs + heartbeat for adapter liveness)."""
        while not self._stop.wait(CHECK_ORDERS_INTERVAL_SECONDS):
            try:
                with self.lock:
                    filled = self.engine.check_orders()  # type: ignore[union-attr]
                filled_count = 0
                dropped_count = 0
                # `engine.check_orders()` returns wrapped entries:
                # ``[{"order": {"id": <int>, ...}, "action": "filled" | ...}]``
                # — see ``_order_to_dict`` in ``vendor/pm_trader/engine.py``.
                # Reading ``d["id"]`` directly returns "" and every fill is
                # silently dropped (server kept OrderState="open" forever,
                # cogni reconciler never observed paper fills). The action
                # filter limits us to genuine fills — expired/rejected entries
                # don't get the same OrderState transition.
                for d in filled:
                    if d.get("action") != "filled":
                        continue
                    upstream_id = d.get("order", {}).get("id", "")
                    oid = _externalize(upstream_id)
                    st = self.orders.get(oid)
                    if st is None:
                        # Engine reported a fill we never placed (different
                        # BOOT_ID after pod restart, or a manual upstream
                        # write). Surface it instead of dropping silently —
                        # the prior silent-drop on every fill is exactly how
                        # paper trade reported 0 fills for weeks. See
                        # ERROR_FILL_LOOP_UNMAPPED_ID.
                        dropped_count += 1
                        log.warning(
                            "fill loop result unmapped to local OrderState",
                            extra={
                                "event": EVENT_FILL_LOOP_DROPPED,
                                "errorCode": ERROR_FILL_LOOP_UNMAPPED_ID,
                                "upstream_id": str(upstream_id),
                                "oid": oid,
                            },
                        )
                        continue
                    st.status = "filled"
                    # bug.5018 — engine attaches realized fill data on
                    # `action="filled"` entries. amount_usd is realized
                    # notional (not intent), avg_price is VWAP across
                    # matched levels, fee is realized fee in USDC.
                    fill = d["fill"]
                    st.filled_size_usdc = float(fill["amount_usd"])
                    st.fill_price = float(fill["avg_price"])
                    st.total_shares = float(fill["total_shares"])
                    st.fees_usdc = float(fill["fee"])
                    st.extra.update(d)
                    filled_count += 1
                    log.info(
                        "order filled",
                        extra={
                            "event": EVENT_ORDER_FILLED,
                            "order_id": oid,
                            "client_order_id": st.client_order_id,
                            "filled_size_usdc": st.filled_size_usdc,
                            "fill_price": st.fill_price,
                            "total_shares": st.total_shares,
                            "fees_usdc": st.fees_usdc,
                        },
                    )
                # Heartbeat — emit every tick so an absence alert in Loki can
                # detect a stuck/crashed fill loop. Low volume (2/min at 30s).
                # `dropped_count` distinguishes "engine produced no fills"
                # (the normal quiet case) from "engine produced fills but
                # OrderState mapping silently dropped them" (the prior bug).
                log.info(
                    "fill loop tick",
                    extra={
                        "event": EVENT_FILL_LOOP_TICK,
                        "pending_count": len(
                            [s for s in self.orders.values() if s.status == "open"]
                        ),
                        "filled_count": filled_count,
                        "dropped_count": dropped_count,
                    },
                )
            except Exception as e:
                log.error(
                    "fill loop iteration failed",
                    extra={
                        "event": EVENT_FILL_LOOP_ERROR,
                        "errorCode": ERROR_FILL_LOOP_ITERATION,
                        "errClass": type(e).__name__,
                    },
                    exc_info=True,
                )

    # ── handlers ───────────────────────────────────────────────────────────

    def place(self, req: PlaceOrderRequest) -> OrderReceipt:
        slug_or_id = _resolve_slug_or_id(req)
        with self.lock:
            try:
                d: dict[str, Any] = self.engine.place_limit_order(  # type: ignore[union-attr]
                    slug_or_id=slug_or_id,
                    outcome=req.outcome,
                    side=req.side.lower(),
                    amount=req.size_usdc,
                    limit_price=req.limit_price,
                    order_type="gtc",
                )
            except Exception as e:
                log.error(
                    "place_order upstream failure",
                    extra={
                        "event": EVENT_PLACE_ERROR,
                        "errorCode": ERROR_UPSTREAM_ENGINE_FAILED,
                        "errClass": type(e).__name__,
                        "client_order_id": req.client_order_id,
                    },
                    exc_info=True,
                )
                raise HTTPException(
                    status_code=502, detail=ERROR_UPSTREAM_ENGINE_FAILED
                )

        upstream_id = d.get("id")
        if upstream_id is None:
            log.error(
                "place_order upstream returned no order id",
                extra={
                    "event": EVENT_PLACE_ERROR,
                    "errorCode": ERROR_UPSTREAM_NO_ORDER_ID,
                    "client_order_id": req.client_order_id,
                    "upstream_keys": list(d.keys()),
                },
            )
            raise HTTPException(status_code=502, detail=ERROR_UPSTREAM_NO_ORDER_ID)
        oid = _externalize(upstream_id)

        upstream_status = str(d.get("status", "pending")).lower()
        cogni_status = UPSTREAM_TO_COGNI_STATUS.get(upstream_status, "open")
        submitted_at = (
            d.get("created_at")
            or datetime.now(timezone.utc).isoformat(timespec="seconds")
        )

        # bug.5018 — at place time the upstream engine returns pending (GTC)
        # with no realized fill yet. filled_size_usdc / fill_price /
        # total_shares / fees_usdc all stay 0 / None until the fill loop
        # observes a real match via `check_orders()` and populates from
        # `Trade.amount_usd` etc. NEVER echo intent.size_usdc here.
        st = OrderState(
            upstream_id=oid,
            client_order_id=req.client_order_id,
            intent_size_usdc=req.size_usdc,
            status=cogni_status,
            filled_size_usdc=0.0,
            submitted_at=str(submitted_at),
            extra=d,
        )
        self.orders[oid] = st
        log.info(
            "order placed",
            extra={
                "event": EVENT_PLACE_COMPLETE,
                "order_id": oid,
                "client_order_id": req.client_order_id,
                "status": cogni_status,
                "side": req.side,
                "size_usdc": req.size_usdc,
                "limit_price": req.limit_price,
            },
        )
        return _to_receipt(st)

    def cancel(self, order_id: str) -> None:
        int_id = _to_upstream_int(order_id)
        if int_id is None:
            # Different BOOT_ID (issued by a prior process), missing prefix, or
            # not parseable as int — none of those can exist in this engine.
            raise HTTPException(status_code=404, detail=ERROR_NOT_FOUND)

        with self.lock:
            try:
                result = self.engine.cancel_limit_order(int_id)  # type: ignore[union-attr]
            except Exception as e:
                log.error(
                    "cancel_order upstream failure",
                    extra={
                        "event": EVENT_CANCEL_ERROR,
                        "errorCode": ERROR_UPSTREAM_ENGINE_FAILED,
                        "errClass": type(e).__name__,
                        "order_id": order_id,
                    },
                    exc_info=True,
                )
                raise HTTPException(
                    status_code=502, detail=ERROR_UPSTREAM_ENGINE_FAILED
                )
        if result is None:
            raise HTTPException(status_code=404, detail=ERROR_NOT_FOUND)
        st = self.orders.get(order_id)
        if st is not None:
            st.status = "cancelled"
        log.info(
            "order cancelled",
            extra={
                "event": EVENT_CANCEL_COMPLETE,
                "order_id": order_id,
                "client_order_id": st.client_order_id if st else None,
            },
        )

    def get(self, order_id: str) -> OrderReceipt:
        st = self.orders.get(order_id)
        if st is None:
            raise HTTPException(status_code=404, detail="not_found")
        return _to_receipt(st)

    # ── pm_trader pass-throughs (sidecar-global PnL surface) ──────────────
    # These expose pm_trader.Engine's existing PnL/portfolio/history methods
    # so we can observe what the paper engine actually thinks is happening.
    # All values are SIDECAR-GLOBAL (one account shared across tenants per the
    # current v0 architecture); per-tenant PnL still has to be aggregated
    # cogni-side from `poly_copy_trade_fills`.
    def balance(self) -> dict[str, Any]:
        with self.lock:
            return self.engine.get_balance()  # type: ignore[union-attr]

    def portfolio(self) -> list[dict[str, Any]]:
        with self.lock:
            return self.engine.get_portfolio()  # type: ignore[union-attr]

    def history(self, limit: int) -> list[dict[str, Any]]:
        with self.lock:
            trades = self.engine.get_history(limit=limit)  # type: ignore[union-attr]
        # pm_trader returns dataclass Trade instances; coerce to plain dicts
        # so FastAPI's serializer doesn't need a model. Trade is a frozen
        # dataclass — `vars()` is the canonical conversion.
        out: list[dict[str, Any]] = []
        for t in trades:
            if hasattr(t, "__dict__"):
                out.append(dict(vars(t)))
            elif isinstance(t, dict):
                out.append(t)
            else:
                out.append({"raw": str(t)})
        return out


sidecar = Sidecar()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    sidecar.start()
    try:
        yield
    finally:
        sidecar.stop()


app = FastAPI(title="poly-paper-sidecar", version="1.0.0", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    if sidecar._fill_thread is None or not sidecar._fill_thread.is_alive():
        raise HTTPException(status_code=503, detail="fill_loop_not_running")
    if sidecar.engine is None:
        raise HTTPException(status_code=503, detail="engine_not_initialized")
    return {"status": "ok"}


@app.get("/version")
def version() -> dict[str, str]:
    return {
        "buildSha": BUILD_SHA,
        "upstreamPaperTraderSha": UPSTREAM_PAPER_TRADER_SHA,
    }


# bug.5018 — response_model_exclude_none=True: pydantic serializes None as
# JSON null by default, but the cogni TS OrderReceiptSchema's optional fields
# only accept undefined/missing (Zod v3 .optional() rejects null). Omit None
# fields from the wire so the TS adapter's Zod.parse() doesn't reject every
# pending-state receipt with `fill_price`/`total_shares`/`fees_usdc` = null.
@app.post("/place-order", response_model_exclude_none=True)
def place_order(req: PlaceOrderRequest) -> OrderReceipt:
    return sidecar.place(req)


@app.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str) -> Response:
    sidecar.cancel(order_id)
    return Response(status_code=204)


@app.get("/orders/{order_id}", response_model_exclude_none=True)
def get_order(order_id: str) -> OrderReceipt:
    return sidecar.get(order_id)


# ─── pm_trader pass-through: PnL, portfolio, history ────────────────────────
# Sidecar-global view (single pm_trader account across all tenants). Cogni-side
# per-tenant aggregation lives separately over `poly_copy_trade_fills`.


@app.get("/balance")
def balance() -> dict[str, Any]:
    return sidecar.balance()


@app.get("/portfolio")
def portfolio() -> list[dict[str, Any]]:
    return sidecar.portfolio()


@app.get("/history")
def history(limit: int = 50) -> list[dict[str, Any]]:
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit_out_of_range")
    return sidecar.history(limit)
