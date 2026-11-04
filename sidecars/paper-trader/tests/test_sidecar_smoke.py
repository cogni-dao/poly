# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
v0 smoke for poly-paper-sidecar.

Goal: prove the FastAPI ↔ pm_trader.Engine wiring is correct without needing
network access to live Polymarket book reads. We stub `pm_trader.engine.Engine`
with a fake that returns canned dicts, then drive the server's handlers via
fastapi.testclient and assert: place → 200 receipt with status=open, fill loop
flips status → filled, getOrder returns the new status with filled_size_usdc
equal to the placed size_usdc (v0 full-fill assumption).

What this does NOT cover (intentionally — out of scope for v0 build-blocker):

- Real upstream `orderbook.py` fill simulation against a recorded book. The
  fixture-recapture script + real-engine smoke land in a follow-up commit;
  pinning that to CI today would couple us to upstream API stability before
  we've validated the integration end-to-end on candidate-a.
- Polymarket public-API rate behaviour.
- Partial-fill mapping (full-fill assumption is documented invariant for v0).

Anything in the FastAPI mapping layer (`_resolve_slug_or_id`, status mapping,
OrderReceipt projection, lifespan startup, lock acquisition, fill loop
behaviour) is exercised here.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import types
import subprocess
from pathlib import Path
from typing import Any

import pytest

# ─── Stub pm_trader.engine BEFORE importing server.py ───────────────────────

# Fast poll so the test isn't slow.
os.environ.setdefault("PAPER_CHECK_ORDERS_INTERVAL_SECONDS", "0.1")
os.environ.setdefault("PM_TRADER_DATA_DIR", "/tmp/pm_trader-test")


class FakeEngine:
    """In-memory stub of `pm_trader.engine.Engine` — just enough surface for
    the sidecar to exercise place / cancel / get / fill-loop semantics."""

    def __init__(self, *, data_dir: Any) -> None:  # signature mirrors upstream
        self._data_dir = data_dir
        self._orders: dict[int, dict[str, Any]] = {}
        self._next_id = 1
        # Markets whose top-of-book is at-or-better than the limit price (per
        # test setup) get filled on the next check_orders tick. Default: empty.
        self.fill_on_next_check: set[int] = set()
        self.init_account_called = False

    def init_account(self, balance: float) -> dict[str, Any]:
        self.init_account_called = True
        return {"balance": balance}

    def place_limit_order(
        self,
        *,
        slug_or_id: str,
        outcome: str,
        side: str,
        amount: float,
        limit_price: float,
        order_type: str = "gtc",
        expires_at: str | None = None,
    ) -> dict[str, Any]:
        oid = self._next_id
        self._next_id += 1
        d = {
            "id": oid,
            "status": "pending",
            "market_slug": slug_or_id,
            "outcome": outcome,
            "side": side,
            "amount": amount,
            "limit_price": limit_price,
            "order_type": order_type,
            "created_at": "2026-05-16T18:00:00+00:00",
            "filled_at": None,
        }
        self._orders[oid] = d
        return d

    def cancel_limit_order(self, order_id: int) -> dict[str, Any] | None:
        d = self._orders.get(order_id)
        if d is None or d["status"] != "pending":
            return None
        d["status"] = "cancelled"
        return d

    def check_orders(self) -> list[dict[str, Any]]:
        # Match real upstream contract from vendor/pm_trader/engine.py: each
        # result is ``{"order": <order_dict>, "action": "filled"|"rejected"|"expired"}``.
        # The flat-dict shape this fake used previously lined up with a
        # matching bug in server.py (reading ``d["id"]`` instead of
        # ``d["order"]["id"]``) — both wrongs cancelled and every paper fill
        # was silently dropped in production.
        filled = []
        for oid in list(self.fill_on_next_check):
            d = self._orders.get(oid)
            if d is None or d["status"] != "pending":
                continue
            d["status"] = "filled"
            d["filled_at"] = "2026-05-16T18:00:30+00:00"
            d["fill_price"] = d["limit_price"]
            # bug.5018 — engine attaches realized fill data on filled entries.
            # Fake: model a full fill at limit_price for the requested USDC
            # amount, so realized notional == intent for the test assertions.
            limit_price = float(d["limit_price"])
            amount_usd = float(d["amount"])
            total_shares = amount_usd / limit_price
            filled.append({
                "order": dict(d),
                "action": "filled",
                "fill": {
                    "avg_price": limit_price,
                    "total_shares": total_shares,
                    "fee": 0.0,
                    "amount_usd": amount_usd,
                },
            })
            self.fill_on_next_check.discard(oid)
        return filled

    def get_pending_orders(self) -> list[dict[str, Any]]:
        return [d for d in self._orders.values() if d["status"] == "pending"]

    def get_balance(self) -> dict[str, Any]:
        # Mirrors pm_trader.Engine.get_balance shape.
        return {
            "cash": 999_950.0,
            "starting_balance": 1_000_000.0,
            "positions_value": 12.5,
            "total_value": 999_962.5,
            "pnl": -37.5,
        }

    def get_portfolio(self) -> list[dict[str, Any]]:
        # Mirrors pm_trader.Engine.get_portfolio shape.
        return [
            {
                "market_slug": "test-market",
                "market_question": "Will X happen?",
                "outcome": "yes",
                "shares": 100.0,
                "avg_entry_price": 0.50,
                "total_cost": 50.0,
                "live_price": 0.55,
                "current_value": 55.0,
                "unrealized_pnl": 5.0,
                "percent_pnl": 10.0,
            }
        ]

    def get_history(self, limit: int = 50) -> list[Any]:
        # Real Engine returns dataclass Trade instances; FakeEngine returns
        # objects with attrs so the server-side `vars()` conversion exercises.
        class _T:
            def __init__(self, **kw):
                for k, v in kw.items():
                    setattr(self, k, v)
        return [
            _T(id=1, side="buy", outcome="yes", avg_price=0.5, shares=10.0,
               amount_usd=5.0, fee=0.0)
        ][:limit]

    def close(self) -> None:
        pass


