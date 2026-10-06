// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Coherent, bounded, DB-only wallet-dashboard read model. */
import { randomUUID } from "node:crypto";
import type {
  PolyAccountPortfolioSnapshotOutput,
  PolyAccountWalletReadiness,
  PolyWalletOverviewInterval,
  WalletDashboardFactMeta,
  WalletDashboardWarning,
  WalletExecutionPosition,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { readCurrentWalletPositionModel } from "./current-position-read-model";
import {
  buildBoundedMarketExposureGroups,
  materializeComparisonCoverage,
  readFullComparisonCoverageCounts,
  unavailableComparisonCoverage,
} from "./market-exposure-service";
import {
  applyRealizedPnl,
  readWalletTokenPnlMap,
  tokenPnlKey,
} from "./realized-pnl-service";
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

type ClosedRow = {
  closed_position_count: string | number | null;
  condition_key: string | null;
  asset_key: string | null;
  client_order_id: string | null;
  position_lifecycle: string | null;
  observed_at: Date | string | null;
  updated_at: Date | string | null;
  closed_at: string | null;
  title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  outcome: string | null;
  limit_price: string | number | null;
  size_usdc: string | number | null;
  filled_size_usdc: string | number | null;
  token_id: string | null;
};

type DailyCountRow = { day: string | null; n: string | number | null };


export type TenantWalletDashboardReadInput = {
  billingAccountId: string;
  interval: PolyWalletOverviewInterval;
  adapterConfigured: boolean;
  /** Component-test seam; production always uses the persisted balance reader. */
  readBalance?: (db: Db, billingAccountId: string) => Promise<WalletBalanceRead>;
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
  if (!input.adapterConfigured) {
    warnings.push(
      warning(
        "wallet",
        "wallet_adapter_unconfigured",
        "Trading-wallet actions are unavailable on this deployment."
      )
    );
  }

  const connection = await readActiveWalletConnection(db, input.billingAccountId);
  const readiness = walletReadiness(connection, capturedAt);
  const address = connection?.address ?? null;
  if (address === null) {
    warnings.push(warning("wallet", "no_trading_wallet", "No trading wallet is connected."));
    return emptyDashboard({
      snapshotId,
      capturedAt,
      interval: input.interval,
      configured: input.adapterConfigured,
      warnings,
      // A row may exist with an unusable address. Readiness still reports the
      // persisted truth rather than inventing a disconnected wallet.
      readiness,
    });
  }

  const balanceRead = await optionalRead(db, (savepoint) =>
    (input.readBalance ?? readWalletBalanceFact)(savepoint, input.billingAccountId)
  );
  const balance: Exclude<WalletBalanceRead, { kind: "no_wallet" }> =
    balanceRead.ok && balanceRead.value.kind !== "no_wallet"
      ? balanceRead.value
      : { kind: "missing", address };
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
    readOrderSummary(savepoint, input.billingAccountId, capturedAt)
  );
  const positionsRead = await optionalRead(db, (savepoint) =>
    readCurrentWalletPositionModel({ db: savepoint, walletAddress: address, capturedAt: capturedAtDate })
  );
  const closedRead = await optionalRead(db, (savepoint) =>
    readClosedPositionSummary(savepoint, input.billingAccountId, capturedAtDate)
  );
  const dailyRead = await optionalRead(db, (savepoint) =>
    readDailyTradeCounts(savepoint, input.billingAccountId, capturedAtDate)
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

  const positionFact = positionsRead.ok
    ? positionsRead.value.warnings.some((entry) => entry.code === "current_positions_wallet_missing") ||
      !positionsRead.value.summary.hasSuccessfulObservation
      ? unavailableFact("data_api_current_positions")
      : positionsRead.value.summary.identityAmbiguous ||
          positionsRead.value.summary.cursorStatus === "partial"
        ? {
            ...factFromAge(
              "data_api_current_positions",
              positionsRead.value.summary.syncedAt,
              capturedAtDate,
              POSITION_FRESHNESS_MS
            ),
            status: "partial" as const,
            complete: false,
          }
        : positionsRead.value.summary.stale
        ? {
            ...factFromAge(
              "data_api_current_positions",
              positionsRead.value.summary.syncedAt,
              capturedAtDate,
              POSITION_FRESHNESS_MS
            ),
            status: "stale" as const,
            complete: false,
          }
        : factFromAge(
            "data_api_current_positions",
            positionsRead.value.summary.syncedAt ?? capturedAt,
            capturedAtDate,
            POSITION_FRESHNESS_MS
          )
    : unavailableFact("data_api_current_positions");
  if (!positionsRead.ok) {
    warnings.push(readFailure("positions", "positions_unavailable", positionsRead.error));
  } else {
    warnings.push(
      ...positionsRead.value.warnings.map((entry) => ({ component: "positions" as const, ...entry }))
    );
    if (
      positionFact.status !== "unavailable" &&
      positionsRead.value.summary.activeRows > positionsRead.value.positions.length
    ) {
      warnings.push(
        warning(
          "positions",
          "positions_preview_truncated",
          `Showing ${positionsRead.value.positions.length} of ${positionsRead.value.summary.activeRows} open positions.`
        )
      );
    }
  }

  if (!closedRead.ok) warnings.push(readFailure("history", "history_unavailable", closedRead.error));

  const activityFact = dailyRead.ok
    ? freshFact("local_ledger", capturedAt)
    : unavailableFact("local_ledger");
  if (!dailyRead.ok) warnings.push(readFailure("activity", "daily_trade_counts_unavailable", dailyRead.error));

  const cashFact = cashMeta(balance, capturedAtDate);
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

  let livePositions =
    positionsRead.ok && positionFact.status !== "unavailable"
      ? positionsRead.value.positions
      : [];
  let closedPositions = closedRead.ok ? closedRead.value.positions : [];
  // Market exposure needs the vendor snapshot cost basis encoded by the
  // pre-realized-overlay `currentValue - pnlUsd` relation. The display
  // overlay below changes pnlUsd to lifetime realized P/L and must not be
  // fed back into market cost-basis math.
  const marketLivePositions = livePositions;
  const marketClosedPositions = closedPositions;
  const displayedLivePositions = marketLivePositions.slice(
    0,
    LIVE_PREVIEW_LIMIT
  );
  const displayedClosedPositions = marketClosedPositions.slice(
    0,
    CLOSED_PREVIEW_LIMIT
  );
  const displayedKeys = [
    ...new Map(
      [...displayedLivePositions, ...displayedClosedPositions].map(
        (position) => [
          tokenPnlKey(position.conditionId, position.asset),
          { conditionId: position.conditionId, tokenId: position.asset },
        ] as const
      )
    ).values(),
  ];
  const realizedRead = await optionalRead(db, (savepoint) =>
    readWalletTokenPnlMap({ db: savepoint, walletAddress: address, positionKeys: displayedKeys })
  );
  if (realizedRead.ok) {
    livePositions = applyRealizedPnl(livePositions, realizedRead.value);
    closedPositions = applyRealizedPnl(closedPositions, realizedRead.value);
  } else {
    warnings.push(readFailure("pnl", "realized_pnl_unavailable", realizedRead.error));
  }
  if (positionsRead.ok && positionsRead.value.summary.identityAmbiguous) {
    warnings.push(
      warning(
        "pnl",
        "realized_pnl_identity_ambiguous",
        "Per-position realized P/L is best-effort because multiple saved wallet identities share this address."
      )
    );
  }
  const missingRealizedClosedCount = realizedRead.ok
    ? displayedClosedPositions.filter(
        (position) =>
          !realizedRead.value.has(
            tokenPnlKey(position.conditionId, position.asset)
          )
      ).length
    : 0;
  if (realizedRead.ok && missingRealizedClosedCount > 0) {
    warnings.push(
      warning(
        "pnl",
        "realized_pnl_incomplete",
        `Realized P/L is missing for ${missingRealizedClosedCount} displayed closed position${missingRealizedClosedCount === 1 ? "" : "s"}; history remains partial.`
      )
    );
  }
  const historyFact = !closedRead.ok
    ? unavailableFact("local_ledger")
    : positionsRead.ok &&
        !positionsRead.value.summary.identityAmbiguous &&
        realizedRead.ok &&
        missingRealizedClosedCount === 0
      ? freshFact("local_ledger", capturedAt)
      : {
          ...freshFact("local_ledger", capturedAt),
          status: "partial" as const,
          complete: false,
        };

  const marketRead =
    positionFact.status === "unavailable"
      ? ({
          ok: false,
          error: new Error("Current-position authority is unavailable."),
        } as const)
      : await optionalRead(db, (savepoint) =>
          buildBoundedMarketExposureGroups({
            db: savepoint,
            billingAccountId: input.billingAccountId,
            walletAddress: address,
            livePositions: marketLivePositions,
            closedPositions: marketClosedPositions,
          })
        );
  const coverageRead =
    positionFact.status === "unavailable"
      ? ({
          ok: false,
          error: new Error("Current-position authority is unavailable."),
        } as const)
      : await optionalRead(db, (savepoint) =>
          readFullComparisonCoverageCounts({
            db: savepoint,
            billingAccountId: input.billingAccountId,
            walletAddress: address,
          })
        );
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
      (positionsRead.ok &&
        positionsRead.value.summary.activeRows > livePositions.length) ||
      (closedRead.ok && closedRead.value.count > closedPositions.length))
  ) {
    marketRead.value.truncated = true;
    warnings.push(warning("markets", "market_exposure_preview_truncated", "Market comparison is a bounded preview; exact position counts remain available separately."));
  }
  const comparisonCoverage = !marketRead.ok || !coverageRead.ok
    ? unavailableComparisonCoverage()
    : materializeComparisonCoverage({
        counts: coverageRead.value,
        groups: marketRead.value.groups,
        livePositions: livePositions.slice(0, LIVE_PREVIEW_LIMIT),
        closedPositions: closedPositions.slice(0, CLOSED_PREVIEW_LIMIT),
        sourceComplete:
          positionFact.status === "fresh" &&
          positionFact.complete &&
          historyFact.status === "fresh" &&
          historyFact.complete,
        previewTruncated: marketRead.value.truncated,
      });
  const comparisonCoverageUnavailable = Object.values(
    comparisonCoverage
  ).some((byStatus) =>
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

  const cashOnChain = balance.kind === "available"
    ? nullableSum(balance.usdcE, balance.pusd)
    : null;
  const lockedUsdc = orderRead.ok && orderRead.value.lockedUsdc !== null
    ? roundMoney(orderRead.value.lockedUsdc)
    : null;
  const availableUsdc = cashOnChain !== null && lockedUsdc !== null
    ? roundMoney(Math.max(0, cashOnChain - lockedUsdc))
    : null;
  const positionsMtm = positionsRead.ok && positionFact.status !== "unavailable"
    ? roundMoney(positionsRead.value.summary.positionsMtm)
    : null;
  const totalCoherent =
    cashOnChain !== null &&
    positionsMtm !== null &&
    cashFact.complete &&
    positionFact.complete &&
    timestampsWithin(cashFact.observedAt, positionFact.observedAt, MAX_FACT_SKEW_MS);
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
      configured: input.adapterConfigured,
      connected: true,
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
      positions_synced_at: positionsRead.ok ? positionsRead.value.summary.syncedAt : null,
      positions_sync_age_ms: positionsRead.ok ? positionsRead.value.summary.syncAgeMs : null,
      positions_stale: positionFact.status !== "fresh",
      pnlHistory: pnlRead.ok && pnlRead.value.status === "available" ? pnlRead.value.points : [],
      warnings: warnings
        .filter((entry) => entry.component !== "activity" && entry.component !== "markets" && entry.component !== "history")
        .map(({ code, message }) => ({ code, message })),
    },
    execution: {
      address,
      freshness: "read_model",
      capturedAt,
      dailyTradeCounts: dailyRead.ok ? dailyRead.value : [],
      live_positions: livePositions.slice(0, LIVE_PREVIEW_LIMIT),
      live_position_count:
        positionsRead.ok && positionFact.status !== "unavailable"
          ? positionsRead.value.summary.activeRows
          : null,
      market_groups: marketRead.ok ? marketRead.value.groups : [],
      comparisonCoverage,
      closed_positions: closedPositions.slice(0, CLOSED_PREVIEW_LIMIT),
      closed_position_count: closedRead.ok ? closedRead.value.count : null,
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
          input.adapterConfigured &&
          positionFact.status === "fresh" &&
          positionFact.complete,
        previewLimit: LIVE_PREVIEW_LIMIT,
      },
      history: {
        ...historyFact,
        authority: "provisional_local_ledger",
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
  /** Null when the row exists but its stored address is unusable. */
  address: `0x${string}` | null;
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
    trading_approvals_ready_at: Date | string | null;
    auto_wrap_consent_at: Date | string | null;
    auto_wrap_revoked_at: Date | string | null;
    auto_wrap_floor_usdce_6dp: string | number | null;
  }>(await db.execute(sql`
    SELECT
      lower(COALESCE(funder_address, address)) AS address,
      trading_approvals_ready_at,
      auto_wrap_consent_at,
      auto_wrap_revoked_at,
      auto_wrap_floor_usdce_6dp
    FROM poly_wallet_connections
    WHERE billing_account_id = ${billingAccountId}
      AND revoked_at IS NULL
    ORDER BY created_at DESC
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
  _capturedAt: string
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
              - CASE WHEN f.attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
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
              COALESCE(f.attributes->>'filled_size_usdc', '') <> ''
              AND f.attributes->>'filled_size_usdc' !~ '^[0-9]+(\\.[0-9]+)?$'
            )
          )
      )::int AS malformed_buy_rows
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${billingAccountId}
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

/** @internal Exported only for SQL-versus-pure component parity coverage. */
export async function readClosedPositionSummary(
  db: ExecuteDb,
  billingAccountId: string,
  capturedAt: Date
): Promise<{ count: number; positions: WalletExecutionPosition[] }> {
  const rows = normalizeRows<ClosedRow>(await db.execute(sql`
    WITH keyed AS (
      SELECT
        lower(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), ''),
          f.fill_id
        )) AS condition_key,
        COALESCE(NULLIF(f.attributes->>'token_id', ''), f.client_order_id) AS asset_key,
        f.client_order_id,
        f.position_lifecycle,
        f.observed_at,
        f.updated_at,
        f.attributes->>'closed_at' AS closed_at,
        f.attributes->>'title' AS title,
        f.attributes->>'event_title' AS event_title,
        COALESCE(f.attributes->>'market_slug', f.attributes->>'slug') AS market_slug,
        f.attributes->>'event_slug' AS event_slug,
        f.attributes->>'outcome' AS outcome,
        NULLIF(f.attributes->>'limit_price', '')::numeric AS limit_price,
        NULLIF(f.attributes->>'size_usdc', '')::numeric AS size_usdc,
        NULLIF(f.attributes->>'filled_size_usdc', '')::numeric AS filled_size_usdc,
        f.attributes->>'token_id' AS token_id,
        ROW_NUMBER() OVER (
          PARTITION BY
            lower(COALESCE(NULLIF(f.attributes->>'condition_id', ''), NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), ''), f.fill_id)),
            COALESCE(NULLIF(f.attributes->>'token_id', ''), f.client_order_id)
          ORDER BY f.observed_at DESC, f.updated_at DESC, f.client_order_id DESC
        ) AS tuple_rank
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${billingAccountId}
    ), terminal AS (
      SELECT * FROM keyed
      WHERE tuple_rank = 1
        AND position_lifecycle IN ('closed', 'redeemed', 'loser', 'dust')
    ), preview AS (
      SELECT * FROM terminal
      ORDER BY COALESCE(NULLIF(closed_at, '')::timestamptz, observed_at) DESC,
        condition_key, asset_key
      LIMIT ${CLOSED_PREVIEW_LIMIT}
    )
    SELECT (SELECT COUNT(*)::int FROM terminal) AS closed_position_count, preview.*
    FROM (SELECT 1) seed
    LEFT JOIN preview ON TRUE
    ORDER BY
      COALESCE(NULLIF(preview.closed_at, '')::timestamptz, preview.observed_at) DESC NULLS LAST,
      preview.condition_key,
      preview.asset_key
  `));
  return {
    count: nonnegativeInt(rows[0]?.closed_position_count),
    positions: rows.flatMap((row) => closedRowToPosition(row, capturedAt)),
  };
}

async function readDailyTradeCounts(db: ExecuteDb, billingAccountId: string, capturedAt: Date) {
  const windowEnd = new Date(capturedAt);
  windowEnd.setUTCHours(0, 0, 0, 0);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - 14);
  const rows = normalizeRows<DailyCountRow>(await db.execute(sql`
    SELECT
      to_char(date_trunc('day', f.observed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS n
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${billingAccountId}
      AND f.observed_at >= ${windowStart.toISOString()}::timestamptz
      AND f.observed_at < ${windowEnd.toISOString()}::timestamptz
      AND (
        CASE WHEN f.attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN (f.attributes->>'filled_size_usdc')::numeric ELSE 0 END > 0
        OR (
          f.status IN ('filled', 'partial')
          AND CASE WHEN f.attributes->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (f.attributes->>'size_usdc')::numeric ELSE 0 END > 0
        )
      )
    GROUP BY 1
    ORDER BY 1
  `));
  const byDay = new Map(rows.map((row) => [row.day ?? "", nonnegativeInt(row.n)]));
  return Array.from({ length: 14 }, (_, index) => {
    const day = new Date(capturedAt);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - (13 - index));
    const key = day.toISOString().slice(0, 10);
    return { day: key, n: byDay.get(key) ?? 0 };
  });
}

function closedRowToPosition(row: ClosedRow, capturedAt: Date): WalletExecutionPosition[] {
  if (row.condition_key === null || row.asset_key === null || row.client_order_id === null) return [];
  const observedAt = toIso(row.observed_at) ?? capturedAt.toISOString();
  const closedAt = toIso(row.closed_at) ?? toIso(row.updated_at) ?? observedAt;
  const price = Math.max(0, toNumber(row.limit_price));
  const notional = Math.max(0, toNumber(row.filled_size_usdc) || toNumber(row.size_usdc));
  const size = price > 0 ? notional / price : notional;
  const eventSlug = nonEmpty(row.event_slug);
  const marketSlug = nonEmpty(row.market_slug);
  return [{
    positionId: `${row.condition_key}:${row.asset_key}`,
    conditionId: row.condition_key.toLowerCase(),
    asset: row.token_id ?? row.asset_key,
    marketTitle: nonEmpty(row.title) ?? "Polymarket",
    eventTitle: nonEmpty(row.event_title) ?? null,
    marketSlug: marketSlug ?? null,
    eventSlug: eventSlug ?? null,
    marketUrl: eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`
      : marketSlug
        ? `https://polymarket.com/market/${encodeURIComponent(marketSlug)}`
        : null,
    outcome: nonEmpty(row.outcome) ?? "UNKNOWN",
    status: "closed",
    lifecycleState: row.position_lifecycle as WalletExecutionPosition["lifecycleState"],
    openedAt: observedAt,
    closedAt,
    resolvesAt: null,
    gameStartTime: null,
    heldMinutes: Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(observedAt)) / 60_000)),
    entryPrice: price,
    currentPrice: price,
    size: roundPrecision(size, 4),
    currentValue: 0,
    pnlUsd: roundMoney(-notional),
    pnlPct: notional > 0 ? -100 : 0,
    syncedAt: toIso(row.updated_at),
    syncAgeMs: Math.max(0, capturedAt.getTime() - (Date.parse(toIso(row.updated_at) ?? observedAt))),
    syncStale: false,
    timeline: [],
    events: [
      { ts: observedAt, kind: "entry", price, shares: size },
      { ts: closedAt, kind: "close", price, shares: size },
    ],
  }];
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
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: null,
      market_groups: [],
      comparisonCoverage: unavailableComparisonCoverage(),
      closed_positions: [],
      closed_position_count: null,
      warnings: input.warnings.map(({ code, message }) => ({ code, message })),
    },
    facts: {
      wallet: unavailableWallet,
      cash: unavailableFact("polygon_balance_snapshot"),
      orders: { ...unavailableFact("local_ledger"), authority: "provisional_local_ledger" },
      positions: { ...unavailableFact("data_api_current_positions"), actionsAllowed: false, previewLimit: LIVE_PREVIEW_LIMIT },
      history: { ...unavailableFact("local_ledger"), authority: "provisional_local_ledger", previewLimit: CLOSED_PREVIEW_LIMIT },
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

function readFailure(component: WalletDashboardWarning["component"], code: string, error: unknown): WalletDashboardWarning {
  return warning(component, code, error instanceof Error ? error.message : String(error));
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

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPrecision(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
