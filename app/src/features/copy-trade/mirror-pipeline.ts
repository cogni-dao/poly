// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/mirror-pipeline`
 * Purpose: Thin pipeline that glues `features/wallet-watch/` → the shared algorithm registry → `features/trading/`. Pure `runMirrorTick(deps)` — no `setInterval`, no env reads, no DB client construction. The ONLY file in the feature layer that imports from both sibling slices.
 * Scope: Sequencing + INSERT_BEFORE_PLACE enforcement. Does not own cadence (bootstrap job), does not own cursor persistence (deps supply `getCursor`/`setCursor`), does not construct adapters.
 * Invariants:
 *   - COPY_TRADE_ONLY_PIPES — the pipeline is the only slice file that imports both `trading/` and `wallet-watch/`.
 *   - INSERT_BEFORE_PLACE — `order-ledger.insertPending` runs BEFORE the placeIntent executor. `markOrderId` / `markError` run AFTER. Crash between insert and place leaves a pending row whose `client_order_id` will be in the next tick's `already_placed_ids`, so `planMirrorFromFill()` returns `skip/already_placed`.
 *   - IDEMPOTENT_BY_CLIENT_ID — `client_order_id = clientOrderIdFor(target.billing_account_id, target.target_id, fill.fill_id)`, pinned helper. Deterministic from the per-tenant PK triple so re-runs dedupe within a tenant; N tenants mirroring the same fill produce N distinct client_order_ids.
 *   - RECORD_EVERY_DECISION — `order-ledger.recordDecision` fires for EVERY registry outcome (placed, skipped, or error) with the same first-class algorithm lineage as the ledger row.
 *   - DECISIONS_TOTAL_HAS_SOURCE — `poly_mirror_decisions_total{outcome, reason, source, placement}` always carries `source` (v0 = `"data-api"`) AND `placement` (`"limit"` | `"market_fok"`).
 *   - DECISION_LAG_OBSERVED_ONCE (task.5042) — every fill emits exactly one `poly_mirror_decision_lag_ms{source}` observation, measured as `decided_at - fill.observed_at`, clamped ≥0. The same `lag_ms_total` is attached as a logger-child field so every downstream decision log line (skip / placed / error / SELL-close) inherits it without per-site edits. Measurement-first lever for root-causing target-fill → mirror-decision lag before any fill-source rebuild.
 *   - DECISION_FACTS_POLICY_INDEPENDENT — every algorithm observes the same mirror NAV and exact fill-token shares before it decides. Policy selects behavior, never telemetry availability; target and mirror facts fail independently so a target API outage cannot erase an available account fact.
 *   - WRONG_SIDE_HOLDING_COUNTER (bug.5048) — `poly_mirror_wrong_side_holding_total{target_id, condition_id}` fires once per option-C decision (wallet held a non-dominant leg from cross-target activity AND current target's dominant fill arrived). Co-emitted WARN log carries `wrong_side_holding_detected: true`, `our_minority_token_id`, `target_dominant_token_id`, `target_side_fraction`. Bounded cardinality; alertable at any non-zero rate above documented residue.
 *   - TENANT_INHERITED_FROM_TARGET — every `insertPending` and `recordDecision` writes `(billing_account_id, created_by_user_id)` taken from `deps.target` (`MirrorTargetConfig`). The pipeline never reads tenant from anywhere else.
 *   - CAPS_LIVE_IN_GRANT — daily / hourly caps are enforced by `authorizeIntent` inside the per-tenant `placeIntent` executor, not here.
 *   - ALREADY_RESTING_BEFORE_INSERT — BUY path runs `ledger.findOpenForMarket` BEFORE `insertPending`. When at least one row exists, the staleness check (`isRestingPriceStale`) decides between (a) skip as `already_resting` (current state) or (b) cancel-then-place (bug.5035: stale resting price chokes off layer-up signals). The DB partial unique index is the correctness backstop: a 23505 throws `AlreadyRestingError` which converts to the same `skip/already_resting` outcome. task.5001 / bug.5035.
 *   - MIRROR_BUY_CANCELED_ON_TARGET_SELL — every SELL fill cancels open mirror orders on `(target, market)` BEFORE the position-close path. `cancelOrder` is optional in tests; production wiring always sets it. Pending rows (no `order_id`) are silently skipped — race with in-flight placement is acceptable for v0. task.5001.
 *   - STALE_RESTING_CANCEL_REPLACE — BUY path: when an open row's `attributes.limit_price` differs from the new intent's `limit_price` by ≥3pp in the disadvantageous direction, the cancel pre-step runs (same machinery as MIRROR_BUY_CANCELED_ON_TARGET_SELL) and placement proceeds. Pending rows (no `order_id`) are treated as not-stale to avoid racing in-flight placements. bug.5035.
 * Side-effects: delegated — DB I/O via `OrderLedger`, HTTP via `WalletActivitySource`, Polymarket CLOB via `placeIntent`/`cancelOrder`. Pipeline itself is pure sequencing + logger/metrics calls.
 * Links: work/items/task.0318 (Phase B3), work/items/task.5001, docs/spec/poly-copy-trade-execution.md, docs/spec/poly-tenant-and-collateral.md
 * @public
 */

import {
  clientOrderIdFor,
  type LoggerPort,
  type MetricsPort,
  normalizeLimitPriceToTick,
  type OrderIntent,
  type OrderReceipt,
} from "@cogni/poly-market-provider";

import {
  AlreadyRestingError,
  type OpenOrderRow,
  type OrderLedger,
  PositionCapReachedError,
} from "@/features/trading";
import type { WalletActivitySource } from "@/features/wallet-watch";
import { EVENT_NAMES } from "@/shared/observability/events";
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";

import {
	ALGORITHM_DEFINITIONS,
	type AlgorithmEvaluation,
	type AlgorithmLineage,
	algorithmIdForSizingKind,
	type CanonicalAlgorithmOrder,
	evaluateAlgorithm,
	fillAlgorithmConfig,
} from "./algorithm-registry";
import { targetVwapForToken } from "./plan-mirror";
import {
  type EffectivePositionGapBudget,
  effectivePositionGapBudget,
} from "./position-gap-budget";
import type {
  MirrorPositionView,
  MirrorReason,
  MirrorTargetConfig,
  PositionBranch,
  SizingPolicy,
  TargetConditionPositionView,
} from "./types";
import { aggregatePositionRows } from "./types";

type PlacementWire = "limit" | "market_fok";

/**
 * Representative per-intent USDC ceiling for a sizing policy. Used by SELL-close
 * caps and audit-log skip blobs. Per-fill size is computed in `plan-mirror`.
 *
 * - Legacy policies (`min_bet`, `target_percentile`, `target_percentile_scaled`):
 *   `max_usdc_per_condition` is the per-trade cap.
 * - `position_gap`: the portfolio gap is computed separately; target fill
 *   notional is only a compatibility fallback for non-planner call sites.
 * - `mirror_fill_exact`: no policy-level ceiling; the verbatim notional IS
 *   `fill.size_usdc`. SELL-close caps at the target's actual sell notional,
 *   bounded downstream by `closePosition` against our actual holdings.
 */
function nominalSizeUsdc(sizing: SizingPolicy, fillSizeUsdc: number): number {
  switch (sizing.kind) {
    case "position_gap":
      return fillSizeUsdc;
    case "mirror_fill_exact":
      return fillSizeUsdc;
    default:
      return sizing.max_usdc_per_condition;
  }
}

/**
 * Build the durable `receipt` JSONB for a `placement_failed` decision row.
 * Before this, `receipt` was `null` for every error, so SQL could not group
 * the 19k+ placement failures by cause. Per docs/spec/observability.md only
 * stable structured fields are persisted — no raw SDK message text.
 * Adapter throws attach `.details: ClobFailureDetails`; raw Errors fall
 * through to `error_code: "unknown"` + `err.name`. We read `err.name`
 * (the string assigned in the constructor body, e.g. `this.name = "ClobRejectionError"`)
 * rather than `err.constructor.name`, because terser minifies class
 * identifiers in production bundles to single letters ("i", "n", …) —
 * persisting those into the durable receipt makes forensics impossible.
 */
function extractAdapterErrorReceipt(err: unknown): Record<string, unknown> {
  const details =
    err && typeof err === "object" && "details" in err
      ? ((err as { details?: unknown }).details ?? null)
      : null;
  const d = (details && typeof details === "object" ? details : {}) as Record<
    string,
    unknown
  >;
  const errorCode = typeof d.error_code === "string" ? d.error_code : "unknown";
  const errorClass =
    typeof d.error_class === "string"
      ? d.error_class
      : err instanceof Error
        ? err.name
        : null;
  return {
    error_code: errorCode,
    http_status: typeof d.http_status === "number" ? d.http_status : null,
    error_class: errorClass,
    reason: typeof d.reason === "string" ? d.reason.slice(0, 200) : null,
    response_keys: Array.isArray(d.response_keys) ? d.response_keys : null,
  };
}

/** Minimal position shape needed by the pipeline — subset of PolymarketUserPosition. */
export interface OperatorPosition {
  asset: string;
  size: number;
  currentValue?: number;
}

export interface MirrorPortfolioSnapshot {
  currentValueUsdc: number;
  positions: OperatorPosition[];
}

/** Metric names emitted by the pipeline. */
export const MIRROR_PIPELINE_METRICS = {
  /** `poly_mirror_decisions_total{outcome, reason, source, placement}` — always fired, bounded labels. */
  decisionsTotal: "poly_mirror_decisions_total",
  /** `poly_mirror_placement_errors_total` — `placeIntent` throw after pending insert. */
  placementErrorsTotal: "poly_mirror_placement_errors_total",
  /** bug.5048 — `poly_mirror_wrong_side_holding_total{target_id}` fires when option C is taken (wallet held a non-dominant leg from cross-target activity at decision time). Bounded by tracked-targets table. Per-condition forensics live on the co-emitted WARN log (`market_id` field), not in the metric label. Alertable. */
  wrongSideHoldingTotal: "poly_mirror_wrong_side_holding_total",
  /** task.5042 — `poly_mirror_decision_lag_ms{source}` — duration histogram of `decision_emit_ts - fill.observed_at` per fill. One observation per fill regardless of outcome; co-emitted `lag_ms_total` field on every downstream decision log line. Lets us see where the target-fill → mirror-decision lag actually accrues before rebuilding the fill source. */
  decisionLagMs: "poly_mirror_decision_lag_ms",
} as const;

/**
 * task.5042 — compute the end-to-end lag between when the target's trade was
 * observed by the upstream source (`fill.observed_at`, ISO-8601 derived from
 * Polymarket `trade.timestamp` at normalize time) and when the mirror pipeline
 * decided on it (`decisionBase.decided_at`). Clamped to ≥0 to absorb tiny
 * clock skew between the trade-side timestamp and the pod's wall clock. NaN
 * on malformed `observed_at` collapses to 0 — surfaces as a heavy 0-bucket
 * spike if the upstream contract drifts, which is the signal we want.
 */
export function computeFillToDecisionLagMs(
  observedAtIso: string,
	decidedAt: Date,
): number {
  const observedMs = Date.parse(observedAtIso);
  if (Number.isNaN(observedMs)) return 0;
  return Math.max(0, decidedAt.getTime() - observedMs);
}

/** `Fill.source` values that land in `decisions_total{source}`. */
export type DecisionSource = "data-api" | "clob-ws" | "chain";

export interface MirrorPipelineDeps {
	/** Exact Git SHA; algorithm versions are invalid without code identity. */
	implementationRevision: string;
	/** Durable `poly_copy_trade_targets.id`; distinct from wallet-derived `target_id`. */
	targetRowId: string;
	/** Immutable target activation/config assignment identity. */
	assignmentId: string;
  /** Authoritative cross-process liveness check for the exact assignment. */
  isAssignmentCurrent: () => Promise<boolean>;
  /** Fill source — v0 is the Polymarket Data-API adapter. */
  source: WalletActivitySource;
  /** Order ledger — reads state + writes pending/mark/decision rows. */
  ledger: OrderLedger;
  /**
   * Tenant-scoped placement seam. Delegates to the per-tenant
   * `PolyTradeExecutor.placeIntent`, which wraps `authorizeIntent` +
   * `PolymarketClobAdapter.placeOrder`. Must be constructed against
   * `deps.target.billing_account_id` by the caller.
   */
  placeIntent: (
    intent: OrderIntent,
		mode: "live" | "paper",
  ) => Promise<OrderReceipt>;
  /**
   * Tenant-scoped cancel seam (task.5001). Delegates to
   * `PolyTradeExecutor.cancelOrder` → `PolymarketClobAdapter.cancelOrder`,
   * which is 404-idempotent (CANCEL_404_SWALLOWED_IN_ADAPTER). Used by the
   * SELL cancel pre-step when the target exits a market we still have a
   * resting BUY on. CANCEL_GOES_THROUGH_TENANT_EXECUTOR.
   *
   * Optional with a no-op fallback for tests that don't exercise the SELL
   * cancel pre-step. Production bootstrap (`copy-trade-mirror.job` →
   * `container.ts`) always wires it.
   */
	cancelOrder?: (order_id: string, mode: "live" | "paper") => Promise<void>;
  /**
   * Market-constraint fetch seam — returns `{ minShares }` for a token id so
   * the sizing policy can avoid sub-min submissions (bug.0342). Optional.
   */
  getMarketConstraints?:
    | ((tokenId: string) => Promise<{
        minShares: number;
        minUsdcNotional?: number;
        tickSize?: number;
      }>)
    | undefined;
  /**
   * Optional target-position read seam. v0 production wiring uses Polymarket
   * Data API `/positions?user=<target>&market=<condition>&sizeThreshold=0`.
   * Planner remains pure; future Postgres-backed target activity can implement
   * this same shape.
   */
  getTargetConditionPosition?:
    | ((params: {
        targetWallet: string;
        conditionId: string;
      }) => Promise<TargetConditionPositionView | undefined>)
    | undefined;
  /** Whole target open-position value recorded as shared algorithm input. */
  getTargetPortfolioCurrentValue?:
    | ((targetWallet: string) => Promise<number>)
    | undefined;
  /** Account NAV + exact positions recorded as shared algorithm inputs. */
  getMirrorPortfolioSnapshot?:
    | ((mode: "live" | "paper") => Promise<MirrorPortfolioSnapshot>)
    | undefined;
  /** Per-target config. */
  target: MirrorTargetConfig;
  /** Cursor accessor — bootstrap closures hold the in-memory state. */
  getCursor: () => number | undefined;
  /** Cursor writeback — called once per tick with the `newSince` from the source. */
  setCursor: (since: number) => void;
  /** Structured log sink (pino-compatible). */
  logger: LoggerPort;
  /** Metrics sink. */
  metrics: MetricsPort;
  /** Clock injection — tests pin `Date`. Default = real `Date`. */
  clock?: () => Date;
  /**
   * Resolve once per tick. Private account facts are read from this venue and
   * placement proceeds only if the ledger stamps the same venue. A transition
   * during planning fails closed before any venue call.
   */
  getExecutionMode: () => Promise<"live" | "paper">;
  /**
   * Optional — SELL-to-close path. Routes through the per-tenant executor's
   * `closePosition` which authorizes + caps + signs. When absent, SELL fills
   * degrade to `skip/sell_without_position` (never open a short).
   */
  closePosition?: (
    params: {
      tokenId: string;
      max_size_usdc: number;
      limit_price: number;
      client_order_id: `0x${string}`;
    },
		mode: "live" | "paper",
  ) => Promise<OrderReceipt>;
  /**
   * Optional — position query used by the SELL branch. Per-tenant.
   * When absent (or no `closePosition`), SELL fills degrade to
   * `skip/sell_without_position`.
   */
  getOperatorPositions?: (
		mode: "live" | "paper",
  ) => Promise<OperatorPosition[]>;
}

/**
 * The account's execution mode for log attribution. `"unresolved"` is reported
 * honestly rather than defaulting to `"live"`: a wrong label on the decision
 * tape is worse than a missing one, and `live` is the label that would get a
 * simulated decision read as real money.
 */
/**
 * One pipeline tick. Fully sequential — no concurrency across fills inside
 * one tick, so `planMirrorFromFill()`'s `already_placed_ids` snapshot stays
 * consistent.
 *
 * @public
 */
export async function runMirrorTick(deps: MirrorPipelineDeps): Promise<void> {
  const clock = deps.clock ?? (() => new Date());
  const algorithmId = algorithmIdForSizingKind(deps.target.sizing.kind);
  const assignmentLog = deps.logger.child({
    billing_account_id: deps.target.billing_account_id,
    target_row_id: deps.targetRowId,
    assignment_id: deps.assignmentId,
    algorithm_id: algorithmId,
  });
  try {
    if (!(await deps.isAssignmentCurrent())) {
      assignmentLog.info(
        {
          event: EVENT_NAMES.POLY_MIRROR_ASSIGNMENT_RETIRED,
          outcome: "skipped",
          reason: "assignment_retired",
        },
        "mirror pipeline: assignment retired; skipping tick",
      );
      return;
    }
  } catch (error) {
    assignmentLog.error(
      {
        event: EVENT_NAMES.POLY_MIRROR_ASSIGNMENT_RETIRED,
        outcome: "error",
        reason: "assignment_liveness_unavailable",
        errorCode: "assignment_liveness_unavailable",
        ...safeErrorDimensions(error),
      },
      "mirror pipeline: assignment liveness unavailable; skipping tick",
    );
    return;
  }
  let executionMode: "live" | "paper";
  try {
    executionMode = await deps.getExecutionMode();
  } catch (error) {
    assignmentLog.error(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "error",
        reason: "execution_venue_unresolved",
        ...safeErrorDimensions(error),
      },
			"mirror pipeline: execution venue unavailable; skipping tick",
    );
    return;
  }
  const log = assignmentLog.child({
    component: "mirror-pipeline",
    target_id: deps.target.target_id,
    // The same binding governs private facts and the pre-placement equality gate.
    execution_mode: executionMode,
  });

  const cursor = deps.getCursor();

  let result: {
    fills: import("@cogni/poly-market-provider").Fill[];
    newSince: number;
  };
  try {
    result = await deps.source.fetchSince(cursor);
  } catch (err: unknown) {
    log.warn(
      {
        event: EVENT_NAMES.POLY_MIRROR_SOURCE_ERROR,
        errorCode: "source_fetch_failed",
        cursor,
        err: err instanceof Error ? err.message : String(err),
      },
			"mirror pipeline: source fetch failed; skipping tick",
    );
    return;
  }

  deps.setCursor(result.newSince);

  for (const fill of result.fills) {
    await processFill(fill, deps, clock, log, executionMode);
  }
}

