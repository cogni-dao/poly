// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/paper-fact-source`
 * Purpose: The second fact source for `poly_trader_*`. Projects a paper
 *   account's simulated trading into the SAME tables the Data-API observer
 *   writes — `poly_trader_fills`, `poly_trader_position_snapshots`,
 *   `poly_trader_current_positions` — plus the tenant's
 *   `poly_wallet_balance_snapshots` NAV row, so every existing DB-only reader
 *   works unchanged with no paper-specific branch.
 *
 *   Also owns the READ-BACK of those facts on the trading hot path
 *   (`readPaperAccountPositionFacts` / `readPaperAccountNavUsdc`): how a paper
 *   account's own open book and NAV reach the sizing policy and the SELL-close
 *   path. Writer and reader live together on purpose — the reader's safety
 *   depends on the cursor and withholding semantics the writer establishes, and
 *   splitting them is how the two drift.
 * Scope: Feature service. Caller injects the DB handle, the logger, and the
 *   mid-price reader, and owns the statement timeout. Each account observation
 *   owns a transaction/savepoint for atomic facts, NAV and prospective P/L. Does not
 *   construct clients, read env, or schedule itself.
 * Invariants:
 *   - SAME_TABLES_NOT_A_MIRROR (migration 0083): paper writes the existing
 *     fact tables under `poly_trader_wallets.kind = 'paper_wallet'` and
 *     `poly_trader_fills.source = 'paper-ledger'`. A parallel
 *     `poly_paper_trader_*` table set is forbidden — it would be a second
 *     reader code path, which is the bug 0082/0083 exist to remove.
 *   - LEDGER_IS_THE_AUTHORITY: a paper account has no chain presence, so the
 *     Polygon CTF `balanceOfBatch` authority (`PositionBalanceBatchReader`) is
 *     never consulted on this path and `authority_unavailable` is never
 *     produced. Closure is DERIVED (`net_shares <= 0`), not inferred from an
 *     upstream omission, so the question the authority answers — "did this
 *     position really close, or did the Data-API just drop it?" — cannot arise.
 *     Reusing the live path here would have reported `authority_unavailable`
 *     for every paper tick and blocked publication entirely.
 *   - PROJECT_ONLY_TERMINAL_REALIZED: only ledger rows whose `status` is
 *     terminal (`filled` / `canceled` / `error`) AND which carry realized
 *     `price` + `shares` are projected. A resting `pending`/`open`/`partial`
 *     row's realized portion can still grow, and `poly_trader_fills` is an
 *     append-only immutable-event table with an `ON CONFLICT DO NOTHING`
 *     writer plus an additive `(created_at, id)`-watermarked rollup
 *     accumulator — projecting a mutable row would freeze its first-seen size
 *     and silently desynchronise `poly_trader_fill_rollups_daily`.
 *   - NO_FABRICATED_VALUES (docs/spec/capability-plane.md): an open position
 *     whose mark cannot be read is NOT marked to 0. A prior authoritative mark
 *     may be reused only inside its explicit freshness bound (settlement 0/1 is
 *     immutable); otherwise the position cursor records `partial` and any prior
 *     NAV row is removed in the same transaction. A withheld NAV reads as
 *     `missing`, which is true, instead of `available` at an invented number.
 *   - MARKED_AT_THE_AUTHORITATIVE_PRICE: only *execution* is simulated. A
 *     trading position is marked at the real CLOB midpoint; after settlement,
 *     when no order book exists, it is marked from the CLOB's unique winner
 *     fact (1/0). Missing or contradictory evidence stays unavailable. This is
 *     a writer, not a render path, so the upstream read does not violate
 *     PAGE_LOAD_DB_ONLY / SAVED_FACTS_ONLY.
 *   - NAV_IS_CASH_PLUS_MARKS: `seed − bought + sold − fees + Σ(shares × mid)`.
 *     The seed comes from `poly_wallet_connections.paper_seed_usdc`
 *     (PAPER_SEED_DECLARED, migration 0082); nothing here defaults or infers
 *     a starting balance.
 *   - AGGREGATES_IN_SQL (bug.5012): the fills projection is a single
 *     `INSERT … SELECT` — zero ledger rows enter V8 — and the position rollup
 *     is a `GROUP BY (condition_id, token_id)` returning one row per position,
 *     never one row per fill.
 *   - EXPLICIT_TENANT_FILTER: `poly_trader_*` carry no tenant FK and therefore
 *     no RLS; the capability plane is their only clamp. Every statement below
 *     binds `trader_wallet_id` and/or `billing_account_id` explicitly. There
 *     is no database backstop behind these queries.
 *   - READS_THE_PROJECTION_NEVER_REAGGREGATES: the read-back returns the rows
 *     this module wrote. It does not re-run the ledger `GROUP BY` — a second
 *     aggregation would be a second answer to "what does this account hold",
 *     and the two would diverge exactly when it mattered (one marked at a mid,
 *     the other not).
 *   - FRESHNESS_IS_A_PRECONDITION: the read-back refuses when the position
 *     cursor is absent (`never_projected`), not `ok` (`projection_incomplete`),
 *     or older than `PAPER_FACTS_MAX_STALENESS_MS` (`projection_stale`). An
 *     empty book is only ever returned when a complete, recent tick proves the
 *     account holds nothing. This is the read-side half of
 *     NO_FABRICATED_VALUES: the writer withholds rather than invents, so the
 *     reader must refuse rather than substitute — a stale or short book
 *     under-reports exposure, which is the same bug the hardcoded `0` was.
 *   - DERIVED_ADDRESS_IS_CROSS_CHECKED: the synthetic address is recomputed
 *     from the billing account and compared to the stored row; a mismatch
 *     skips the account loudly rather than observing an address that two
 *     derivations disagree on (the live-path drift OBSERVE_WHAT_THE_EXECUTOR_
 *     SIGNS_FROM was written for).
 * Side-effects: IO — DB reads/writes through the injected handle, plus a
 *   bounded cursor-resumed window of CLOB mark reads.
 * Links: docs/spec/capability-plane.md, docs/spec/poly-copy-trade-execution.md,
 *   migration 0082, migration 0083
 * @public
 */

