// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/copy-trade-mirror.job`
 * Purpose: Disposable 30s scheduler that drives `mirror-pipeline.runMirrorTick()`. Boot-guarded by per-tenant executor factory presence + a non-empty `CopyTradeTargetSource`. Uses `setInterval` (not `@cogni/scheduler-core` — that package is governance-schedule machinery, not a tick library). In-memory cursor + one-shot singleton claim. One poll instance per (tenant × target wallet) pair.
 * Scope: Wiring + cadence only. Does not build adapters (container injects), does not own decision logic, does not touch DB directly. One function: `startMirrorPoll(deps) → stop()`.
 * Invariants:
 *   - SCAFFOLDING_LABELED — this file and its wiring are `@scaffolding` / `Deleted-in-phase: 4`. P4's cutover PR deletes this file + the env-based target config.
 *   - SINGLE_WRITER — exactly one process runs the poll. Enforced by caller (POLY_ROLE=trader + replicas=1 is the joint invariant). Boot logs `event:poly.mirror.poll.singleton_claim` so a second pod running this code is Loki-visible.
 *   - TICK_IS_SELF_HEALING — the pipeline already swallows per-fill + per-source errors; the tick wrapper catches anything that escapes, logs, and keeps the interval going.
 *   - NO_CURSOR_PERSISTENCE_V0 — cursor lives in-memory and resets on boot. On startup the initial cursor is `Math.floor(now/1000) - WARMUP_BACKLOG_SEC` so we don't replay a target's months-deep history through `planMirrorFromFill()`.
 *   - CAPS_LIVE_IN_GRANT — daily / hourly USDC caps are enforced downstream by `authorizeIntent` inside the per-tenant `placeIntent` executor (see `bootstrap/capabilities/poly-trade-executor.ts`). Mirror-sizing here is notional only.
 * Side-effects: starts a `setInterval`, emits logs + metrics.
 * Links: work/items/task.0318 (Phase B3), docs/spec/poly-tenant-and-collateral.md
 *
 * @scaffolding
 * Deleted-in-phase: 4 (replaced by Temporal-hosted WS ingester workflow; see
 *   work/items/task.0322.poly-copy-trade-phase4-design-prep.md).
 *
 * @internal
 */

import type {
  LoggerPort,
  MetricsPort,
  OrderReceipt,
} from "@cogni/poly-market-provider";
import {
  type MirrorPipelineDeps,
  type OperatorPosition,
  runMirrorTick,
} from "@/features/copy-trade/mirror-pipeline";
import { positionCostUsdc } from "@/features/copy-trade/position-cost";
import { targetIdFromWallet } from "@/features/copy-trade/target-id";
import {
  buildWalletStatistic,
  snapshotForTargetWallet,
} from "@/features/copy-trade/target-percentile-snapshots";
import type {
  MirrorTargetConfig,
  PositionFollowupPolicy,
  SizingPolicy,
  TargetConditionPositionView,
} from "@/features/copy-trade/types";
import type { OrderLedger } from "@/features/trading";
import type { WalletActivitySource } from "@/features/wallet-watch";
import { EVENT_NAMES } from "@/shared/observability/events";

export const MIRROR_JOB_METRICS = {
  /** `poly_mirror_poll_ticks_total` — one per successful tick. Alertable on rate from >1 pod (SINGLE_WRITER canary). */
  pollTicksTotal: "poly_mirror_poll_ticks_total",
  /** `poly_mirror_poll_tick_errors_total` — tick wrapper catches an escape. */
  pollTickErrorsTotal: "poly_mirror_poll_tick_errors_total",
  /** `poly_mirror_ws_wake_ticks_total` — wake-driven tick fired (push-on-wake path). Push runs in addition to the safety-net `setInterval`. Use `rate(...)` to confirm push is producing signal in prod. */
  wsWakeTicksTotal: "poly_mirror_ws_wake_ticks_total",
  /** `poly_mirror_ws_wake_tick_errors_total` — wake IIFE wrapper caught an escape (paranoia counter; `tick()` already swallows). */
  wsWakeTickErrorsTotal: "poly_mirror_ws_wake_tick_errors_total",
} as const;