async function processFill(
  fill: import("@cogni/poly-market-provider").Fill,
  deps: MirrorPipelineDeps,
  clock: () => Date,
  parentLog: LoggerPort,
	planningMode: "live" | "paper",
): Promise<void> {
  // bug.5022 — construct the TenantContext envelope ONCE at the top of
  // `processFill` and route every per-tenant READ through it
  // (`snapshotState`, `cumulativeIntentForMarketToken`, `findOpenForMarket`).
  // Each call is wrapped in `withTenantScope(appDb, ctx.created_by_user_id, ...)`
  // inside the adapter so Postgres RLS strips any row owned by another user
  // even if a future query forgets the explicit filter.
  //
  // Writes (`insertPending`, `recordDecision`, `markOrderId`, `markError`,
  // `markCanceled`) still go through the root `deps.ledger.*` surface
  // (serviceDb) — they stamp tenant attribution explicitly in the row
  // values and were never the bug.5022 leak surface. task.5012 Phase 1
  // migrates them onto the same `withTenantScope` wrap.
  const tenantLedger = deps.ledger.forTenant({
    billing_account_id: deps.target.billing_account_id,
    created_by_user_id: deps.target.created_by_user_id,
  });
  const client_order_id = clientOrderIdFor(
    deps.target.billing_account_id,
    deps.target.target_id,
		fill.fill_id,
  );
  const placement: PlacementWire =
    deps.target.placement.kind === "mirror_limit" ? "limit" : "market_fok";

  const snapshot = await tenantLedger.snapshotState(deps.target.target_id);

  const source: DecisionSource = fill.source as DecisionSource;
	const basePlannerInput = {
		fill,
		state: {
			already_placed_ids: snapshot.already_placed_ids,
			placed_fill_ids: snapshot.placed_fill_ids,
		},
		now_ms: clock().getTime(),
	};
	const algorithmId = algorithmIdForSizingKind(deps.target.sizing.kind);
	const baseEvaluation = evaluateAlgorithm({
		definition: ALGORITHM_DEFINITIONS[algorithmId],
		input: basePlannerInput,
		config: fillAlgorithmConfig(deps.target),
		implementationRevision: deps.implementationRevision,
		assignmentId: deps.assignmentId,
		correlationId: client_order_id,
	});
  const decisionBase = {
    target_id: deps.target.target_id,
    fill_id: fill.fill_id,
    billing_account_id: deps.target.billing_account_id,
    created_by_user_id: deps.target.created_by_user_id,
    decided_at: clock(),
		lineage: {
			...baseEvaluation.lineage,
			algorithm_id: algorithmId,
		} as AlgorithmLineage,
  };

  // task.5042 — one observation + log-field per fill. The `lag_ms_total`
  // child binding is inherited by every downstream decision log line
  // (skip / placed / error / SELL-close branches) without touching each
  // emission site. The histogram label set stays bounded to `source` so
  // cardinality remains v0-safe.
  const lag_ms_total = computeFillToDecisionLagMs(
    fill.observed_at,
		decisionBase.decided_at,
  );
  deps.metrics.observeDurationMs(
    MIRROR_PIPELINE_METRICS.decisionLagMs,
    lag_ms_total,
		{ source },
  );
	let log = parentLog.child({
		lag_ms_total,
		...decisionBase.lineage,
	});
  const portfolioValues = await fetchDecisionPortfolioValues({
    deps,
    fill,
    log,
    planningMode,
  });

  if (isMultiTargetPositionGapUnsupported(deps.target)) {
    await cancelOpenMirrorOrdersForMarket({
      deps,
      fill,
      log,
      reason: "multi_target_position_gap_unsupported",
    });
    const decisionLogFields = {
      position_branch: fill.side === "SELL" ? "sell_close" : "new_entry",
      ...buildDecisionPortfolioFactFields(portfolioValues),
      ...buildPositionGapBudgetLogFields(deps.target, portfolioValues),
    };
    emitDecisionMetric(
      deps.metrics,
      "skipped",
      "multi_target_position_gap_unsupported",
      source,
			placement,
    );
    await tenantLedger.recordDecision({
      ...decisionBase,
      outcome: "skipped",
      reason: "multi_target_position_gap_unsupported",
      intent: buildDecisionIntentBlob(
        fill,
        deps.target,
        client_order_id,
				decisionLogFields,
      ),
      receipt: null,
    });
    log.warn(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "skipped",
        reason: "multi_target_position_gap_unsupported",
        source,
        fill_id: fill.fill_id,
        client_order_id,
        ...decisionLogFields,
      },
			"mirror pipeline: multiple position-gap targets fail closed",
    );
    return;
  }

  if (fill.side === "SELL") {
    await processSellFill({
      fill,
      deps,
			baseEvaluation,
			basePlannerInput,
			algorithmId,
      client_order_id,
      placement,
      source,
      decisionBase,
      log,
      portfolioValues,
      planningMode,
    });
    return;
  }

  let min_shares: number | undefined;
  let min_usdc_notional: number | undefined;
  let tick_size: number | undefined;
  if (deps.getMarketConstraints) {
    const tokenId =
      typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
    if (tokenId) {
      try {
        const constraints = await deps.getMarketConstraints(tokenId);
        min_shares = constraints.minShares;
        min_usdc_notional = constraints.minUsdcNotional;
        tick_size = constraints.tickSize;
      } catch (err) {
        log.warn(
          {
            event: "poly.mirror.constraints.fetch_error",
            fill_id: fill.fill_id,
            client_order_id,
            err: err instanceof Error ? err.message : String(err),
          },
					"mirror pipeline: getMarketConstraints threw; planMirrorFromFill will run without market floors",
        );
      }
    }
  }

  // CAP_IS_PER_TOKEN_ID (bug.5004): cap is scoped per (market, token). Pull
  // the token_id from the normalized fill — `fill.attributes.asset` is the
  // CTF token-id field this pipeline already reads elsewhere (see
  // plan-mirror.ts:577). When the fill arrives without an asset OR with an
  // empty asset (defensive — buildIntent's fallback shape), skip the cap-read;
  // the planner will treat `cumulative_intent_usdc_for_token` as undefined and
  // bypass the cap check (preserves SELL/legacy paths). The atomic
  // `insertPending` cap-check applies the same empty-token bypass, so both
  // enforcement points agree.
  const rawFillTokenId =
    typeof fill.attributes?.asset === "string"
      ? fill.attributes.asset
      : undefined;
  const fillTokenId =
    rawFillTokenId !== undefined && rawFillTokenId.length > 0
      ? rawFillTokenId
      : undefined;
  const cumulative_intent_usdc_for_token =
    snapshot.already_placed_ids.includes(client_order_id) ||
    fillTokenId === undefined
      ? undefined
      : await tenantLedger.cumulativeIntentForMarketToken(
          fill.market_id,
					fillTokenId,
        );

  const positions_by_condition = aggregatePositionRows(
		snapshot.position_aggregates,
  );
  const position = positions_by_condition.get(fill.market_id);
  const targetPosition = await fetchTargetConditionPosition({
    deps,
    fill,
    log,
  });
  const fillEndDate = fill.attributes?.end_date;
  if (typeof fillEndDate !== "string" || fillEndDate.length === 0) {
    log.warn(
      {
        event: "poly.mirror.fill.end_date_missing",
        fill_id: fill.fill_id,
        client_order_id,
        market_id: fill.market_id,
        attributes_keys: fill.attributes ? Object.keys(fill.attributes) : [],
      },
			"BUY fill missing fill.attributes.end_date — market-liveness gate is a no-op for this fill",
    );
  }

	const plannerInput = {
    fill,
    state: {
      already_placed_ids: snapshot.already_placed_ids,
      placed_fill_ids: snapshot.placed_fill_ids,
      cumulative_intent_usdc_for_token,
      position,
      ...(targetPosition !== undefined
        ? {
            target_position: targetPosition,
          }
        : {}),
      ...(portfolioValues?.target !== undefined
        ? { target_portfolio_current_value_usdc: portfolioValues.target }
        : {}),
      ...(portfolioValues?.mirror !== undefined
        ? { mirror_portfolio_current_value_usdc: portfolioValues.mirror }
        : {}),
      ...(portfolioValues?.budget?.effectiveBudgetUsdc !== undefined
        ? {
            mirror_effective_budget_usdc:
              portfolioValues.budget.effectiveBudgetUsdc,
          }
        : {}),
      ...(portfolioValues?.mirrorTokenShares !== undefined
        ? { mirror_token_qty_shares: portfolioValues.mirrorTokenShares }
        : {}),
    },
    min_shares,
    min_usdc_notional,
    tick_size,
		now_ms: decisionBase.decided_at.getTime(),
	};
	const evaluation = evaluateAlgorithm({
		definition: ALGORITHM_DEFINITIONS[algorithmId],
		input: plannerInput,
		config: fillAlgorithmConfig(deps.target),
		implementationRevision: deps.implementationRevision,
		assignmentId: deps.assignmentId,
		correlationId: client_order_id,
  });
	const evaluatedDecisionBase = {
		...decisionBase,
		lineage: {
			...evaluation.lineage,
			algorithm_id: algorithmId,
		} as AlgorithmLineage,
	};
	log = log.child(evaluatedDecisionBase.lineage);
	const positionBranch =
		typeof evaluation.decision.diagnostics.position_branch === "string"
			? (evaluation.decision.diagnostics.position_branch as PositionBranch)
			: "new_entry";
	const canonicalOrder = evaluation.decision.orders[0];
	const plan =
		evaluation.decision.status === "ready" && canonicalOrder
			? ({
					kind: "place" as const,
					reason: evaluation.decision.reason as
						| "ok"
						| "layer_scale_in"
						| "hedge_followup",
					position_branch: positionBranch,
					intent: materializeFillOrderIntent(
						canonicalOrder,
						deps.target,
						evaluatedDecisionBase.lineage,
						fill,
					),
					wrong_side_holding_detected:
						evaluation.decision.diagnostics.wrong_side_holding_detected ===
						true,
				} as const)
			: ({
					kind: "skip" as const,
					reason: evaluation.decision.reason as Exclude<
						MirrorReason,
						"ok" | "sell_closed_position"
					>,
					position_branch: positionBranch,
				} as const);

  const wrongSideHoldingDetected =
    plan.kind === "place" && plan.wrong_side_holding_detected === true;

  const decisionLogFields = buildDecisionLogFields({
    branch: plan.position_branch,
    fill,
    position,
    target: deps.target,
    targetPosition,
    wrongSideHoldingDetected,
    min_shares,
    min_usdc_notional,
    tick_size,
    portfolioValues,
  });

  // bug.5048 — fire the wrong-side counter + WARN log when option C taken.
  // Counter labels are bounded by tracked-targets table (target_id only); the
  // co-emitted WARN log carries market_id for per-condition forensics. Keeping
  // condition_id off the metric prevents Prometheus cardinality from growing
  // with the universe of Polymarket conditions.
  if (wrongSideHoldingDetected) {
    deps.metrics.incr(MIRROR_PIPELINE_METRICS.wrongSideHoldingTotal, {
      target_id: deps.target.target_id,
    });
    log.warn(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        phase: "wrong_side_holding_detected",
        source,
        fill_id: fill.fill_id,
        client_order_id,
        market_id: fill.market_id,
        our_minority_token_id: position?.our_token_id ?? null,
        target_dominant_token_id: decisionLogFields.target_dominant_token_id,
        target_side_fraction: decisionLogFields.target_side_fraction,
      },
			"mirror pipeline: option C — wallet holds non-dominant leg from cross-target activity; opening dominant-side parallel leg",
    );
  }

  if (plan.kind === "skip") {
    emitDecisionMetric(deps.metrics, "skipped", plan.reason, source, placement);
    await tenantLedger.recordDecision({
			...evaluatedDecisionBase,
      outcome: "skipped",
      reason: plan.reason,
      intent: buildDecisionIntentBlob(
        fill,
        deps.target,
        client_order_id,
				decisionLogFields,
      ),
      receipt: null,
    });
    log.info(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "skipped",
        reason: plan.reason,
        source,
        fill_id: fill.fill_id,
        client_order_id,
        ...decisionLogFields,
      },
			"mirror pipeline: skip",
    );
    return;
  }

  // Fast-path dedupe; the DB partial unique index is the backstop. task.5001.
  // bug.5035: a stale resting order at an out-of-band price chokes off every
  // subsequent mirror signal during a target price surge. Inspect the open
  // rows; cancel-then-place when the new intent's limit_price is materially
  // ahead of the resting price, else skip as before.
  const open = await tenantLedger.findOpenForMarket({
    target_id: deps.target.target_id,
    market_id: fill.market_id,
  });
  if (open.length > 0) {
    const stale = isRestingPriceStale(open, plan.intent);
    if (!stale) {
      emitDecisionMetric(
        deps.metrics,
        "skipped",
        "already_resting",
        source,
				placement,
      );
      await tenantLedger.recordDecision({
				...evaluatedDecisionBase,
        outcome: "skipped",
        reason: "already_resting",
        intent: buildDecisionIntentBlob(
          fill,
          deps.target,
          client_order_id,
					decisionLogFields,
        ),
        receipt: null,
      });
      log.info(
        {
          event: EVENT_NAMES.POLY_MIRROR_DECISION,
          outcome: "skipped",
          reason: "already_resting",
          source,
          fill_id: fill.fill_id,
          client_order_id,
          market_id: fill.market_id,
          ...decisionLogFields,
        },
				"mirror pipeline: skip (already resting on market)",
      );
      return;
    }

    // Stale resting at an out-of-band price. Cancel before placing so the
    // partial unique index has room for the new pending row.
    log.info(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        phase: "cancel_replace_stale_resting",
        source,
        fill_id: fill.fill_id,
        client_order_id,
        market_id: fill.market_id,
        new_intent_price: plan.intent.limit_price,
        resting_prices: open.map((r) => r.limit_price),
      },
			"mirror pipeline: cancel-then-place (resting price stale vs new intent)",
    );
    await cancelOpenMirrorOrdersForMarket({
      deps,
      fill,
      log,
      reason: "stale_resting_layer_up",
    });
  }

  await executeMirrorOrder(
    deps,
    fill,
    client_order_id,
		evaluatedDecisionBase,
    source,
    placement,
    plan.intent,
    plan.reason,
    log,
    planningMode,
    undefined,
		decisionLogFields,
  );
}