# Inject the fake module so `from pm_trader.engine import Engine` in server.py
# finds it without needing the real upstream package installed.
_fake_engine_module = types.ModuleType("pm_trader.engine")
_fake_engine_module.Engine = FakeEngine  # type: ignore[attr-defined]
_fake_pm_trader_module = types.ModuleType("pm_trader")
_fake_pm_trader_module.__path__ = [str(Path(__file__).resolve().parents[1] / "vendor/pm_trader/pm_trader")]
_fake_pm_trader_module.engine = _fake_engine_module  # type: ignore[attr-defined]
sys.modules.setdefault("pm_trader", _fake_pm_trader_module)
sys.modules["pm_trader.engine"] = _fake_engine_module

# Now safe to import the server. Force reimport in case prior tests cached it.
sys.modules.pop("server", None)
import server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

ACCOUNT_ID = "paper-account-a"
OTHER_ACCOUNT_ID = "paper-account-b"
STARTING_BALANCE_USDC = 10_000.0


@pytest.fixture
def client():
    with TestClient(server.app) as c:
        yield c


# ─── Tests ──────────────────────────────────────────────────────────────────


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readyz_reports_engine_and_fill_loop(client):
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_version_returns_pinned_shas(client):
    # Reads whatever the actual env is (Dockerfile-set in CI; defaults locally).
    # The test asserts shape + non-empty, not specific values — CI's real SHA
    # values are the source of truth, not a literal in this file.
    r = client.get("/version")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"buildSha", "bootId", "upstreamPaperTraderSha"}
    assert isinstance(body["buildSha"], str) and body["buildSha"]
    assert isinstance(body["bootId"], str) and body["bootId"]
    assert isinstance(body["upstreamPaperTraderSha"], str) and body["upstreamPaperTraderSha"]


def test_place_order_returns_open_receipt(client):
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "cogni-coid-1",
            "market_id": "prediction-market:polymarket:0xCONDITION_ID",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 10.0,
            "limit_price": 0.55,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client_order_id"] == "cogni-coid-1"
    assert body["status"] == "open"
    assert body["filled_size_usdc"] == 0
    assert body["order_id"]  # non-empty
    assert body["submitted_at"]