/** How far back to initialize the first-tick cursor (seconds). */
const WARMUP_BACKLOG_SEC = 60;

/**
 * Hardcoded v0 scaffolding parameters for mirror sizing. Caps ($/day, fills/hr)
 * moved to the tenant's `poly_wallet_grants` row in Phase B3 and are enforced
 * by `authorizeIntent`.
 */
const MIRROR_POLL_MS = 30_000;
const DEFAULT_MIRROR_MAX_USDC_PER_TRADE = 5;
const DEFAULT_CONVICTION_FILTER_PERCENTILE = 75;
/**
 * bug.5048 — target-dominance gate threshold. Fill on a token holding < 20% of
 * target's total condition cost is rejected as `target_dominant_other_side`.
 * Catches Chelsea/Nott-Forest (4.4% minority) with margin; permissive enough
 * for genuine 70/30 hedges to route through the hedge branch. Tunable
 * per-target.
 */
const DEFAULT_MIN_TARGET_SIDE_FRACTION = 0.2;
/**
 * bug.5048 — upward tolerance above target's VWAP on the fill's token. 0.005
 * = 0.5pp on the 0–1 price scale. Covers tick-grid rounding + ladder
 * slippage. Above this we refuse to place (`vwap_floor_breach`).
 */
const DEFAULT_VWAP_TOLERANCE = 0.005;
const DEFAULT_POSITION_FOLLOWUP_POLICY: PositionFollowupPolicy = {
  enabled: true,
  min_mirror_position_usdc: 5,
  market_floor_multiple: 5,
  min_target_hedge_ratio: 0.02,
  min_target_hedge_usdc: 5,
  max_hedge_fraction_of_position: 0.25,
  max_layer_fraction_of_position: 0.5,
};
/**
 * Per-target sizing-policy kind. `'auto'` (the back-compat sentinel) tells
 * `buildSizingPolicy` to infer the kind from the wallet's curated snapshot;
 * explicit kinds pin the planner regardless of snapshot. Mirrors the DB
 * CHECK on `poly_copy_trade_targets.sizing_policy_kind` and the
 * `SizingPolicySchema` discriminated union — adding a variant requires
 * updating all three together.
 */
type SizingPolicyKindInput =
  | "auto"
  | "min_bet"
  | "target_percentile_scaled"
  | "position_gap"
  | "mirror_fill_exact";

function minBetPolicy(maxUsdcPerCondition: number): SizingPolicy {
  return {
    kind: "min_bet",
    // DB column `mirror_max_usdc_per_trade` retained; v0 internal rename
    // to `max_usdc_per_condition` (bug.5054). bug.5004 narrowed the cap
    // scope from per-conditionId to per-token_id (CAP_IS_PER_TOKEN_ID) —
    // the value here now bounds each leg of a hedged binary independently.
    max_usdc_per_condition: maxUsdcPerCondition,
  };
}