/** Runtime-owned translation from an economic decision to the venue port. */
function materializeFillOrderIntent(
	order: CanonicalAlgorithmOrder,
	target: MirrorTargetConfig,
	lineage: AlgorithmLineage,
	fill: import("@cogni/poly-market-provider").Fill,
): OrderIntent {
	return {
		provider: "polymarket",
		market_id: order.market_id,
		outcome: order.outcome ?? "unknown",
		side: order.side,
		size_usdc: order.size_usdc,
		limit_price: order.limit_price,
		client_order_id: lineage.correlation_id as `0x${string}`,
		attributes: {
			token_id: order.token_id,
			condition_id: order.condition_id ?? undefined,
			source_fill_id: fill.fill_id,
			target_wallet: fill.target_wallet.toLowerCase(),
			placement:
				target.placement.kind === "mirror_limit" ? "limit" : "market_fok",
			position_branch: order.position_branch ?? undefined,
			title: nullableStringAttribute(fill.attributes?.title),
			slug: nullableStringAttribute(fill.attributes?.slug),
			event_slug: nullableStringAttribute(fill.attributes?.event_slug),
			event_title: nullableStringAttribute(fill.attributes?.event_title),
			transaction_hash: nullableStringAttribute(
				fill.attributes?.transaction_hash,
			),
			...lineage,
		},
	};
}