def test_place_order_strips_prefix_and_passes_condition_id(client):
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "cogni-coid-2",
            "market_id": "prediction-market:polymarket:0xABCDEF",
            "outcome": "No",
            "side": "BUY",
            "size_usdc": 5.0,
            "limit_price": 0.4,
        },
    )
    assert r.status_code == 200
    # Look up the stored upstream order to confirm the slug_or_id mapping.
    engine: FakeEngine = server.sidecars.get(ACCOUNT_ID).engine  # type: ignore[assignment]
    placed = list(engine._orders.values())[-1]
    assert placed["market_slug"] == "0xABCDEF"
    assert placed["side"] == "buy"  # lowercased before passing upstream


def test_get_order_returns_404_for_unknown_id(client):
    r = client.get(f"/orders/999999?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_get_order_returns_receipt_after_place(client):
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "cogni-coid-3",
            "market_id": "prediction-market:polymarket:0xCID",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 3.0,
            "limit_price": 0.5,
        },
    )
    oid = r.json()["order_id"]
    r2 = client.get(f"/orders/{oid}?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r2.status_code == 200
    body = r2.json()
    assert body["status"] == "open"
    assert body["client_order_id"] == "cogni-coid-3"
    assert body["filled_size_usdc"] == 0


def test_accounts_have_isolated_orders_and_engine_state(client):
    first = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "tenant-a-order",
            "market_id": "prediction-market:polymarket:0xTENANT",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 2.0,
            "limit_price": 0.5,
        },
    ).json()
    second = client.post(
        "/place-order",
        json={
            "account_id": OTHER_ACCOUNT_ID,
            "starting_balance_usdc": 20_000.0,
            "client_order_id": "tenant-b-order",
            "market_id": "prediction-market:polymarket:0xTENANT",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 3.0,
            "limit_price": 0.5,
        },
    ).json()

    assert first["order_id"] != second["order_id"]
    assert client.get(
        f"/orders/{first['order_id']}?account_id={OTHER_ACCOUNT_ID}&starting_balance_usdc=20000"
    ).status_code == 404
    open_a = client.get(
        f"/orders?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}"
    ).json()
    open_b = client.get(
        f"/orders?account_id={OTHER_ACCOUNT_ID}&starting_balance_usdc=20000"
    ).json()
    assert [row["client_order_id"] for row in open_a] == ["tenant-a-order"]
    assert [row["client_order_id"] for row in open_b] == ["tenant-b-order"]


def test_new_account_open_orders_is_authoritative_empty(client):
    r = client.get(
        "/orders?account_id=fresh-account&starting_balance_usdc=5000"
    )
    assert r.status_code == 200
    assert r.json() == []


