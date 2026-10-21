// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Coherent, bounded, DB-only wallet-dashboard read model. */
import { copyFillAccountingSql } from "@/features/trading/fill-accounting-sql";
import { randomUUID } from "node:crypto";
import type {
  PolyAccountPortfolioSnapshotOutput,
  PolyAccountWalletReadiness,
  PolyWalletOverviewInterval,
  WalletDashboardFactMeta,
  WalletDashboardWarning,
  WalletExecutionPosition,
  WalletExecutionTradeActivity,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  positionKey,
  readAlgorithmOriginProjection,
  unavailableOriginCoverage,
} from "./algorithm-origin-read-model";
import { buildEconomicPositionProjectionQuery, type EconomicPositionReadDiagnostics, readEconomicPositionProjection } from "./economic-position-read-model";
import { captureEconomicProjectionPlan, type EconomicProjectionPlanProbe } from "./economic-projection-plan";
import {
  type BoundedMarketExposureRead,
  buildBoundedMarketExposureGroups,
  buildBoundedMarketExposureWithCoverage,
  type ComparisonCoverageCountRow,
  type ComparisonReadDiagnostics,
  emptyComparisonCoverageCounts,
  materializeComparisonCoverage,
  readComparisonSourceIdentityAmbiguity,
  unavailableComparisonCoverage,
} from "./market-exposure-service";
import { portfolioWindowStart } from "./portfolio-window";
import { getTradingWalletPnlHistoryRead } from "./trading-wallet-overview-service";
import {
  readWalletBalanceFact,
  WALLET_BALANCE_FRESHNESS_MS,
  type WalletBalanceRead,
} from "./wallet-balance-snapshot-service";

type Db = PostgresJsDatabase<Record<string, unknown>>;
type ExecuteDb = { execute(query: SQL): Promise<unknown> };

const STATEMENT_TIMEOUT_MS = 8_000;
const POSITION_FRESHNESS_MS = 10 * 60_000;
const ORDER_FRESHNESS_MS = 5 * 60_000;
const MAX_FACT_SKEW_MS = 10 * 60_000;
const LIVE_PREVIEW_LIMIT = 500 as const;
const CLOSED_PREVIEW_LIMIT = 30 as const;

type OrderSummaryRow = {
  open_orders: string | number | null;
  locked_usdc: string | number | null;
  observed_at: Date | string | null;
  malformed_buy_rows: string | number | null;
};

type TradeActivityRow = {
  bucket_index: string | number | null;
  bucket_start: string | null;
  n: string | number | null;
};

export type WalletDashboardReadDiagnostics = ComparisonReadDiagnostics & EconomicPositionReadDiagnostics & {
  comparisonPath?:
    | "cache_hit"
    | "unknown"
    | "unavailable"
    | "zero_identity"
    | "bundle"
    | "bundle_fallback";
  economicPlanProbe?: EconomicProjectionPlanProbe;
  comparisonIdentityMs?: number;
  comparisonBundleTotalMs?: number;
  comparisonFallbackMarketMs?: number;
};

type OptionalRead<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export type TenantWalletDashboardReadInput = {
  billingAccountId: string;
  interval: PolyWalletOverviewInterval;
  adapterConfigured: boolean;
  /** Component-test seam; production always uses the persisted balance reader. */
  readBalance?: (db: Db, billingAccountId: string) => Promise<WalletBalanceRead>;
  /** Bounded internal timing sink; never serialized into the public response. */
  diagnostics?: WalletDashboardReadDiagnostics;
};

/**
 * Own-transaction wrapper, retained so existing callers and the component
 * suites keep working unchanged.
 *
 * SNAPSHOT_COHERENCE_IS_THE_CONTRACT: this whole read model rests on every
 * statement seeing ONE snapshot — `snapshotId`, `capturedAt`, and the
 * cross-fact `MAX_FACT_SKEW_MS` coherence gate behind `usdc_total` are only
 * meaningful under `REPEATABLE READ READ ONLY`. Nesting this function inside
 * another transaction would silently defeat that: postgres-js degrades a
 * nested `transaction()` to a SAVEPOINT and DROPS the isolation-level and
 * access-mode options on the floor, with no error. Callers that already own a
 * transaction MUST therefore call {@link readTenantWalletDashboardIn} against
 * their own already-read-only transaction, never this wrapper.
 */