function nullableStringAttribute(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** bug.5035: true if any resting order's limit_price is ≥STALE_RESTING_PRICE_DELTA disadvantageously out of band vs the new intent. Pending rows (no order_id) and rows missing limit_price are not stale — fail-closed to the existing skip-as-already_resting path. */
const STALE_RESTING_PRICE_DELTA = 0.03;
function isRestingPriceStale(
  open: OpenOrderRow[],
	newIntent: OrderIntent,
): boolean {
  for (const row of open) {
    if (row.order_id === null) return false;
    if (row.limit_price === null) continue;
    if (newIntent.side === "BUY") {
      if (newIntent.limit_price - row.limit_price >= STALE_RESTING_PRICE_DELTA)
        return true;
    } else if (newIntent.side === "SELL") {
      if (row.limit_price - newIntent.limit_price >= STALE_RESTING_PRICE_DELTA)
        return true;
    }
  }
  return false;
}

async function fetchTargetConditionPosition(args: {
  deps: MirrorPipelineDeps;
  fill: import("@cogni/poly-market-provider").Fill;
  log: LoggerPort;
}): Promise<TargetConditionPositionView | undefined> {
  const { deps, fill, log } = args;
  if (!needsTargetPosition(deps.target)) return undefined;
  if (!deps.getTargetConditionPosition) return undefined;
  if (typeof fill.attributes?.asset !== "string") return undefined;
  const conditionId = targetConditionIdForFill(fill);
  if (!conditionId) return undefined;
  try {
    return await deps.getTargetConditionPosition({
      targetWallet: deps.target.target_wallet,
      conditionId,
    });
  } catch (err) {
    log.warn(
      {
        event: "poly.mirror.target_position.fetch_error",
        fill_id: fill.fill_id,
        market_id: fill.market_id,
        err: err instanceof Error ? err.message : String(err),
      },
			"mirror pipeline: target position fetch failed; follow-up branch will fail closed",
    );
    return undefined;
  }
}

/**
 * Hydrate the account facts every algorithm needs for interchangeable
 * paper/live evaluation. Sizing policy decides how (or whether) to act on the
 * facts; it must not decide whether the decision tape observes them.
 *
 * position_gap additionally needs a budget allocation. Other policies return
 * the same venue-derived NAV/share facts without inventing an inapplicable
 * budget.
 */
async function fetchDecisionPortfolioValues(args: {
  deps: MirrorPipelineDeps;
  fill: import("@cogni/poly-market-provider").Fill;
  log: LoggerPort;
  planningMode: "live" | "paper";
}): Promise<DecisionPortfolioValues | undefined> {
  const { deps, fill, log, planningMode } = args;
  if (
    !deps.getTargetPortfolioCurrentValue ||
    !deps.getMirrorPortfolioSnapshot
  ) {
    return undefined;
  }
  const [targetResult, mirrorResult] = await Promise.allSettled([
    deps.getTargetPortfolioCurrentValue(deps.target.target_wallet),
    deps.getMirrorPortfolioSnapshot(planningMode),
  ]);

  const values: DecisionPortfolioValues = {};
  if (targetResult.status === "fulfilled" && targetResult.value >= 0) {
    values.target = targetResult.value;
  } else {
    log.warn(
      {
        event: "poly.mirror.portfolio_value.fetch_error",
        fact_source: "target",
        fill_id: fill.fill_id,
        market_id: fill.market_id,
        err:
          targetResult.status === "rejected"
            ? targetResult.reason instanceof Error
              ? targetResult.reason.message
              : String(targetResult.reason)
            : "invalid target portfolio value",
      },
			"mirror pipeline: target portfolio fact unavailable",
    );
  }

  if (
    mirrorResult.status === "fulfilled" &&
    mirrorResult.value.currentValueUsdc > 0
  ) {
    const mirrorSnapshot = mirrorResult.value;
    values.mirror = mirrorSnapshot.currentValueUsdc;
    const tokenId =
      typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
    values.mirrorTokenShares = mirrorSnapshot.positions
      .filter((position) => position.asset === tokenId)
      .reduce((sum, position) => sum + Math.max(0, position.size), 0);
  } else {
    log.warn(
      {
        event: "poly.mirror.portfolio_value.fetch_error",
        fact_source: "mirror",
        fill_id: fill.fill_id,
        market_id: fill.market_id,
        err:
          mirrorResult.status === "rejected"
            ? mirrorResult.reason instanceof Error
              ? mirrorResult.reason.message
              : String(mirrorResult.reason)
            : "invalid mirror portfolio value",
      },
			"mirror pipeline: mirror portfolio facts unavailable",
    );
  }

  const sizing = deps.target.sizing;
  if (sizing.kind !== "position_gap") {
    return Object.keys(values).length > 0 ? values : undefined;
  }
  if (
    values.target === undefined ||
    values.mirror === undefined ||
    values.mirrorTokenShares === undefined
  ) {
    return undefined;
  }
  const configuredBudget = sizing.mirror_capital_budget_usdc ?? null;
  const budget = effectivePositionGapBudget({
    configuredBudgetUsdc: configuredBudget,
    mirrorNavUsdc: values.mirror,
    group: {
      positionGapTargetCount: sizing.account_position_gap_target_count ?? 1,
      explicitBudgetTotalUsdc:
        sizing.account_explicit_budget_total_usdc ?? configuredBudget ?? 0,
      automaticTargetCount:
        sizing.account_automatic_budget_target_count ??
        (configuredBudget === null ? 1 : 0),
      unbudgetedTargetCount: sizing.account_unbudgeted_target_count ?? 0,
    },
  });
  if (!budget) return undefined;
  return {
    ...values,
    budget,
    effectiveBudgetObservedAt: new Date().toISOString(),
  };
}

interface DecisionPortfolioValues {
  target?: number;
  mirror?: number;
  mirrorTokenShares?: number;
  budget?: EffectivePositionGapBudget;
  effectiveBudgetObservedAt?: string;
}

function needsTargetPosition(target: MirrorTargetConfig): boolean {
  return (
    target.position_followup?.enabled === true ||
    target.sizing.kind !== "min_bet" ||
    target.min_target_side_fraction !== undefined ||
    target.vwap_tolerance !== undefined
  );
}

function targetConditionIdForFill(
	fill: import("@cogni/poly-market-provider").Fill,
): string | undefined {
  if (typeof fill.attributes?.condition_id === "string") {
    return fill.attributes.condition_id;
  }
  const prefix = "prediction-market:polymarket:";
  if (fill.market_id.startsWith(prefix)) {
    return fill.market_id.slice(prefix.length);
  }
  return fill.market_id || undefined;
}

function buildDecisionLogFields(args: {
  branch: PositionBranch;
  fill: import("@cogni/poly-market-provider").Fill;
  position: MirrorPositionView | undefined;
  target: MirrorTargetConfig;
  targetPosition: TargetConditionPositionView | undefined;
  wrongSideHoldingDetected?: boolean;
  min_shares?: number | undefined;
  min_usdc_notional?: number | undefined;
  tick_size?: number | undefined;
  portfolioValues?: DecisionPortfolioValues | undefined;
}): Record<string, unknown> {
  const {
    branch,
    fill,
    position,
    target,
    targetPosition,
    wrongSideHoldingDetected,
    min_shares,
    min_usdc_notional,
    tick_size,
    portfolioValues,
  } = args;
  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
  const normalizedLimitPrice = tick_size
    ? normalizeLimitPriceToTick(fill.price, tick_size)
    : ({ ok: true, price: fill.price } as const);
  return {
    position_branch: branch,
    position_qty_shares: position?.our_qty_shares ?? 0,
    position_token_id: position?.our_token_id ?? null,
    target_token_cost_usdc: targetTokenCostUsdc(targetPosition, tokenId),
    target_position_usdc: targetPositionTotalUsdc(targetPosition),
    target_hedge_ratio: targetHedgeRatio(position, targetPosition),
    target_side_fraction: targetSideFraction(targetPosition, tokenId),
    target_dominant_token_id: targetDominantTokenId(targetPosition),
    target_vwap_for_fill_token: targetVwapForFillToken(targetPosition, tokenId),
    min_target_side_fraction: target.min_target_side_fraction ?? null,
    vwap_tolerance: target.vwap_tolerance ?? null,
    wrong_side_holding_detected: wrongSideHoldingDetected ?? false,
    sizing_policy_kind: target.sizing.kind,
    // Legacy ceilings do not participate in portfolio-weighted sizing.
    mirror_max_usdc_per_trade:
      target.sizing.kind === "position_gap"
        ? null
        : nominalSizeUsdc(target.sizing, fill.size_usdc),
    position_gap_version: target.sizing.kind === "position_gap" ? 2 : null,
    ...buildDecisionPortfolioFactFields(portfolioValues),
    ...buildPositionGapBudgetLogFields(target, portfolioValues),
    sizing_percentile:
      "statistic" in target.sizing ? target.sizing.statistic.percentile : null,
    sizing_min_target_usdc:
      "statistic" in target.sizing
        ? target.sizing.statistic.min_target_usdc
        : null,
    sizing_max_target_usdc:
      "statistic" in target.sizing
        ? target.sizing.statistic.max_target_usdc
        : null,
    // FLOOR_FIELDS_EXPLAIN_BELOW_MARKET_MIN (bug.5256) — `below_market_min`
    // used to be unfalsifiable from logs alone: the skip is decided by
    // `floor_usdc` vs `mirror_max_usdc_per_trade`, and NEITHER input to
    // `floor_usdc` was emitted. Prod 2026-09-26 burned a session guessing
    // whether an $5 cap sat under the market's floor. `floor_usdc` mirrors
    // `applyMarketFloors`'s own `max(minShares × price, minUsdcNotional)` so
    // a reader can compare it against the cap in one glance.
    min_shares: min_shares ?? null,
    min_usdc_notional: min_usdc_notional ?? null,
    tick_size: tick_size ?? null,
    fill_price: fill.price,
    evaluated_limit_price: normalizedLimitPrice.ok
      ? normalizedLimitPrice.price
      : null,
    floor_usdc:
      min_usdc_notional === undefined
        ? null
        : Number(
            Math.max((min_shares ?? 0) * fill.price, min_usdc_notional).toFixed(
							4,
						),
          ),
  };
}

function buildDecisionPortfolioFactFields(
	portfolioValues?: DecisionPortfolioValues,
): Record<string, number | null> {
  return {
    target_portfolio_current_value_usdc: portfolioValues?.target ?? null,
    mirror_portfolio_current_value_usdc: portfolioValues?.mirror ?? null,
    mirror_token_qty_shares: portfolioValues?.mirrorTokenShares ?? null,
  };
}

function buildPositionGapBudgetLogFields(
  target: MirrorTargetConfig,
	portfolioValues?: DecisionPortfolioValues,
): Record<string, unknown> {
  if (target.sizing.kind !== "position_gap") return {};
  const positionGapTargetCount =
    target.sizing.account_position_gap_target_count ?? 1;
  const blockedMultiTarget = positionGapTargetCount > 1;
  return {
    mirror_capital_budget_usdc:
      target.sizing.mirror_capital_budget_usdc ?? null,
    effective_mirror_capital_budget_usdc:
      portfolioValues?.budget?.effectiveBudgetUsdc ?? null,
		mirror_budget_allocation_status: blockedMultiTarget
        ? "blocked_multi_target"
        : (portfolioValues?.budget?.allocationStatus ?? null),
    effective_budget_observed_at:
      portfolioValues?.effectiveBudgetObservedAt ?? null,
    position_gap_explicit_budget_total_usdc:
      target.sizing.account_explicit_budget_total_usdc ??
      target.sizing.mirror_capital_budget_usdc ??
      0,
    position_gap_target_count: positionGapTargetCount,
    position_gap_automatic_target_count:
      target.sizing.account_automatic_budget_target_count ??
      (target.sizing.mirror_capital_budget_usdc == null ? 1 : 0),
    unbudgeted_active_target_count:
      target.sizing.account_unbudgeted_target_count ?? 0,
    budget_overallocated: portfolioValues?.budget?.overallocated ?? null,
  };
}

function isMultiTargetPositionGapUnsupported(
	target: MirrorTargetConfig,
): boolean {
  return (
    target.sizing.kind === "position_gap" &&
    (target.sizing.account_position_gap_target_count ?? 1) > 1
  );
}

/** bug.5048 — fraction of target's total condition cost on the fill's token, or null when unknown. */
function targetSideFraction(
  targetPosition: TargetConditionPositionView | undefined,
	tokenId: string | undefined,
): number | null {
  if (!targetPosition || !tokenId) return null;
  const total = targetPosition.tokens.reduce((sum, t) => sum + t.cost_usdc, 0);
  if (total <= 0) return null;
  const thisCost = targetPosition.tokens
    .filter((t) => t.token_id === tokenId)
    .reduce((sum, t) => sum + t.cost_usdc, 0);
  return Number((thisCost / total).toFixed(4));
}

/** bug.5048 — token id with the highest cost in target's condition position, or null. */
function targetDominantTokenId(
	targetPosition: TargetConditionPositionView | undefined,
): string | null {
  if (!targetPosition || targetPosition.tokens.length === 0) return null;
  let dominantId: string | null = null;
  let dominantCost = -1;
  for (const t of targetPosition.tokens) {
    if (t.cost_usdc > dominantCost) {
      dominantCost = t.cost_usdc;
      dominantId = t.token_id;
    }
  }
  return dominantCost > 0 ? dominantId : null;
}

/** bug.5048 — target's VWAP on the fill's token, derived from cost_usdc / size_shares, or null. */
function targetVwapForFillToken(
  targetPosition: TargetConditionPositionView | undefined,
	tokenId: string | undefined,
): number | null {
  const vwap = targetVwapForToken(targetPosition, tokenId ?? "");
  return vwap === undefined ? null : Number(vwap.toFixed(4));
}

function targetPositionTotalUsdc(
	targetPosition: TargetConditionPositionView | undefined,
): number | null {
  if (!targetPosition) return null;
  return Number(
    targetPosition.tokens
      .reduce((sum, token) => sum + token.cost_usdc, 0)
			.toFixed(2),
  );
}

function targetTokenCostUsdc(
  targetPosition: TargetConditionPositionView | undefined,
	tokenId: string | undefined,
): number | null {
  if (!targetPosition || !tokenId) return null;
  return Number(
    targetPosition.tokens
      .filter((token) => token.token_id === tokenId)
      .reduce((sum, token) => sum + token.cost_usdc, 0)
			.toFixed(2),
  );
}

function targetHedgeRatio(
  position: MirrorPositionView | undefined,
	targetPosition: TargetConditionPositionView | undefined,
): number | null {
  if (
    !position?.our_token_id ||
    !position.opposite_token_id ||
    !targetPosition
  ) {
    return null;
  }
  const primary = targetPosition.tokens
    .filter((token) => token.token_id === position.our_token_id)
    .reduce((sum, token) => sum + token.cost_usdc, 0);
  const hedge = targetPosition.tokens
    .filter((token) => token.token_id === position.opposite_token_id)
    .reduce((sum, token) => sum + token.cost_usdc, 0);
  if (primary <= 0) return null;
  return Number((hedge / primary).toFixed(4));
}

/** Handles a SELL fill: position-check then close, or skip. */
async function processSellFill(args: {
  fill: import("@cogni/poly-market-provider").Fill;
  deps: MirrorPipelineDeps;
	baseEvaluation: AlgorithmEvaluation;
	basePlannerInput: {
		fill: import("@cogni/poly-market-provider").Fill;
		state: {
			already_placed_ids: string[];
			placed_fill_ids: string[];
		};
		now_ms: number;
	};
	algorithmId: ReturnType<typeof algorithmIdForSizingKind>;
  client_order_id: `0x${string}`;
  placement: PlacementWire;
  source: DecisionSource;
  decisionBase: {
    target_id: string;
    fill_id: string;
    billing_account_id: string;
    created_by_user_id: string;
    decided_at: Date;
		lineage: AlgorithmLineage;
  };
  log: LoggerPort;
  portfolioValues: DecisionPortfolioValues | undefined;
  planningMode: "live" | "paper";
}): Promise<void> {
  const {
    fill,
    deps,
		baseEvaluation,
		basePlannerInput,
		algorithmId,
    client_order_id,
    placement,
    source,
    decisionBase,
    log,
    portfolioValues,
    planningMode,
  } = args;
  const { closePosition, getOperatorPositions } = deps;

  // bug.5022 — tenantLedger for all per-tenant writes (recordDecision +
  // insertPending). Uses appDb + withTenantScope; RLS active.
  const tenantLedger = deps.ledger.forTenant({
    billing_account_id: deps.target.billing_account_id,
    created_by_user_id: deps.target.created_by_user_id,
  });
	const noPositionReason = baseEvaluation.decision.reason as MirrorReason;
	const decisionLogFields = {
    ...buildDecisionPortfolioFactFields(portfolioValues),
    ...buildPositionGapBudgetLogFields(deps.target, portfolioValues),
  };

  // Cancel resting mirror BUYs before position-close. task.5001.
  await cancelOpenMirrorOrdersForMarket({
    deps,
    fill,
    log,
    reason: "target_exited_market",
  });

  if (!closePosition || !getOperatorPositions) {
    emitDecisionMetric(
      deps.metrics,
      "skipped",
			noPositionReason,
      source,
			placement,
    );
    await tenantLedger.recordDecision({
      ...decisionBase,
      outcome: "skipped",
			reason: noPositionReason,
      intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
        close: false,
        position_branch: "sell_close",
        ...decisionLogFields,
      }),
      receipt: null,
    });
    log.info(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "skipped",
				reason: noPositionReason,
        source,
        fill_id: fill.fill_id,
        client_order_id,
        detail: "closePosition/getOperatorPositions deps absent",
        position_branch: "sell_close",
        ...decisionLogFields,
      },
			"mirror pipeline: skip (no close deps)",
    );
    return;
  }

  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";

  let positions: OperatorPosition[];
  try {
    positions = await getOperatorPositions(planningMode);
  } catch {
    emitDecisionMetric(
      deps.metrics,
      "skipped",
			noPositionReason,
      source,
			placement,
    );
    await tenantLedger.recordDecision({
      ...decisionBase,
      outcome: "skipped",
			reason: noPositionReason,
      intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
        close: false,
        position_branch: "sell_close",
        ...decisionLogFields,
      }),
      receipt: null,
    });
    log.warn(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "skipped",
				reason: noPositionReason,
        source,
        fill_id: fill.fill_id,
        client_order_id,
        detail: "getOperatorPositions threw; skipping to avoid short",
        position_branch: "sell_close",
        ...decisionLogFields,
      },
			"mirror pipeline: skip (position query failed)",
    );
    return;
  }

  const position = positions.find((p) => p.asset === tokenId);
  const hasPosition = position !== undefined && position.size > 0;

  if (!hasPosition) {
    emitDecisionMetric(
      deps.metrics,
      "skipped",
			noPositionReason,
      source,
			placement,
    );
    await tenantLedger.recordDecision({
      ...decisionBase,
      outcome: "skipped",
			reason: noPositionReason,
      intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
        close: false,
        position_branch: "sell_close",
        ...decisionLogFields,
      }),
      receipt: null,
    });
    log.info(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "skipped",
				reason: noPositionReason,
        source,
        fill_id: fill.fill_id,
        client_order_id,
        token_id: tokenId,
        position_branch: "sell_close",
        ...decisionLogFields,
      },
			"mirror pipeline: skip (no position to close)",
    );
    return;
  }

	const evaluation = evaluateAlgorithm({
		definition: ALGORITHM_DEFINITIONS[algorithmId],
		input: { ...basePlannerInput, sell_position_shares: position.size },
		config: fillAlgorithmConfig(deps.target),
		implementationRevision: deps.implementationRevision,
		assignmentId: deps.assignmentId,
		correlationId: client_order_id,
    });
	const canonicalOrder = evaluation.decision.orders[0];
	const evaluatedDecisionBase = {
		...decisionBase,
		lineage: evaluation.lineage,
    };
	const evaluatedLog = log.child(evaluation.lineage);
	if (evaluation.decision.status !== "ready" || !canonicalOrder) {
      await recordSellSkip({
        deps,
        tenantLedger,
        fill,
			decisionBase: evaluatedDecisionBase,
            source,
            placement,
            client_order_id,
			log: evaluatedLog,
			reason: evaluation.decision.reason as MirrorReason,
			detail: "algorithm emitted no safe SELL action",
            decisionLogFields,
          });
          return;
        }
	const closeSizeUsdc = canonicalOrder.size_usdc;

  const boundClose = deps.closePosition;
  if (!boundClose) return;
  const closeExecutor = (
    intent: OrderIntent,
		mode: "live" | "paper",
  ): Promise<OrderReceipt> =>
    boundClose(
      {
        tokenId: intent.attributes?.token_id as string,
        max_size_usdc: closeSizeUsdc,
        limit_price: fill.price,
        client_order_id,
      },
			mode,
    );

	const closeIntent = materializeFillOrderIntent(
		canonicalOrder,
		deps.target,
		evaluation.lineage,
		fill,
	);

  await executeMirrorOrder(
    deps,
    fill,
    client_order_id,
		evaluatedDecisionBase,
    source,
    placement,
    closeIntent,
		evaluation.decision.reason as MirrorReason,
		evaluatedLog,
    planningMode,
    closeExecutor,
    {
      position_branch: "sell_close",
      position_qty_shares: position.size,
      position_token_id: tokenId,
      ...decisionLogFields,
		},
  );
}