function buildSizingPolicy(params: {
  targetWallet: `0x${string}`;
  mirrorFilterPercentile: number;
  mirrorMaxUsdcPerTrade: number;
  /** Per-target opt-in; `'auto'` (default) preserves snapshot-derived behavior. */
  sizingPolicyKind: SizingPolicyKindInput;
  /**
   * Per-target assumed per-condition position ceiling for `position_gap`.
   * Required when `resolvedKind === 'position_gap'`; throws otherwise.
   * task.5014 range-relative rewrite — no fallback constant, no default.
   */
  targetRangeMaxUsdc?: number;
  /**
   * Per-condition USDC cap for `position_gap`. Required when
   * `resolvedKind === 'position_gap'`; throws otherwise. task.5014.
   */
  mirrorMaxAllocPerConditionUsdc?: number;
}): SizingPolicy {
  const snapshot = snapshotForTargetWallet(params.targetWallet);
  const resolvedKind: Exclude<SizingPolicyKindInput, "auto"> =
    params.sizingPolicyKind === "auto"
      ? snapshot
        ? "target_percentile_scaled"
        : "min_bet"
      : params.sizingPolicyKind;
  if (resolvedKind === "min_bet") {
    return minBetPolicy(params.mirrorMaxUsdcPerTrade);
  }
  if (resolvedKind === "position_gap") {
    if (
      params.targetRangeMaxUsdc === undefined ||
      !(params.targetRangeMaxUsdc > 0)
    ) {
      throw new Error(
        `position_gap target ${params.targetWallet} missing target_range_max_usdc — CHECK constraint should have caught this at the DB layer`
      );
    }
    if (
      params.mirrorMaxAllocPerConditionUsdc === undefined ||
      !(params.mirrorMaxAllocPerConditionUsdc > 0)
    ) {
      throw new Error(
        `position_gap target ${params.targetWallet} missing mirror_max_alloc_per_condition_usdc — CHECK constraint should have caught this at the DB layer`
      );
    }
    return {
      kind: "position_gap",
      target_range_max_usdc: params.targetRangeMaxUsdc,
      mirror_max_alloc_per_condition_usdc:
        params.mirrorMaxAllocPerConditionUsdc,
    };
  }
  if (resolvedKind === "mirror_fill_exact") {
    return { kind: "mirror_fill_exact" };
  }
  // `target_percentile_scaled` requires a snapshot. If the user explicitly
  // pinned this kind on an uncurated wallet, fall back to `min_bet` — same
  // shape as `'auto'` on uncurated wallets, preserves DEFAULT-no-crash.
  if (!snapshot) {
    return minBetPolicy(params.mirrorMaxUsdcPerTrade);
  }
  return {
    kind: "target_percentile_scaled",
    max_usdc_per_condition: params.mirrorMaxUsdcPerTrade,
    statistic: buildWalletStatistic(snapshot, params.mirrorFilterPercentile),
  };
}

/**
 * Resolve the effective sizing-policy kind for a target wallet at config-
 * load time. `'auto'` inputs (or omitted) inherit from snapshot availability;
 * explicit kinds pin the result, but `target_percentile_scaled` on a wallet
 * with no curated snapshot degrades to `min_bet` (same fallback as
 * `buildSizingPolicy`).
 */
export function sizingPolicyKindForTargetWallet(
  targetWallet: `0x${string}`,
  configuredKind: SizingPolicyKindInput = "auto"
):
  | "min_bet"
  | "target_percentile_scaled"
  | "position_gap"
  | "mirror_fill_exact" {
  const snapshot = snapshotForTargetWallet(targetWallet);
  if (configuredKind === "auto") {
    return snapshot ? "target_percentile_scaled" : "min_bet";
  }
  if (configuredKind === "target_percentile_scaled" && !snapshot) {
    return "min_bet";
  }
  return configuredKind;
}

/**
 * Build a `MirrorTargetConfig` from an enumerated target wallet + tenant
 * attribution. All non-tenant fields stay hardcoded scaffolding. Daily /
 * hourly caps now live on the tenant's `poly_wallet_grants` row and are
 * enforced by `authorizeIntent`.
 *
 * @public
 */