def test_fill_loop_flips_status_and_populates_filled_size(client):
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "cogni-coid-4",
            "market_id": "prediction-market:polymarket:0xFILLME",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 7.0,
            "limit_price": 0.6,
        },
    )
    oid = r.json()["order_id"]
    # Externally-visible oid is `<account_key>-<BOOT_ID>-<upstream_int>`;
    # the fake engine keys on the raw upstream int.
    upstream_int = server._to_upstream_int(oid, server._account_key(ACCOUNT_ID))
    assert upstream_int is not None
    engine: FakeEngine = server.sidecars.get(ACCOUNT_ID).engine  # type: ignore[assignment]
    engine.fill_on_next_check.add(upstream_int)

    # Background fill loop runs every 0.1s (test env). Poll the receipt up to 2s.
    deadline = time.time() + 2.0
    while time.time() < deadline:
        r2 = client.get(f"/orders/{oid}?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
        if r2.json().get("status") == "filled":
            break
        time.sleep(0.05)

    body = r2.json()
    assert body["status"] == "filled", f"never filled; final body={body}"
    # v0 full-fill assumption: realized = intent.
    assert body["filled_size_usdc"] == 7.0


def test_cancel_unknown_id_returns_404(client):
    r = client.post(f"/orders/999999/cancel?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r.status_code == 404


def test_cancel_existing_order_returns_204_and_flips_status(client):
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "cogni-coid-5",
            "market_id": "prediction-market:polymarket:0xCNX",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 4.0,
            "limit_price": 0.5,
        },
    )
    oid = r.json()["order_id"]
    r2 = client.post(f"/orders/{oid}/cancel?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r2.status_code == 204
    r3 = client.get(f"/orders/{oid}?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r3.json()["status"] == "canceled"


def test_cancel_invalid_id_format_returns_404(client):
    r = client.post(f"/orders/not-an-int/cancel?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r.status_code == 404


# ─── Regression: engine return shape contract (silent-drop bug 2026-05-17) ──


def test_fill_loop_reads_wrapped_engine_result_not_flat(client):
    """The real ``Engine.check_orders`` returns wrapped entries:
    ``[{"order": {"id": N, ...}, "action": "filled"}]`` — not a flat list of
    order dicts. The prior server.py read ``d["id"]`` from the wrapper, which
    is always missing, so every fill was silently dropped. This test asserts
    the wrapped shape is what propagates state, by injecting a raw wrapped
    result directly into ``_fill_loop``'s code path through a one-shot
    check_orders override.
    """
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "regression-wrapped-1",
            "market_id": "prediction-market:polymarket:0xWRAP",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 6.0,
            "limit_price": 0.5,
        },
    )
    oid = r.json()["order_id"]
    upstream_int = server._to_upstream_int(oid, server._account_key(ACCOUNT_ID))
    assert upstream_int is not None
    engine: FakeEngine = server.sidecars.get(ACCOUNT_ID).engine  # type: ignore[assignment]
    engine.fill_on_next_check.add(upstream_int)

    deadline = time.time() + 2.0
    while time.time() < deadline:
        if client.get(f"/orders/{oid}?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}").json().get("status") == "filled":
            break
        time.sleep(0.05)

    body = client.get(f"/orders/{oid}?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}").json()
    assert body["status"] == "filled", f"wrapped-shape mapping broken; body={body}"
    assert body["filled_size_usdc"] == 6.0


# ─── pm_trader pass-through PnL/portfolio/history endpoints ────────────────


def test_balance_returns_pm_trader_shape(client):
    client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "balance-bootstrap",
            "market_id": "prediction-market:polymarket:0xBAL",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 1.0,
            "limit_price": 0.5,
        },
    )
    r = client.get(f"/balance?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r.status_code == 200
    body = r.json()
    # Mirrors pm_trader.Engine.get_balance contract — fail loud if upstream drifts.
    assert set(body.keys()) == {
        "cash", "starting_balance", "positions_value", "total_value", "pnl"
    }
    assert isinstance(body["pnl"], (int, float))


def test_portfolio_returns_list_of_positions_with_unrealized_pnl(client):
    client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "portfolio-bootstrap",
            "market_id": "prediction-market:polymarket:0xPORT",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 1.0,
            "limit_price": 0.5,
        },
    )
    r = client.get(f"/portfolio?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 1
    pos = body[0]
    assert "shares" in pos
    assert "unrealized_pnl" in pos
    assert "current_value" in pos
    assert "live_price" in pos


def test_history_returns_serialized_trades(client):
    client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "history-bootstrap",
            "market_id": "prediction-market:polymarket:0xHIST",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 1.0,
            "limit_price": 0.5,
        },
    )
    r = client.get(f"/history?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 1
    # Trade dataclasses get converted to plain dicts via vars()
    assert body[0]["side"] == "buy"
    assert "avg_price" in body[0]


def test_history_limit_param_validates(client):
    server.sidecars.get_or_create(ACCOUNT_ID, STARTING_BALANCE_USDC)
    r = client.get(f"/history?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}&limit=0")
    assert r.status_code == 400
    r = client.get(f"/history?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}&limit=501")
    assert r.status_code == 400
    r = client.get(f"/history?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}&limit=10")
    assert r.status_code == 200


def test_fill_loop_ignores_non_filled_actions(client):
    """Engine return entries with action != 'filled' (e.g. 'expired',
    'rejected') must NOT flip OrderState to filled. The fix added an
    ``action != "filled"`` guard precisely for this.
    """
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "regression-action-1",
            "market_id": "prediction-market:polymarket:0xEXP",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 2.0,
            "limit_price": 0.3,
        },
    )
    oid = r.json()["order_id"]
    upstream_int = server._to_upstream_int(oid, server._account_key(ACCOUNT_ID))
    engine: FakeEngine = server.sidecars.get(ACCOUNT_ID).engine  # type: ignore[assignment]

    # Monkey-patch a single tick to emit an action=expired entry for this id.
    original = engine.check_orders
    emitted = {"done": False}

    def one_shot_expired() -> list[dict[str, Any]]:
        if emitted["done"]:
            return []
        emitted["done"] = True
        d = engine._orders[upstream_int]
        return [{"order": dict(d), "action": "expired"}]

    engine.check_orders = one_shot_expired  # type: ignore[assignment]
    try:
        time.sleep(0.5)  # several fill-loop ticks at 0.1s
    finally:
        engine.check_orders = original  # type: ignore[assignment]

    body = client.get(f"/orders/{oid}?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}").json()
    assert body["status"] == "open", (
        f"expired action incorrectly flipped status to filled; body={body}"
    )