async function recordSellSkip(args: {
  deps: MirrorPipelineDeps;
  tenantLedger: ReturnType<OrderLedger["forTenant"]>;
  fill: import("@cogni/poly-market-provider").Fill;
  decisionBase: {
    target_id: string;
    fill_id: string;
    billing_account_id: string;
    created_by_user_id: string;
    decided_at: Date;
		lineage: AlgorithmLineage;
  };
  source: DecisionSource;
  placement: PlacementWire;
  client_order_id: `0x${string}`;
  log: LoggerPort;
  reason: MirrorReason;
  detail: string;
  decisionLogFields?: Record<string, unknown>;
}): Promise<void> {
  const {
    deps,
    tenantLedger,
    fill,
    decisionBase,
    source,
    placement,
    client_order_id,
    log,
    reason,
    detail,
    decisionLogFields,
  } = args;
  emitDecisionMetric(deps.metrics, "skipped", reason, source, placement);
  await tenantLedger.recordDecision({
    ...decisionBase,
    outcome: "skipped",
    reason,
    intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
      close: false,
      position_branch: "sell_close",
      ...decisionLogFields,
    }),
    receipt: null,
  });
  log.info(
    {
      event: EVENT_NAMES.POLY_MIRROR_DECISION,
      outcome: "skipped",
      reason,
      source,
      fill_id: fill.fill_id,
      client_order_id,
      detail,
      position_branch: "sell_close",
      ...decisionLogFields,
    },
		"mirror pipeline: skip position-gap SELL",
  );
}