export function buildMirrorTargetConfig(params: {
  targetWallet: `0x${string}`;
  billingAccountId: string;
  createdByUserId: string;
  mirrorFilterPercentile?: number;
  mirrorMaxUsdcPerTrade?: number;
  /**
   * Per-target sizing-policy kind. Read from
   * `poly_copy_trade_targets.sizing_policy_kind` by the enumerator. Defaults
   * to `'auto'` (snapshot-derived) for back-compat.
   */
  sizingPolicyKind?: SizingPolicyKindInput;
  /**
   * Per-target assumed per-condition position ceiling for `position_gap`.
   * Read from `poly_copy_trade_targets.target_range_max_usdc` by the
   * enumerator. Required when `sizingPolicyKind === 'position_gap'` (CHECK
   * enforced at the DB layer). task.5014.
   */
  targetRangeMaxUsdc?: number;
  /**
   * Per-condition USDC cap for `position_gap`. Read from
   * `poly_copy_trade_targets.mirror_max_alloc_per_condition_usdc` by the
   * enumerator. Required when `sizingPolicyKind === 'position_gap'`.
   * task.5014.
   */
  mirrorMaxAllocPerConditionUsdc?: number;
}): MirrorTargetConfig {
  const mirrorFilterPercentile =
    params.mirrorFilterPercentile ?? DEFAULT_CONVICTION_FILTER_PERCENTILE;
  const mirrorMaxUsdcPerTrade =
    params.mirrorMaxUsdcPerTrade ?? DEFAULT_MIRROR_MAX_USDC_PER_TRADE;
  const sizing = buildSizingPolicy({
    targetWallet: params.targetWallet,
    mirrorFilterPercentile,
    mirrorMaxUsdcPerTrade,
    sizingPolicyKind: params.sizingPolicyKind ?? "auto",
    ...(params.targetRangeMaxUsdc !== undefined
      ? { targetRangeMaxUsdc: params.targetRangeMaxUsdc }
      : {}),
    ...(params.mirrorMaxAllocPerConditionUsdc !== undefined
      ? {
          mirrorMaxAllocPerConditionUsdc: params.mirrorMaxAllocPerConditionUsdc,
        }
      : {}),
  });
  // SELF_CONTAINED_SIZING_POLICIES: `mirror_fill_exact` and `position_gap`
  // each encode their own conviction (verbatim per-fill mirror, range-relative
  // gap math). Attaching the bug.5048 per-fill gates — `min_target_side_fraction`,
  // `vwap_tolerance` — or the `position_followup` dispatcher would re-introduce
  // filtering these policies exist to evaluate without (and worse, fire as
  // spurious skips: bug.5027). Optional fields are fail-open when unset; see
  // `planMirrorFromFill`'s applyVwapGate + analyzeTargetDominance + the
  // `skipFollowupDispatch` short-circuit in `decideMirrorBranch`.
  const isSelfContainedPolicy =
    sizing.kind === "mirror_fill_exact" || sizing.kind === "position_gap";
  return {
    target_id: targetIdFromWallet(params.targetWallet),
    target_wallet: params.targetWallet,
    billing_account_id: params.billingAccountId,
    created_by_user_id: params.createdByUserId,
    sizing,
    // task.5001 — default to mirror_limit (resting GTC at target's entry).
    // Persistence to a per-target column is deferred to task.0347.
    placement: { kind: "mirror_limit" },
    // bug.5048 — gate new_entry + layer routing against target's per-side
    // cost asymmetry, and refuse to place above target's per-token VWAP.
    // Skipped under self-contained policies.
    ...(isSelfContainedPolicy
      ? {}
      : {
          min_target_side_fraction: DEFAULT_MIN_TARGET_SIDE_FRACTION,
          vwap_tolerance: DEFAULT_VWAP_TOLERANCE,
        }),
    ...(!isSelfContainedPolicy &&
    snapshotForTargetWallet(params.targetWallet) !== undefined
      ? { position_followup: DEFAULT_POSITION_FOLLOWUP_POLICY }
      : {}),
  };
}

export function targetConditionPositionFromDataApiPositions(
  conditionId: string,
  positions: Array<{
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
  }>
): TargetConditionPositionView {
  return {
    condition_id: conditionId,
    tokens: positions
      .filter((position) => position.conditionId === conditionId)
      .map((position) => ({
        token_id: position.asset,
        size_shares: Math.max(0, position.size),
        cost_usdc: positionCostUsdc(position),
        current_value_usdc: Math.max(0, position.currentValue),
      })),
  };
}

// `positionCostUsdc` moved to `@features/copy-trade/position-cost` so the
// bootstrap container's whole-book Σ hydrator shares the same fallback
// semantics. Re-imported below.

