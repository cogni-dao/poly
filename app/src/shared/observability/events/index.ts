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
	DB_POOL_CONFIGURED: "adapter.db_pool.configured",
	// Node AI sandbox (story.0090): the push-token env provider warning and the cleanup tick.
	ADAPTER_SANDBOX_PUSH_TOKEN: "adapter.sandbox.push_token",
	ADAPTER_SANDBOX_TICK: "adapter.sandbox.tick",
	// Admin AI access (story.0090): one terminal event per permission operation, and the admin session's audit.
	ADMIN_ACTION: "admin.action",
	AI_PERMISSION_COMPLETE: "ai_permission.complete",
	// Agent authority host (`@cogni/agent-grants/host`, AGENT_HOST_EVENTS): the names repeat the package's values (parity test).
	AGENT_TOOL_AUTHZ: "agent_tool.authz",
	AGENT_ROLE_GRANTED: "agent_role.granted",
	AGENT_ROLE_REVOKED: "agent_role.revoked",
	AGENT_ROLE_REQUESTED: "agent_role.requested",
	AGENT_ROLE_DENIED: "agent_role.denied",
	AGENT_ROLES_UNAVAILABLE: "agent.roles.unavailable",
	// Wallet-analysis slice failed and was swallowed into a response warning (bug.5064).
	POLY_WALLET_ANALYSIS_SLICE_FAILED: "poly.wallet_analysis.slice_failed",
	// Research read refused because Postgres had no connection to give (bug.5064): 503, not 500.
	POLY_RESEARCH_DB_CAPACITY_UNAVAILABLE:
		"poly.research.db_capacity_unavailable",
	// Reconciler skipped an account with no buildable executor (bug.5050): one per account per tick.
	POLY_MIRROR_RECONCILE_ACCOUNT_UNAVAILABLE:
		"poly.mirror.reconcile.account_unavailable",
	// Goal metrics (story.0021): refresh dispatch receipt and goals read.
	METRIC_REFRESH_COMPLETE: "metric.refresh_complete",
	GOALS_PROGRESS_READ: "goals.progress_read",
	// Work item expectations read (task.0112): one terminal event per request, no row content.
	WORK_EXPECTATIONS_READ: "work.expectations.read",
	// Row history reads (story.0023): one terminal event per read, counts only.
	WORK_ITEMS_HISTORY_READ: "work.items.history_read",
	// Bounded work reads (task.0056): one terminal event per /work/summaries or /work/board request.
	WORK_ITEMS_LIST_COMPLETE: "work.items.list_complete",
	// bug.0063: the package route core emits these; the names repeat WORK_ITEM_WRITE_EVENTS.
	WORK_ITEMS_CREATE_SUCCESS: "work.items.create_success",
	WORK_ITEMS_CREATE_REFUSED: "work.items.create_refused",
	WORK_ITEMS_PATCH_SUCCESS: "work.items.patch_success",
	WORK_ITEMS_PATCH_REFUSED: "work.items.patch_refused",
	KNOWLEDGE_HISTORY_READ: "knowledge.history_read",
	KNOWLEDGE_CONTRIBUTION_DIFF_SUCCESS: "knowledge.contribution.diff_success",
	// Auth perimeter (proxy): request rejected before reaching any route handler,
	// so the request-scoped logger never sees it — emitted directly from the proxy.
	AUTH_PERIMETER_DENIED: "auth.perimeter.denied",
	// /admin/payments money-plane snapshot: one terminal event per page read
	// (outcome success|error, durationMs, worst grade, per-plane grade enums).
	MONEY_PLANE_SNAPSHOT: "money_plane.snapshot",

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

	POLY_AGENT_GRANT_ACCESS_DECISION: "feature.poly_agent_grant.access_decision",
	POLY_RESEARCH_COPY_TRADE_PNL_COMPLETE:
		"feature.poly_research.copy_trade_pnl.complete",
	POLY_RESEARCH_COPY_TRADE_INVESTIGATION_COMPLETE:
		"feature.poly_research.copy_trade_investigation.complete",
	POLY_RESEARCH_TRADER_COMPARISON_COMPLETE:
		"feature.poly_research.trader_comparison.complete",

	// Copy-operations account reads (task.1791070959). One terminal event per
	// capability, emitted ONLY by `executeAccountRead`.
	POLY_ACCOUNT_COPY_SETUP_COMPLETE: "feature.poly_account.copy_setup.complete",
	POLY_ACCOUNT_RECENT_ATTEMPTS_COMPLETE:
		"feature.poly_account.recent_attempts.complete",
	POLY_ACCOUNT_TARGET_POSITIONS_COMPLETE:
		"feature.poly_research.target_positions.complete",
	POLY_COPY_TRADE_ORDERS_COMPLETE: "feature.poly_copy_trade.orders.complete",
	POLY_WALLET_REFRESH_COMPLETE: "feature.poly_wallet_refresh.complete",
	POLY_WALLET_DASHBOARD_COMPLETE: "feature.poly_wallet_dashboard.complete",
	POLY_WALLET_POSITIONS_CLOSE_COMPLETE:
		"feature.poly_wallet_positions_close.complete",

	// Push-on-wake mirror dispatch (task.5017)
	POLY_MIRROR_ASSIGNMENT_RETIRED: "poly.mirror.assignment_retired",
	POLY_MIRROR_WAKE_TICK: "poly.mirror.wake_tick",
	POLY_WALLET_WATCH_WS_WAKE_CALLBACK_THREW:
		"poly.wallet_watch.ws.wake_callback_threw",

	// Polygon chain-log wallet-watch source (task.5043). Heartbeat reuses
	// POLY_WALLET_WATCH_WS_HEARTBEAT — same Loki absence-alert key applies, the
	// `component` label disambiguates ws vs chain in the line body.
	POLY_WALLET_WATCH_CHAIN_STARTED: "poly.wallet_watch.chain.started",
	POLY_WALLET_WATCH_CHAIN_STOPPED: "poly.wallet_watch.chain.stopped",

	POLY_RECONCILER_STATUS_UPDATED: "poly.reconciler.status_updated",
	// Paper-account fact projection (story.5016). Background work has no HTTP
	// reqId, so these registry-backed terminal events are the correlation seam.
	POLY_PAPER_ACCOUNT_ADDRESS_MISMATCH: "poly.paper.account_address_mismatch",
	POLY_PAPER_ACCOUNT_FUNDER_MISMATCH: "poly.paper.account_funder_mismatch",
	POLY_PAPER_ACCOUNT_SEED_MISSING: "poly.paper.account_seed_missing",
	POLY_PAPER_POSITION_INCOHERENT: "poly.paper.position_incoherent",
	POLY_PAPER_NAV_WITHHELD: "poly.paper.nav_withheld",
	POLY_PAPER_NAV_NEGATIVE: "poly.paper.nav_negative",
	POLY_PAPER_OBSERVE: "poly.paper.observe",
	POLY_PAPER_PROJECT: "poly.paper.project",
	POLY_POSITION_GAP_V3_RUN_FAILED: "poly.position_gap.v3.run_failed",
	POLY_POSITION_GAP_V3_RUN_RECOVERED: "poly.position_gap.v3.run_recovered",
	POLY_POSITION_GAP_PAPER_FILL_EVIDENCE_UNAVAILABLE:
		"poly.position_gap.v3.paper_fill_evidence_unavailable",
	POLY_ALGORITHM_ATTEMPT_COMPLETE: "feature.poly_algorithm.attempt.complete",

	// Process health (bug.5520). One info line per 60s window: the max event-loop
	// block is the direct signal for in-process sync work stalling every request.
	PROCESS_EVENT_LOOP_DELAY: "process.event_loop_delay",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];
export type { EventBase };