import { createHash } from "node:crypto";
import {
  polyWalletBalanceSnapshots,
  polyWalletConnections,
} from "@cogni/db-schema/wallet-connections";
import {
  type LoggerPort,
  normalizePositionIdentity,
  positionIdentityKey,
} from "@cogni/poly-market-provider";
import {
  polyTraderCurrentPositions,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { type SQL, and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { derivePaperAccountAddress } from "@/features/paper-accounts";
import { FILL_NOTIONAL_TOLERANCE, FILL_SHARE_TOLERANCE } from "@/features/trading/fill-accounting";
import { fillNumericSql, paperFillAccountingSql } from "@/features/trading/fill-accounting-sql";
import { EVENT_NAMES } from "@/shared/observability/events";
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";
import { persistWalletBalanceFact } from "./wallet-balance-snapshot-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/**
 * `poly_trader_wallets.kind` for a paper account (migration 0083).
 *
 * KIND_ROUTES_THE_OBSERVER: this is the single field the observation tick
 * branches on, and it is also what keeps the two retirement sweeps disjoint —
 * `disableMissingTenantWallets` filters `kind = 'cogni_wallet'` and so cannot
 * retire a paper wallet, while {@link retireMissingPaperWallets} filters this
 * value and cannot retire a live one.
 */
export const PAPER_WALLET_KIND = "paper_wallet";

/** `poly_trader_fills.source` for a projected paper fill (migration 0083). */
export const PAPER_FILL_SOURCE = "paper-ledger";

/** `poly_trader_ingestion_cursors.source` for the fills projection. */
export const PAPER_TRADE_CURSOR_SOURCE = "paper-ledger-trades";

/** `poly_trader_ingestion_cursors.source` for the position projection. */
export const PAPER_POSITION_CURSOR_SOURCE = "paper-ledger-positions";

/**
 * Maximum public mark reads one paper account may issue in a projection tick.
 *
 * A historical paper ledger can contain thousands of still-open aggregates.
 * Reading all of them serially made every tick restart at the same prefix and
 * hit the job timeout before it could publish a complete book. The durable
 * position cursor rotates this bounded window until the whole book converges.
 */
export const PAPER_MARK_REFRESH_LIMIT_PER_TICK = 100;

/**
 * A real, previously acquired live-market mark may bridge short CLOB read
 * failures, but never indefinitely. Ten minutes matches the dashboard's live
 * wallet-balance freshness contract and lets a 100-mark/30s bounded projector
 * converge a 2,000-position historical book. Settlement marks (exactly 0 or
 * 1) are immutable and therefore do not expire.
 */
export const PAPER_OPEN_MARK_MAX_AGE_MS = 600_000;

/**
 * Label on the enrolled wallet row. Distinct from the live
 * `"Tenant trading wallet"` label so the two populations are legible in the
 * observed-wallet list, but — unlike the live sweep — nothing *routes* on it.
 */
export const PAPER_TRADER_WALLET_LABEL = "Paper trading account";

/**
 * Ledger statuses whose realized `price`/`shares` are frozen.
 * Accepted final receipts freeze cumulative execution. A status-only error
 * does not establish finality and stays in current observation coverage.
 */
const TERMINAL_LEDGER_STATUSES = ["filled", "canceled"] as const;

/**
 * `(…)` list for the status predicate, each value bound as a parameter.
 * A module constant, but bound rather than inlined so the shape stays
 * injection-proof if the list ever becomes caller-supplied.
 */
function terminalStatusList() {
  return sql`(${sql.join(
    TERMINAL_LEDGER_STATUSES.map((status) => sql`${status}`),
    sql`, `
  )})`;
}

/**
 * Overlap applied to the projection watermark. The watermark advances to
 * `max(updated_at)` of the rows projected, but a concurrently-committing
 * transaction can land a row with an *earlier* `updated_at` than one already
 * projected, which a strict `>` watermark would skip forever. Re-reading a
 * minute of already-projected rows is free: the writer is
 * `ON CONFLICT DO NOTHING` on `(trader_wallet_id, source, native_id)`.
 */
const PROJECTION_WATERMARK_OVERLAP_MS = 60_000;

/** Scale of every USDC-denominated numeric column written here. */
const USDC_SCALE = 8;

/**
 * Reads the current authoritative mark for one CTF token: live midpoint or
 * last actual venue trade in `(0, 1)`, or a proven settlement value in
 * `{0, 1}`. Returns `null` when none can be read.
 *
 * `null` means UNKNOWN and is never coerced to 0 — see NO_FABRICATED_VALUES.
 * Production binds `PolymarketClobPublicClient.getMarkPrice`; the historical
 * type name is retained to avoid churn in injected test readers.
 */
export type PaperMidPriceReader = (
  tokenId: string,
  signal?: AbortSignal,
  conditionId?: string
) => Promise<number | null>;

/** One active paper account, as the observation tick needs it. */
export type PaperAccount = {
  billingAccountId: string;
  /** The synthetic deterministic address, lowercased. */
  address: `0x${string}`;
  /** `paper_seed_usdc`, verbatim as a fixed-point string. */
  seedUsdc: string;
};

/** An enrolled paper wallet joined to the account it belongs to. */
export type EnrolledPaperWallet = {
  traderWalletId: string;
  account: PaperAccount;
};

export type PaperObservationResult = {
  /** Ledger rows newly projected into `poly_trader_fills`. */
  fills: number;
  /** `poly_trader_current_positions` rows written this tick. */
  positions: number;
  /** Open positions whose mid price could not be read (NAV withheld). */
  unpricedPositions: number;
  /** Whether the NAV row was published this tick. */
  navPublished: boolean;
  /** Public mark calls made during this tick. */
  marksAttempted: number;
  /** Mark calls that returned an authoritative value. */
  marksRefreshed: number;
  /** Prior real marks reused inside their declared freshness bound. */
  marksReused: number;
};

/**
 * Every active paper account, keyed for enrollment.
 *
 * Reads `poly_wallet_connections` directly rather than going through
 * `PolyTraderWalletPort`. That is NOT a second derivation of the kind
 * OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM forbids: a live row's trading identity
 * is ambiguous (signer EOA vs V2 funder, which is why the port must own it),
 * whereas a paper row's address has exactly one definition —
 * `derivePaperAccountAddress(billingAccountId)`, a pure function. We recompute
 * it and assert agreement with the stored row, so this path cannot drift onto
 * a different address than the one `provisionPaperAccount` wrote; it can only
 * fail loudly.
 *
 * Carries an explicit `kind = 'paper'` filter, so it can never return a live
 * connection even though both kinds now share the table
 * (KIND_IS_THE_DISCRIMINATOR, migration 0082).
 */
export async function readActivePaperAccounts(
  db: Db,
  logger: LoggerPort
): Promise<readonly PaperAccount[]> {
  const rows = await db
    .select({
      billingAccountId: polyWalletConnections.billingAccountId,
      address: polyWalletConnections.address,
      funderAddress: polyWalletConnections.funderAddress,
      paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
    })
    .from(polyWalletConnections)
    .where(
      and(
        eq(polyWalletConnections.kind, "paper"),
        isNull(polyWalletConnections.revokedAt)
      )
    );

  return rows.flatMap((row) => {
    const expected = derivePaperAccountAddress(row.billingAccountId);
    const stored = row.address.toLowerCase();
    if (stored !== expected) {
      logger.error(
        {
          event: EVENT_NAMES.POLY_PAPER_ACCOUNT_ADDRESS_MISMATCH,
          errorCode: "paper_account_address_mismatch",
          billing_account_id: row.billingAccountId,
          stored_address: stored,
          derived_address: expected,
        },
        "paper account address does not match its derivation — refusing to observe it"
      );
      return [];
    }
    // The funder is the trading identity every live reader drives from
    // (`readWalletBalanceFact` joins on `lower(funder_address)`), so a paper
    // row whose funder disagrees with its address would publish a NAV the
    // dashboard cannot find. Fail closed rather than pick one.
    if ((row.funderAddress ?? "").toLowerCase() !== expected) {
      logger.error(
        {
          event: EVENT_NAMES.POLY_PAPER_ACCOUNT_FUNDER_MISMATCH,
          errorCode: "paper_account_funder_mismatch",
          billing_account_id: row.billingAccountId,
          funder_address: row.funderAddress,
          derived_address: expected,
        },
        "paper account funder_address does not match its derivation — refusing to observe it"
      );
      return [];
    }
    // PAPER_SEED_DECLARED (migration 0082) makes this non-null for every paper
    // row at the DB level. If it is somehow null we cannot compute a NAV and
    // must not invent a starting balance.
    if (row.paperSeedUsdc === null) {
      logger.error(
        {
          event: EVENT_NAMES.POLY_PAPER_ACCOUNT_SEED_MISSING,
          errorCode: "paper_account_seed_missing",
          billing_account_id: row.billingAccountId,
        },
        "paper account has no declared seed balance — refusing to observe it"
      );
      return [];
    }
    return [
      {
        billingAccountId: row.billingAccountId,
        address: expected,
        seedUsdc: row.paperSeedUsdc,
      },
    ];
  });
}

/**
 * Enroll every active paper account as an observed wallet and retire the ones
 * that are gone. Returns the enrolled set keyed by `poly_trader_wallets.id`,
 * because the wallet row carries no `billing_account_id` and the projection
 * needs the tenant + seed to do anything.
 *
 * ENROLLMENT_FAILURE_IS_NOT_A_WIPE, strengthened: an EMPTY account list
 * retires nothing at all. The live `disableMissingTenantWallets` treats empty
 * as "retire every tenant wallet", which makes a transient reader outage
 * indistinguishable from a genuine mass-revoke. A revoked paper account is
 * retired on the next tick that reads a non-empty list, and in the meantime an
 * over-retained paper wallet is harmless (its projection is idempotent) while
 * an over-retired one loses the dashboard.
 */
export async function syncPaperTraderWallets(
  db: Db,
  accounts: readonly PaperAccount[],
  now = new Date()
): Promise<readonly EnrolledPaperWallet[]> {
  if (accounts.length === 0) return [];

  const enrolled = await db
    .insert(polyTraderWallets)
    .values(
      accounts.map((account) => ({
        walletAddress: account.address,
        kind: PAPER_WALLET_KIND,
        label: PAPER_TRADER_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
        createdAt: now,
      }))
    )
    .onConflictDoUpdate({
      target: polyTraderWallets.walletAddress,
      set: {
        kind: PAPER_WALLET_KIND,
        label: PAPER_TRADER_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
      },
    })
    .returning({
      id: polyTraderWallets.id,
      walletAddress: polyTraderWallets.walletAddress,
    });

  await retireMissingPaperWallets(
    db,
    accounts.map((account) => account.address),
    now
  );

  // Key type widened to plain `string` deliberately. The values keep their
  // branded `0x${string}` address because `derivePaperAccountAddress` COMPUTED
  // it — that brand means "derived, not read". `row.walletAddress` comes back
  // from Postgres as a plain string, and casting it to the branded type here
  // would assert exactly the thing this module cannot know at that point, and
  // which DERIVED_ADDRESS_IS_CROSS_CHECKED already verifies at runtime instead.
  // This Map is an internal lookup index; its key carries no guarantee.
  const byAddress = new Map<string, PaperAccount>(
    accounts.map((account) => [account.address, account])
  );
  return enrolled.flatMap((row) => {
    const account = byAddress.get(row.walletAddress.toLowerCase());
    return account ? [{ traderWalletId: row.id, account }] : [];
  });
}

/**
 * Deactivate paper wallets whose account is no longer active.
 *
 * Filters `kind = PAPER_WALLET_KIND`, so this sweep is structurally incapable
 * of touching a `cogni_wallet` or `copy_target` row — the mirror of the
 * guarantee `disableMissingTenantWallets` gives in the other direction. Caller
 * guarantees a non-empty address list (see {@link syncPaperTraderWallets}).
 */
async function retireMissingPaperWallets(
  db: Db,
  activeAddresses: readonly string[],
  now: Date
): Promise<void> {
  if (activeAddresses.length === 0) return;
  await db
    .update(polyTraderWallets)
    .set({ activeForResearch: false, disabledAt: now, updatedAt: now })
    .where(
      and(
        eq(polyTraderWallets.kind, PAPER_WALLET_KIND),
        isNull(polyTraderWallets.disabledAt),
        notInArray(polyTraderWallets.walletAddress, [...activeAddresses])
      )
    );
}

/**
 * One account-scoped SQL authority for current paper inventory and finance.
 * No raw ledger/fill rows leave SQL. Immutable terminal events are authenticated
 * against the accepted ledger tuple; cumulative nonterminal facts never become
 * append-only events. The cutoff includes proof time, not just trade time.
 */
export function paperAccountingCtes(input: {
  billingAccountId: string;
  walletIds: SQL;
  capturedAt: SQL;
  enabled?: boolean;
}): SQL {
  const proof = paperFillAccountingSql("f", input.capturedAt);
  return sql`
    paper_ledger AS MATERIALIZED (
      SELECT f.*, ${proof.positive} AS proof_positive,
        ${proof.verified} AS proof_verified, ${proof.feeKnown} AS proof_fee_known,
        ${proof.observedAt} AS proof_observed_at
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${input.billingAccountId}
        AND f.mode = 'paper' AND ${input.enabled !== false}
    ), paper_projected AS MATERIALIZED (
      SELECT p.*, l.client_order_id AS bound_client_order_id,
        COALESCE(l.proof_positive AND l.status IN ('filled', 'canceled')
          AND p.native_id = l.target_id::text || ':' || l.fill_id
          AND p.raw->'paper_ledger'->>'client_order_id' = l.client_order_id
          AND p.raw->'paper_ledger'->>'order_id' = l.order_id
          AND lower(p.condition_id) = l.attributes->'paper_receipt_v1'->>'condition_id'
          AND p.token_id = l.attributes->>'token_id' AND p.side = l.attributes->>'side'
          AND abs(p.shares - l.shares) <= ${FILL_SHARE_TOLERANCE}::numeric
          AND p.price = l.price
          AND abs(p.size_usdc - ${fillNumericSql(sql`l.attributes->>'filled_size_usdc'`)})
            <= greatest(${FILL_NOTIONAL_TOLERANCE}::numeric, abs(p.size_usdc) * ${FILL_NOTIONAL_TOLERANCE}::numeric)
          AND p.observed_at <= ${input.capturedAt}, false) AS authenticated,
        l.proof_observed_at
      FROM poly_trader_fills p
      LEFT JOIN paper_ledger l
        ON p.native_id = l.target_id::text || ':' || l.fill_id
      WHERE p.trader_wallet_id IN (${input.walletIds})
        AND p.source = 'paper-ledger' AND ${input.enabled !== false}
    ), paper_inventory_facts AS MATERIALIZED (
      /* Authentication gates availability at proof time; it cannot move an
         immutable trade's entry/exit time when only its fee proof improves. */
      (SELECT DISTINCT ON (native_id) lower(condition_id) AS condition_id, token_id, side, price, shares,
        size_usdc, observed_at
      FROM paper_projected WHERE authenticated
      ORDER BY native_id, observed_at DESC, id)
      UNION ALL
      SELECT f.attributes->'paper_receipt_v1'->>'condition_id',
        f.attributes->>'token_id', f.attributes->>'side', f.price, f.shares,
        ${fillNumericSql(sql`f.attributes->'paper_receipt_v1'->>'notional_usdc'`)},
        f.proof_observed_at
      FROM paper_ledger f
      WHERE f.proof_positive AND f.status NOT IN ('filled', 'canceled')
        AND NOT EXISTS (SELECT 1 FROM paper_projected p
          WHERE p.native_id = f.target_id::text || ':' || f.fill_id)
    ), paper_position_fees AS MATERIALIZED (
      SELECT attributes->'paper_receipt_v1'->>'condition_id' AS condition_id,
        attributes->>'token_id' AS token_id, sum(fees_usdc) AS fees_usdc
      FROM paper_ledger WHERE proof_verified AND proof_fee_known
      GROUP BY attributes->'paper_receipt_v1'->>'condition_id', attributes->>'token_id'
    ), paper_coverage_counts AS MATERIALIZED (
      SELECT
        (SELECT count(*) FROM paper_ledger WHERE NOT proof_verified) AS invalid_receipts,
        (SELECT count(*) FROM paper_ledger WHERE proof_positive
          AND status NOT IN ('filled', 'canceled')) AS partial_receipts,
        (SELECT count(*) FROM paper_ledger f WHERE f.proof_positive
          AND f.status IN ('filled', 'canceled') AND NOT EXISTS (
            SELECT 1 FROM paper_projected p WHERE p.authenticated
              AND p.native_id = f.target_id::text || ':' || f.fill_id
          )) AS missing_projections,
        (SELECT count(*) FROM paper_projected WHERE NOT authenticated) AS conflicting_projections,
        (SELECT count(*) FROM paper_ledger WHERE proof_verified AND NOT proof_fee_known) AS unknown_fees,
        (SELECT COALESCE(sum(fees_usdc) FILTER (WHERE proof_fee_known), 0)
          FROM paper_ledger WHERE proof_verified) AS fees_usdc,
        (SELECT max(proof_observed_at) FROM paper_ledger) AS latest_proof_at
    ), paper_coverage AS MATERIALIZED (
      SELECT *, invalid_receipts + missing_projections + conflicting_projections = 0 AS inventory_complete,
        invalid_receipts + missing_projections + conflicting_projections + partial_receipts + unknown_fees = 0 AS finance_complete
      FROM paper_coverage_counts
    )`;
}

/**
 * Project the tenant's terminal, realized paper ledger rows into
 * `poly_trader_fills`.
 *
 * One statement, `INSERT … SELECT`: no ledger row is ever hydrated into V8
 * (AGGREGATES_IN_SQL). The scan is bounded by one tenant's own ledger via the
 * leading `billing_account_id` predicate — served by
 * `poly_copy_trade_fills_pnl_idx (billing_account_id, target_id, market_id,
 * mode, status)` — and further narrowed by the `updated_at` watermark, so it
 * does not grow into the cross-wallet unbounded scan of bug.5012.
 *
 * `native_id` is `"<target_id>:<fill_id>"`. The ledger's PK is
 * `(billing_account_id, target_id, fill_id)` and `billing_account_id` is
 * already implied by the wallet, so that pair is the natural per-wallet
 * identity and makes the `(trader_wallet_id, source, native_id)` unique index
 * the idempotence gate.
 *
 * `side` and `token_id` come from `attributes` JSONB: the ledger has no such
 * columns (`market_id` is the conditionId). Rows missing either, or whose side
 * is not exactly BUY/SELL, are skipped — the `poly_trader_fills` CHECKs would
 * reject them anyway, and guessing a side is unthinkable.
 */
export async function projectPaperFills(input: {
  db: Db;
  traderWalletId: string;
  billingAccountId: string;
  /** `max(updated_at)` already projected, or null on the first run. */
  watermark: Date | null;
  capturedAt?: Date;
}): Promise<{ inserted: number; candidates: number; watermark: Date | null }> {
  const since = input.watermark
    ? new Date(input.watermark.getTime() - PROJECTION_WATERMARK_OVERLAP_MS)
    : null;

  const proof = paperFillAccountingSql("f", sql`${(input.capturedAt ?? new Date()).toISOString()}::timestamptz`);
  const result = await input.db.execute(sql`
    WITH src AS (
      SELECT
        ${input.traderWalletId}::uuid AS trader_wallet_id,
        f.target_id,
        f.fill_id,
        f.client_order_id,
        f.order_id,
        f.status,
        f.fees_usdc,
        f.attributes,
        f.updated_at,
        f.observed_at,
        ${proof.observedAt} AS proof_observed_at,
        f.attributes->'paper_receipt_v1'->>'condition_id' AS condition_id,
        f.attributes->>'token_id' AS token_id,
        f.attributes->>'side' AS side,
        f.price AS price,
        f.shares AS shares,
        round(f.price * f.shares, 8) AS size_usdc
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${input.billingAccountId}
        AND f.mode = 'paper'
        AND f.status IN ${terminalStatusList()}
        AND ${proof.positive}
        AND f.price IS NOT NULL AND f.price > 0
        AND f.shares IS NOT NULL AND f.shares > 0
        AND round(f.price * f.shares, 8) > 0
        AND f.attributes->>'side' IN ('BUY', 'SELL')
        AND NULLIF(f.attributes->>'token_id', '') IS NOT NULL
        AND COALESCE(NULLIF(f.attributes->>'condition_id', ''), f.market_id) IS NOT NULL
        ${since ? sql`AND f.updated_at >= ${since.toISOString()}::timestamptz` : sql``}
    ),
    ins AS (
      INSERT INTO poly_trader_fills (
        trader_wallet_id, source, native_id, condition_id, token_id,
        side, price, shares, size_usdc, tx_hash, observed_at, raw
      )
      SELECT
        src.trader_wallet_id,
        ${PAPER_FILL_SOURCE},
        src.target_id::text || ':' || src.fill_id,
        src.condition_id,
        src.token_id,
        src.side,
        src.price,
        src.shares,
        src.size_usdc,
        -- Paper has no chain transaction. NULL, never a synthesised hash.
        NULL,
        greatest(src.observed_at, src.proof_observed_at),
        jsonb_build_object(
          'paper_ledger', jsonb_build_object(
            'target_id', src.target_id,
            'fill_id', src.fill_id,
            'client_order_id', src.client_order_id,
            'order_id', src.order_id,
            'status', src.status,
            'fees_usdc', src.fees_usdc
          ),
          'attributes', src.attributes
        )
      FROM src
      ON CONFLICT (trader_wallet_id, source, native_id) DO NOTHING
      RETURNING 1 AS projected
    )
    SELECT
      (SELECT count(*) FROM ins)::int AS inserted,
      (SELECT count(*) FROM src)::int AS candidates,
      (SELECT max(updated_at) FROM src) AS max_updated_at
  `);

  const row = firstRow<{
    inserted: number | string;
    candidates: number | string;
    max_updated_at: string | Date | null;
  }>(result);
  const advanced = row?.max_updated_at ?? null;
  return {
    inserted: Number(row?.inserted ?? 0),
    candidates: Number(row?.candidates ?? 0),
    // Never regress the watermark: a tick that matched nothing keeps the old
    // one rather than resetting to null and re-scanning all of history.
    watermark: advanced ? new Date(advanced) : input.watermark,
  };
}

/** One position's aggregate, straight out of SQL. */
type PaperPositionRollup = {
  conditionId: string;
  tokenId: string;
  netShares: number;
  buyShares: number;
  buyUsdc: number;
  sellUsdc: number;
  lastFillAt: Date;
  cachedActive: boolean | null;
  cachedShares: number | null;
  cachedCurrentValueUsdc: number | null;
  cachedLastObservedAt: Date | null;
  cachedRaw: Record<string, unknown> | null;
};

/**
 * Read account coverage and current paper inventory in one statement snapshot.
 *
 * `GROUP BY (condition_id, token_id)` — the result is bounded by the account's
 * unique position count (tens), never by its fill count, so this is the
 * "small per-entity rollup" shape the data-research standard permits in V8.
 * Served by `poly_trader_fills_trader_observed_idx (trader_wallet_id,
 * observed_at)`.
 *
 * Average-cost convention: `avg_price` is the BUY-side VWAP and the remaining
 * position's cost basis is `net_shares × avg_price`. This matches what
 * Polymarket's Data-API reports for a live wallet (`avgPrice` / `initialValue`),
 * so a paper position and a live position mean the same thing to every reader.
 */
async function readPaperGeneration(
  db: Db,
  traderWalletId: string,
  billingAccountId: string,
  capturedAt: Date
): Promise<{ coverage: PaperCoverage; rollups: readonly PaperPositionRollup[] }> {
  const result = await db.execute(sql`
    WITH ${paperAccountingCtes({ billingAccountId, walletIds: sql`${traderWalletId}::uuid`, capturedAt: sql`${capturedAt.toISOString()}::timestamptz` })}, rollups AS (
      SELECT
        condition_id,
        token_id,
        SUM(CASE WHEN side = 'BUY' THEN shares ELSE -shares END) AS net_shares,
        COALESCE(SUM(shares)   FILTER (WHERE side = 'BUY'),  0) AS buy_shares,
        COALESCE(SUM(size_usdc) FILTER (WHERE side = 'BUY'),  0) AS buy_usdc,
        COALESCE(SUM(size_usdc) FILTER (WHERE side = 'SELL'), 0) AS sell_usdc,
        MAX(observed_at) AS last_fill_at
      FROM paper_inventory_facts
      GROUP BY condition_id, token_id
    )
    SELECT
      paper_coverage.fees_usdc,
      paper_coverage.unknown_fees,
      paper_coverage.inventory_complete,
      paper_coverage.finance_complete,
      paper_coverage.latest_proof_at,
      rollups.*,
      current_position.active AS cached_active,
      current_position.shares AS cached_shares,
      current_position.current_value_usdc AS cached_current_value_usdc,
      current_position.last_observed_at AS cached_last_observed_at,
      current_position.raw AS cached_raw
    FROM paper_coverage
    LEFT JOIN rollups ON paper_coverage.inventory_complete
    LEFT JOIN poly_trader_current_positions current_position
      ON current_position.trader_wallet_id = ${traderWalletId}::uuid
     AND current_position.condition_id = rollups.condition_id
     AND current_position.token_id = rollups.token_id
    ORDER BY rollups.condition_id, rollups.token_id
  `);
  const rows = allRows<{
    fees_usdc: string;
    unknown_fees: string;
    inventory_complete: boolean;
    finance_complete: boolean;
    latest_proof_at: string | Date | null;
    condition_id: string | null;
    token_id: string | null;
    net_shares: string;
    buy_shares: string;
    buy_usdc: string;
    sell_usdc: string;
    last_fill_at: string | Date;
    cached_active: boolean | null;
    cached_shares: string | null;
    cached_current_value_usdc: string | null;
    cached_last_observed_at: string | Date | null;
    cached_raw: Record<string, unknown> | null;
  }>(result);
  const first = rows[0];
  const coverage: PaperCoverage = {
    feesUsdc: Number(first?.fees_usdc ?? 0),
    rowsMissingFees: Number(first?.unknown_fees ?? 0),
    inventoryComplete: first?.inventory_complete === true,
    financeComplete: first?.finance_complete === true,
    latestProofAt: first?.latest_proof_at ?? null,
  };
  const rollups = rows.flatMap((row) => {
    if (row.condition_id === null || row.token_id === null) return [];
    return [{
      conditionId: row.condition_id,
      tokenId: row.token_id,
      netShares: Number(row.net_shares),
      buyShares: Number(row.buy_shares),
      buyUsdc: Number(row.buy_usdc),
      sellUsdc: Number(row.sell_usdc),
      lastFillAt: new Date(row.last_fill_at),
      cachedActive: row.cached_active,
      cachedShares: row.cached_shares === null ? null : Number(row.cached_shares),
      cachedCurrentValueUsdc:
        row.cached_current_value_usdc === null
          ? null
          : Number(row.cached_current_value_usdc),
      cachedLastObservedAt:
        row.cached_last_observed_at === null
          ? null
          : new Date(row.cached_last_observed_at),
      cachedRaw: row.cached_raw,
    }];
  });
  return { coverage, rollups };
}

function paperPositionKey(position: {
  conditionId: string;
  tokenId: string;
}): string {
  return `${position.conditionId}|${position.tokenId}`;
}

function reusablePaperMark(
  rollup: PaperPositionRollup,
  now: Date
): number | null {
  if (
    rollup.cachedActive !== true ||
    rollup.cachedShares === null ||
    rollup.cachedCurrentValueUsdc === null ||
    rollup.cachedLastObservedAt === null ||
    rollup.cachedRaw?.source !== PAPER_FILL_SOURCE ||
    typeof rollup.cachedRaw.curPrice !== "number"
  ) {
    return null;
  }
  const mark = rollup.cachedRaw.curPrice;
  if (
    !Number.isFinite(mark) ||
    mark < 0 ||
    mark > 1 ||
    !Number.isFinite(rollup.cachedShares) ||
    Math.abs(rollup.cachedShares - rollup.netShares) > 1e-8 ||
    !Number.isFinite(rollup.cachedCurrentValueUsdc) ||
    Math.abs(rollup.cachedCurrentValueUsdc - rollup.cachedShares * mark) > 1e-6
  ) {
    return null;
  }

  // getMarkPrice returns exact 0/1 only from a unique closed-market winner,
  // never from midpoint or last-trade fallbacks, so this fact is permanent.
  if (mark === 0 || mark === 1) return mark;
  const ageMs = now.getTime() - rollup.cachedLastObservedAt.getTime();
  return ageMs >= 0 && ageMs <= PAPER_OPEN_MARK_MAX_AGE_MS ? mark : null;
}

function rotatedMarkWindow(
  candidates: readonly PaperPositionRollup[],
  priorCursor: string | null,
  limit: number
): readonly PaperPositionRollup[] {
  if (candidates.length === 0 || limit <= 0) return [];
  const start =
    priorCursor === null
      ? 0
      : Math.max(
          0,
          candidates.findIndex(
            (candidate) => paperPositionKey(candidate) > priorCursor
          )
        );
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
  return ordered.slice(0, limit);
}

/** Scalar account coverage carried by the same snapshot as inventory. */
type PaperCoverage = {
  feesUsdc: number;
  rowsMissingFees: number;
  inventoryComplete: boolean;
  financeComplete: boolean;
  latestProofAt: string | Date | null;
};

/**
 * Content hash for snapshot dedupe, mirroring {@link hashPosition}'s contract
 * exactly: position-DEFINING fields only.
 *
 * `currentValueUsdc` is deliberately excluded. Including the mark would make
 * every tick of an open position in a liquid market write a fresh snapshot row
 * (~2880/day/position at a 30s cadence) because the mid always moves — the
 * same blowup task.5012 fixed on the live path. A snapshot row means "the
 * position itself changed"; live marks live in `poly_trader_current_positions`.
 */
function hashPaperPosition(input: {
  conditionId: string;
  tokenId: string;
  shares: string;
  avgPrice: string;
  costBasisUsdc: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        conditionId: input.conditionId,
        tokenId: input.tokenId,
        shares: input.shares,
        avgPrice: input.avgPrice,
        costBasisUsdc: input.costBasisUsdc,
      })
    )
    .digest("hex");
}