/**
 * Cancel any open mirror orders for this (target, market). Used by the SELL-
 * fill pre-step (target exited the market) AND the BUY-side stale-resting
 * cancel-and-replace path (bug.5035: target layered up at higher prices and
 * our resting bid is too low to fill). Idempotent: pending rows (no
 * `order_id` yet) are skipped; the adapter swallows CLOB 404 so concurrent
 * cancels from the TTL sweeper are harmless. `cancelOrder` is optional;
 * tests omit it and the loop no-ops.
 */
async function cancelOpenMirrorOrdersForMarket(args: {
  deps: MirrorPipelineDeps;
  fill: import("@cogni/poly-market-provider").Fill;
  log: LoggerPort;
  reason:
    | "target_exited_market"
    | "stale_resting_layer_up"
    | "multi_target_position_gap_unsupported";
}): Promise<void> {
  const { deps, fill, log, reason } = args;
  const cancelOrder = deps.cancelOrder;
  if (!cancelOrder) return;
  const tenantLedger = deps.ledger.forTenant({
    billing_account_id: deps.target.billing_account_id,
    created_by_user_id: deps.target.created_by_user_id,
  });
  const open = await tenantLedger.findOpenForMarket({
    target_id: deps.target.target_id,
    market_id: fill.market_id,
  });
  for (const row of open) {
    if (row.order_id === null) continue;
    try {
      await cancelOrder(row.order_id, row.mode);
      await deps.ledger.markCanceled({
        client_order_id: row.client_order_id,
        reason,
      });
      log.info(
        {
          event: EVENT_NAMES.POLY_MIRROR_DECISION,
          phase:
            reason === "stale_resting_layer_up"
              ? "buy_canceled_on_stale_resting"
              : reason === "multi_target_position_gap_unsupported"
                ? "buy_canceled_on_unsupported_multi_target"
                : "buy_canceled_on_target_sell",
          client_order_id: row.client_order_id,
          order_id: row.order_id,
          market_id: row.market_id,
          reason,
        },
        reason === "stale_resting_layer_up"
          ? "mirror pipeline: canceled stale resting BUY for layer-up replace"
          : reason === "multi_target_position_gap_unsupported"
            ? "mirror pipeline: canceled resting BUY because multi-target position-gap is unsupported"
						: "mirror pipeline: canceled resting BUY on target SELL",
      );
    } catch (err: unknown) {
      log.error(
        {
          event: EVENT_NAMES.POLY_MIRROR_DECISION,
          phase: "cancel_failed",
          client_order_id: row.client_order_id,
          order_id: row.order_id,
          err: err instanceof Error ? err.message : String(err),
        },
				"mirror pipeline: cancel failed; row stays open for sweeper",
      );
    }
  }
}