export async function readTenantWalletDashboard(
  input: TenantWalletDashboardReadInput & { db: Db }
): Promise<PolyAccountPortfolioSnapshotOutput> {
  return input.db.transaction(
    async (tx) => readTenantWalletDashboardIn(tx as unknown as Db, input),
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/**
 * The read model itself, against a caller-owned transaction.
 *
 * The caller owns the isolation level and access mode. The capability plane's
 * executor sets `REPEATABLE READ READ ONLY` as the first statement after the
 * tenant context, which is exactly the guarantee the wrapper above establishes
 * for standalone callers — so the snapshot contract holds identically on both
 * paths, and the owner UI and a delegated agent read one coherent cutoff.
 */
export async function readTenantWalletDashboardIn(
  db: Db,
  input: TenantWalletDashboardReadInput
): Promise<PolyAccountPortfolioSnapshotOutput> {
  await db.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
  const clockRows = normalizeRows<{ captured_at: Date | string }>(
    await db.execute(sql`SELECT clock_timestamp() AS captured_at`)
  );
  const capturedAt = toIso(clockRows[0]?.captured_at) ?? new Date().toISOString();
  const capturedAtDate = new Date(capturedAt);
  const snapshotId = randomUUID();
  const warnings: WalletDashboardWarning[] = [];

  const connection = await readActiveWalletConnection(db, input.billingAccountId);
  // Paper has its own complete venue adapter and must not inherit Privy's
  // deployment-readiness flag. Live remains gated exactly as before.
  const accountConfigured =
    connection?.connectionKind === "paper" || input.adapterConfigured;
  if (!accountConfigured) {
    warnings.push(
      warning(
        "wallet",
        "wallet_adapter_unconfigured",
        "Trading-wallet actions are unavailable on this deployment."
      )
    );
  }

  const readiness = walletReadiness(connection, capturedAt);
  if (connection === null || connection.address === null) {
    warnings.push(warning("wallet", "no_trading_wallet", "No trading wallet is connected."));
    return emptyDashboard({
      snapshotId,
      capturedAt,
      interval: input.interval,
      configured: accountConfigured,
      warnings,
      // A row may exist with an unusable address. Readiness still reports the
      // persisted truth rather than inventing a disconnected wallet.
      readiness,
    });
  }
  const address = connection.address;

  const balanceRead = await optionalRead(db, (savepoint) =>
    (input.readBalance ?? readWalletBalanceFact)(savepoint, input.billingAccountId)
  );
  const balance: Exclude<WalletBalanceRead, { kind: "no_wallet" }> =
    balanceRead.ok && balanceRead.value.kind !== "no_wallet"
      ? balanceRead.value
      : {
          kind: "missing",
          address,
          connectionKind: connection.connectionKind,
        };
  if (!balanceRead.ok) {
    warnings.push(readFailure("cash", "balances_unavailable", balanceRead.error));
  } else if (balanceRead.value.kind === "no_wallet") {
    warnings.push(
      warning(
        "cash",
        "balances_unavailable",
        "The balance reader could not resolve the active wallet inside this snapshot."
      )
    );
  }
  const orderRead = await optionalRead(db, (savepoint) =>
    readOrderSummary(savepoint, input.billingAccountId, capturedAt, connection.connectionKind === "paper" ? "paper" : "live")
  );
  const economicInput = {
    billingAccountId: input.billingAccountId,
    walletAddress: address,
    connectionKind: connection.connectionKind,
    capturedAt: capturedAtDate,
    interval: input.interval,
  };
  const economicRead = await optionalRead(db, (savepoint) =>
    readEconomicPositionProjection({
      ...economicInput,
      db: savepoint,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    })
  );
  // The failed projection savepoint has already rolled back. A planning-only
  // probe inherits this exact authorized actor/snapshot and cannot replace its result.
  if (!economicRead.ok && input.diagnostics?.economicReadPhase === "projection" &&
    (input.diagnostics.economicCauseCode === "57014" || input.diagnostics.economicErrorCode === "57014")) {
    try {
      recordDashboardDiagnostic(input.diagnostics, "economicPlanProbe",
        await captureEconomicProjectionPlan(db, buildEconomicPositionProjectionQuery(economicInput)));
    } catch {
      // Optional diagnostics must never alter financial facts or read errors.
      recordDashboardDiagnostic(input.diagnostics, "economicPlanProbe", { status: "failed", durationMs: null });
    }
  }
  const originRead = economicRead.ok
    ? await optionalRead(db, (savepoint) =>
        readAlgorithmOriginProjection({
          db: savepoint,
          billingAccountId: input.billingAccountId,
          connectionKind: connection.connectionKind,
          capturedAt: capturedAtDate,
          previewPositionKeys: [
            ...economicRead.value.livePositions,
            ...economicRead.value.closedPositions,
          ].map((position) => ({
            conditionId: position.conditionId,
            tokenId: position.asset,
          })),
        })
      )
    : { ok: false as const, error: economicRead.error };
  const activityRead = await optionalRead(db, (savepoint) =>
    readTradeActivity(
      savepoint,
      input.billingAccountId,
      capturedAtDate,
      input.interval
    )
  );
  const pnlRead = await optionalRead(db, (savepoint) =>
    getTradingWalletPnlHistoryRead({
      db: savepoint,
      address,
      interval: input.interval,
      capturedAt,
    })
  );

  const orderFact = orderRead.ok
    ? orderRead.value.malformedBuyRows > 0
      ? {
          ...factFromAge("local_ledger", orderRead.value.observedAt, capturedAtDate, ORDER_FRESHNESS_MS),
          status: "partial" as const,
          complete: false,
        }
      : factFromAge("local_ledger", orderRead.value.observedAt, capturedAtDate, ORDER_FRESHNESS_MS)
    : unavailableFact("local_ledger");
  if (!orderRead.ok) warnings.push(readFailure("orders", "orders_unavailable", orderRead.error));
  else if (orderRead.value.malformedBuyRows > 0) {
    warnings.push(
      warning(
        "orders",
        "orders_malformed_numeric",
        "One or more local order amounts are malformed; reserved collateral is unavailable."
      )
    );
  } else if (orderFact.status === "stale") {
    warnings.push(
      warning(
        "orders",
        "orders_stale",
        "The local order ledger has no recent synchronization timestamp."
      )
    );
  }

  const observerAgeFact = economicRead.ok && economicRead.value.observerSyncedAt !== null
    ? factFromAge(
        "data_api_current_positions",
        economicRead.value.observerSyncedAt,
        capturedAtDate,
        POSITION_FRESHNESS_MS
      )
    : unavailableFact("data_api_current_positions");
  const currentPositionFact = !economicRead.ok || !economicRead.value.observerComplete
    ? unavailableFact("data_api_current_positions")
    : economicRead.value.observerStatus !== "ok"
      ? { ...observerAgeFact, status: "partial" as const, complete: false }
      : observerAgeFact;
  const economicProjectionIncomplete = economicRead.ok &&
    (economicRead.value.currentIdentityConflictCount > 0 ||
      economicRead.value.missingMarkCount > 0);
  const positionFact = !economicRead.ok
    ? unavailableFact("saved_wallet_economics")
    : economicProjectionIncomplete || currentPositionFact.status !== "fresh"
      ? {
          ...freshFact("saved_wallet_economics", capturedAt),
          observedAt: currentPositionFact.observedAt,
          ageMs: currentPositionFact.ageMs,
          status: "partial" as const,
          complete: false,
        }
      : {
          ...currentPositionFact,
          source: "saved_wallet_economics" as const,
        };
  if (!economicRead.ok) {
    warnings.push(readFailure("positions", "positions_unavailable", economicRead.error));
  } else {
    if (
      positionFact.status !== "unavailable" &&
      economicRead.ok &&
      economicRead.value.liveCount > economicRead.value.livePositions.length
    ) {
      warnings.push(
        warning(
          "positions",
          "positions_preview_truncated",
          `Showing ${economicRead.value.livePositions.length} of ${economicRead.value.liveCount} open positions.`
        )
      );
    }
  }

  if (!economicRead.ok) {
    warnings.push(readFailure("history", "history_unavailable", economicRead.error));
  } else if (economicRead.value.fillIdentityConflictCount > 0) {
    warnings.push(
      warning(
        "history",
        "history_fill_identity_ambiguous",
        `${economicRead.value.fillIdentityConflictCount} position${economicRead.value.fillIdentityConflictCount === 1 ? " has" : "s have"} conflicting saved fill identities; affected economics are withheld.`
      )
    );
  }
  if (economicRead.ok && economicRead.value.outcomeIdentityConflictCount > 0) {
    warnings.push(
      warning(
        "history",
        "history_outcome_identity_ambiguous",
        `${economicRead.value.outcomeIdentityConflictCount} position${economicRead.value.outcomeIdentityConflictCount === 1 ? " has" : "s have"} conflicting terminal market facts; affected outcomes are withheld.`
      )
    );
  }
  if (economicRead.ok && economicRead.value.currentIdentityConflictCount > 0) {
    warnings.push(
      warning(
        "positions",
        "positions_current_identity_ambiguous",
        `${economicRead.value.currentIdentityConflictCount} position${economicRead.value.currentIdentityConflictCount === 1 ? " has" : "s have"} conflicting saved current facts; affected valuation is withheld.`
      )
    );
  }
  if (economicRead.ok && economicRead.value.incompleteCount > 0) {
    warnings.push(
      warning(
        "history",
        "history_projection_incomplete",
        `${economicRead.value.incompleteCount} position${economicRead.value.incompleteCount === 1 ? " is" : "s are"} omitted because saved economic facts are incomplete or ambiguous.`
      )
    );
  }
  if (economicRead.ok && economicRead.value.missingMarkCount > 0) {
    warnings.push(
      warning(
        "positions",
        "positions_current_mark_unavailable",
        `${economicRead.value.missingMarkCount} open position${economicRead.value.missingMarkCount === 1 ? " has" : "s have"} no fresh, identity-consistent saved mark; valuation and P/L are withheld while the position remains live.`
      )
    );
  }
  const incompleteOriginCount = originRead.ok
    ? (originRead.value.coverage.incompleteEventCount ?? 0) +
      (originRead.value.coverage.identityAmbiguousEventCount ?? 0)
    : null;
  if (!originRead.ok) {
    warnings.push(
      readFailure("positions", "copy_origin_unavailable", originRead.error)
    );
  } else if (incompleteOriginCount !== null && incompleteOriginCount > 0) {
    warnings.push(
      warning(
        "positions",
        "copy_origin_incomplete",
        `${incompleteOriginCount} executed fill${incompleteOriginCount === 1 ? " has" : "s have"} incomplete or ambiguous algorithm lineage; those origins are withheld.`
      )
    );
  }

  const activityFact = activityRead.ok
    ? freshFact("local_ledger", capturedAt)
    : unavailableFact("local_ledger");
  if (!activityRead.ok) {
    warnings.push(
      readFailure(
        "activity",
        "daily_trade_counts_unavailable",
        activityRead.error
      )
    );
  }

  // Paper's saved balance is NAV; unsupported chain assets do not make an
  // authenticated, complete paper generation financially partial.
  const paperFinanceValidated = connection.connectionKind === "paper" &&
    balance.kind === "available" && balance.status !== "error" && balance.usdcE !== null &&
    balance.observedAt.getTime() <= capturedAtDate.getTime() &&
    economicRead.ok && economicRead.value.observerComplete && economicRead.value.observerStatus === "ok" &&
    economicRead.value.historyIncompleteCount === 0 && economicRead.value.incompleteCount === 0 &&
    economicRead.value.fillIdentityConflictCount === 0 && economicRead.value.currentIdentityConflictCount === 0 &&
    balance.observedAt.toISOString() === economicRead.value.observerSyncedAt;
  const cashFact = paperFinanceValidated && balance.kind === "available"
    ? factFromAge("polygon_balance_snapshot", balance.observedAt.toISOString(), capturedAtDate, WALLET_BALANCE_FRESHNESS_MS)
    : cashMeta(balance, capturedAtDate);
  if (!balanceRead.ok) {
    // The identity row is authoritative and was resolved before the
    // component savepoint. A cash-table failure must not erase it or
    // abort the remaining repeatable-read snapshot.
  } else if (balance.kind === "missing") {
    warnings.push(warning("cash", "balance_snapshot_missing", "No persisted balance observation is available; this is not a zero balance."));
  } else {
    for (const message of balance.errors) {
      warnings.push(warning("cash", balance.status === "error" ? "balances_unavailable" : "balances_partial", message));
    }
    if (cashFact.status === "stale") {
      warnings.push(warning("cash", "balances_stale", "The persisted Polygon cash fact is older than ten minutes."));
    }
  }

  const attachOrigins = (
    position: WalletExecutionPosition
  ): WalletExecutionPosition => {
    if (!originRead.ok) return position;
    const key = positionKey(position.conditionId, position.asset);
    const copyOrigins = [...(originRead.value.byPositionKey.get(key) ?? [])];
    const copyOriginLayerCount =
      originRead.value.layerCountByPositionKey.get(key) ?? 0;
    return {
      ...position,
      copyOrigins,
      copyOriginLayerCount,
      copyOriginsTruncated: copyOrigins.length < copyOriginLayerCount,
    };
  };
  const livePositions = economicRead.ok
    ? economicRead.value.livePositions.map(attachOrigins)
    : [];
  const closedPositions = economicRead.ok
    ? economicRead.value.closedPositions.map(attachOrigins)
    : [];
  const historyFact = !economicRead.ok
    ? unavailableFact("saved_wallet_economics")
    : economicRead.value.incompleteCount === 0 &&
        economicRead.value.historyIncompleteCount === 0 &&
        economicRead.value.fillIdentityConflictCount === 0 &&
        economicRead.value.outcomeIdentityConflictCount === 0
      ? freshFact("saved_wallet_economics", capturedAt)
      : {
          ...freshFact("saved_wallet_economics", capturedAt),
          status: "partial" as const,
          complete: false,
        };

  let marketRead: OptionalRead<BoundedMarketExposureRead>;
  let coverageRead: OptionalRead<ComparisonCoverageCountRow[]>;
  let positionClassifications: Awaited<
    ReturnType<typeof buildBoundedMarketExposureWithCoverage>
  >["positionClassifications"] = [];
  const comparisonUnavailable = new Error(
    "Current-position authority is unavailable."
  );
  if (positionFact.status === "unavailable") {
    recordDashboardDiagnostic(
      input.diagnostics,
      "comparisonPath",
      "unavailable"
    );
    marketRead = { ok: false, error: comparisonUnavailable };
    coverageRead = { ok: false, error: comparisonUnavailable };
  } else if (
    economicRead.ok &&
    economicRead.value.liveCount === 0 &&
    economicRead.value.closedCount === 0
  ) {
    // Both authorities have exact full-population zero counts. Preserve the
    // full reader's all-physical wallet/target ambiguity semantics, but avoid
    // its inventory/snapshot CTEs entirely.
    recordDashboardDiagnostic(
      input.diagnostics,
      "comparisonPath",
      "zero_identity"
    );
    marketRead = { ok: true, value: { groups: [], truncated: false } };
    const identityStartedAt = performance.now();
    const identityRead = await optionalRead(db, (savepoint) =>
      readComparisonSourceIdentityAmbiguity({
        db: savepoint,
        billingAccountId: input.billingAccountId,
        walletAddress: address,
        connectionKind: connection.connectionKind,
      })
    );
    recordDashboardDiagnostic(
      input.diagnostics,
      "comparisonIdentityMs",
      Math.max(0, Math.round(performance.now() - identityStartedAt))
    );
    coverageRead = identityRead.ok
      ? {
          ok: true,
          value: emptyComparisonCoverageCounts(identityRead.value),
        }
      : identityRead;
  } else {
    recordDashboardDiagnostic(input.diagnostics, "comparisonPath", "bundle");
    const bundleStartedAt = performance.now();
    let bundleRead: OptionalRead<Awaited<
      ReturnType<typeof buildBoundedMarketExposureWithCoverage>
    >>;
    try {
      bundleRead = await optionalRead(db, (savepoint) =>
        buildBoundedMarketExposureWithCoverage({
          db: savepoint,
          billingAccountId: input.billingAccountId,
          walletAddress: address,
          connectionKind: connection.connectionKind,
          positionFacts: economicRead.ok ? economicRead.value.positionFacts : [],
          mode: connection.connectionKind === "paper" ? "paper" : "live",
          capturedAt,
          livePositions,
          closedPositions,
          priorityPositionKeys: economicRead.ok
            ? economicRead.value.targetCorrelatedKeys
            : new Set(),
          ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
        })
      );
    } finally {
      recordDashboardDiagnostic(
        input.diagnostics,
        "comparisonBundleTotalMs",
        Math.max(0, Math.round(performance.now() - bundleStartedAt))
      );
    }
    if (bundleRead.ok) {
      marketRead = { ok: true, value: bundleRead.value.market };
      coverageRead = { ok: true, value: bundleRead.value.counts };
      positionClassifications = bundleRead.value.positionClassifications;
    } else {
      // A coverage/bundle failure may never erase the legacy-renderable market
      // preview. Re-run only that bounded reader in a fresh savepoint; coverage
      // remains explicitly unavailable.
      recordDashboardDiagnostic(
        input.diagnostics,
        "comparisonPath",
        "bundle_fallback"
      );
      const fallbackStartedAt = performance.now();
      try {
        marketRead = await optionalRead(db, (savepoint) =>
          buildBoundedMarketExposureGroups({
            db: savepoint,
            billingAccountId: input.billingAccountId,
            walletAddress: address,
            positionFacts: economicRead.ok ? economicRead.value.positionFacts : [],
            mode: connection.connectionKind === "paper" ? "paper" : "live",
            capturedAt,
            livePositions,
            closedPositions,
            priorityPositionKeys: economicRead.ok
              ? economicRead.value.targetCorrelatedKeys
              : new Set(),
            ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
          })
        );
      } finally {
        recordDashboardDiagnostic(
          input.diagnostics,
          "comparisonFallbackMarketMs",
          Math.max(0, Math.round(performance.now() - fallbackStartedAt))
        );
      }
      coverageRead = { ok: false, error: bundleRead.error };
    }
  }
  if (!marketRead.ok) warnings.push(readFailure("markets", "market_exposure_unavailable", marketRead.error));
  if (!coverageRead.ok) {
    warnings.push(
      readFailure(
        "markets",
        "comparison_coverage_unavailable",
        coverageRead.error
      )
    );
  }
  if (
    marketRead.ok &&
    (marketRead.value.truncated ||
      (economicRead.ok && economicRead.value.liveCount > livePositions.length) ||
      (economicRead.ok && economicRead.value.closedCount > closedPositions.length))
  ) {
    marketRead.value.truncated = true;
    warnings.push(warning("markets", "market_exposure_preview_truncated", "Market comparison is a bounded preview; exact position counts remain available separately."));
  }
  const comparisonCoverage = !marketRead.ok || !coverageRead.ok
    ? unavailableComparisonCoverage()
    : materializeComparisonCoverage({
        counts: coverageRead.value,
        positionClassifications,
        groups: marketRead.value.groups,
        livePositions: livePositions.slice(0, LIVE_PREVIEW_LIMIT),
        closedPositions: closedPositions.slice(0, CLOSED_PREVIEW_LIMIT),
        sourceComplete:
          positionFact.status === "fresh" &&
          positionFact.complete,
        previewTruncated: marketRead.value.truncated,
      });
  if (originRead.ok) {
    comparisonCoverage.positionClassifications =
      comparisonCoverage.positionClassifications.map((classification) => {
        const origins = originRead.value.byPositionKey.get(
          positionKey(classification.conditionId, classification.tokenId)
        );
        return origins &&
          origins.length > 0 &&
          (classification.result === "no_target_position" ||
            classification.result === "exact_token_missing")
          ? { ...classification, result: "target_now_unavailable" as const }
          : classification;
      });
  }
  const comparisonCoverageUnavailable = [
    comparisonCoverage.markets,
    comparisonCoverage.positions,
  ].some((byStatus) =>
    Object.values(byStatus).some((leaf) =>
      leaf.reasons.includes("source_unavailable")
    )
  );
  if (
    marketRead.ok &&
    coverageRead.ok &&
    comparisonCoverageUnavailable
  ) {
    warnings.push(
      warning(
        "markets",
        "comparison_coverage_invalid",
        "Comparison coverage counts failed invariant validation."
      )
    );
  }

  const coherentPaperMtm = economicRead.ok && currentPositionFact.complete
    ? economicRead.value.positionsMtm : null;
  const cashOnChain = connection.connectionKind === "paper"
    ? paperFinanceValidated && balance.kind === "available" && balance.usdcE !== null && coherentPaperMtm !== null
      ? roundMoney(balance.usdcE - coherentPaperMtm) : null
    : balance.kind === "available" ? nullableSum(balance.usdcE, balance.pusd) : null;
  const lockedUsdc = orderRead.ok && orderRead.value.lockedUsdc !== null
    ? roundMoney(orderRead.value.lockedUsdc)
    : null;
  const availableUsdc = cashOnChain !== null && lockedUsdc !== null
    ? roundMoney(Math.max(0, cashOnChain - lockedUsdc))
    : null;
  // UNKNOWN_IS_NOT_ZERO: `summary.positionsMtm` is summed over the SAVED
  // position inventory but filtered by the LIVE market-outcome / redeem joins
  // (see current-position-read-model). When the position observer stalls, the
  // inventory freezes while that filter keeps resolving markets, so the sum
  // drifts toward a misleading figure — bug.5031: a dead observer (frozen
  // 9.5h) collapsed a ~$21 live book to $0 while the card still presented cash
  // as if it were the balance. Trust the MTM only when the positions fact is
  // fresh and complete — the same gate the composite total already requires —
  // and otherwise surface it as unknown (null) so the UI shows "—", never a
  // stale number dressed as truth.
  const positionsMtm =
    economicRead.ok && currentPositionFact.complete
      ? economicRead.value.positionsMtm
      : null;
  const totalCoherent =
    cashOnChain !== null &&
    positionsMtm !== null &&
    cashFact.complete &&
    currentPositionFact.complete &&
    // Aggregate valuation authority is separate from physical quantity/history.
    // Exact terminal losers are worth zero even while their quantity is stale.
    timestampsWithin(cashFact.observedAt, currentPositionFact.observedAt, MAX_FACT_SKEW_MS);
  const totalFact: WalletDashboardFactMeta = totalCoherent
    ? freshFact("composite", capturedAt)
    : unavailableFact("composite");
  if (!totalCoherent) {
    warnings.push(warning("wallet", "wallet_total_unavailable", "Total is hidden until cash and positions are fresh, complete, and from the same freshness window."));
  }

  const pnlFact = pnlRead.ok
    ? pnlMeta(pnlRead.value.status, pnlRead.value.observedAt, capturedAtDate)
    : unavailableFact("user_pnl_snapshot");
  if (!pnlRead.ok) warnings.push(readFailure("pnl", "pnl_history_unavailable", pnlRead.error));
  else if (pnlRead.value.status !== "available") {
    warnings.push(warning("pnl", `pnl_history_${pnlRead.value.status}`, "Persisted P/L history is not currently available for this interval."));
  }

  return {
    snapshotId,
    capturedAt,
    interval: input.interval,
    readiness,
    overview: {
      configured: accountConfigured,
      connected: true,
      account_kind: connection.connectionKind,
      freshness: "read_model",
      address,
      interval: input.interval,
      capturedAt,
      pol_gas: balance.kind === "available" && cashFact.status !== "unavailable" ? balance.pol : null,
      usdc_available: availableUsdc,
      usdc_locked: lockedUsdc,
      usdc_positions_mtm: positionsMtm,
      usdc_total:
        totalCoherent && cashOnChain !== null && positionsMtm !== null
          ? roundMoney(cashOnChain + positionsMtm)
          : null,
      open_orders: orderRead.ok ? orderRead.value.openOrders : null,
      positions_synced_at: economicRead.ok ? economicRead.value.observerSyncedAt : null,
      positions_sync_age_ms: currentPositionFact.ageMs,
      positions_stale: positionFact.status !== "fresh",
      pnlHistory: pnlRead.ok && pnlRead.value.status === "available" ? pnlRead.value.points : [],
      pnl_basis: connection.connectionKind === "paper" ? "paper_trading_pnl" : "polymarket_trade_pnl_before_fees",
      warnings: warnings
        .filter((entry) => entry.component !== "activity" && entry.component !== "markets" && entry.component !== "history")
        .map(({ code, message }) => ({ code, message })),
    },
    execution: {
      address,
      freshness: "read_model",
      capturedAt,
      tradeActivity: activityRead.ok ? activityRead.value : undefined,
      live_positions: livePositions.slice(0, LIVE_PREVIEW_LIMIT),
      live_position_count:
        economicRead.ok ? economicRead.value.liveCount : null,
      market_groups: marketRead.ok ? marketRead.value.groups : [],
      comparisonCoverage,
      originCoverage: originRead.ok
        ? originRead.value.coverage
        : unavailableOriginCoverage(),
      closed_positions: closedPositions.slice(0, CLOSED_PREVIEW_LIMIT),
      closed_position_count: economicRead.ok ? economicRead.value.closedCount : null,
      warnings: warnings
        .filter(
          (entry) =>
            entry.component !== "cash" &&
            (entry.component !== "wallet" ||
              entry.code === "wallet_adapter_unconfigured")
        )
        .map(({ code, message }) => ({ code, message })),
    },
    facts: {
      wallet: freshFact("wallet_connection", capturedAt),
      cash: cashFact,
      orders: { ...orderFact, authority: "provisional_local_ledger" },
      positions: {
        ...positionFact,
        actionsAllowed:
          connection.connectionKind === "privy_live" &&
          input.adapterConfigured &&
          currentPositionFact.status === "fresh" &&
          currentPositionFact.complete &&
          positionFact.status === "fresh" &&
          positionFact.complete,
        previewLimit: LIVE_PREVIEW_LIMIT,
      },
      history: {
        ...historyFact,
        authority: "saved_wallet_fills_and_outcomes",
        previewLimit: CLOSED_PREVIEW_LIMIT,
      },
      pnl: pnlFact,
      activity: activityFact,
      markets: !marketRead.ok
        ? unavailableFact("composite")
        : marketRead.value.truncated ||
            positionFact.status === "partial" ||
            !coverageRead.ok ||
            comparisonCoverageUnavailable
          ? {
              ...factFromAge(
                "composite",
                positionFact.observedAt,
                capturedAtDate,
                POSITION_FRESHNESS_MS
              ),
              status: "partial",
              complete: false,
            }
          : positionFact.status === "stale"
            ? {
                ...factFromAge(
                  "composite",
                  positionFact.observedAt,
                  capturedAtDate,
                  POSITION_FRESHNESS_MS
                ),
                status: "stale",
                complete: false,
              }
            : freshFact("composite", capturedAt),
      total: totalFact,
    },
    warnings,
  };
}

type ActiveWalletConnection = {
  /** Null when the row exists but has no usable funder address (unprovisioned). */
  address: `0x${string}` | null;
  connectionKind: "privy_live" | "paper";
  tradingReady: boolean;
  autoWrapConsentAt: string | null;
  autoWrapFloorUsdceAtomic: string | null;
};

/**
 * Essential identity + readiness lookup; all non-identity facts are isolated
 * savepoints. ONE row serves both `overview.address` and the whole `readiness`
 * block, so the two can never describe different connections.
 *
 * This replaces the readiness half of `GET /wallet/status`, which reached the
 * same columns through a BYPASSRLS service handle and a tenant resolved from
 * the caller's own id. Here the tenant is a parameter and RLS is underneath.
 */
async function readActiveWalletConnection(
  db: ExecuteDb,
  billingAccountId: string
): Promise<ActiveWalletConnection | null> {
  const rows = normalizeRows<{
    address: string | null;
    connection_kind: "privy_live" | "paper";
    trading_approvals_ready_at: Date | string | null;
    auto_wrap_consent_at: Date | string | null;
    auto_wrap_revoked_at: Date | string | null;
    auto_wrap_floor_usdce_6dp: string | number | null;
  }>(await db.execute(sql`
    SELECT
      -- Amendment 2: funder_address alone. A null funder is an unprovisioned
      -- deposit wallet, and flows to a null address below, never to the signer.
      lower(funder_address) AS address,
      kind AS connection_kind,
      trading_approvals_ready_at,
      auto_wrap_consent_at,
      auto_wrap_revoked_at,
      auto_wrap_floor_usdce_6dp
    FROM poly_wallet_connections
    WHERE billing_account_id = ${billingAccountId}
      AND revoked_at IS NULL
    -- LIVE_WINS_PAPER_SHOWS (migration 0082): a tenant may hold an active
    -- live row and an active paper row. Ordering on created_at alone would
    -- let whichever was provisioned last take over the readiness panel.
    ORDER BY (kind = 'privy_live') DESC, created_at DESC
    LIMIT 1
  `));
  const row = rows[0];
  if (row === undefined) return null;
  const address = row.address;
  const floor = row.auto_wrap_floor_usdce_6dp;
  return {
    address:
      typeof address === "string" && /^0x[0-9a-f]{40}$/.test(address)
        ? (address as `0x${string}`)
        : null,
    connectionKind: row.connection_kind,
    tradingReady: row.trading_approvals_ready_at !== null,
    // A revocation nulls the consent out; the stamp itself is never rewritten.
    autoWrapConsentAt:
      row.auto_wrap_revoked_at === null ? toIso(row.auto_wrap_consent_at) : null,
    autoWrapFloorUsdceAtomic:
      floor === null || floor === undefined ? null : String(floor),
  };
}

/**
 * NO_FABRICATED_VALUES: with no connection row nothing is known, so every
 * readiness value is null/false rather than a zero-shaped default, and
 * `observedAt` stays null so a consumer can tell "no row" from "not ready".
 */
function walletReadiness(
  connection: ActiveWalletConnection | null,
  capturedAt: string
): PolyAccountWalletReadiness {
  if (connection === null) {
    return {
      connected: false,
      funder_address: null,
      trading_ready: false,
      auto_wrap_consent_at: null,
      auto_wrap_floor_usdce_atomic: null,
      observedAt: null,
    };
  }
  return {
    connected: true,
    funder_address: connection.address,
    trading_ready: connection.tradingReady,
    auto_wrap_consent_at: connection.autoWrapConsentAt,
    auto_wrap_floor_usdce_atomic: connection.autoWrapFloorUsdceAtomic,
    observedAt: capturedAt,
  };
}

/** @internal Exported only for aggregate/tenant component coverage. */
export async function readOrderSummary(
  db: ExecuteDb,
  billingAccountId: string,
  capturedAt: string,
  mode: "live" | "paper"
) {
  const rows = normalizeRows<OrderSummaryRow>(await db.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE f.status IN ('pending', 'open', 'partial')
          AND (f.position_lifecycle IS NULL OR f.position_lifecycle IN ('unresolved', 'open', 'closing'))
      )::int AS open_orders,
      CASE WHEN COUNT(*) FILTER (
        WHERE f.status IN ('pending', 'open', 'partial')
          AND (f.position_lifecycle IS NULL OR f.position_lifecycle IN ('unresolved', 'open', 'closing'))
          AND f.attributes->>'side' = 'BUY'
          AND (
            COALESCE(f.attributes->>'size_usdc', '') !~ '^[0-9]+(\\.[0-9]+)?$'
            OR (
              (
                ${copyFillAccountingSql("f", sql`${capturedAt}::timestamptz`).realized}
              )
              AND
              COALESCE(f.attributes->>'filled_size_usdc', '') <> ''
              AND f.attributes->>'filled_size_usdc' !~ '^[0-9]+(\\.[0-9]+)?$'
            )
          )
      ) > 0 THEN NULL ELSE COALESCE(SUM(
        CASE
          WHEN f.status IN ('pending', 'open', 'partial')
            AND (f.position_lifecycle IS NULL OR f.position_lifecycle IN ('unresolved', 'open', 'closing'))
            AND f.attributes->>'side' = 'BUY'
          THEN GREATEST(
            CASE WHEN f.attributes->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (f.attributes->>'size_usdc')::numeric ELSE 0 END
              - CASE WHEN (
                  ${copyFillAccountingSql("f", sql`${capturedAt}::timestamptz`).realized}
                ) AND f.attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (f.attributes->>'filled_size_usdc')::numeric ELSE 0 END,
            0
          )
          ELSE 0
        END
      ), 0) END AS locked_usdc,
      MAX(f.synced_at) AS observed_at,
      COUNT(*) FILTER (
        WHERE f.status IN ('pending', 'open', 'partial')
          AND (f.position_lifecycle IS NULL OR f.position_lifecycle IN ('unresolved', 'open', 'closing'))
          AND f.attributes->>'side' = 'BUY'
          AND (
            COALESCE(f.attributes->>'size_usdc', '') !~ '^[0-9]+(\\.[0-9]+)?$'
            OR (
              (
                ${copyFillAccountingSql("f", sql`${capturedAt}::timestamptz`).realized}
              )
              AND
              COALESCE(f.attributes->>'filled_size_usdc', '') <> ''
              AND f.attributes->>'filled_size_usdc' !~ '^[0-9]+(\\.[0-9]+)?$'
            )
          )
      )::int AS malformed_buy_rows
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${billingAccountId}
      AND f.mode = ${mode}
  `));
  const row = rows[0];
  const openOrders = nonnegativeInt(row?.open_orders);
  const malformedBuyRows = nonnegativeInt(row?.malformed_buy_rows);
  return {
    openOrders,
    lockedUsdc:
      malformedBuyRows > 0 || row?.locked_usdc === null
        ? null
        : toNumber(row?.locked_usdc),
    observedAt: toIso(row?.observed_at),
    malformedBuyRows,
  };
}

/**
 * Interval-scoped executed-trade aggregate for the shared portfolio snapshot.
 * Postgres returns at most one row per visual bucket; V8 only zero-fills that
 * bounded axis and never hydrates the underlying fill population.
 */
export async function readTradeActivity(
  db: ExecuteDb,
  billingAccountId: string,
  capturedAt: Date,
  interval: PolyWalletOverviewInterval
): Promise<WalletExecutionTradeActivity> {
  if (interval === "1D" || interval === "1W" || interval === "1M") {
    const bucketUnit = interval === "1D" ? "hour" : "day";
    const bucketCount = interval === "1D" ? 24 : interval === "1W" ? 7 : 30;
    const bucketMs = bucketUnit === "hour" ? 3_600_000 : 86_400_000;
    const windowStart = portfolioWindowStart(interval, capturedAt);
    if (windowStart === null) throw new Error(`missing ${interval} window start`);
    const bucketSeconds = bucketMs / 1_000;
    const rows = normalizeRows<TradeActivityRow>(await db.execute(sql`
      SELECT
        LEAST(
          ${bucketCount - 1},
          FLOOR(EXTRACT(EPOCH FROM (
            f.observed_at - ${windowStart.toISOString()}::timestamptz
          )) / ${bucketSeconds})
        )::int AS bucket_index,
        COUNT(*)::int AS n
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${billingAccountId}
        AND f.observed_at >= ${windowStart.toISOString()}::timestamptz
        AND f.observed_at <= ${capturedAt.toISOString()}::timestamptz
        AND ${countedTradePredicate(capturedAt)}
      GROUP BY 1
      ORDER BY 1
    `));
    const byIndex = new Map(
      rows.map((row) => [
        nonnegativeInt(row.bucket_index),
        nonnegativeInt(row.n),
      ])
    );
    return {
      bucketUnit,
      buckets: Array.from({ length: bucketCount }, (_, index) => ({
        start: new Date(windowStart.getTime() + index * bucketMs).toISOString(),
        n: byIndex.get(index) ?? 0,
      })),
    };
  }

  const bucketUnit = interval === "ALL" ? "year" : "month";
  const windowStart = portfolioWindowStart(interval, capturedAt);
  const bucketExpression =
    bucketUnit === "year"
      ? sql`date_trunc('year', f.observed_at AT TIME ZONE 'UTC')`
      : sql`date_trunc('month', f.observed_at AT TIME ZONE 'UTC')`;
  const rows = normalizeRows<TradeActivityRow>(await db.execute(sql`
    SELECT
      to_char(${bucketExpression}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket_start,
      COUNT(*)::int AS n
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${billingAccountId}
      AND ${
        windowStart
          ? sql`f.observed_at >= ${windowStart.toISOString()}::timestamptz`
          : sql`TRUE`
      }
      AND f.observed_at <= ${capturedAt.toISOString()}::timestamptz
      AND ${countedTradePredicate(capturedAt)}
    GROUP BY 1
    ORDER BY 1
  `));
  const byStart = new Map(
    rows.flatMap((row) =>
      row.bucket_start === null
        ? []
        : [
            [
              new Date(row.bucket_start).toISOString(),
              nonnegativeInt(row.n),
            ] as const,
          ]
    )
  );
  if (bucketUnit === "year" && byStart.size === 0) {
    return { bucketUnit, buckets: [] };
  }

  const first =
    bucketUnit === "year"
      ? new Date([...byStart.keys()][0] ?? capturedAt)
      : new Date(
          Date.UTC(
            (windowStart ?? capturedAt).getUTCFullYear(),
            (windowStart ?? capturedAt).getUTCMonth(),
            1
          )
        );
  const end = new Date(
    Date.UTC(
      capturedAt.getUTCFullYear(),
      bucketUnit === "month" ? capturedAt.getUTCMonth() : 0,
      1
    )
  );
  const buckets: WalletExecutionTradeActivity["buckets"] = [];
  for (const cursor = new Date(first); cursor <= end; ) {
    const start = cursor.toISOString();
    buckets.push({ start, n: byStart.get(start) ?? 0 });
    if (bucketUnit === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
  }
  return { bucketUnit, buckets };
}

function countedTradePredicate(capturedAt: Date): SQL {
  return sql`(
    CASE WHEN (
        ${copyFillAccountingSql("f", sql`${capturedAt.toISOString()}::timestamptz`).realized}
      ) AND f.attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
      THEN (f.attributes->>'filled_size_usdc')::numeric ELSE 0 END > 0
    OR (
      f.mode = 'live' AND COALESCE(f.attributes->>'position_gap_version', '') <> '3'
      AND f.status IN ('filled', 'partial')
      AND CASE WHEN f.attributes->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (f.attributes->>'size_usdc')::numeric ELSE 0 END > 0
    )
  )`;
}

async function optionalRead<T>(
  db: Db,
  read: (savepoint: Db) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    const value = await db.transaction(async (savepoint) =>
      read(savepoint as unknown as Db)
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

function recordDashboardDiagnostic<K extends keyof WalletDashboardReadDiagnostics>(
  diagnostics: WalletDashboardReadDiagnostics | undefined,
  key: K,
  value: WalletDashboardReadDiagnostics[K]
): void {
  if (!diagnostics) return;
  try {
    diagnostics[key] = value;
  } catch {
    // Observability is fail-open and cannot alter wallet truth.
  }
}

function cashMeta(balance: Exclude<Awaited<ReturnType<typeof readWalletBalanceFact>>, { kind: "no_wallet" }>, capturedAt: Date): WalletDashboardFactMeta {
  if (balance.kind === "missing") return unavailableFact("polygon_balance_snapshot");
  const meta = factFromAge("polygon_balance_snapshot", balance.observedAt.toISOString(), capturedAt, WALLET_BALANCE_FRESHNESS_MS);
  if (balance.status === "error") return { ...meta, status: "unavailable", complete: false };
  if (balance.status === "partial") return { ...meta, status: "partial", complete: false };
  return meta;
}

function pnlMeta(status: "available" | "no_history" | "stale" | "wallet_missing", observedAt: string | undefined, capturedAt: Date): WalletDashboardFactMeta {
  if (status === "available") return factFromAge("user_pnl_snapshot", observedAt ?? capturedAt.toISOString(), capturedAt, POSITION_FRESHNESS_MS);
  if (status === "stale") return { ...factFromAge("user_pnl_snapshot", observedAt ?? null, capturedAt, POSITION_FRESHNESS_MS), status: "stale", complete: false };
  return unavailableFact("user_pnl_snapshot");
}

function factFromAge(source: WalletDashboardFactMeta["source"], observedAt: string | null, capturedAt: Date, freshForMs: number): WalletDashboardFactMeta {
  const observedMs = observedAt === null ? null : Date.parse(observedAt);
  const ageMs = observedMs === null || !Number.isFinite(observedMs) ? null : Math.max(0, capturedAt.getTime() - observedMs);
  return {
    status: ageMs !== null && ageMs <= freshForMs ? "fresh" : "stale",
    source,
    observedAt,
    ageMs,
    complete: ageMs !== null && ageMs <= freshForMs,
  };
}

function freshFact(source: WalletDashboardFactMeta["source"], capturedAt: string): WalletDashboardFactMeta {
  return { status: "fresh", source, observedAt: capturedAt, ageMs: 0, complete: true };
}

function unavailableFact(source: WalletDashboardFactMeta["source"]): WalletDashboardFactMeta {
  return { status: "unavailable", source, observedAt: null, ageMs: null, complete: false };
}

function emptyDashboard(input: { snapshotId: string; capturedAt: string; interval: PolyWalletOverviewInterval; configured: boolean; warnings: WalletDashboardWarning[]; readiness: PolyAccountWalletReadiness }): PolyAccountPortfolioSnapshotOutput {
  const unavailableWallet = unavailableFact("wallet_connection");
  return {
    snapshotId: input.snapshotId,
    capturedAt: input.capturedAt,
    interval: input.interval,
    readiness: input.readiness,
    overview: {
      configured: input.configured,
      connected: false,
      account_kind: null,
      freshness: "read_model",
      address: null,
      interval: input.interval,
      capturedAt: input.capturedAt,
      pol_gas: null,
      usdc_available: null,
      usdc_locked: null,
      usdc_positions_mtm: null,
      usdc_total: null,
      open_orders: null,
      positions_synced_at: null,
      positions_sync_age_ms: null,
      positions_stale: false,
      pnlHistory: [],
      warnings: input.warnings.map(({ code, message }) => ({ code, message })),
    },
    execution: {
      address: "0x0000000000000000000000000000000000000000",
      freshness: "read_model",
      capturedAt: input.capturedAt,
      tradeActivity: undefined,
      live_positions: [],
      live_position_count: null,
      market_groups: [],
      comparisonCoverage: unavailableComparisonCoverage(),
      originCoverage: unavailableOriginCoverage(),
      closed_positions: [],
      closed_position_count: null,
      warnings: input.warnings.map(({ code, message }) => ({ code, message })),
    },
    facts: {
      wallet: unavailableWallet,
      cash: unavailableFact("polygon_balance_snapshot"),
      orders: { ...unavailableFact("local_ledger"), authority: "provisional_local_ledger" },
      positions: { ...unavailableFact("saved_wallet_economics"), actionsAllowed: false, previewLimit: LIVE_PREVIEW_LIMIT },
      history: { ...unavailableFact("saved_wallet_economics"), authority: "saved_wallet_fills_and_outcomes", previewLimit: CLOSED_PREVIEW_LIMIT },
      pnl: unavailableFact("user_pnl_snapshot"),
      activity: unavailableFact("local_ledger"),
      markets: unavailableFact("composite"),
      total: unavailableFact("composite"),
    },
    warnings: input.warnings,
  };
}

function warning(component: WalletDashboardWarning["component"], code: string, message: string): WalletDashboardWarning {
  return { component, code, message };
}

const READ_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  balances_unavailable: "Saved wallet balances could not be read for this snapshot.",
  orders_unavailable: "Saved order facts could not be read for this snapshot.",
  positions_unavailable: "Saved position facts could not be read for this snapshot.",
  history_unavailable: "Saved position history could not be read for this snapshot.",
  daily_trade_counts_unavailable:
    "Saved trading activity could not be read for this snapshot.",
  realized_pnl_unavailable: "Saved realized P/L could not be read for this snapshot.",
  market_exposure_unavailable:
    "Saved market comparison facts could not be read for this snapshot.",
  comparison_coverage_unavailable:
    "Comparison coverage could not be certified from saved facts for this snapshot.",
  pnl_history_unavailable: "Saved P/L history could not be read for this snapshot.",
};

function readFailure(
  component: WalletDashboardWarning["component"],
  code: string,
  _error: unknown
): WalletDashboardWarning {
  return warning(
    component,
    code,
    READ_FAILURE_MESSAGES[code] ??
      "A saved dashboard fact could not be read for this snapshot."
  );
}

function normalizeRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && "rows" in value && Array.isArray((value as { rows?: unknown }).rows)) {
    return (value as { rows: T[] }).rows;
  }
  return [];
}

function nullableSum(...values: Array<number | null>): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length === 0 ? null : roundMoney(observed.reduce((sum, value) => sum + value, 0));
}

function timestampsWithin(left: string | null, right: string | null, maxMs: number): boolean {
  if (left === null || right === null) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= maxMs;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonnegativeInt(value: string | number | null | undefined): number {
  return Math.max(0, Math.trunc(toNumber(value)));
}



function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