/** A position row ready to write, plus whether it still needs a mark. */
type PreparedPaperPosition = {
  conditionId: string;
  tokenId: string;
  active: boolean;
  shares: string;
  costBasisUsdc: string;
  currentValueUsdc: string;
  avgPrice: string;
  contentHash: string;
  raw: Record<string, unknown>;
};

/**
 * Project positions and publish the NAV row.
 *
 * Writes `poly_trader_position_snapshots` + `poly_trader_current_positions`
 * with the exact conflict keys the live writer uses, then — only if every open
 * position could be marked — the tenant's `poly_wallet_balance_snapshots` row.
 * That NAV row is what makes the dashboard render at all:
 * `readWalletBalanceFact` drives from `poly_wallet_connections` and left-joins
 * this table on `lower(address) = lower(funder_address)`, returning
 * `available` only when the row exists.
 */
async function projectPaperPositionsAndNav(input: {
  db: Db;
  wallet: EnrolledPaperWallet;
  readMidPrice: PaperMidPriceReader;
  logger: LoggerPort;
  signal?: AbortSignal | undefined;
  now?: Date;
  markRefreshLimit?: number;
}): Promise<{
  positions: number;
  unpricedPositions: number;
  navPublished: boolean;
  marksAttempted: number;
  marksRefreshed: number;
  marksReused: number;
}> {
  const now = input.now ?? new Date();
  const { traderWalletId, account } = input.wallet;
  // READ COMMITTED transactions take a new snapshot for each statement. Read
  // coverage and grouped inventory together so a late receipt cannot combine
  // an older complete coverage verdict with newer, incomplete inventory.
  // The LEFT JOIN keeps scalar coverage even for an empty or withheld book.
  const { coverage, rollups } = await readPaperGeneration(
    input.db, traderWalletId, account.billingAccountId, now
  );

  const cursorRows = await input.db
    .select({ lastSeenNativeId: polyTraderIngestionCursors.lastSeenNativeId })
    .from(polyTraderIngestionCursors)
    .where(
      and(
        eq(polyTraderIngestionCursors.traderWalletId, traderWalletId),
        eq(polyTraderIngestionCursors.source, PAPER_POSITION_CURSOR_SOURCE)
      )
    )
    .limit(1);
  const priorMarkCursor = cursorRows[0]?.lastSeenNativeId ?? null;
  const refreshCandidates = rollups.filter(
    (rollup) =>
      rollup.netShares > 0 &&
      rollup.buyShares > 0 &&
      (reusablePaperMark(rollup, now) === null ||
        (coverage.latestProofAt !== null && (rollup.cachedLastObservedAt === null ||
          new Date(coverage.latestProofAt).getTime() > rollup.cachedLastObservedAt.getTime())) ||
        (rollup.cachedRaw?.paperCoverage as { financeComplete?: unknown } | undefined)?.financeComplete !== coverage.financeComplete)
  );
  const refreshWindow = rotatedMarkWindow(
    refreshCandidates,
    priorMarkCursor,
    input.markRefreshLimit ?? PAPER_MARK_REFRESH_LIMIT_PER_TICK
  );
  const refreshKeys = new Set(refreshWindow.map(paperPositionKey));
  const nextMarkCursor =
    refreshWindow.length > 0
      ? paperPositionKey(refreshWindow[refreshWindow.length - 1]!)
      : priorMarkCursor;

  const prepared: PreparedPaperPosition[] = [];
  const unpriced: { conditionId: string; tokenId: string }[] = [];
  const incoherent: { conditionId: string; tokenId: string }[] = [];
  let openValueUsdc = 0;
  let boughtUsdc = 0;
  let soldUsdc = 0;
  let marksRefreshed = 0;
  let marksReused = 0;

  for (const rollup of rollups) {
    boughtUsdc += rollup.buyUsdc;
    soldUsdc += rollup.sellUsdc;

    // Clamp at zero: the CHECKs on both tables require shares >= 0, and a
    // negative net is over-selling, which CTF cannot represent. Treated as
    // fully closed and logged below if it actually went negative.
    const openShares = rollup.netShares > 0 ? rollup.netShares : 0;
    const avgPrice = rollup.buyShares > 0 ? rollup.buyUsdc / rollup.buyShares : 0;

    if (openShares > 0 && rollup.buyShares <= 0) {
      // Held shares with no BUY to derive an entry price from. There is no
      // honest cost basis here and we will not invent one.
      incoherent.push({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
      });
      continue;
    }

    if (openShares === 0) {
      // A closed position is worth zero because it holds zero shares — that is
      // arithmetic, not a fabricated mark, so it needs no mid price.
      // `avg_price` keeps the real entry VWAP rather than being zeroed: it is a
      // fact we know, and the live path only zeroes it because the position
      // vanished from upstream with no history to keep.
      const shares = "0";
      const costBasisUsdc = "0";
      const avgPriceStr = avgPrice.toFixed(USDC_SCALE);
      prepared.push({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
        active: false,
        shares,
        costBasisUsdc,
        currentValueUsdc: "0",
        avgPrice: avgPriceStr,
        contentHash: hashPaperPosition({
          conditionId: rollup.conditionId,
          tokenId: rollup.tokenId,
          shares,
          avgPrice: avgPriceStr,
          costBasisUsdc,
        }),
        raw: paperPositionRaw(rollup, null, 0, coverage.financeComplete, now),
      });
      continue;
    }

    const shouldRefresh = refreshKeys.has(paperPositionKey(rollup));
    if (shouldRefresh && input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("paper projection aborted before mark refresh");
    }
    const refreshedMid = shouldRefresh
      ? await input.readMidPrice(
          rollup.tokenId,
          input.signal,
          rollup.conditionId
        )
      : null;
    if (shouldRefresh && input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("paper projection aborted during mark refresh");
    }
    const cachedMid = reusablePaperMark(rollup, now);
    const mid = refreshedMid ?? cachedMid;
    if (mid === null) {
      // NO_FABRICATED_VALUES: leave the existing row untouched and withhold the
      // NAV. Writing 0 here is the bug; writing a stale-but-real prior mark and
      // saying so is the fix.
      unpriced.push({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
      });
      continue;
    }

    if (refreshedMid === null) marksReused += 1;
    else marksRefreshed += 1;

    const shares = openShares.toFixed(USDC_SCALE);
    const costBasisUsdc = (openShares * avgPrice).toFixed(USDC_SCALE);
    const avgPriceStr = avgPrice.toFixed(USDC_SCALE);
    const currentValue = openShares * mid;
    openValueUsdc += currentValue;
    const markedPosition: PreparedPaperPosition = {
      conditionId: rollup.conditionId,
      tokenId: rollup.tokenId,
      active: true,
      shares,
      costBasisUsdc,
      currentValueUsdc: currentValue.toFixed(USDC_SCALE),
      avgPrice: avgPriceStr,
      contentHash: hashPaperPosition({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
        shares,
        avgPrice: avgPriceStr,
        costBasisUsdc,
      }),
      raw: paperPositionRaw(rollup, mid, currentValue, coverage.financeComplete, now),
    };
    // Reusing a prior real mark contributes to this tick's complete NAV, but
    // must not rewrite last_observed_at and pretend the mark was refreshed.
    if (refreshedMid !== null) prepared.push(markedPosition);
  }

  if (incoherent.length > 0) {
    input.logger.error(
      {
        event: EVENT_NAMES.POLY_PAPER_POSITION_INCOHERENT,
        errorCode: "paper_position_cost_basis_missing",
        trader_wallet_id: traderWalletId,
        billing_account_id: account.billingAccountId,
        positions: incoherent.length,
        sample: incoherent.slice(0, 5),
      },
      "paper position holds shares with no BUY fills — no cost basis can be derived; skipped"
    );
  }

  if (prepared.length > 0) {
    await writePaperPositionRows(input.db, traderWalletId, prepared, now);
  }

  const fees = coverage;
  const seedUsdc = Number(account.seedUsdc);

  // NAV_IS_CASH_PLUS_MARKS. Withheld whenever any open position is unmarked or
  // incoherent, because the total would then silently omit that exposure.
  const nav = seedUsdc - boughtUsdc + soldUsdc - fees.feesUsdc + openValueUsdc;
  const negativeNav = Number.isFinite(nav) && nav < 0;
  const invalidSeed = !Number.isFinite(seedUsdc);
  const invalidNav = !Number.isFinite(nav);
  const navBlockers =
    unpriced.length +
    incoherent.length +
    (negativeNav ? 1 : 0) +
    (invalidSeed ? 1 : 0) +
    (invalidNav && !invalidSeed ? 1 : 0) +
    (coverage.financeComplete ? 0 : 1);
  const navPublishable = navBlockers === 0 && Number.isFinite(nav);
  if (negativeNav) {
    input.logger.error(
      {
        event: EVENT_NAMES.POLY_PAPER_NAV_NEGATIVE,
        errorCode: "paper_nav_negative",
        trader_wallet_id: traderWalletId,
        billing_account_id: account.billingAccountId,
        nav_usdc: nav,
      },
      "paper NAV computed negative — snapshot withheld because publishing 0 would fabricate value"
    );
  } else if (navPublishable) {
    await publishPaperNav({
      db: input.db,
      account,
      navUsdc: nav,
      rowsMissingFees: fees.rowsMissingFees,
      logger: input.logger,
      observedAt: now,
    });
    await publishPaperPnl(input.db, input.wallet, now);
  } else if (!negativeNav) {
    input.logger.warn(
      {
        event: EVENT_NAMES.POLY_PAPER_NAV_WITHHELD,
        errorCode: !coverage.inventoryComplete
          ? "paper_receipt_coverage_incomplete"
          : !coverage.financeComplete
            ? "paper_financial_coverage_incomplete"
          : invalidSeed
          ? "paper_seed_invalid"
          : invalidNav
            ? "paper_nav_non_finite"
            : "paper_position_mark_unavailable",
        ...(invalidSeed || invalidNav || !coverage.financeComplete ? {} : { dep: "polymarket_clob" }),
        trader_wallet_id: traderWalletId,
        billing_account_id: account.billingAccountId,
        unpriced_positions: unpriced.length,
        incoherent_positions: incoherent.length,
        receipt_inventory_complete: coverage.inventoryComplete,
        receipt_finance_complete: coverage.financeComplete,
        rows_missing_fees: coverage.rowsMissingFees,
        seed_usdc_finite: Number.isFinite(seedUsdc),
        nav_usdc_finite: Number.isFinite(nav),
        sample_unpriced: unpriced.slice(0, 5),
      },
      "paper NAV withheld — the current projection is incomplete or invalid; publishing a partial total would invent a value"
    );
  }

  if (!navPublishable) {
    // INVALID_CURRENT_NAV_INVALIDATES_PRIOR_FACT. Leaving the last good value
    // readable would make a known-bad current account look tradeable until the
    // normal staleness TTL elapsed. The caller runs this projection in one
    // account-scoped transaction, so deletion and the partial cursor below are
    // committed atomically.
    await input.db
      .delete(polyWalletBalanceSnapshots)
      .where(
        and(
          eq(
            polyWalletBalanceSnapshots.billingAccountId,
            account.billingAccountId
          ),
          sql`lower(${polyWalletBalanceSnapshots.address}) = ${account.address}`
        )
      );
  }

  await publishPaperPositionCursor({
    db: input.db,
    traderWalletId,
    status: coverage.inventoryComplete && unpriced.length === 0 && incoherent.length === 0 && !invalidSeed && !invalidNav && !negativeNav ? "ok" : "partial",
    errorMessage:
      !coverage.inventoryComplete ? "paper receipt coverage incomplete; prior positions retained and NAV withheld"
        : !coverage.financeComplete ? "paper final history or fee coverage incomplete; inventory observed and NAV withheld"
        : negativeNav
        ? `paper NAV computed negative (${nav}); snapshot withheld because cap or fill accounting is inconsistent`
        : invalidSeed
          ? "paper seed is not finite; NAV withheld"
          : invalidNav
            ? "paper NAV is not finite; snapshot withheld because an aggregate is invalid"
          : navBlockers === 0
            ? null
            : `${unpriced.length} open position(s) had no readable midpoint or settlement mark and ${incoherent.length} had no derivable cost basis; NAV withheld`,
    observedAt: now,
    lastSeenNativeId: nextMarkCursor,
  });

  return {
    positions: prepared.length,
    unpricedPositions: unpriced.length,
    navPublished: navPublishable,
    marksAttempted: refreshWindow.length,
    marksRefreshed,
    marksReused,
  };
}

