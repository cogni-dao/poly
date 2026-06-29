// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/observability/events`
 * Purpose: App-local event registry for structured logging.
 * Scope: Extends shared node event names with Poly app events that are not
 *   exported from `@cogni/node-shared`.
 * Invariants: New app log event names are registered here; callsites do not
 *   inline event strings.
 * Side-effects: none
 * @public
 */

import {
  type EventBase,
  EVENT_NAMES as SHARED_EVENT_NAMES,
} from "@cogni/node-shared/observability/events";

export const EVENT_NAMES = {
  ...SHARED_EVENT_NAMES,
  // Auth perimeter (proxy): request rejected before reaching any route handler,
  // so the request-scoped logger never sees it — emitted directly from the proxy.
  AUTH_PERIMETER_DENIED: "auth.perimeter.denied",

  POLY_WALLET_ENABLE_TRADING_COMPLETE:
    "feature.poly_wallet_enable_trading.complete",
  ADAPTER_POLY_WALLET_RESOLVE_ERROR: "adapter.poly_wallet.resolve_error",

  // Poly redeem lifecycle bridge (task.5006)
  POLY_REDEEM_CATCHUP_COMPLETE: "feature.poly_redeem.catchup.complete",
  POLY_REDEEM_CATCHUP_FAILED: "feature.poly_redeem.catchup.failed",
  POLY_REDEEM_CATCHUP_TICK_SKIPPED: "poly.ctf.redeem.catchup_tick_skipped",
  POLY_REDEEM_DIFF_TICK_COMPLETE: "feature.poly_redeem.diff_tick.complete",
  POLY_REDEEM_DIFF_TICK_FAILED: "feature.poly_redeem.diff_tick.failed",
  POLY_REDEEM_DIFF_TICK_SKIPPED: "poly.ctf.redeem.diff_tick_skipped",
  POLY_REDEEM_LIFECYCLE_MIRRORED: "feature.poly_redeem.lifecycle_mirrored",
  POLY_REDEEM_LIFECYCLE_MIRROR_FAILED:
    "feature.poly_redeem.lifecycle_mirror_failed",

  POLY_AGENT_KEYS_MINTED: "feature.agent.keys.minted",
  POLY_USERS_ME_ACCOUNT_COMPLETE: "feature.users.me.account.complete",
  POLY_RESEARCH_COPY_TRADE_PNL_COMPLETE:
    "feature.poly_research.copy_trade_pnl.complete",
  POLY_RESEARCH_TRADER_COMPARISON_COMPLETE:
    "feature.poly_research.trader_comparison.complete",
  POLY_WALLET_REFRESH_COMPLETE: "feature.poly_wallet_refresh.complete",
  POLY_WALLET_POSITIONS_CLOSE_COMPLETE:
    "feature.poly_wallet_positions_close.complete",

  // Push-on-wake mirror dispatch (task.5017)
  POLY_MIRROR_WAKE_TICK: "poly.mirror.wake_tick",
  POLY_WALLET_WATCH_WS_WAKE_CALLBACK_THREW:
    "poly.wallet_watch.ws.wake_callback_threw",

  // Polygon chain-log wallet-watch source (task.5043). Heartbeat reuses
  // POLY_WALLET_WATCH_WS_HEARTBEAT — same Loki absence-alert key applies, the
  // `component` label disambiguates ws vs chain in the line body.
  POLY_WALLET_WATCH_CHAIN_STARTED: "poly.wallet_watch.chain.started",
  POLY_WALLET_WATCH_CHAIN_STOPPED: "poly.wallet_watch.chain.stopped",

  POLY_RECONCILER_STATUS_UPDATED: "poly.reconciler.status_updated",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];
export type { EventBase };