export interface MirrorJobDeps {
  /** Target config — built via `buildMirrorTargetConfig`; Phase 4 reads from a tenant-aware table. */
  target: MirrorTargetConfig;
  /** Injected source (Data-API adapter) — P4 swaps in WS. */
  source: WalletActivitySource;
  /** Order ledger (Drizzle-backed in prod, FakeOrderLedger in tests). */
  ledger: OrderLedger;
  /**
   * Tenant-scoped placement seam. Delegates to the per-tenant
   * `PolyTradeExecutor.placeIntent`, which wraps `authorizeIntent` + adapter
   * `placeOrder`. Must be constructed against `params.billingAccountId`.
   */
  placeIntent: MirrorPipelineDeps["placeIntent"];
  /**
   * Tenant-scoped cancel seam (task.5001). Delegates to
   * `PolyTradeExecutor.cancelOrder` → 404-idempotent
   * `PolymarketClobAdapter.cancelOrder`. Optional in tests; production wiring
   * always sets it so SELL fills cancel resting mirror BUYs.
   */
  cancelOrder?: MirrorPipelineDeps["cancelOrder"];
  /** Optional market-constraints fetch; pipes into the pipeline. bug.0342. */
  getMarketConstraints?: MirrorPipelineDeps["getMarketConstraints"];
  /** Optional target-position read; v0 production uses Polymarket Data API. */
  getTargetConditionPosition?: MirrorPipelineDeps["getTargetConditionPosition"];
  /**
   * Optional per-(billing, target, condition) baseline writer for `position_gap`
   * (task.5014 range-relative rewrite). See
   * `MirrorPipelineDeps.getOrInsertConditionBaseline` for semantics.
   */
  getOrInsertConditionBaseline?: MirrorPipelineDeps["getOrInsertConditionBaseline"];
  /** Structured log sink. */
  logger: LoggerPort;
  /** Metrics sink. */
  metrics: MetricsPort;
  /**
   * Optional SELL-to-close path from `PolyTradeExecutor.closePosition`.
   * When absent, SELL fills degrade to `skip/sell_without_position`.
   */
  closePosition?: (params: {
    tokenId: string;
    max_size_usdc: number;
    limit_price: number;
    client_order_id: `0x${string}`;
  }) => Promise<OrderReceipt>;
  /**
   * Optional position query from `PolyTradeExecutor.listPositions`.
   * When absent, SELL fills degrade to `skip/sell_without_position`.
   */
  getOperatorPositions?: () => Promise<OperatorPosition[]>;
}

/** Stops the poll. Returned so the container can call on SIGTERM (future). */
export type MirrorJobStopFn = () => void;

/**
 * Start the 30s mirror poll. Emits `poly.mirror.poll.singleton_claim` at
 * boot (ops alerts on absence or on duplicate rate). Returns a stop fn.
 *
 * @public
 */