/**
 * The `raw` payload stored alongside a projected position.
 *
 * Deliberately records the inputs the aggregate was computed FROM, so a reader
 * can audit the number without re-deriving it — the persisted-payload
 * discipline the data-research standard asks for (bug.5020). `mid` is null for
 * a closed position, which carries no mark by construction.
 */
function paperPositionRaw(
  rollup: PaperPositionRollup,
  mid: number | null,
  currentValue: number,
  financeComplete: boolean,
  generationAt: Date
): Record<string, unknown> {
  return {
    source: PAPER_FILL_SOURCE,
    conditionId: rollup.conditionId,
    asset: rollup.tokenId,
    netShares: rollup.netShares,
    buyShares: rollup.buyShares,
    buyUsdc: rollup.buyUsdc,
    sellUsdc: rollup.sellUsdc,
    curPrice: mid,
    currentValue,
    lastFillAt: rollup.lastFillAt.toISOString(),
    paperCoverage: { financeComplete, generationAt: generationAt.toISOString() },
  };
}

/**
 * Write the snapshot + current-position rows, honouring the live writer's
 * conflict keys exactly: snapshots dedupe on
 * `(trader_wallet_id, condition_id, token_id, content_hash)`, current
 * positions upsert on the PK `(trader_wallet_id, condition_id, token_id)`.
 */