def test_place_returns_boot_prefixed_order_id(client):
    """Returned `order_id` must be `<BOOT_ID>-<upstream_int>` so two pods that
    each restart their ephemeral SQLite (resetting upstream autoincrement to 1)
    do not produce colliding `order_id`s in cogni Postgres."""
    r = client.post(
        "/place-order",
        json={
            "account_id": ACCOUNT_ID,
            "starting_balance_usdc": STARTING_BALANCE_USDC,
            "client_order_id": "cogni-coid-boot",
            "market_id": "prediction-market:polymarket:0xBOOT",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 1.0,
            "limit_price": 0.5,
        },
    )
    oid = r.json()["order_id"]
    assert oid.startswith(f"{server._account_key(ACCOUNT_ID)}-{server.BOOT_ID}-"), oid
    # Plain int parse must fail — that's the whole point of the prefix.
    with pytest.raises(ValueError):
        int(oid)


def test_to_upstream_int_rejects_foreign_boot_prefix():
    """A request carrying an order_id minted by a previous pod (different
    BOOT_ID) must read as 'not found' rather than dispatch to the wrong
    upstream row."""
    foreign_oid = f"deadbeefcafe-42"
    key = server._account_key(ACCOUNT_ID)
    assert server._to_upstream_int(foreign_oid, key) is None
    # Sanity-check the positive case too.
    assert server._to_upstream_int(f"{key}-{server.BOOT_ID}-42", key) == 42


def test_cancel_with_foreign_boot_prefix_returns_404(client):
    """A cancel for an id minted in a previous process must 404 cleanly."""
    r = client.post(
        f"/orders/deadbeefcafe-1/cancel?account_id={ACCOUNT_ID}&starting_balance_usdc={STARTING_BALANCE_USDC}"
    )
    assert r.status_code == 404