/**
 * Shared INSERT_BEFORE_PLACE + mark/record sequence used by both the BUY path
 * and the SELL-close path.
 */
async function executeMirrorOrder(
  deps: MirrorPipelineDeps,
  fill: import("@cogni/poly-market-provider").Fill,
  client_order_id: `0x${string}`,
  decisionBase: {
    target_id: string;
    fill_id: string;
    billing_account_id: string;
    created_by_user_id: string;
    decided_at: Date;
		lineage: AlgorithmLineage;
  },
  source: DecisionSource,
  placement: PlacementWire,
  intent: OrderIntent,
  reason: MirrorReason,
  log: LoggerPort,
  planningMode: "live" | "paper",
  intentExecutor?: (
    intent: OrderIntent,
		mode: "live" | "paper",
  ) => Promise<OrderReceipt>,
	decisionLogFields?: Record<string, unknown>,
): Promise<void> {
  // bug.5022 — tenantLedger for all per-tenant writes (insertPending +
  // recordDecision). Uses appDb + withTenantScope; RLS active.
  const tenantLedger = deps.ledger.forTenant({
    billing_account_id: deps.target.billing_account_id,
    created_by_user_id: deps.target.created_by_user_id,
  });
  const executor = intentExecutor ?? deps.placeIntent;

  let placementMode: "live" | "paper";
  try {
    placementMode = await tenantLedger.insertPending({
      target_id: deps.target.target_id,
      fill_id: fill.fill_id,
      observed_at: new Date(fill.observed_at),
      intent,
      ...(intent.side === "BUY"
        ? {
            max_market_intent_usdc: nominalSizeUsdc(
              deps.target.sizing,
							fill.size_usdc,
            ),
          }
        : {}),
    });
  } catch (err: unknown) {
    // DB partial unique index races past the app-level gate → same skip outcome.
    if (err instanceof AlreadyRestingError) {
      emitDecisionMetric(
        deps.metrics,
        "skipped",
        "already_resting",
        source,
				placement,
      );
      await tenantLedger.recordDecision({
        ...decisionBase,
        outcome: "skipped",
        reason: "already_resting",
        intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
          ...decisionLogFields,
          position_branch: decisionLogFields?.position_branch ?? "new_entry",
        }),
        receipt: null,
      });
      log.info(
        {
          event: EVENT_NAMES.POLY_MIRROR_DECISION,
          outcome: "skipped",
          reason: "already_resting",
          source,
          fill_id: fill.fill_id,
          client_order_id,
          market_id: fill.market_id,
          detail: "DB unique-index backstop fired (race past app-level gate)",
          ...decisionLogFields,
        },
				"mirror pipeline: skip (already resting; DB index backstop)",
      );
      return;
    }
    if (err instanceof PositionCapReachedError) {
      emitDecisionMetric(
        deps.metrics,
        "skipped",
        "position_cap_reached",
        source,
				placement,
      );
      await tenantLedger.recordDecision({
        ...decisionBase,
        outcome: "skipped",
        reason: "position_cap_reached",
        intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
          ...decisionLogFields,
          position_branch: decisionLogFields?.position_branch ?? "new_entry",
          current_intent_usdc: err.current_intent_usdc,
          proposed_intent_usdc: err.proposed_intent_usdc,
          max_intent_usdc: err.max_intent_usdc,
        }),
        receipt: null,
      });
      log.info(
        {
          event: EVENT_NAMES.POLY_MIRROR_DECISION,
          outcome: "skipped",
          reason: "position_cap_reached",
          source,
          fill_id: fill.fill_id,
          client_order_id,
          market_id: fill.market_id,
          current_intent_usdc: err.current_intent_usdc,
          proposed_intent_usdc: err.proposed_intent_usdc,
          max_intent_usdc: err.max_intent_usdc,
          detail: "DB tenant-market intent cap backstop fired",
          ...decisionLogFields,
        },
				"mirror pipeline: skip (position cap reached; DB backstop)",
      );
      return;
    }
    emitDecisionMetric(
      deps.metrics,
      "error",
      "pending_insert_failed",
      source,
			placement,
    );
    await tenantLedger.recordDecision({
      ...decisionBase,
      outcome: "error",
      reason: "pending_insert_failed",
      intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
        ...decisionLogFields,
        position_branch: decisionLogFields?.position_branch ?? "new_entry",
      }),
      receipt: null,
    });
    log.error(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "error",
        errorCode: "pending_insert_failed",
        reason: "pending_insert_failed",
        source,
        fill_id: fill.fill_id,
        ...decisionLogFields,
      },
			"mirror pipeline: pending insert failed; skipping placement",
    );
    return;
  }

  try {
    if (placementMode !== planningMode) {
      throw new Error(
				`execution venue changed during mirror planning (${planningMode} -> ${placementMode})`,
      );
    }
    let assignmentCurrent = false;
    let assignmentLivenessError: unknown;
    try {
      assignmentCurrent = await deps.isAssignmentCurrent();
    } catch (error) {
      assignmentLivenessError = error;
    }
    if (!assignmentCurrent) {
      await deps.ledger.markCanceled({
        client_order_id,
        reason: "assignment_retired",
      });
      emitDecisionMetric(
        deps.metrics,
        "skipped",
        "assignment_retired",
        source,
				placement,
      );
      await tenantLedger.recordDecision({
        ...decisionBase,
        mode_override: placementMode,
        outcome: "skipped",
        reason: "assignment_retired",
        intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
          ...decisionLogFields,
          side: intent.side,
          close: intent.side === "SELL",
          position_branch: decisionLogFields?.position_branch ?? "new_entry",
        }),
        receipt: null,
      });
      const terminalFields = {
        event: EVENT_NAMES.POLY_MIRROR_ASSIGNMENT_RETIRED,
        outcome: "skipped",
        reason: "assignment_retired",
        source,
        fill_id: fill.fill_id,
        client_order_id,
        ...(assignmentLivenessError
          ? {
              errorCode: "assignment_liveness_unavailable",
              ...safeErrorDimensions(assignmentLivenessError),
            }
          : {}),
      };
      if (assignmentLivenessError) {
        log.error(
          terminalFields,
          "mirror pipeline: assignment liveness unavailable before venue dispatch",
        );
      } else {
        log.info(
          terminalFields,
          "mirror pipeline: assignment retired before venue dispatch",
        );
      }
      return;
    }
    const receipt = await executor(intent, placementMode);
    await deps.ledger.markOrderId({
      client_order_id,
      receipt,
    });
    emitDecisionMetric(deps.metrics, "placed", reason, source, placement);
    await tenantLedger.recordDecision({
      ...decisionBase,
      mode_override: placementMode,
      outcome: "placed",
      reason,
      intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
        ...decisionLogFields,
        side: intent.side,
        close: intent.side === "SELL",
        position_branch: decisionLogFields?.position_branch ?? "new_entry",
      }),
      receipt: {
        order_id: receipt.order_id,
        client_order_id: receipt.client_order_id,
        status: receipt.status,
        filled_size_usdc: receipt.filled_size_usdc ?? 0,
        submitted_at: receipt.submitted_at,
      },
    });
    log.info(
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "placed",
        reason,
        source,
        fill_id: fill.fill_id,
        client_order_id,
        order_id: receipt.order_id,
        // Sized notional from the planner. Lets us verify sizing-policy
        // effects (D6 proportional scaling, percentile interpolation, follow-
        // up branch sizing) directly from the decision log — without joining
        // to `poly.copy_trade.execute` by `client_order_id`.
        size_usdc: intent.size_usdc,
        limit_price: intent.limit_price,
        ...decisionLogFields,
        execution_mode: placementMode,
      },
			"mirror pipeline: placed",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errDetails =
      err && typeof err === "object" && "details" in err
        ? ((err as { details?: unknown }).details ?? null)
        : null;
    const detailsObj = (
      errDetails && typeof errDetails === "object" ? errDetails : {}
    ) as Record<string, unknown>;
    const adapterErrorCode =
      typeof detailsObj.error_code === "string"
        ? (detailsObj.error_code as string)
        : undefined;
    const adapterErrorReason =
      typeof detailsObj.reason === "string"
        ? (detailsObj.reason as string)
        : null;
    const adapterErrorClass =
      typeof detailsObj.error_class === "string"
        ? (detailsObj.error_class as string)
        : err instanceof Error
          ? err.name
          : null;
    deps.metrics.incr(MIRROR_PIPELINE_METRICS.placementErrorsTotal, {});
    await deps.ledger.markError({ client_order_id, error: msg });
    emitDecisionMetric(
      deps.metrics,
      "error",
      "placement_failed",
      source,
			placement,
    );
    await tenantLedger.recordDecision({
      ...decisionBase,
      mode_override: placementMode,
      outcome: "error",
      reason: "placement_failed",
      intent: buildDecisionIntentBlob(fill, deps.target, client_order_id, {
        ...decisionLogFields,
        position_branch: decisionLogFields?.position_branch ?? "new_entry",
      }),
      receipt: extractAdapterErrorReceipt(err),
    });
    const isFokNoMatch = adapterErrorCode === "fok_no_match";
    const logLevel = isFokNoMatch ? "info" : "error";
    log[logLevel](
      {
        event: EVENT_NAMES.POLY_MIRROR_DECISION,
        outcome: "error",
        errorCode: adapterErrorCode ?? "placement_failed",
        errorReason: adapterErrorReason,
        errorClass: adapterErrorClass,
        // Underlying error text from the adapter (or `String(err)` if non-Error
        // was thrown). Without this, generic `throw new Error("…")` paths —
        // e.g. paper adapter on non-2xx sidecar response, or Zod parse failure
        // in the request schema — vanish from observability and force a DB
        // dive via the ledger's `error` column. bug.5060.
        errorMessage: msg,
        reason: "placement_failed",
        source,
        fill_id: fill.fill_id,
        execution_mode: placementMode,
        client_order_id,
        // Sized notional + limit from the planner. Mirrors the `placed` log
        // line so failure analysis can join intent shape vs adapter rejection
        // (size below market min, limit outside tick grid, etc.) without
        // round-tripping to the ledger's `intent` JSONB. bug.5060.
        size_usdc: intent.size_usdc,
        limit_price: intent.limit_price,
        ...decisionLogFields,
      },
      isFokNoMatch
        ? "mirror pipeline: FOK no-match — clean skip, no retry"
				: "mirror pipeline: placement error",
    );
  }
}

function emitDecisionMetric(
  metrics: MetricsPort,
  outcome: "placed" | "skipped" | "error",
  reason: MirrorReason | "pending_insert_failed" | "placement_failed",
  source: DecisionSource,
	placement: PlacementWire,
): void {
  metrics.incr(MIRROR_PIPELINE_METRICS.decisionsTotal, {
    outcome,
    reason,
    source,
    placement,
  });
}

function buildDecisionIntentBlob(
  fill: import("@cogni/poly-market-provider").Fill,
  target: MirrorTargetConfig,
  client_order_id: `0x${string}`,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    target_wallet: target.target_wallet,
    market_id: fill.market_id,
    outcome: fill.outcome,
    side: fill.side,
    fill_size_usdc_target: fill.size_usdc,
    fill_price_target: fill.price,
    mirror_usdc: nominalSizeUsdc(target.sizing, fill.size_usdc),
    client_order_id,
    ...extra,
  };
}