async function writePaperPositionRows(
  db: Db,
  traderWalletId: string,
  prepared: readonly PreparedPaperPosition[],
  capturedAt: Date
): Promise<void> {
  await db
    .insert(polyTraderPositionSnapshots)
    .values(
      prepared.map((position) => ({
        traderWalletId,
        conditionId: position.conditionId,
        tokenId: position.tokenId,
        shares: position.shares,
        costBasisUsdc: position.costBasisUsdc,
        currentValueUsdc: position.currentValueUsdc,
        avgPrice: position.avgPrice,
        contentHash: position.contentHash,
        capturedAt,
        raw: position.raw,
      }))
    )
    .onConflictDoNothing({
      target: [
        polyTraderPositionSnapshots.traderWalletId,
        polyTraderPositionSnapshots.conditionId,
        polyTraderPositionSnapshots.tokenId,
        polyTraderPositionSnapshots.contentHash,
      ],
    });

  await db
    .insert(polyTraderCurrentPositions)
    .values(
      prepared.map((position) => ({
        traderWalletId,
        conditionId: position.conditionId,
        tokenId: position.tokenId,
        active: position.active,
        shares: position.shares,
        costBasisUsdc: position.costBasisUsdc,
        currentValueUsdc: position.currentValueUsdc,
        avgPrice: position.avgPrice,
        contentHash: position.contentHash,
        lastObservedAt: capturedAt,
        raw: position.raw,
      }))
    )
    .onConflictDoUpdate({
      target: [
        polyTraderCurrentPositions.traderWalletId,
        polyTraderCurrentPositions.conditionId,
        polyTraderCurrentPositions.tokenId,
      ],
      set: {
        active: sql`excluded.active`,
        shares: sql`excluded.shares`,
        costBasisUsdc: sql`excluded.cost_basis_usdc`,
        currentValueUsdc: sql`excluded.current_value_usdc`,
        avgPrice: sql`excluded.avg_price`,
        contentHash: sql`excluded.content_hash`,
        lastObservedAt: capturedAt,
        raw: sql`excluded.raw`,
      },
    });
}