export function startMirrorPoll(deps: MirrorJobDeps): MirrorJobStopFn {
  const log = deps.logger.child({
    component: "mirror-job",
    target_id: deps.target.target_id,
    target_wallet: deps.target.target_wallet,
    billing_account_id: deps.target.billing_account_id,
  });

  // First-tick cursor — avoid replaying a target's historical activity at boot.
  let cursor: number | undefined =
    Math.floor(Date.now() / 1000) - WARMUP_BACKLOG_SEC;

  log.info(
    {
      event: EVENT_NAMES.POLY_MIRROR_POLL_SINGLETON_CLAIM,
      poll_ms: MIRROR_POLL_MS,
      initial_cursor: cursor,
      warmup_backlog_sec: WARMUP_BACKLOG_SEC,
    },
    "mirror poll starting (SINGLE_WRITER — alert on duplicate pods running this)"
  );

  const pipelineDeps: MirrorPipelineDeps = {
    source: deps.source,
    ledger: deps.ledger,
    placeIntent: deps.placeIntent,
    ...(deps.cancelOrder !== undefined
      ? { cancelOrder: deps.cancelOrder }
      : {}),
    getMarketConstraints: deps.getMarketConstraints,
    getTargetConditionPosition: deps.getTargetConditionPosition,
    getOrInsertConditionBaseline: deps.getOrInsertConditionBaseline,
    target: deps.target,
    getCursor: () => cursor,
    setCursor: (n) => {
      cursor = n;
    },
    logger: deps.logger,
    metrics: deps.metrics,
    // exactOptionalPropertyTypes: only spread when defined to avoid
    // assigning `undefined` to a property typed as `T` (not `T | undefined`).
    ...(deps.closePosition !== undefined
      ? { closePosition: deps.closePosition }
      : {}),
    ...(deps.getOperatorPositions !== undefined
      ? { getOperatorPositions: deps.getOperatorPositions }
      : {}),
  };

  async function tick(): Promise<void> {
    try {
      await runMirrorTick(pipelineDeps);
      deps.metrics.incr(MIRROR_JOB_METRICS.pollTicksTotal, {});
    } catch (err: unknown) {
      // Belt-and-suspenders: the pipeline already catches per-fill errors
      // + source errors. Anything that escapes to here is a real bug, not
      // operational data. Log + counter + keep the interval going.
      deps.metrics.incr(MIRROR_JOB_METRICS.pollTickErrorsTotal, {});
      log.error(
        {
          event: EVENT_NAMES.POLY_MIRROR_POLL_TICK_ERROR,
          errorCode: "tick_escaped_handler",
          err: err instanceof Error ? err.message : String(err),
        },
        "mirror poll: tick threw (continuing)"
      );
    }
  }

  // First tick fires immediately so ops sees activity without waiting 30s.
  // `void` keeps the promise from leaking back into the event loop error flow.
  void tick();

  // Push-on-wake: when the source supports `subscribeWake`, a watched-asset WS
  // frame fires the registered callback synchronously. We collapse fan-in with
  // a single-flight runner — at most one wake-tick in flight, plus at most one
  // queued follow-up — so a burst of frames coalesces into ≤2 ticks. The 30s
  // `setInterval` below is the safety-net for new-market discovery and zombie
  // WS recovery; it stays untouched. Push path is purely additive.
  let inFlightWakeTick: Promise<void> | null = null;
  let queuedWakeup = false;
  let unsubscribeWake: (() => void) | null = null;

  if (deps.source.subscribeWake) {
    unsubscribeWake = deps.source.subscribeWake(() => {
      if (inFlightWakeTick) {
        queuedWakeup = true;
        return;
      }
      inFlightWakeTick = (async () => {
        do {
          queuedWakeup = false;
          const t0 = Date.now();
          let threw = false;
          try {
            await tick();
          } catch (err: unknown) {
            // `tick()` already swallows everything; this is paranoia for a
            // future refactor that lets something escape.
            threw = true;
            deps.metrics.incr(MIRROR_JOB_METRICS.wsWakeTickErrorsTotal, {});
            log.error(
              {
                event: EVENT_NAMES.POLY_MIRROR_POLL_TICK_ERROR,
                errorCode: "wake_tick_threw",
                err: err instanceof Error ? err.message : String(err),
              },
              "push-on-wake tick threw (continuing)"
            );
          }
          if (!threw) {
            deps.metrics.incr(MIRROR_JOB_METRICS.wsWakeTicksTotal, {});
          }
          log.debug(
            {
              event: EVENT_NAMES.POLY_MIRROR_WAKE_TICK,
              duration_ms: Date.now() - t0,
              queued: queuedWakeup,
              threw,
            },
            "wake tick complete"
          );
        } while (queuedWakeup);
        inFlightWakeTick = null;
      })();
    });
  }

  const handle = setInterval(() => {
    void tick();
  }, MIRROR_POLL_MS);

  return function stop() {
    unsubscribeWake?.();
    clearInterval(handle);
    log.info(
      { event: EVENT_NAMES.POLY_MIRROR_POLL_STOPPED },
      "mirror poll stopped"
    );
  };
}

// `targetIdFromWallet` moved to `@/features/copy-trade/target-id` so the env
// `CopyTradeTargetSource` impl can synthesize stable per-wallet ids without
// crossing the features → bootstrap layer boundary. Re-exported here for
// pre-existing import sites.
export { targetIdFromWallet };