def test_lock_serializes_engine_calls(client):
    """Smoke that the global lock prevents concurrent engine entry.

    We can't easily assert "only one thread inside engine at a time" without
    instrumenting the engine — instead we drive 20 parallel place_order POSTs
    through the testclient's threadpool and assert all succeed with distinct
    upstream ids. A broken lock would race the fake engine's _next_id counter
    and produce dupes."""
    results = []
    lock = threading.Lock()

    def _place(i: int):
        r = client.post(
            "/place-order",
            json={
                "account_id": ACCOUNT_ID,
                "starting_balance_usdc": STARTING_BALANCE_USDC,
                "client_order_id": f"parallel-{i}",
                "market_id": "prediction-market:polymarket:0xPAR",
                "outcome": "Yes",
                "side": "BUY",
                "size_usdc": 1.0,
                "limit_price": 0.5,
            },
        )
        with lock:
            results.append(r.json()["order_id"])

    threads = [threading.Thread(target=_place, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 20
    assert len(set(results)) == 20, f"duplicate order_ids: {sorted(results)}"


@pytest.mark.parametrize("stage", ["account_lock", "registry_lock", "discovery_headers", "discovery_body", "sqlite_lock", "before_insert", "before_commit", "bounded_success", "normal"])
def test_native_qualification_deadline(stage: str) -> None:
    """Fresh process: the REAL helper, vendored engine/client and SQLite, no Engine stub.

    Block at native seams, expire, release, then inspect actual SQLite and prove
    that the same account still accepts an ordinary call with default behavior.
    This runs in the existing image smoke gate, never against a live venue.
    """
    script = r'''
import json, sqlite3, sys, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

root, stage = Path(sys.argv[1]), sys.argv[2]
sys.path[:0] = [str(root), str(root / "vendor/pm_trader")]
import server
from pm_trader.engine import Engine
import pm_trader.api as api

entered, release = threading.Event(), threading.Event()
class GatedConnection(sqlite3.Connection):
    armed = False
    def execute(self, sql, *args, **kwargs):
        if self.armed and stage == "before_insert" and sql.lstrip().startswith("INSERT INTO limit_orders"):
            entered.set()
            assert release.wait(3)
        return super().execute(sql, *args, **kwargs)
    def commit(self):
        if self.armed and stage == "before_commit":
            entered.set()
            assert release.wait(3)
        return super().commit()

with tempfile.TemporaryDirectory() as directory:
    account = server.Sidecar("qualification-native", 100)
    engine = Engine(Path(directory))
    engine.init_account(balance=100)
    # Replace only the connection's test gate, retaining the real on-disk schema.
    engine.db.conn.close()
    conn = sqlite3.connect(str(engine.db.db_path), factory=GatedConnection)
    conn.row_factory = sqlite3.Row
    engine.db._conn = conn
    account.engine = engine
    server.sidecars.accounts["qualification-native"] = account
    market = SimpleNamespace(slug="fixture", condition_id="0xcondition", outcomes=["Yes", "No"])
    original_get_market = engine.api.get_market
    engine.api.get_market = lambda *a, **k: market
    httpd = None
    if stage.startswith("discovery_"):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                entered.set()
                if stage == "discovery_headers":
                    release.wait(3)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "2")
                self.end_headers()
                if stage == "discovery_body":
                    release.wait(3)
                try: self.wfile.write(b"[]")
                except (BrokenPipeError, ConnectionResetError): pass
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        api.GAMMA_BASE = f"http://127.0.0.1:{httpd.server_port}"
        engine.api.get_market = original_get_market

    blocker = None
    lock = account.lock if stage == "account_lock" else server.sidecars.lock
    if stage in ("account_lock", "registry_lock"):
        lock.acquire()
    if stage == "sqlite_lock":
        blocker = sqlite3.connect(str(engine.db.db_path))
        blocker.execute("BEGIN IMMEDIATE")
    req = server.PlaceOrderRequest(account_id="qualification-native", starting_balance_usdc=100,
        client_order_id="qualification-one", market_id="fixture", outcome="YES", side="BUY",
        size_usdc=1, limit_price=0.01,
        **({} if stage == "normal" else {"action_deadline_at_ms": int(time.time()*1000)+(1000 if stage.startswith("discovery_") else 250)}))
    conn.armed = True
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=1) as pool:
        action = pool.submit(server.place_order, req)
        if stage.startswith("discovery_") or stage in ("before_insert", "before_commit"):
            assert entered.wait(2), stage
        if stage in ("before_insert", "before_commit"):
            time.sleep(0.3)
            release.set()
        if stage in ("normal", "bounded_success"):
            result = action.result(timeout=2)
            assert result.status == "open"
        else:
            try:
                action.result(timeout=1.5)
                raise AssertionError("expired placement succeeded: " + stage)
            except server.HTTPException:
                pass
            assert time.monotonic()-started < 1.5, stage
        if stage in ("account_lock", "registry_lock"):
            lock.release()
        if blocker:
            blocker.rollback()
            blocker.close()
        release.set()
    conn.armed = False
    rows = conn.execute("SELECT * FROM limit_orders").fetchall()
    assert len(rows) == (1 if stage in ("normal", "bounded_success") else 0), (stage, rows)
    assert not account.orders if stage not in ("normal", "bounded_success") else len(account.orders) == 1
    # Timeout hooks and client settings cannot poison the next ordinary caller.
    engine.api.get_market = lambda *a, **k: market
    ordinary = req.model_copy(update={"action_deadline_at_ms": None, "client_order_id": "ordinary"})
    result = server.place_order(ordinary)
    assert result.status == "open"
    assert len(conn.execute("SELECT * FROM limit_orders").fetchall()) == len(rows)+1
    if httpd:
        httpd.shutdown()
        httpd.server_close()
    engine.close()
print("native deadline scenario passed:", stage)
'''
    result = subprocess.run(
        [sys.executable, "-c", script, str(Path(__file__).resolve().parents[1]), stage],
        capture_output=True, text=True, timeout=12,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("stage", [
    "cold_open_lock", "cold_open_mutation", "cold_schema_lock", "cold_schema_mutation",
    "cold_schema_commit", "cold_account_mutation", "cold_account_commit", "cold_publish",
    "cold_success", "cold_get_account_mutation", "cold_list_account_commit",
    "cancel_account_lock", "cancel_registry_lock", "cancel_sqlite_lock",
    "cancel_mutation", "cancel_commit", "cancel_success", "cancel_normal",
])
def test_native_cold_and_cancel_lifetime(stage: str) -> None:
    """Actual HTTP routes, fresh real Engine and SQLite; no manual warm-up.

    SQL gates delay the real native statements/commit past the same received
    deadline. Inspect native state after release and retry ordinary operations.
    The declared runtime image build must execute this existing smoke suite.
    """
    script = r'''
import sqlite3, sys, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
root, stage = Path(sys.argv[1]), sys.argv[2]
sys.path[:0] = [str(root), str(root / "vendor/pm_trader")]
import server
from fastapi.testclient import TestClient
from pm_trader.engine import Engine
from pm_trader.api import PolymarketClient

entered, release = threading.Event(), threading.Event()
created_threads = []
original_connect, original_start = sqlite3.connect, threading.Thread.start
armed = False
phase = stage.replace("cold_get_", "cold_").replace("cold_list_", "cold_")
class GatedConnection(sqlite3.Connection):
    last_mutation = ""
    def execute(self, sql, *args, **kwargs):
        text = sql.lstrip()
        if text.startswith("CREATE TABLE"): self.last_mutation = "schema"
        if text.startswith("INSERT OR REPLACE INTO account"): self.last_mutation = "account"
        if text.startswith("UPDATE limit_orders"): self.last_mutation = "cancel"
        target = {"cold_open_mutation": "PRAGMA journal_mode=WAL", "cold_schema_mutation": "CREATE TABLE",
            "cold_account_mutation": "INSERT OR REPLACE INTO account", "cancel_mutation": "UPDATE limit_orders"}.get(phase)
        if armed and target and text.startswith(target):
            entered.set()
            assert release.wait(4), stage
        return super().execute(sql, *args, **kwargs)
    def commit(self):
        if armed and phase == ("cancel_commit" if self.last_mutation == "cancel" else "cold_"+self.last_mutation+"_commit"):
            entered.set()
            assert release.wait(4), stage
        return super().commit()
def connect(*a, **kw):
    kw["factory"] = GatedConnection
    return original_connect(*a, **kw)
def start(thread, *a, **kw):
    result = original_start(thread, *a, **kw)
    if thread.name == "paper-fill-loop":
        created_threads.append(thread)
        if armed and stage == "cold_publish":
            entered.set()
            assert release.wait(4), stage
    return result
sqlite3.connect, threading.Thread.start = connect, start
# Real native lifecycle/SQL; fixture market metadata alone avoids a venue call.
PolymarketClient.get_market = lambda *a, **k: SimpleNamespace(slug="fixture", condition_id="0xcondition", outcomes=["Yes", "No"])
with tempfile.TemporaryDirectory() as directory:
    server.DATA_DIR = Path(directory)
    account_id = "qualification-native-cold-cancel"
    query = {"account_id": account_id, "starting_balance_usdc": 100}
    request = dict(**query, client_order_id="native-one", market_id="fixture", outcome="YES", side="BUY", size_usdc=1, limit_price=0.01)
    path = server.DATA_DIR / server._account_key(account_id) / "paper.db"
    blocker, held = None, None
    with TestClient(server.app, raise_server_exceptions=False) as client:
        if stage.startswith("cancel_"):
            placed = client.post("/place-order", json=request)
            assert placed.status_code == 200, placed.text
            oid = placed.json()["order_id"]
            account = server.sidecars.accounts[account_id]
            conn = account.engine.db.conn
            if stage in ("cancel_account_lock", "cancel_registry_lock"):
                held = account.lock if stage == "cancel_account_lock" else server.sidecars.lock
                held.acquire()
            if stage == "cancel_sqlite_lock":
                blocker = original_connect(str(path))
                blocker.execute("BEGIN IMMEDIATE")
        elif stage in ("cold_open_lock", "cold_schema_lock"):
            path.parent.mkdir(parents=True)
            blocker = original_connect(str(path))
            if stage == "cold_schema_lock": blocker.execute("PRAGMA journal_mode=WAL")
            blocker.execute("BEGIN EXCLUSIVE" if stage == "cold_open_lock" else "BEGIN IMMEDIATE")
        expiry = int(time.time()*1000)+800
        ordinary = stage == "cancel_normal"
        success = stage in ("cold_success", "cancel_success", "cancel_normal")
        armed = True
        def action():
            if stage.startswith("cancel_"):
                return client.post("/orders/"+oid+"/cancel", params={**query, **({} if ordinary else {"action_deadline_at_ms": expiry})})
            if stage.startswith("cold_get_"):
                return client.get("/orders/missing", params={**query, "action_deadline_at_ms": expiry})
            if stage.startswith("cold_list_"):
                return client.get("/orders", params={**query, "action_deadline_at_ms": expiry})
            return client.post("/place-order", json={**request, "action_deadline_at_ms": expiry})
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(action)
            if phase.endswith(("mutation", "commit")) or stage == "cold_publish":
                assert entered.wait(2), stage
                time.sleep(max(0, expiry/1000-time.time())+0.05)
                release.set()
            response = future.result(timeout=2)
            assert time.monotonic()-started < 2, stage
            if success:
                assert response.status_code == (204 if stage.startswith("cancel_") else 200), response.text
            else:
                assert response.status_code >= 400, (stage, response.status_code, response.text)
            if held: held.release()
            if blocker:
                blocker.rollback()
                blocker.close()
            release.set()
        armed = False
        # Observe after blocked work is released: a failed action cannot mutate later.
        if stage.startswith("cancel_"):
            expected = "cancelled" if success else "pending"
            assert conn.execute("SELECT status FROM limit_orders").fetchone()[0] == expected, stage
            assert not conn.in_transaction
            assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
            assert account.orders[oid].status == ("canceled" if success else "open")
            # Preserve boot/account identity on the native route.
            bad = oid.replace(server.BOOT_ID, "another-boot")
            assert client.post("/orders/"+bad+"/cancel", params=query).status_code == 404
            assert client.post("/orders/"+oid+"/cancel", params={**query, "account_id": "other-account"}).status_code == 404
            assert client.post("/orders/"+oid+"/cancel", params=query).status_code == (404 if success else 204)
            assert conn.execute("SELECT status FROM limit_orders").fetchone()[0] == "cancelled"
        elif not success:
            assert account_id not in server.sidecars.accounts, stage
            for thread in created_threads:
                thread.join(0.5)
                assert not thread.is_alive(), stage
            check = original_connect(str(path))
            tables = {r[0] for r in check.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if phase.startswith(("cold_open_", "cold_schema_")):
                assert "account" not in tables and "limit_orders" not in tables, (stage, tables)
            if "account" in tables:
                assert check.execute("SELECT count(*) FROM account").fetchone()[0] == (1 if stage == "cold_publish" else 0), stage
            if "limit_orders" in tables:
                assert check.execute("SELECT count(*) FROM limit_orders").fetchone()[0] == 0, stage
            check.close()
            # The same cold request can bootstrap automatically after failure.
            repaired = client.post("/place-order", json={**request, "action_deadline_at_ms": int(time.time()*1000)+3000})
            assert repaired.status_code == 200, repaired.text
        account = server.sidecars.accounts[account_id]
        assert account.engine.db.get_account().cash == 100
        assert account._fill_thread.is_alive()
        # Ordinary callers on that native connection retain their default behavior.
        assert account.engine.db.conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        assert client.post("/place-order", json={**request, "client_order_id": "ordinary-after"}).status_code == 200
print("native cold/cancel HTTP scenario passed:", stage)
'''
    result = subprocess.run(
        [sys.executable, "-c", script, str(Path(__file__).resolve().parents[1]), stage],
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