/**
 * Publish the tenant's NAV as a `poly_wallet_balance_snapshots` row.
 *
 * Why `usdc_e` carries the NAV and the other two legs are NULL: the table's
 * `status_values` CHECK admits exactly three shapes — `ok` with all three legs
 * non-null, `partial` with one or two, `error` with none. A paper account has
 * no on-chain pUSD and no POL, and it never will. Writing `0` for them to
 * reach `ok` would assert two measurements that were never taken; NULL plus a
 * `partial` status plus an explicit `errors` entry says what is true, and
 * `readWalletBalanceFact` returns `available` for `partial` just as it does for
 * `ok`, so the dashboard renders either way. `paper_seed_usdc`'s own docstring
 * pins its precision to `usdc_e`, which is the column task A intended.
 *
 * Reuses `persistWalletBalanceFact`, so the status classification and the
 * `(billing_account_id, address)` upsert are shared with the live Polygon
 * writer rather than re-implemented.
 */
async function publishPaperNav(input: {
  db: Db;
  account: PaperAccount;
  navUsdc: number;
  rowsMissingFees: number;
  logger: LoggerPort;
  observedAt: Date;
}): Promise<void> {
  const errors = [
    "Simulated account: the reported collateral is paper NAV (seed − cost + marked open positions), not an on-chain balance.",
    "On-chain pUSD and POL balances are not reported for a paper account — it has no chain presence.",
  ];
  if (input.rowsMissingFees > 0) {
    errors.push(
      `${input.rowsMissingFees} realized paper fill(s) reported no fee value; NAV treats their fees as unreported, not as zero.`
    );
  }
  if (!Number.isFinite(input.navUsdc) || input.navUsdc < 0) {
    throw new Error(
      "paper NAV must be finite and nonnegative before publication"
    );
  }
  await persistWalletBalanceFact(
    input.db,
    {
      billingAccountId: input.account.billingAccountId,
      address: input.account.address,
      usdcE: Number(input.navUsdc.toFixed(USDC_SCALE)),
      pusd: null,
      pol: null,
      errors,
    },
    input.observedAt
  );
}

/** Publish only genuine current NAV observations; the buckets are dedupe keys. */
async function publishPaperPnl(db: Db, wallet: EnrolledPaperWallet, observedAt: Date): Promise<void> {
  let published = 0;
  for (const fidelity of ["1h", "1d"] as const) {
    const rows = allRows<{ fidelity: string }>(await db.execute(sql`
      INSERT INTO poly_trader_user_pnl_points (trader_wallet_id, fidelity, ts, pnl_usdc, observed_at)
      SELECT w.id, f.fidelity, date_trunc(f.bucket, ${observedAt}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        (b.usdc_e - c.paper_seed_usdc)::numeric(38,8), ${observedAt}::timestamptz
      FROM poly_wallet_connections c
      JOIN poly_trader_wallets w ON w.id = ${wallet.traderWalletId}::uuid AND w.kind = 'paper_wallet'
        AND lower(w.wallet_address) = lower(c.address) AND w.active_for_research AND w.disabled_at IS NULL
      JOIN poly_wallet_balance_snapshots b ON b.billing_account_id = c.billing_account_id
        AND lower(b.address) = lower(c.funder_address) AND b.observed_at = ${observedAt}::timestamptz
      CROSS JOIN (VALUES (${fidelity}::text, ${fidelity === '1h' ? 'hour' : 'day'}::text)) f(fidelity, bucket)
      WHERE c.billing_account_id = ${wallet.account.billingAccountId} AND c.kind = 'paper' AND c.revoked_at IS NULL
        AND c.paper_seed_usdc = ${wallet.account.seedUsdc}::numeric
        AND lower(c.address) = ${wallet.account.address} AND lower(c.funder_address) = ${wallet.account.address}
      ON CONFLICT (trader_wallet_id, fidelity, ts) DO UPDATE SET
        pnl_usdc = excluded.pnl_usdc, observed_at = excluded.observed_at
      WHERE poly_trader_user_pnl_points.observed_at < excluded.observed_at
      RETURNING fidelity
    `));
    if (rows.length !== 1) throw new Error("paper P/L publication did not acknowledge fidelity");
    published += rows.length;
  }
  if (published !== 2) throw new Error("paper P/L publication did not acknowledge both fidelities");
}

/** Advance (or fault) the paper position cursor, same shape as the live one. */
async function publishPaperPositionCursor(input: {
  db: Db;
  traderWalletId: string;
  status: "ok" | "partial";
  errorMessage: string | null;
  observedAt: Date;
  lastSeenNativeId: string | null;
}): Promise<void> {
  await input.db
    .insert(polyTraderIngestionCursors)
    .values({
      traderWalletId: input.traderWalletId,
      source: PAPER_POSITION_CURSOR_SOURCE,
      lastSeenNativeId: input.lastSeenNativeId,
      lastSuccessAt: input.observedAt,
      status: input.status,
      errorMessage: input.errorMessage,
      updatedAt: input.observedAt,
    })
    .onConflictDoUpdate({
      target: [
        polyTraderIngestionCursors.traderWalletId,
        polyTraderIngestionCursors.source,
      ],
      set: {
        lastSeenNativeId: sql`excluded.last_seen_native_id`,
        lastSuccessAt: input.observedAt,
        status: sql`excluded.status`,
        errorMessage: sql`excluded.error_message`,
        updatedAt: input.observedAt,
      },
    });
}

/**
 * Observe one paper wallet: project fills, aggregate + mark positions, publish
 * NAV. The paper analogue of `observeWallet`.
 *
 * Never touches `PolymarketDataApiClient` and never consults
 * `PositionBalanceBatchReader` — see LEDGER_IS_THE_AUTHORITY. The caller owns
 * the statement timeout, exactly as it does for the live path.
 */
export async function observePaperWallet(input: {
  db: Db;
  wallet: EnrolledPaperWallet;
  readMidPrice: PaperMidPriceReader;
  logger: LoggerPort;
  signal?: AbortSignal | undefined;
  now?: Date;
  markRefreshLimit?: number;
}): Promise<PaperObservationResult> {
  return input.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const { traderWalletId, account } = input.wallet;
    // Existing durable account row serializes observers across processes.
    const connections = await db.select().from(polyWalletConnections)
      .where(and(eq(polyWalletConnections.billingAccountId, account.billingAccountId), eq(polyWalletConnections.kind, "paper")))
      .orderBy(polyWalletConnections.id).limit(2).for("update");
    const connection = connections[0];
    const now = input.now ?? new Date();
    const expected = derivePaperAccountAddress(account.billingAccountId);
    const [physical] = await db.select().from(polyTraderWallets)
      .where(eq(polyTraderWallets.id, traderWalletId)).limit(1);
    if (connections.length !== 1 || !connection || connection.revokedAt !== null ||
      connection.address.toLowerCase() !== expected || (connection.funderAddress ?? "").toLowerCase() !== expected ||
      account.address !== expected || connection.paperSeedUsdc === null ||
      !Number.isFinite(Number(connection.paperSeedUsdc)) || Number(connection.paperSeedUsdc) <= 0 ||
      !Number.isFinite(Number(account.seedUsdc)) ||
      !physical || physical.kind !== PAPER_WALLET_KIND || !physical.activeForResearch || physical.disabledAt !== null ||
      physical.walletAddress.toLowerCase() !== expected || physical.createdAt < connection.createdAt ||
      !Number.isFinite(now.getTime()) || now < physical.createdAt || now < connection.createdAt) {
      throw new Error("paper observation lifecycle is unsupported or changed");
    }
    const seedMatch = allRows<{ matches: boolean }>(await db.execute(sql`
      SELECT ${account.seedUsdc}::numeric(20,8) = ${connection.paperSeedUsdc}::numeric(20,8) AS matches
    `))[0]?.matches;
    if (!seedMatch) throw new Error("paper observation seed changed");
    const previous = allRows<{ latest: Date | string | null }>(await db.execute(sql`
      SELECT max(generation) AS latest FROM (
        SELECT last_success_at AS generation FROM poly_trader_ingestion_cursors
          WHERE trader_wallet_id = ${traderWalletId}::uuid AND source IN (${PAPER_TRADE_CURSOR_SOURCE}, ${PAPER_POSITION_CURSOR_SOURCE})
        UNION ALL SELECT observed_at FROM poly_wallet_balance_snapshots
          WHERE billing_account_id = ${account.billingAccountId} AND lower(address) = ${expected}
        UNION ALL SELECT observed_at FROM poly_trader_user_pnl_points WHERE trader_wallet_id = ${traderWalletId}::uuid
      ) generations
    `))[0]?.latest;
    if (previous !== null && previous !== undefined && now.getTime() <= new Date(previous).getTime()) {
      throw new Error("paper observation generation must be strictly newer");
    }
    const startedAt = Date.now();

    const cursor = await db
      .select({ lastSeenAt: polyTraderIngestionCursors.lastSeenAt })
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, traderWalletId),
          eq(polyTraderIngestionCursors.source, PAPER_TRADE_CURSOR_SOURCE)
        )
      )
      .limit(1);

    const projected = await projectPaperFills({
      db,
      traderWalletId,
      billingAccountId: account.billingAccountId,
      watermark: cursor[0]?.lastSeenAt ?? null,
      capturedAt: now,
    });

    await db
      .insert(polyTraderIngestionCursors)
      .values({
        traderWalletId,
        source: PAPER_TRADE_CURSOR_SOURCE,
        lastSeenAt: projected.watermark,
        lastSuccessAt: now,
        status: "ok",
        errorMessage: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          polyTraderIngestionCursors.traderWalletId,
          polyTraderIngestionCursors.source,
        ],
        set: {
          lastSeenAt: sql`excluded.last_seen_at`,
          lastSuccessAt: now,
          status: "ok",
          errorMessage: null,
          updatedAt: now,
        },
      });

    const positions = await projectPaperPositionsAndNav({
      db,
      wallet: input.wallet,
      readMidPrice: input.readMidPrice,
      logger: input.logger,
      signal: input.signal,
      now,
      ...(input.markRefreshLimit === undefined
        ? {}
        : { markRefreshLimit: input.markRefreshLimit }),
    });

    input.logger.info(
      {
        event: EVENT_NAMES.POLY_PAPER_OBSERVE,
        phase: "wallet_ok",
        trader_wallet_id: traderWalletId,
        billing_account_id: account.billingAccountId,
        wallet: account.address,
        fills: projected.inserted,
        fill_candidates: projected.candidates,
        positions: positions.positions,
        unpriced_positions: positions.unpricedPositions,
        nav_published: positions.navPublished,
        marks_attempted: positions.marksAttempted,
        marks_refreshed: positions.marksRefreshed,
        marks_reused: positions.marksReused,
        duration_ms: Date.now() - startedAt,
      },
      "paper wallet observed"
    );

    return {
      fills: projected.inserted,
      positions: positions.positions,
      unpricedPositions: positions.unpricedPositions,
      navPublished: positions.navPublished,
      marksAttempted: positions.marksAttempted,
      marksRefreshed: positions.marksRefreshed,
      marksReused: positions.marksReused,
    };
  });
}

/**
 * `db.execute` result shape differs between the node-postgres and postgres-js
 * drivers (`{ rows }` vs a bare array). Same normalisation the observation
 * service's `executionRows` does; duplicated rather than imported to keep this
 * module free of a cycle back into `trader-observation-service`.
 */
function allRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function firstRow<T>(result: unknown): T | undefined {
  return allRows<T>(result)[0];
}

/**
 * Wraps one unit of projection work in a bounded transaction.
 *
 * Injected rather than imported so this module never reaches back into
 * `trader-observation-service` (which imports {@link PAPER_WALLET_KIND} from
 * here) — that would be an import cycle. The job binds
 * `withStatementTimeout(db, OBSERVATION_STATEMENT_TIMEOUT_MS, fn)`; tests may
 * omit it and run unwrapped.
 */
export type BoundedTxRunner = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;

export type PaperProjectionTickResult = {
  /** Active paper accounts found this tick. Zero is the idle case. */
  paperAccounts: number;
  walletsProjected: number;
  fills: number;
  positions: number;
  unpricedPositions: number;
  navsPublished: number;
  marksAttempted: number;
  marksRefreshed: number;
  marksReused: number;
  errors: number;
  /**
   * Set when the tick deliberately did nothing. Distinguishes "idle" from
   * "broken" for the operator — a silent no-op here would reproduce exactly
   * the invisible-paper-account failure this whole slice exists to fix.
   */
  idleReason?: "no_paper_accounts";
};

/**
 * One paper-projection tick: find the active paper accounts, enrol them, and
 * project each one's ledger into the shared fact tables.
 *
 * THE GATE IS THE DATA, NOT A FLAG. This runs whenever at least one active
 * paper account exists and is deliberately NOT gated on
 * `POLY_TRADER_OBSERVATION_WRITER_ENABLED`. That lever exists because
 * Data-API observation writes burn production IO for zero user value on
 * non-prod lanes whose DBs live on the prod VM by custody (bug.5297/bug.5206):
 * paginated `/activity` + `/positions` for every target and tenant wallet,
 * plus snapshot rows per token, every 30s. The paper projection shares none of
 * that shape — it is a local SQL projection over this node's OWN
 * `poly_copy_trade_fills`, scoped to the paper accounts that actually exist,
 * with a bounded, cursor-resumed window of authoritative mark reads. Reusing
 * the observation flag would conflate two unrelated write loads and leave the
 * paper dashboard structurally unrenderable on exactly the lanes paper
 * trading runs on.
 *
 * Per-account error isolation: one account's failure is logged and counted,
 * never fatal to the others.
 */
export async function runPaperProjectionTick(deps: {
  db: Db;
  readMidPrice: PaperMidPriceReader;
  logger: LoggerPort;
  /** Defaults to running unwrapped; the job binds a statement timeout. */
  runBounded?: BoundedTxRunner;
  signal?: AbortSignal | undefined;
  now?: Date;
  markRefreshLimit?: number;
}): Promise<PaperProjectionTickResult> {
  const runBounded: BoundedTxRunner =
    deps.runBounded ?? (<T>(fn: (tx: Db) => Promise<T>) => fn(deps.db));
  const empty: PaperProjectionTickResult = {
    paperAccounts: 0,
    walletsProjected: 0,
    fills: 0,
    positions: 0,
    unpricedPositions: 0,
    navsPublished: 0,
    marksAttempted: 0,
    marksRefreshed: 0,
    marksReused: 0,
    errors: 0,
  };

  // The read runs before any write (ENROLLMENT_FAILURE_IS_NOT_A_WIPE) and is
  // also the gate: no accounts, no work, no writes.
  const accounts = await readActivePaperAccounts(deps.db, deps.logger);
  if (accounts.length === 0) {
    deps.logger.info(
      {
        event: EVENT_NAMES.POLY_PAPER_PROJECT,
        phase: "idle_no_paper_accounts",
        reason: "no active poly_wallet_connections row with kind='paper'",
      },
      "paper projection idle — no paper accounts exist on this lane (idle, not broken)"
    );
    return { ...empty, idleReason: "no_paper_accounts" };
  }

  const enrolled = await runBounded(
    async (tx) => await syncPaperTraderWallets(tx, accounts, deps.now)
  );

  const result: PaperProjectionTickResult = {
    ...empty,
    paperAccounts: accounts.length,
  };
  for (const wallet of enrolled) {
    if (deps.signal?.aborted) break;
    try {
      const projected = await runBounded(
        async (tx) =>
          await observePaperWallet({
            db: tx,
            wallet,
            readMidPrice: deps.readMidPrice,
            logger: deps.logger,
            signal: deps.signal,
            ...(deps.now === undefined ? {} : { now: deps.now }),
            ...(deps.markRefreshLimit === undefined
              ? {}
              : { markRefreshLimit: deps.markRefreshLimit }),
          })
      );
      result.walletsProjected += 1;
      result.fills += projected.fills;
      result.positions += projected.positions;
      result.unpricedPositions += projected.unpricedPositions;
      result.marksAttempted += projected.marksAttempted;
      result.marksRefreshed += projected.marksRefreshed;
      result.marksReused += projected.marksReused;
      if (projected.navPublished) result.navsPublished += 1;
    } catch (err: unknown) {
      if (deps.signal?.aborted) throw err;
      result.errors += 1;
      deps.logger.error(
        {
          event: EVENT_NAMES.POLY_PAPER_PROJECT,
          phase: "account_failed",
          errorCode: "paper_projection_account_failed",
          trader_wallet_id: wallet.traderWalletId,
          billing_account_id: wallet.account.billingAccountId,
          ...safeErrorDimensions(err),
        },
        "paper projection failed for one account; other accounts continue"
      );
    }
  }
  return result;
}

/* ── Read-back: a paper account's own projected positions + NAV ───────────── */

/**
 * How old the position projection may be and still be used to SIZE an order.
 *
 * The projection ticks every 30s (`PAPER_PROJECTION_POLL_MS`) with a 25s
 * timeout, so four ticks absorbs a slow tick and a failed one without making
 * paper untradeable. The bound exists because a stale read UNDER-reports a
 * position that was just opened, and "position smaller than it really is" is
 * the same failure the hardcoded `0` produced — only slower and harder to see.
 * Past the bound the reader reports `projection_stale` instead.
 *
 * Note this is bounded staleness, not a fresh read: the live path marks against
 * a live Data-API position read. That difference is inherent to paper (its
 * positions are DERIVED from our own ledger, by a writer, on a timer) and is
 * named here rather than hidden.
 */
export const PAPER_FACTS_MAX_STALENESS_MS = 120_000;

/** Why a paper account's facts cannot be used right now. */
export type PaperFactsUnavailableReason =
  /** No enrolled `poly_trader_wallets` row for the derived paper address. */
  | "no_paper_wallet"
  /** The wallet exists but the position projection has never completed. */
  | "never_projected"
  /** Last tick was `partial` — a mid was unreadable, so exposure is incomplete. */
  | "projection_incomplete"
  /** Last successful tick is older than {@link PAPER_FACTS_MAX_STALENESS_MS}. */
  | "projection_stale"
  /** No usable NAV row for this paper address. */
  | "nav_missing";

/**
 * Thrown instead of returning an incomplete or stale paper fact set.
 *
 * NO_FABRICATED_VALUES, on the read side: the writer already refuses to invent
 * a mark, and this is the matching refusal for the reader. Returning "no
 * positions" for an account whose projection has not run, or a NAV of 0 for one
 * whose NAV was withheld, would re-create the exact bug the hardcoded
 * `getPositionShareBalance: async () => 0` was.
 */
export class PaperFactsUnavailableError extends Error {
  constructor(
    public readonly billingAccountId: string,
    public readonly reason: PaperFactsUnavailableReason,
    public readonly detail?: string
  ) {
    super(
      `paper facts unavailable for billingAccountId=${billingAccountId} (${reason})${
        detail ? `: ${detail}` : ""
      }`
    );
    this.name = "PaperFactsUnavailableError";
  }
}

/** One open paper position, as projected and marked by the last good tick. */
export type PaperOpenPosition = {
  readonly conditionId: string;
  readonly tokenId: string;
  /** Net shares held. Always > 0 — closed positions are not returned. */
  readonly shares: number;
  /** `shares × mid` at `observedAt`. */
  readonly currentValueUsdc: number;
  /** Entry VWAP. */
  readonly avgPrice: number;
};

/** The paper account's open book, with the observation time it came from. */
export type PaperAccountPositionFacts = {
  readonly traderWalletId: string;
  /** The derived synthetic address these facts belong to. */
  readonly address: `0x${string}`;
  /** `last_success_at` of the position cursor — when these marks were taken. */
  readonly observedAt: Date;
  readonly positions: readonly PaperOpenPosition[];
};

/**
 * Read one paper account's open positions back out of the fact tables.
 *
 * READS_THE_PROJECTION_NEVER_REAGGREGATES: this returns the rows
 * {@link projectPaperPositionsAndNav} wrote. It deliberately does NOT re-run
 * the `GROUP BY` over `poly_copy_trade_fills` — a second aggregation would be a
 * second answer to "what does this account hold", and the two would drift
 * exactly when it mattered (one marked at a mid, the other not). The cursor row
 * that projection publishes is what makes the read-back safe: it carries both
 * completeness (`status`) and recency (`last_success_at`), so an incomplete or
 * stale projection is detectable here rather than silently returning a short
 * book.
 *
 * `active = false` rows are excluded: the projection writes those with
 * `shares = 0` when a position closed, which is arithmetic rather than a mark.
 * A caller asking "what do I hold" is asking about the open book.
 *
 * @throws {PaperFactsUnavailableError} on every not-usable state. Never returns
 *   an empty book to mean "unknown"; an empty `positions` array means this
 *   account verifiably holds nothing as of `observedAt`.
 * @public
 */
export async function readPaperAccountPositionFacts(input: {
	db: Db;
	billingAccountId: string;
	now?: Date;
	maxStalenessMs?: number;
}): Promise<PaperAccountPositionFacts> {
  const now = input.now ?? new Date();
  const maxStalenessMs = input.maxStalenessMs ?? PAPER_FACTS_MAX_STALENESS_MS;
  // Same single definition of the address the writer enrolls under
  // (DERIVED_ADDRESS_IS_CROSS_CHECKED) — not a second derivation, the same one.
  const address = derivePaperAccountAddress(input.billingAccountId);

  // One statement snapshot binds completeness and holdings to the same
  // projection generation. A LEFT JOIN sentinel preserves a proven empty book.
  const rows = await input.db
    .select({
      walletId: polyTraderWallets.id,
      status: polyTraderIngestionCursors.status,
      lastSuccessAt: polyTraderIngestionCursors.lastSuccessAt,
      positionWalletId: polyTraderCurrentPositions.traderWalletId,
      conditionId: polyTraderCurrentPositions.conditionId,
      tokenId: polyTraderCurrentPositions.tokenId,
      shares: polyTraderCurrentPositions.shares,
      currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
      avgPrice: polyTraderCurrentPositions.avgPrice,
    })
    .from(polyTraderWallets)
    .leftJoin(polyTraderIngestionCursors, and(
      eq(polyTraderIngestionCursors.traderWalletId, polyTraderWallets.id),
      eq(polyTraderIngestionCursors.source, PAPER_POSITION_CURSOR_SOURCE)
    ))
    .leftJoin(polyTraderCurrentPositions, and(
      eq(polyTraderCurrentPositions.traderWalletId, polyTraderWallets.id),
      eq(polyTraderCurrentPositions.active, true)
    ))
    .where(and(
      eq(polyTraderWallets.walletAddress, address),
      eq(polyTraderWallets.kind, PAPER_WALLET_KIND),
      isNull(polyTraderWallets.disabledAt)
    ));
  const cursor = rows[0];
  if (!cursor) {
    throw new PaperFactsUnavailableError(input.billingAccountId, "no_paper_wallet");
  }
  if (!cursor.lastSuccessAt) {
    throw new PaperFactsUnavailableError(input.billingAccountId, "never_projected");
  }
  const ageMs = now.getTime() - cursor.lastSuccessAt.getTime();
  if (cursor.status !== "ok" || !Number.isFinite(ageMs) || ageMs < 0 ||
      !Number.isFinite(maxStalenessMs) || maxStalenessMs < 0) {
    throw new PaperFactsUnavailableError(input.billingAccountId, "projection_incomplete");
  }
  if (ageMs > maxStalenessMs) {
    throw new PaperFactsUnavailableError(input.billingAccountId, "projection_stale");
  }

  const positions: PaperOpenPosition[] = [];
  const keys = new Set<string>();
  const conditionsByToken = new Map<string, string>();
  for (const row of rows) {
    if (row.positionWalletId === null) continue; // complete empty-book sentinel
    const identity = normalizePositionIdentity(row);
    const key = positionIdentityKey(row);
    const shares = Number(row.shares);
    const currentValueUsdc = Number(row.currentValueUsdc);
    const avgPrice = Number(row.avgPrice);
    if (identity.availability !== "available" || key === null || keys.has(key) ||
        (conditionsByToken.has(identity.tokenId) && conditionsByToken.get(identity.tokenId) !== identity.conditionId) ||
        row.shares === null || row.currentValueUsdc === null || row.avgPrice === null ||
        !Number.isFinite(shares) || shares <= 0 ||
        !Number.isFinite(currentValueUsdc) || currentValueUsdc < 0 ||
        !Number.isFinite(avgPrice) || avgPrice < 0) {
      // Never omit a corrupt active leg: that would understate exposure.
      throw new PaperFactsUnavailableError(input.billingAccountId, "projection_incomplete");
    }
    keys.add(key);
    conditionsByToken.set(identity.tokenId, identity.conditionId);
    positions.push({ conditionId: identity.conditionId, tokenId: identity.tokenId,
      shares, currentValueUsdc, avgPrice });
  }

  return {
    traderWalletId: cursor.walletId,
    address,
    observedAt: cursor.lastSuccessAt,
    positions,
  };
}

/**
 * Read the paper account's NAV (`seed − bought + sold − fees + marks`) back out
 * of the `poly_wallet_balance_snapshots` row the projection publishes.
 *
 * Deliberately NOT via `readWalletBalanceFact`: that reader applies
 * LIVE_WINS_PAPER_SHOWS, so for a tenant holding both kinds it would hand back
 * the LIVE wallet's cash as this paper account's NAV. The snapshot table is
 * keyed by `(billing_account_id, address)`, so live and paper facts coexist.
 *
 * @throws {PaperFactsUnavailableError} `nav_missing` when the row is absent,
 *   belongs to another address, carries a NULL (withheld) NAV, or is older than
 *   the staleness bound. The writer withholds rather than invents; this reader
 *   refuses rather than substitutes 0.
 * @public
 */
export async function readPaperAccountNavUsdc(input: {
  db: Db;
  billingAccountId: string;
  now?: Date;
  maxStalenessMs?: number;
}): Promise<{ navUsdc: number; observedAt: Date }> {
  const now = input.now ?? new Date();
  const maxStalenessMs = input.maxStalenessMs ?? PAPER_FACTS_MAX_STALENESS_MS;
  const address = derivePaperAccountAddress(input.billingAccountId);

  const rows = await input.db
    .select({
      address: polyWalletBalanceSnapshots.address,
      usdcE: polyWalletBalanceSnapshots.usdcE,
      observedAt: polyWalletBalanceSnapshots.observedAt,
    })
    .from(polyWalletBalanceSnapshots)
    .where(
      and(
        eq(polyWalletBalanceSnapshots.billingAccountId, input.billingAccountId),
        sql`lower(${polyWalletBalanceSnapshots.address}) = ${address}`
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new PaperFactsUnavailableError(
      input.billingAccountId,
      "nav_missing",
      "no poly_wallet_balance_snapshots row — the projection has published no NAV yet"
    );
  }
  if (row.address.toLowerCase() !== address) {
    throw new PaperFactsUnavailableError(
      input.billingAccountId,
      "nav_missing",
      "the tenant's NAV row belongs to a different address (live custody owns it); this paper account has no published NAV"
    );
  }
  if (row.usdcE === null) {
    throw new PaperFactsUnavailableError(
      input.billingAccountId,
      "nav_missing",
      "NAV was withheld by the projection (an open position could not be marked)"
    );
  }
  const navUsdc = Number(row.usdcE);
  if (!Number.isFinite(navUsdc)) {
    throw new PaperFactsUnavailableError(
      input.billingAccountId,
      "nav_missing",
      "published NAV is not a finite number"
    );
  }
  const ageMs = now.getTime() - row.observedAt.getTime();
  if (ageMs > maxStalenessMs) {
    throw new PaperFactsUnavailableError(
      input.billingAccountId,
      "projection_stale",
      `published NAV is ${Math.round(ageMs / 1000)}s old (bound ${Math.round(maxStalenessMs / 1000)}s)`
    );
  }
  return { navUsdc, observedAt: row.observedAt };
}
