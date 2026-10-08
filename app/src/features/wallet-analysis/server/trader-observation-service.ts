// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/trader-observation-service`
 * Purpose: Live-forward observation service for configured Polymarket trader wallets — fills, current positions, and (when `userPnlClient` is injected) user-pnl time-series for the page-load read model.
 * Scope: Feature service. Caller injects DB/client/logger; this module does not construct runtime dependencies or own scheduling.
 * Invariants:
 *   - LIVE_FORWARD_COLLECTION: polls `active_for_research` wallets and stores facts for later query windows.
 *   - BOUNDED_PARALLEL_WALLETS: the per-wallet loop fans out through `pLimit(WALLET_OBSERVE_CONCURRENCY)` (task.5015) — at most 3 wallets in flight; one wallet's failure never kills the tick.
 *   - COOPERATIVE_CANCELLATION: `deps.signal` (armed by the job's tick timeout) is checked before each wallet and between upstream pages, and is passed to every Polymarket fetch; an aborted wallet is counted `walletsAborted`, writes no cursor-error row, and post-loop prunes/metadata refresh are skipped so the abandoned tick settles quickly.
 *   - SAME_OBSERVED_TRADE_TABLE: target and Cogni public wallet trades are both stored in `poly_trader_fills`.
 *   - WATERMARKED_INGESTION: reads newest-to-prior-watermark and advances cursor only after DB upserts complete.
 *   - ROLLUPS_FOLLOW_FILLS (task.research-rollup-read-models): after each wallet's fills upsert, the tick folds new fills into `poly_trader_fill_rollups_daily` via `accumulateFillRollups` (bounded batches, `skipIfLocked` so a running boot backfill wins the cursor). DB-only; failures log + count `errors` without failing the wallet.
 *   - PNL_INGEST_INDEPENDENT: per-wallet user-pnl ingest runs after observation regardless of observe outcome; failures bump `errors` and continue. Retention prune runs once per tick after all wallets.
 *   - SNAPSHOTS_ARE_POSITION_CHANGES: `poly_trader_position_snapshots` rows are written only when a position-defining field changes (see `hashPosition`); mark-to-market history lives in `poly_market_price_history` + `poly_trader_user_pnl_points`, live marks in `poly_trader_current_positions`. Retention (`pruneOldPositionSnapshots`) drops >35d rows in bounded batches but always keeps each group's newest row.
 *   - OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM: tenant enrollment takes its
 *     address set from the injected `listActiveTradingAddresses` reader —
 *     `PolyTraderWalletPort.listActiveTradingAddresses()` in production — and
 *     never derives it from `poly_wallet_connections` itself. The port owns
 *     the one resolution; two derivations drifted the observer onto the Privy
 *     signer EOA while trading ran from the V2 funder, so the position read
 *     model found no row and the dashboard reported a funded wallet as empty.
 *   - ENROLLMENT_FAILURE_IS_NOT_A_WIPE: the reader runs before any write, so a
 *     failed read enrolls and retires nothing. The tick logs
 *     `sync_tenant_wallets_failed`, counts one `error`, and still observes the
 *     already-enrolled wallets — losing enrollment is the outage, not the fix.
 *   - COGNI_POSITION_ABSENCE_NEEDS_AUTHORITY: complete Data API polls do not
 *     deactivate Cogni-wallet current-position rows unless an injected
 *     authority classifies the missing row terminal.
 *   - KIND_ROUTES_THE_FACT_SOURCE (migration 0083): a `paper_wallet` row is
 *     observed by `paper-fact-source`, which projects the paper ledger into
 *     these same tables. That path never calls `deps.client` (the Data-API has
 *     nothing to say about a synthetic address), never calls
 *     `deps.userPnlClient`, and never consults `deps.readPositionBalances` —
 *     see LEDGER_IS_THE_AUTHORITY. `deps.client` therefore needs no interface
 *     seam: the branch happens before any client use.
 *   - PAPER_AND_LIVE_SWEEPS_ARE_DISJOINT: `disableMissingTenantWallets`
 *     filters `kind = 'cogni_wallet'` and `retireMissingPaperWallets` filters
 *     `kind = 'paper_wallet'`, so neither population can retire the other.
 *     The paper sweep additionally refuses to retire anything on an EMPTY
 *     account list, so a transient read of zero accounts cannot wipe
 *     enrollment (a stronger form of ENROLLMENT_FAILURE_IS_NOT_A_WIPE).
 * Side-effects: IO through injected Data API client + optional user-pnl client + injected DB.
 * Links: docs/spec/poly-copy-trade-execution.md, work/items/task.5005, work/items/task.5012, work/items/task.5015
 * @public
 */

import { createHash } from "node:crypto";
import {
  type PolyTraderWallet,
  polyMarketOutcomes,
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import type {
  Fill,
  LoggerPort,
  MetricsPort,
} from "@cogni/poly-market-provider";
import {
  createPolymarketActivitySource,
  type PolymarketDataApiClient,
  type PolymarketUserPnlClient,
  type PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import {
  and,
  eq,
  exists,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pLimit from "p-limit";
import { hydrateCopyTargetPositions } from "./copy-target-position-hydration-service";
import {
  type EnrolledPaperWallet,
  observePaperWallet,
  PAPER_WALLET_KIND,
  type PaperAccount,
  PAPER_TRADE_CURSOR_SOURCE,
  type PaperMidPriceReader,
  syncPaperTraderWallets,
} from "./paper-fact-source";
import {
  accumulateFillRollups,
  TICK_ROLLUP_MAX_BATCHES,
} from "./fill-rollup-service";
import { refreshMarketMetadata } from "./poly-market-metadata-service";
import {
  fetchAndPersistTradingWalletPnlHistory,
  pruneOldTradingWalletPnlPoints,
} from "./trading-wallet-overview-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

const TRADE_SOURCE = "data-api-trades";
const POSITION_SOURCE = "data-api-positions";
const DEFAULT_TRADE_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 10;
const POSITION_FETCH_LIMIT = 500;
const DEFAULT_POSITION_MAX_PAGES = 10;
const POSITION_MAX_ROWS = POSITION_FETCH_LIMIT * DEFAULT_POSITION_MAX_PAGES;
const POSITION_OMISSION_LIMIT = POSITION_MAX_ROWS + 1;
const POSITION_BALANCE_CHUNK_SIZE = 100;
const POSITION_BALANCE_MAX_CHUNKS = 50;
const POSITION_BALANCE_CHUNK_TIMEOUT_MS = 5_000;
const POSITION_BALANCE_TOTAL_TIMEOUT_MS = 30_000;
const POSITION_PUBLISH_MAX_ATTEMPTS = 2;
const DEFAULT_POSITION_POLL_MS = 5 * 60 * 1000;
const TENANT_TRADING_WALLET_LABEL = "Tenant trading wallet";
/**
 * Snapshot rows older than this are pruned by the tick (task.5012). 35 days
 * matches the `1h` retention standard on `poly_trader_user_pnl_points` and
 * `poly_market_price_history`. The latest row per (wallet, condition, token)
 * is NEVER pruned regardless of age — SNAPSHOTS_ARE_DURABLE_TRUTH in
 * `market-exposure-service.ts` reads it as the only surviving record of an
 * exited position, and post-hash-change (see `hashPosition`) a *held*
 * position that simply hasn't changed in >35d also has no newer row.
 */
const SNAPSHOT_RETENTION_DAYS = 35;
/** Per-DELETE row bound so pruning a huge backlog never holds locks long. */
const SNAPSHOT_PRUNE_BATCH_SIZE = 5_000;
/** Batches per tick; a backlog drains across ticks instead of in one stall. */
const SNAPSHOT_PRUNE_MAX_BATCHES = 10;
/**
 * Max wallets observed in parallel per tick (task.5015). 3 keeps the tick's
 * worst-case Data-API rate well under the `pLimit(4)` ≈ 24 rps ceiling
 * spike.5001 measured for the CLOB jobs while collapsing tick duration from
 * O(wallets) serial to O(wallets / 3).
 */
const WALLET_OBSERVE_CONCURRENCY = 3;

/**
 * Supplies the lowercased trading-wallet address of every unrevoked tenant.
 * Production binds `PolyTraderWalletPort.listActiveTradingAddresses`; the port
 * is the only thing allowed to know how a connection row resolves to an
 * address (see OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM).
 */
export type TenantTradingAddressReader = () => Promise<readonly string[]>;

export interface TraderObservationTickDeps {
  db: Db;
  client: PolymarketDataApiClient;
  userPnlClient?: PolymarketUserPnlClient;
  /**
   * Tenant trading wallets to enroll for observation. Required — the tick
   * cannot enroll what it cannot resolve, and defaulting it to a local
   * `poly_wallet_connections` read is exactly the second derivation this
   * invariant exists to forbid.
   */
  listActiveTradingAddresses: TenantTradingAddressReader;
  /** Polygon CTF `balanceOfBatch` authority for Data-API omissions. */
  readPositionBalances?: PositionBalanceBatchReader;
  /**
   * Active paper accounts to enroll and project (migration 0083). Omitted =>
   * no paper enrollment and no paper projection this tick, which is exactly
   * the pre-0083 behaviour. Supplying it is what makes a paper account's facts
   * exist at all.
   *
   * Unlike `listActiveTradingAddresses` this is NOT a port call: a paper row's
   * trading identity has one definition (`derivePaperAccountAddress`), which
   * the reader recomputes and cross-checks. Production binds
   * `readActivePaperAccounts` against the service DB.
   */
  listPaperAccounts?: (() => Promise<readonly PaperAccount[]>) | undefined;
  /**
   * Live CLOB midpoint used to mark paper positions to market. Required for a
   * paper wallet to publish anything: without it every open position is
   * unpriced, so NAV is withheld rather than invented (NO_FABRICATED_VALUES).
   * Production binds `PolymarketClobPublicClient.getMidpoint`.
   */
  readPaperMidPrice?: PaperMidPriceReader | undefined;
  logger: LoggerPort;
  metrics: MetricsPort;
  tradePageLimit?: number;
  maxPages?: number;
  positionMaxPages?: number;
  positionPollMs?: number;
  /**
   * Cooperative cancellation (task.5015). Armed by the job's tick timeout;
   * checked before each wallet and between upstream pages, and passed to
   * every Polymarket fetch so in-flight requests abort too.
   */
  signal?: AbortSignal | undefined;
  /**
   * STAGE_SURVIVES_A_HUNG_TICK (bug.5273) — called as the tick enters each
   * stage. The job holds the value in a plain variable OUTSIDE the
   * timeout/grace race, so a tick that never settles still reports where it
   * hung. Without it the timeout log's `wallets*` fields are all `null`
   * (they come from the tick's return value, which a hung tick never
   * produces) and the stall is undiagnosable — observed on prod 51bd530,
   * `settled_after_abort: false`, every field null.
   */
  onStage?: ((stage: TraderObservationStage) => void) | undefined;
  /**
   * RETENTION_PRUNE_ON_A_SLOW_CADENCE (prod EXPLAIN 2026-10-01) — the job gates the two
   * retention prunes (pnl-points + position-snapshots) to a slow interval
   * instead of running them on every 30s poll. Prod `EXPLAIN (ANALYZE,
   * BUFFERS)` 2026-10-01: the snapshot prune is fully index-driven yet spends
   * 30-72s of disk I/O per tick to delete ZERO rows, because the outer index
   * scan must heap-visit 127k candidate rows over a heavily bloated heap. The
   * fix for the *shape* is bloat/autovacuum (substrate-owned); the fix for the
   * *cadence* is here — a 35-day retention window needs nothing near a 30s
   * cadence, so re-running a multi-second no-op every tick is pure waste.
   * Omitted or `true`: run the prunes this tick (preserves existing/test
   * behaviour). `false`: skip both prune stages this tick.
   */
  runRetentionPrune?: boolean;
}

/**
 * Stages of one observation tick, in execution order. `sync_tenant_wallets`
 * and `select_wallets` run BEFORE the bounded wallet loop and are plain DB
 * calls — drizzle/postgres-js take no `AbortSignal`, so an abort cannot
 * interrupt them. They are the prime suspects for a hung tick precisely
 * because a hang there leaves every loop counter unset.
 */
export type TraderObservationStage =
  | "sync_tenant_wallets"
  | "select_wallets"
  | "wallet_loop"
  | "hydrate_copy_targets"
  | "prune_pnl_points"
  | "prune_position_snapshots"
  | "refresh_market_metadata"
  | "done";

export interface TraderObservationTickResult {
  wallets: number;
  /** Wallets whose per-wallet work ran to completion (possibly with logged errors). */
  walletsProcessed: number;
  /** Wallets skipped or interrupted because `signal` aborted mid-tick. */
  walletsAborted: number;
  fills: number;
  positions: number;
  /** Target V2 rows published from exact local execution lineage. */
  targetPositionRows: number;
  /** Fills folded into `poly_trader_fill_rollups_daily` this tick. */
  rollupFills: number;
  /** Paper wallets enrolled for projection this tick. */
  paperWallets: number;
  /** Paper accounts whose NAV row was published this tick. */
  paperNavPublished: number;
  /**
   * Open paper positions whose mid price could not be read. Non-zero means at
   * least one account's NAV was deliberately withheld — a visible, countable
   * "unavailable", never a silent zero.
   */
  paperUnpricedPositions: number;
  pnlPoints: number;
  prunedPnlPoints: number;
  prunedPositionSnapshots: number;
  errors: number;
}

export interface CurrentPositionRefreshResult {
  positions: PolymarketUserPosition[];
  positionRows: number;
  complete: boolean;
  stalePositionRowsDeactivated: number;
  stalePositionRowsPreserved: number;
  failureReason?: PositionObservationFailureReason;
}

type PersistedCurrentPositions = {
  observedPositions: PolymarketUserPosition[];
  positionRows: number;
  complete: boolean;
  stalePositionRowsDeactivated: number;
  stalePositionRowsPreserved: number;
};

export interface MissingCurrentPosition {
  conditionId: string;
  tokenId: string;
  shares: number;
  currentValueUsdc: number;
  lastObservedAt: Date;
}

/**
 * One Polygon `balanceOfBatch` call. The writer owns chunking, sequential
 * execution, deadlines, and result validation so every caller follows the
 * same bounded authority protocol.
 */
export type PositionBalanceBatchReader = (input: {
  walletAddress: string;
  tokenIds: readonly string[];
  signal: AbortSignal;
}) => Promise<readonly bigint[]>;

export type PositionObservationFailureReason =
  | "data_api_error"
  | "data_api_incomplete"
  | "data_api_malformed"
  | "omission_over_cap"
  | "authority_unavailable"
  | "authority_malformed"
  | "authority_nonzero"
  | "superseded_exhausted";

type PositionCursorToken = {
  rowExists: boolean;
  xmin: string | null;
  lastSuccessAt: string | null;
  status: string | null;
};

export type PositionAuthorityResult = {
  reason:
    | "all_zero"
    | "authority_unavailable"
    | "authority_malformed"
    | "authority_nonzero";
  classifiedCount: number;
  zeroCount: number;
  nonzeroCount: number;
  chunkCount: number;
};

type PositionPrepareState = {
  capturedAt: string;
  cursor: PositionCursorToken;
};

type PreparedPositionPublication = {
  state: PositionPrepareState;
  positions: PolymarketUserPosition[];
  omitted: MissingCurrentPosition[];
};

/** Pure exact-zero gate used after every Polygon `balanceOfBatch` chunk. */
export function classifyMissingPositionBalances(
  balances: readonly unknown[],
  expectedCount: number
): "all_zero" | "authority_malformed" | "authority_nonzero" {
  if (
    balances.length !== expectedCount ||
    balances.some((balance) => typeof balance !== "bigint" || balance < 0n)
  ) {
    return "authority_malformed";
  }
  return balances.some((balance) => balance !== 0n)
    ? "authority_nonzero"
    : "all_zero";
}

/**
 * Bounded-parallel fan-out with cooperative cancellation (task.5015).
 * Generic so unit tests exercise the concurrency/abort/error contract with
 * fake wallet fns; `runTraderObservationTick` is the only production caller.
 *
 * Contract:
 * - At most `concurrency` `run` invocations are in flight at once.
 * - `signal.aborted` is checked before each wallet starts; wallets not yet
 *   started when the signal fires never run (counted `aborted`).
 * - A rejection from `run` while the signal is aborted counts that wallet
 *   `aborted` (the abort interrupted it) and is swallowed.
 * - Any other rejection is routed to `onError` — one wallet's failure never
 *   rejects the loop or affects sibling wallets (counted `processed`).
 */
export async function runBoundedWalletLoop<W>(input: {
  wallets: readonly W[];
  concurrency: number;
  signal?: AbortSignal | undefined;
  run: (wallet: W) => Promise<void>;
  onError?: (wallet: W, err: unknown) => void;
}): Promise<{ processed: number; aborted: number }> {
  const limit = pLimit(Math.max(1, input.concurrency));
  let processed = 0;
  let aborted = 0;
  await Promise.all(
    input.wallets.map((wallet) =>
      limit(async () => {
        if (input.signal?.aborted) {
          aborted += 1;
          return;
        }
        try {
          await input.run(wallet);
          processed += 1;
        } catch (err: unknown) {
          if (input.signal?.aborted) {
            aborted += 1;
            return;
          }
          processed += 1;
          input.onError?.(wallet, err);
        }
      })
    )
  );
  return { processed, aborted };
}

export async function runTraderObservationTick(
  deps: TraderObservationTickDeps
): Promise<TraderObservationTickResult> {
  const tickStartedAt = Date.now();
  const log = deps.logger.child({
    component: "trader-observation",
  });
  const stage = (next: TraderObservationStage): void => deps.onStage?.(next);
  // NOTE (bug.5273): deliberately NO abort short-circuit between these two
  // stages. An abort check here cannot interrupt the in-flight query anyway
  // (drizzle/postgres-js take no AbortSignal), and returning early loses the
  // wallet count that `runBoundedWalletLoop` is contracted to report as
  // `walletsAborted` — see the task.5015 abort test. The loop already handles
  // an aborted signal, and the post-loop stages are gated on `tickAborted`.
  // Bounding a hung pre-loop query needs a Postgres `statement_timeout`, not a
  // JS check; stage reporting is what makes that hang visible in the first place.
  // BOUND_THE_PRE_LOOP_STAGES (bug.5297): these run BEFORE the bounded wallet
  // loop and, being plain DB work, cannot be interrupted by `deps.signal` at
  // all — drizzle/postgres-js accept no AbortSignal. A `statement_timeout` is
  // the only thing that bounds them, and without it either one can hold the
  // whole tick past its 120s budget while the abort flag is set and ignored.
  // Wrapping the sync in one transaction is also a consistency win: its upsert
  // and its disable-missing pass are now atomic, so a failure between them can
  // no longer leave wallets both enabled and orphaned.
  stage("sync_tenant_wallets");
  // ENROLLMENT_FAILURE_IS_NOT_A_WIPE — the reader is a port call, so it can
  // fail for reasons the DB cannot (unconfigured wallet adapter in paper mode,
  // a Privy-app misconfig). It runs BEFORE any write, so a throw leaves
  // enrollment untouched; the tick must then carry on observing the wallets
  // already enrolled rather than die. Treating this as fatal would stop
  // observation entirely — the same blank dashboard, by a different route.
  // Audible, never silent: its own log phase plus the tick's `errors` count.
  let syncTenantWalletsFailed = false;
  // Pre-loop failures are counted here because `errors` is not yet in scope.
  let errorsBeforeLoop = 0;
  try {
    await withStatementTimeout(
      deps.db,
      OBSERVATION_STATEMENT_TIMEOUT_MS,
      async (tx) =>
        await syncActiveTenantWallets(tx, deps.listActiveTradingAddresses)
    );
  } catch (err: unknown) {
    syncTenantWalletsFailed = true;
    log.error(
      {
        event: "poly.trader.observe",
        phase: "sync_tenant_wallets_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "trader observation: tenant wallet enrollment failed; observing the already-enrolled set"
    );
  }
  // Paper enrollment runs in its own transaction and its own try/catch: a
  // paper-side failure must not retire or block live enrollment, and vice
  // versa. Same statement-timeout bound as the live sync — this is pre-loop DB
  // work that `deps.signal` cannot interrupt (BOUND_THE_PRE_LOOP_STAGES).
  const paperWalletsById = new Map<string, EnrolledPaperWallet>();
  const listPaperAccounts = deps.listPaperAccounts;
  if (listPaperAccounts) {
    try {
      // The read runs BEFORE the write transaction opens, mirroring
      // ENROLLMENT_FAILURE_IS_NOT_A_WIPE: a throw here enrolls and retires
      // nothing, and an empty result retires nothing either (see
      // `syncPaperTraderWallets`).
      const accounts = await listPaperAccounts();
      const enrolled = await withStatementTimeout(
        deps.db,
        OBSERVATION_STATEMENT_TIMEOUT_MS,
        async (tx) => await syncPaperTraderWallets(tx, accounts)
      );
      for (const wallet of enrolled) {
        paperWalletsById.set(wallet.traderWalletId, wallet);
      }
    } catch (err: unknown) {
      errorsBeforeLoop += 1;
      log.error(
        {
          event: "poly.paper.observe",
          phase: "sync_paper_wallets_failed",
          err: err instanceof Error ? err.message : String(err),
        },
        "paper account enrollment failed; previously-enrolled paper wallets keep their facts"
      );
    }
  }

  stage("select_wallets");
  const wallets = await withStatementTimeout(
    deps.db,
    OBSERVATION_STATEMENT_TIMEOUT_MS,
    async (tx) =>
      await tx
        .select()
        .from(polyTraderWallets)
        .where(
          and(
            eq(polyTraderWallets.activeForResearch, true),
            isNull(polyTraderWallets.disabledAt)
          )
        )
        .orderBy(polyTraderWallets.kind, polyTraderWallets.label)
  );

  let fills = 0;
  let positions = 0;
  let rollupFills = 0;
  let pnlPoints = 0;
  let errors = (syncTenantWalletsFailed ? 1 : 0) + errorsBeforeLoop;
  let paperNavPublished = 0;
  let paperUnpricedPositions = 0;

  // task.5015: bounded-parallel wallet fan-out. Per-wallet error isolation is
  // preserved — each phase catches its own errors and continues — EXCEPT when
  // `deps.signal` has aborted: abort-induced rejections are rethrown so the
  // loop counts the wallet aborted without writing a cursor-error row.
  stage("wallet_loop");
  const loop = await runBoundedWalletLoop({
    wallets,
    concurrency: WALLET_OBSERVE_CONCURRENCY,
    signal: deps.signal,
    run: async (wallet) => {
      // KIND_ROUTES_THE_FACT_SOURCE: a paper wallet is projected from the
      // ledger and returns BEFORE the Data-API observe call, the rollup
      // accumulator's live-fill assumptions, and the user-pnl ingest below —
      // all three of which would ask Polymarket about an address it has never
      // seen and get an empty answer that reads as "no activity".
      if (wallet.kind === PAPER_WALLET_KIND) {
        const paper = paperWalletsById.get(wallet.id);
        if (!paper) {
          // Enrolled earlier but its account is not resolvable this tick
          // (enrollment failed, the account was revoked, or the address
          // cross-check rejected it). We cannot project without the tenant and
          // the declared seed, and we will not guess either.
          errors += 1;
          log.warn(
            {
              event: "poly.paper.observe",
              phase: "account_unresolved",
              trader_wallet_id: wallet.id,
              wallet: wallet.walletAddress,
            },
            "paper wallet has no resolvable account this tick; skipping projection"
          );
          return;
        }
        const readMidPrice = deps.readPaperMidPrice;
        if (!readMidPrice) {
          errors += 1;
          log.error(
            {
              event: "poly.paper.observe",
              phase: "mid_price_reader_missing",
              trader_wallet_id: wallet.id,
            },
            "no paper mid-price reader injected; refusing to mark positions at a fabricated price"
          );
          return;
        }
        try {
          const result = await withStatementTimeout(
            deps.db,
            OBSERVATION_STATEMENT_TIMEOUT_MS,
            async (tx) =>
              await observePaperWallet({
                db: tx,
                wallet: paper,
                readMidPrice,
                logger: log,
                signal: deps.signal,
              })
          );
          fills += result.fills;
          positions += result.positions;
          paperUnpricedPositions += result.unpricedPositions;
          if (result.navPublished) paperNavPublished += 1;
        } catch (err: unknown) {
          if (deps.signal?.aborted) throw err;
          errors += 1;
          log.error(
            {
              event: "poly.paper.observe",
              phase: "error",
              trader_wallet_id: wallet.id,
              wallet: wallet.walletAddress,
              err: err instanceof Error ? err.message : String(err),
            },
            "paper wallet projection failed"
          );
          await markCursorError(
            deps.db,
            wallet.id,
            err,
            PAPER_TRADE_CURSOR_SOURCE
          );
        }
        return;
      }
      try {
        const result = await observeWallet({ ...deps, wallet, logger: log });
        fills += result.fills;
        positions += result.positions;
        rollupFills += result.rollupFills;
      } catch (err: unknown) {
        if (deps.signal?.aborted) throw err;
        errors += 1;
        log.error(
          {
            event: "poly.trader.observe",
            phase: "error",
            trader_wallet_id: wallet.id,
            wallet: wallet.walletAddress,
            err: err instanceof Error ? err.message : String(err),
          },
          "trader observation failed"
        );
        await markCursorError(deps.db, wallet.id, err);
      }
      if (deps.userPnlClient) {
        try {
          const pnlResult = await fetchAndPersistTradingWalletPnlHistory({
            db: deps.db,
            traderWalletId: wallet.id,
            walletAddress: wallet.walletAddress as `0x${string}`,
            client: deps.userPnlClient,
            logger: log,
            component: "trader-observation",
            signal: deps.signal,
          });
          pnlPoints += pnlResult.inserted;
        } catch (err: unknown) {
          if (deps.signal?.aborted) throw err;
          errors += 1;
          log.error(
            {
              event: "poly.trader.observe",
              phase: "user_pnl_error",
              trader_wallet_id: wallet.id,
              wallet: wallet.walletAddress,
              err: err instanceof Error ? err.message : String(err),
            },
            "trader user-pnl ingest failed"
          );
        }
      }
    },
    onError: (wallet, err) => {
      // Defensive: `run` handles its own errors; anything escaping here is a
      // failure of the error-handling path itself (e.g. markCursorError).
      errors += 1;
      log.error(
        {
          event: "poly.trader.observe",
          phase: "wallet_loop_error",
          trader_wallet_id: wallet.id,
          wallet: wallet.walletAddress,
          err: err instanceof Error ? err.message : String(err),
        },
        "trader observation wallet loop escaped error"
      );
    },
  });

  // Abandoned tick (job timeout fired): skip the post-loop maintenance so the
  // promise settles quickly — no orphan writers past the next tick start.
  const tickAborted = deps.signal?.aborted === true;

  // bug.5007 — a power target's whole-wallet V1 walk may exceed the 5,000
  // row publication cap. Recover only conditions proven by durable local
  // copy-fill + current-position lineage. The shared V2 reader completes all
  // cursor/chunk walks before this off-render writer publishes any target row.
  let targetPositionRows = 0;
  if (!tickAborted) {
    stage("hydrate_copy_targets");
    try {
      const hydration = await hydrateCopyTargetPositions({
        db: deps.db,
        client: deps.client,
        logger: log,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      targetPositionRows = hydration.rows;
      errors += hydration.errors;
    } catch (err: unknown) {
      if (deps.signal?.aborted) throw err;
      errors += 1;
      log.warn(
        {
          event: "poly.trader.target_positions_v2",
          phase: "selection_failed",
          error_class: "persistence_read_error",
        },
        "copy-target V2 cohort selection failed; saved facts preserved"
      );
    }
  }

  let prunedPnlPoints = 0;
  if (deps.userPnlClient && !tickAborted && deps.runRetentionPrune !== false) {
    stage("prune_pnl_points");
    try {
      const prune = await withStatementTimeout(
        deps.db,
        OBSERVATION_STATEMENT_TIMEOUT_MS,
        (tx) => pruneOldTradingWalletPnlPoints(tx)
      );
      prunedPnlPoints = prune.deleted;
    } catch (err: unknown) {
      log.warn(
        {
          event: "poly.trader.observe",
          phase: "user_pnl_prune_error",
          err: err instanceof Error ? err.message : String(err),
        },
        "trader user-pnl prune failed"
      );
    }
  }

  // Retention (task.5012): bounded prune of mark-churn snapshot history.
  // Runs once per tick after all wallets, mirroring the pnl-points prune;
  // NOT gated on `userPnlClient` because snapshots are written regardless.
  let prunedPositionSnapshots = 0;
  if (!tickAborted && deps.runRetentionPrune !== false) {
    stage("prune_position_snapshots");
    try {
      // bug.5297 — prod stage telemetry named this stage as a hang site (3x).
      // The tick's abort cannot reach a running DELETE, so Postgres enforces
      // the ceiling instead.
      const prune = await withStatementTimeout(
        deps.db,
        OBSERVATION_STATEMENT_TIMEOUT_MS,
        (tx) =>
          pruneOldPositionSnapshots(tx, {
            deadlineMs: OBSERVATION_STAGE_DEADLINE_MS,
          })
      );
      prunedPositionSnapshots = prune.deleted;
    } catch (err: unknown) {
      log.warn(
        {
          event: "poly.trader.observe",
          phase: "position_snapshot_prune_error",
          err: err instanceof Error ? err.message : String(err),
        },
        "trader position-snapshot prune failed"
      );
    }
  }

  // Project the latest /positions raw JSONB into `poly_market_metadata` so
  // readers JOIN one canonical typed row per market instead of scraping
  // `poly_trader_current_positions.raw->>'endDate'`. Pure SQL — no HTTP.
  // Soft-failures so a projection error never aborts the wallet tick.
  if (!tickAborted) {
    stage("refresh_market_metadata");
    try {
      // bug.5297 — named as a hang site (2x) by the same telemetry.
      await withStatementTimeout(
        deps.db,
        OBSERVATION_STATEMENT_TIMEOUT_MS,
        (tx) => refreshMarketMetadata({ db: tx, logger: log })
      );
    } catch (err: unknown) {
      log.warn(
        {
          event: "poly.trader.observe",
          phase: "market_metadata_error",
          err: err instanceof Error ? err.message : String(err),
        },
        "market metadata refresh failed"
      );
    }
  }

  log.info(
    {
      event: "poly.trader.observe",
      phase: "tick_ok",
      wallets: wallets.length,
      wallets_processed: loop.processed,
      wallets_aborted: loop.aborted,
      tick_ms: Date.now() - tickStartedAt,
      fills,
      positions,
      target_position_rows: targetPositionRows,
      rollup_fills: rollupFills,
      paper_wallets: paperWalletsById.size,
      paper_nav_published: paperNavPublished,
      paper_unpriced_positions: paperUnpricedPositions,
      pnl_points: pnlPoints,
      pruned_pnl_points: prunedPnlPoints,
      pruned_position_snapshots: prunedPositionSnapshots,
      errors,
    },
    "trader observation tick complete"
  );

  return {
    wallets: wallets.length,
    walletsProcessed: loop.processed,
    walletsAborted: loop.aborted,
    fills,
    positions,
    targetPositionRows,
    rollupFills,
    paperWallets: paperWalletsById.size,
    paperNavPublished,
    paperUnpricedPositions,
    pnlPoints,
    prunedPnlPoints,
    prunedPositionSnapshots,
    errors,
  };
}

export async function refreshCurrentPositionsForWallet(params: {
  db: Db;
  client: PolymarketDataApiClient;
  walletAddress: string;
  positionMaxPages?: number;
  readPositionBalances?: PositionBalanceBatchReader;
  /** @internal deterministic fault seam for atomic-publication component tests. */
  beforePositionCursorPublish?: () => void | Promise<void>;
  logger?: LoggerPort;
  signal?: AbortSignal | undefined;
}): Promise<CurrentPositionRefreshResult> {
  const wallet = await upsertCogniObservedWallet(
    params.db,
    params.walletAddress.toLowerCase()
  );
  return observePositionsNow({
    db: params.db,
    client: params.client,
    wallet,
    ...(params.positionMaxPages === undefined
      ? {}
      : { positionMaxPages: params.positionMaxPages }),
    ...(params.readPositionBalances === undefined
      ? {}
      : { readPositionBalances: params.readPositionBalances }),
    ...(params.beforePositionCursorPublish === undefined
      ? {}
      : { beforePositionCursorPublish: params.beforePositionCursorPublish }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
}

/**
 * Enroll every unrevoked tenant connection as an observed `cogni_wallet` and
 * retire the rows that no longer correspond to an active connection.
 *
 * Exported for the OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM proof —
 * `runTraderObservationTick` is the only production caller.
 */
export async function syncActiveTenantWallets(
  db: Db,
  listActiveTradingAddresses: TenantTradingAddressReader
): Promise<void> {
  const now = new Date();
  const observedAddresses = await listActiveTradingAddresses();
  if (observedAddresses.length === 0) {
    await disableMissingTenantWallets(db, [], now);
    return;
  }

  await db
    .insert(polyTraderWallets)
    .values(
      observedAddresses.map((walletAddress) => ({
        walletAddress,
        kind: "cogni_wallet",
        label: TENANT_TRADING_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
      }))
    )
    .onConflictDoUpdate({
      target: polyTraderWallets.walletAddress,
      set: {
        kind: "cogni_wallet",
        label: TENANT_TRADING_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
      },
    });
  // Stale signer-EOA rows enrolled by the pre-V2 behavior fall out of this
  // list and get deactivated here — the sweep that retires them.
  await disableMissingTenantWallets(db, observedAddresses, now);
}

async function upsertCogniObservedWallet(
  db: Db,
  walletAddress: string
): Promise<PolyTraderWallet> {
  const now = new Date();
  const [wallet] = await db
    .insert(polyTraderWallets)
    .values({
      walletAddress,
      kind: "cogni_wallet",
      label: TENANT_TRADING_WALLET_LABEL,
      activeForResearch: true,
      disabledAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: polyTraderWallets.walletAddress,
      set: {
        kind: "cogni_wallet",
        label: TENANT_TRADING_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
      },
    })
    .returning();
  if (!wallet) {
    throw new Error(`failed to upsert observed wallet ${walletAddress}`);
  }
  return wallet;
}

async function disableMissingTenantWallets(
  db: Db,
  activeWalletAddresses: readonly string[],
  now: Date
): Promise<void> {
  const filters = [
    eq(polyTraderWallets.kind, "cogni_wallet"),
    eq(polyTraderWallets.label, TENANT_TRADING_WALLET_LABEL),
    isNull(polyTraderWallets.disabledAt),
  ];
  if (activeWalletAddresses.length > 0) {
    filters.push(
      notInArray(polyTraderWallets.walletAddress, [...activeWalletAddresses])
    );
  }
  await db
    .update(polyTraderWallets)
    .set({
      activeForResearch: false,
      disabledAt: now,
      updatedAt: now,
    })
    .where(and(...filters));
}

async function observeWallet(
  deps: TraderObservationTickDeps & {
    wallet: PolyTraderWallet;
  }
): Promise<{ fills: number; positions: number; rollupFills: number }> {
  const startedAt = Date.now();
  const cursor = await deps.db
    .select()
    .from(polyTraderIngestionCursors)
    .where(
      and(
        eq(polyTraderIngestionCursors.traderWalletId, deps.wallet.id),
        eq(polyTraderIngestionCursors.source, TRADE_SOURCE)
      )
    )
    .limit(1);
  const since = cursor[0]?.lastSeenAt
    ? Math.floor(cursor[0].lastSeenAt.getTime() / 1000)
    : undefined;

  const source = createPolymarketActivitySource({
    client: deps.client,
    wallet: deps.wallet.walletAddress as `0x${string}`,
    logger: deps.logger,
    metrics: deps.metrics,
    limit: deps.tradePageLimit ?? DEFAULT_TRADE_PAGE_LIMIT,
    maxPages: deps.maxPages ?? DEFAULT_MAX_PAGES,
    signal: deps.signal,
  });
  const observed = await source.fetchSince(since);
  // Bulk write, one row per observed fill — the largest DB unit in the wallet
  // loop and the last unbounded one now that the upstream reads honour the
  // signal (bug.5297). Per-wallet transaction, deliberately NOT a stage-wide
  // one: a timeout must cost this wallet's writes only, never roll back the
  // wallets that already succeeded.
  // Guarded on non-empty: `upsertObservedFills` returns 0 without touching the
  // DB when there are no fills, which is the common case on a quiet tick, and
  // wrapping that unconditionally would spend BEGIN + SET LOCAL + COMMIT to do
  // nothing. Unlike the positions writer below, which still reconciles stale
  // rows when upstream returns nothing, this one has no empty-input work.
  const insertedFills =
    observed.fills.length === 0
      ? 0
      : await withStatementTimeout(
          deps.db,
          OBSERVATION_STATEMENT_TIMEOUT_MS,
          async (tx) =>
            await upsertObservedFills(tx, deps.wallet.id, observed.fills)
        );
  const positionResult = await observePositionsIfDue(deps).catch(
    async (err: unknown) => {
      // task.5015: an abort-interrupted position fetch is cancellation, not a
      // wallet failure — rethrow so the loop counts it aborted with no
      // cursor-error write.
      if (deps.signal?.aborted) throw err;
      deps.logger.error(
        {
          event: "poly.trader.observe",
          phase: "positions_error",
          trader_wallet_id: deps.wallet.id,
          wallet: deps.wallet.walletAddress,
          err: err instanceof Error ? err.message : String(err),
        },
        "trader position observation failed"
      );
      // The serialized position path records ordinary fetch/authority
      // failures with its preflight cursor token. An escaped error is a DB or
      // cancellation failure; writing an unversioned cursor error here could
      // overwrite a newer writer and is therefore deliberately forbidden.
      return { positions: 0, complete: false, skipped: false };
    }
  );

  await deps.db
    .insert(polyTraderIngestionCursors)
    .values({
      traderWalletId: deps.wallet.id,
      source: TRADE_SOURCE,
      lastSeenAt:
        observed.newSince > 0
          ? new Date(observed.newSince * 1000)
          : cursor[0]?.lastSeenAt,
      lastSeenNativeId:
        observed.fills[0]?.fill_id ?? cursor[0]?.lastSeenNativeId,
      lastSuccessAt: new Date(),
      status: "ok",
      errorMessage: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        polyTraderIngestionCursors.traderWalletId,
        polyTraderIngestionCursors.source,
      ],
      set: {
        lastSeenAt:
          observed.newSince > 0
            ? new Date(observed.newSince * 1000)
            : cursor[0]?.lastSeenAt,
        lastSeenNativeId:
          observed.fills[0]?.fill_id ?? cursor[0]?.lastSeenNativeId,
        lastSuccessAt: new Date(),
        status: "ok",
        errorMessage: null,
        updatedAt: new Date(),
      },
    });

  // ROLLUPS_FOLLOW_FILLS: fold this wallet's new fills into the daily rollup
  // AFTER the fills upsert settles (per-wallet writer serialization is what
  // makes the insertion-key watermark sound — see fill-rollup-service.ts).
  // Bounded batches per tick; a boot backfill holding the cursor wins via
  // NOWAIT-skip. DB-only, so a failure is logged and never fails the wallet
  // or writes a cursor-error row.
  let rollupFills = 0;
  if (!deps.signal?.aborted) {
    try {
      const rollup = await accumulateFillRollups(deps.db, {
        traderWalletId: deps.wallet.id,
        maxBatches: TICK_ROLLUP_MAX_BATCHES,
        skipIfLocked: true,
        signal: deps.signal,
      });
      rollupFills = rollup.fills;
      if (!rollup.caughtUp || rollup.batches > 1) {
        deps.logger.info(
          {
            event: "poly.fill_rollup.tick_accumulate",
            trader_wallet_id: deps.wallet.id,
            wallet: deps.wallet.walletAddress,
            fills: rollup.fills,
            batches: rollup.batches,
            caught_up: rollup.caughtUp,
            skipped_locked: rollup.skippedLocked,
          },
          "fill-rollup tick accumulate draining backlog"
        );
      }
    } catch (err: unknown) {
      if (deps.signal?.aborted) throw err;
      deps.logger.warn(
        {
          event: "poly.fill_rollup.tick_accumulate_error",
          trader_wallet_id: deps.wallet.id,
          wallet: deps.wallet.walletAddress,
          err: err instanceof Error ? err.message : String(err),
        },
        "fill-rollup tick accumulate failed — readers fall back to the live tail"
      );
    }
  }

  deps.logger.info(
    {
      event: "poly.trader.observe",
      phase: "wallet_ok",
      trader_wallet_id: deps.wallet.id,
      wallet: deps.wallet.walletAddress,
      kind: deps.wallet.kind,
      fills: insertedFills,
      positions: positionResult.positions,
      positions_complete: positionResult.complete,
      positions_skipped: positionResult.skipped,
      rollup_fills: rollupFills,
      new_since: observed.newSince,
      duration_ms: Date.now() - startedAt,
    },
    "trader wallet observed"
  );

  return { fills: insertedFills, positions: positionResult.positions, rollupFills };
}

async function upsertObservedFills(
  db: Db,
  traderWalletId: string,
  fills: readonly Fill[]
): Promise<number> {
  if (fills.length === 0) return 0;
  const values = fills.flatMap((fill) => {
    const conditionId = readString(fill.attributes, "condition_id");
    const tokenId = readString(fill.attributes, "asset");
    if (!conditionId || !tokenId || fill.price <= 0) return [];
    const shares = fill.size_usdc / fill.price;
    return [
      {
        traderWalletId,
        source: fill.source,
        nativeId: fill.fill_id,
        conditionId,
        tokenId,
        side: fill.side,
        price: fill.price.toFixed(8),
        shares: shares.toFixed(8),
        sizeUsdc: fill.size_usdc.toFixed(8),
        txHash: readString(fill.attributes, "transaction_hash"),
        observedAt: new Date(fill.observed_at),
        raw: fill as unknown as Record<string, unknown>,
      },
    ];
  });
  if (values.length === 0) return 0;
  await db
    .insert(polyTraderFills)
    .values(values)
    .onConflictDoNothing({
      target: [
        polyTraderFills.traderWalletId,
        polyTraderFills.source,
        polyTraderFills.nativeId,
      ],
    });
  return values.length;
}

async function observePositionsIfDue(
  deps: TraderObservationTickDeps & { wallet: PolyTraderWallet }
): Promise<{ positions: number; complete: boolean; skipped: boolean }> {
  const cursor = await deps.db
    .select()
    .from(polyTraderIngestionCursors)
    .where(
      and(
        eq(polyTraderIngestionCursors.traderWalletId, deps.wallet.id),
        eq(polyTraderIngestionCursors.source, POSITION_SOURCE)
      )
    )
    .limit(1);
  const pollMs = deps.positionPollMs ?? DEFAULT_POSITION_POLL_MS;
  const lastSuccessAt = cursor[0]?.lastSuccessAt;
  if (lastSuccessAt && Date.now() - lastSuccessAt.getTime() < pollMs) {
    return {
      positions: 0,
      complete: cursor[0]?.status === "ok",
      skipped: true,
    };
  }

  const result = await observePositionsSerialized({
    db: deps.db,
    client: deps.client,
    wallet: deps.wallet,
    maxPages: deps.positionMaxPages ?? DEFAULT_POSITION_MAX_PAGES,
    signal: deps.signal,
    readPositionBalances: deps.readPositionBalances,
    logger: deps.logger,
  });
  return {
    positions: result.positionRows,
    complete: result.complete,
    skipped: false,
  };
}

async function observePositionsNow(deps: {
  db: Db;
  client: PolymarketDataApiClient;
  wallet: PolyTraderWallet;
  positionMaxPages?: number;
  readPositionBalances?: PositionBalanceBatchReader;
  beforePositionCursorPublish?: () => void | Promise<void>;
  logger?: LoggerPort;
  signal?: AbortSignal | undefined;
}): Promise<CurrentPositionRefreshResult> {
  const result = await observePositionsSerialized({
    db: deps.db,
    client: deps.client,
    wallet: deps.wallet,
    maxPages: deps.positionMaxPages ?? DEFAULT_POSITION_MAX_PAGES,
    readPositionBalances: deps.readPositionBalances,
    beforePositionCursorPublish: deps.beforePositionCursorPublish,
    logger: deps.logger,
    signal: deps.signal,
  });
  return {
    positions: result.observedPositions,
    positionRows: result.positionRows,
    complete: result.complete,
    stalePositionRowsDeactivated: result.stalePositionRowsDeactivated,
    stalePositionRowsPreserved: result.stalePositionRowsPreserved,
    ...(result.failureReason === undefined
      ? {}
      : { failureReason: result.failureReason }),
  };
}

async function observePositionsSerialized(deps: {
  db: Db;
  client: PolymarketDataApiClient;
  wallet: PolyTraderWallet;
  maxPages: number;
  signal?: AbortSignal | undefined;
  readPositionBalances?: PositionBalanceBatchReader | undefined;
  beforePositionCursorPublish?: (() => void | Promise<void>) | undefined;
  logger?: LoggerPort | undefined;
}): Promise<PersistedCurrentPositions & {
  failureReason?: PositionObservationFailureReason;
}> {
  const startedAt = Date.now();
  let lastPositions: PolymarketUserPosition[] = [];
  let lastOmissionCount = 0;
  let lastPages = 0;
  let lastAuthority = emptyAuthorityResult("authority_unavailable");
  let lastState: PositionPrepareState | undefined;
  for (let attempt = 0; attempt < POSITION_PUBLISH_MAX_ATTEMPTS; attempt += 1) {
    deps.signal?.throwIfAborted();
    const state = await readPositionPrepareState(deps.db, deps.wallet.id);
    lastState = state;
    let pageResult: {
      positions: PolymarketUserPosition[];
      complete: boolean;
      pages: number;
    };
    try {
      pageResult = await fetchTraderPositionsPages({
        client: deps.client,
        walletAddress: deps.wallet.walletAddress,
        maxPages: deps.maxPages,
        signal: deps.signal,
      });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      const published = await publishPositionFailure({
        db: deps.db,
        wallet: deps.wallet,
        state,
        signal: deps.signal,
        reason: "data_api_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      if (published === "superseded") continue;
      logPositionPublication(deps, {
        state,
        status: "data_api_error",
        reason: "data_api_error",
        pages: 0,
        fetchedCount: 0,
        omittedCount: 0,
        authority: emptyAuthorityResult("authority_unavailable"),
        published: false,
        startedAt,
      });
      return failedPositionResult([], 0, "data_api_error");
    }

    lastPositions = pageResult.positions;
    lastPages = pageResult.pages;
    if (!pageResult.complete) {
      const published = await publishPositionFailure({
        db: deps.db,
        wallet: deps.wallet,
        state,
        signal: deps.signal,
        reason: "data_api_incomplete",
        detail: `position page cap reached at ${pageResult.positions.length} rows`,
      });
      if (published === "superseded") continue;
      logPositionPublication(deps, {
        state,
        status: "data_api_incomplete",
        reason: "data_api_incomplete",
        pages: pageResult.pages,
        fetchedCount: pageResult.positions.length,
        omittedCount: 0,
        authority: emptyAuthorityResult("authority_unavailable"),
        published: false,
        startedAt,
      });
      return failedPositionResult(
        pageResult.positions,
        0,
        "data_api_incomplete"
      );
    }
    if (!pageResult.positions.every(isValidObservedPosition)) {
      const published = await publishPositionFailure({
        db: deps.db,
        wallet: deps.wallet,
        state,
        signal: deps.signal,
        reason: "data_api_malformed",
        detail: "Data API returned a malformed position row",
      });
      if (published === "superseded") continue;
      logPositionPublication(deps, {
        state,
        status: "data_api_malformed",
        reason: "data_api_malformed",
        pages: pageResult.pages,
        fetchedCount: pageResult.positions.length,
        omittedCount: 0,
        authority: emptyAuthorityResult("authority_unavailable"),
        published: false,
        startedAt,
      });
      return failedPositionResult(
        pageResult.positions,
        0,
        "data_api_malformed"
      );
    }

    const omitted = await readOmittedCurrentPositions({
      db: deps.db,
      wallet: deps.wallet,
      positions: pageResult.positions,
    });
    deps.signal?.throwIfAborted();
    lastOmissionCount = omitted.length;
    if (omitted.length >= POSITION_OMISSION_LIMIT) {
      const published = await publishPositionFailure({
        db: deps.db,
        wallet: deps.wallet,
        state,
        signal: deps.signal,
        reason: "omission_over_cap",
        detail: `omitted position cap exceeded (${POSITION_MAX_ROWS})`,
      });
      if (published === "superseded") continue;
      logPositionPublication(deps, {
        state,
        status: "omission_over_cap",
        reason: "omission_over_cap",
        pages: pageResult.pages,
        fetchedCount: pageResult.positions.length,
        omittedCount: POSITION_OMISSION_LIMIT,
        authority: emptyAuthorityResult("authority_unavailable"),
        published: false,
        startedAt,
      });
      return failedPositionResult(
        pageResult.positions,
        omitted.length,
        "omission_over_cap"
      );
    }

    const authority = await classifyMissingPositionsWithBalances({
      walletAddress: deps.wallet.walletAddress,
      positions: omitted,
      readPositionBalances: deps.readPositionBalances,
      signal: deps.signal,
    });
    lastAuthority = authority;
    if (authority.reason !== "all_zero") {
      const published = await publishPositionFailure({
        db: deps.db,
        wallet: deps.wallet,
        state,
        signal: deps.signal,
        reason: authority.reason,
        detail: `${omitted.length} Data API omissions were not all proven exact-zero on Polygon`,
      });
      if (published === "superseded") continue;
      logPositionPublication(deps, {
        state,
        status: authority.reason,
        reason: authority.reason,
        pages: pageResult.pages,
        fetchedCount: pageResult.positions.length,
        omittedCount: omitted.length,
        authority,
        published: false,
        startedAt,
      });
      return failedPositionResult(
        pageResult.positions,
        omitted.length,
        authority.reason
      );
    }

    const published = await publishPreparedPositions({
      db: deps.db,
      wallet: deps.wallet,
      prepared: { state, positions: pageResult.positions, omitted },
      signal: deps.signal,
      beforePositionCursorPublish: deps.beforePositionCursorPublish,
    });
    if (published === "superseded") continue;
    logPositionPublication(deps, {
      state,
      status: "ok",
      reason: "complete_all_zero",
      pages: pageResult.pages,
      fetchedCount: pageResult.positions.length,
      omittedCount: omitted.length,
      authority,
      published: true,
      startedAt,
    });
    return published;
  }

  if (lastState !== undefined) {
    logPositionPublication(deps, {
      state: lastState,
      status: "superseded_exhausted",
      reason: "superseded_exhausted",
      pages: lastPages,
      fetchedCount: lastPositions.length,
      omittedCount: lastOmissionCount,
      authority: lastAuthority,
      published: false,
      startedAt,
    });
  }
  return failedPositionResult(
    lastPositions,
    lastOmissionCount,
    "superseded_exhausted"
  );
}

function logPositionPublication(
  deps: {
    logger?: LoggerPort | undefined;
    wallet: PolyTraderWallet;
    readPositionBalances?: PositionBalanceBatchReader | undefined;
  },
  input: {
    state: PositionPrepareState;
    status: "ok" | PositionObservationFailureReason;
    reason: string;
    pages: number;
    fetchedCount: number;
    omittedCount: number;
    authority: PositionAuthorityResult;
    published: boolean;
    startedAt: number;
  }
): void {
  deps.logger?.info(
    {
      event: "poly.trader.positions.publish",
      status: normalizePositionPublishStatus(input.status),
      reason: input.reason,
      observation_time: input.state.capturedAt,
      wallet: deps.wallet.walletAddress,
      pages: input.pages,
      observed_count: input.fetchedCount,
      omitted_count: input.omittedCount,
      classified_count: input.authority.classifiedCount,
      zero_count: input.authority.zeroCount,
      nonzero_count: input.authority.nonzeroCount,
      chunk_count: input.authority.chunkCount,
      cursor_before_status: input.state.cursor.status ?? "missing",
      cursor_after_status: input.published
        ? "ok"
        : normalizePositionPublishStatus(input.status),
      published: input.published,
      duration_ms: Date.now() - input.startedAt,
    },
    "trader positions publication finished"
  );
}

function normalizePositionPublishStatus(
  status: "ok" | PositionObservationFailureReason
): "published" | "partial" | "stale" | "error" | "superseded" {
  if (status === "ok") return "published";
  if (status === "data_api_incomplete" || status === "omission_over_cap") {
    return "partial";
  }
  if (status === "authority_nonzero") return "stale";
  if (status === "superseded_exhausted") return "superseded";
  return "error";
}

function emptyAuthorityResult(
  reason: PositionAuthorityResult["reason"]
): PositionAuthorityResult {
  return {
    reason,
    classifiedCount: 0,
    zeroCount: 0,
    nonzeroCount: 0,
    chunkCount: 0,
  };
}

function failedPositionResult(
  positions: PolymarketUserPosition[],
  preservedRows: number,
  failureReason: PositionObservationFailureReason
): PersistedCurrentPositions & {
  failureReason: PositionObservationFailureReason;
} {
  return {
    observedPositions: positions,
    positionRows: 0,
    complete: false,
    stalePositionRowsDeactivated: 0,
    stalePositionRowsPreserved: preservedRows,
    failureReason,
  };
}

async function readPositionPrepareState(
  db: Db,
  traderWalletId: string
): Promise<PositionPrepareState> {
  const result = await db.execute(sql`
    SELECT
      clock_timestamp()::text AS captured_at,
      EXISTS (
        SELECT 1
        FROM poly_trader_ingestion_cursors c
        WHERE c.trader_wallet_id = ${traderWalletId}::uuid
          AND c.source = ${POSITION_SOURCE}
      ) AS row_exists,
      (
        SELECT c.xmin::text
        FROM poly_trader_ingestion_cursors c
        WHERE c.trader_wallet_id = ${traderWalletId}::uuid
          AND c.source = ${POSITION_SOURCE}
      ) AS cursor_xmin,
      (
        SELECT c.last_success_at::text
        FROM poly_trader_ingestion_cursors c
        WHERE c.trader_wallet_id = ${traderWalletId}::uuid
          AND c.source = ${POSITION_SOURCE}
      ) AS last_success_at,
      (
        SELECT c.status
        FROM poly_trader_ingestion_cursors c
        WHERE c.trader_wallet_id = ${traderWalletId}::uuid
          AND c.source = ${POSITION_SOURCE}
      ) AS cursor_status
  `);
  const row = executionRows<{
    captured_at: string;
    row_exists: boolean;
    cursor_xmin: string | null;
    last_success_at: string | null;
    cursor_status: string | null;
  }>(result)[0];
  if (!row) throw new Error("position prepare state query returned no row");
  return {
    capturedAt: row.captured_at,
    cursor: {
      rowExists: row.row_exists,
      xmin: row.cursor_xmin,
      lastSuccessAt: row.last_success_at,
      status: row.cursor_status,
    },
  };
}

async function readOmittedCurrentPositions(input: {
  db: Db;
  wallet: PolyTraderWallet;
  positions: readonly PolymarketUserPosition[];
  lockRows?: boolean;
}): Promise<MissingCurrentPosition[]> {
  const observedKeys = JSON.stringify(
    input.positions.map((position) => ({
      condition_id: position.conditionId,
      token_id: position.asset,
    }))
  );
  const result = await input.db.execute(sql`
    SELECT
      p.condition_id,
      p.token_id,
      p.shares::text,
      p.current_value_usdc::text,
      p.last_observed_at
    FROM poly_trader_current_positions p
    WHERE p.trader_wallet_id = ${input.wallet.id}::uuid
      AND p.active = true
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(${observedKeys}::jsonb)
          AS observed(condition_id text, token_id text)
        WHERE observed.condition_id = p.condition_id
          AND observed.token_id = p.token_id
      )
    ORDER BY p.last_observed_at, p.condition_id, p.token_id
    LIMIT ${POSITION_OMISSION_LIMIT}
    ${input.lockRows ? sql`FOR UPDATE OF p` : sql``}
  `);
  return executionRows<{
    condition_id: string;
    token_id: string;
    shares: string;
    current_value_usdc: string;
    last_observed_at: Date | string;
  }>(result).map((row) => ({
    conditionId: row.condition_id,
    tokenId: row.token_id,
    shares: Number(row.shares),
    currentValueUsdc: Number(row.current_value_usdc),
    lastObservedAt:
      row.last_observed_at instanceof Date
        ? row.last_observed_at
        : new Date(row.last_observed_at),
  }));
}

export async function classifyMissingPositionsWithBalances(input: {
  walletAddress: string;
  positions: readonly MissingCurrentPosition[];
  readPositionBalances?: PositionBalanceBatchReader | undefined;
  signal?: AbortSignal | undefined;
}): Promise<PositionAuthorityResult> {
  input.signal?.throwIfAborted();
  if (input.positions.length === 0) return emptyAuthorityResult("all_zero");
  if (input.readPositionBalances === undefined) {
    return emptyAuthorityResult("authority_unavailable");
  }

  const startedAt = Date.now();
  let classifiedCount = 0;
  let zeroCount = 0;
  let nonzeroCount = 0;
  let chunkCount = 0;
  const chunks = Math.ceil(
    input.positions.length / POSITION_BALANCE_CHUNK_SIZE
  );
  if (chunks > POSITION_BALANCE_MAX_CHUNKS) {
    return emptyAuthorityResult("authority_malformed");
  }
  for (let offset = 0; offset < input.positions.length; offset += POSITION_BALANCE_CHUNK_SIZE) {
    input.signal?.throwIfAborted();
    const elapsed = Date.now() - startedAt;
    const remainingTotal = POSITION_BALANCE_TOTAL_TIMEOUT_MS - elapsed;
    if (remainingTotal <= 0) {
      return {
        reason: "authority_unavailable",
        classifiedCount,
        zeroCount,
        nonzeroCount,
        chunkCount,
      };
    }
    const chunk = input.positions.slice(
      offset,
      offset + POSITION_BALANCE_CHUNK_SIZE
    );
    let balances: readonly bigint[];
    try {
      chunkCount += 1;
      balances = await readBalanceChunkWithDeadline({
        read: input.readPositionBalances,
        walletAddress: input.walletAddress,
        tokenIds: chunk.map((position) => position.tokenId),
        timeoutMs: Math.min(
          POSITION_BALANCE_CHUNK_TIMEOUT_MS,
          remainingTotal
        ),
        parentSignal: input.signal,
      });
    } catch (err) {
      if (input.signal?.aborted) throw err;
      return {
        reason: "authority_unavailable",
        classifiedCount,
        zeroCount,
        nonzeroCount,
        chunkCount,
      };
    }
    const decision = classifyMissingPositionBalances(balances, chunk.length);
    if (decision === "authority_malformed") {
      return {
        reason: decision,
        classifiedCount,
        zeroCount,
        nonzeroCount,
        chunkCount,
      };
    }
    const chunkZeroCount = balances.filter((balance) => balance === 0n).length;
    classifiedCount += balances.length;
    zeroCount += chunkZeroCount;
    nonzeroCount += balances.length - chunkZeroCount;
  }
  return {
    reason: nonzeroCount > 0 ? "authority_nonzero" : "all_zero",
    classifiedCount,
    zeroCount,
    nonzeroCount,
    chunkCount,
  };
}

async function readBalanceChunkWithDeadline(input: {
  read: PositionBalanceBatchReader;
  walletAddress: string;
  tokenIds: readonly string[];
  timeoutMs: number;
  parentSignal?: AbortSignal | undefined;
}): Promise<readonly bigint[]> {
  const controller = new AbortController();
  const abortFromParent = (): void =>
    controller.abort(input.parentSignal?.reason);
  if (input.parentSignal?.aborted) abortFromParent();
  else input.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      input.read({
        walletAddress: input.walletAddress,
        tokenIds: input.tokenIds,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error(
              `position authority timed out after ${input.timeoutMs}ms`
            );
            controller.abort(error);
            reject(error);
          },
          input.timeoutMs
        );
        timer.unref?.();
      }),
      new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () =>
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("position authority aborted")
          );
        if (controller.signal.aborted) rejectOnAbort();
        else controller.signal.addEventListener("abort", rejectOnAbort, {
          once: true,
        });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (rejectOnAbort !== undefined) {
      controller.signal.removeEventListener("abort", rejectOnAbort);
    }
    input.parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function publishPreparedPositions(input: {
  db: Db;
  wallet: PolyTraderWallet;
  prepared: PreparedPositionPublication;
  signal?: AbortSignal | undefined;
  beforePositionCursorPublish?: (() => void | Promise<void>) | undefined;
}): Promise<PersistedCurrentPositions | "superseded"> {
  input.signal?.throwIfAborted();
  return await withStatementTimeout(
    input.db,
    OBSERVATION_STATEMENT_TIMEOUT_MS,
    async (tx) => {
      await lockPositionWriter(tx, input.wallet.id);
      if (
        !(await positionCursorStillCurrent(
          tx,
          input.wallet.id,
          input.prepared.state
        ))
      ) {
        return "superseded";
      }
      const lockedOmissions = await readOmittedCurrentPositions({
        db: tx,
        wallet: input.wallet,
        positions: input.prepared.positions,
        lockRows: true,
      });
      if (!samePositionKeys(lockedOmissions, input.prepared.omitted)) {
        // `poly_trader_current_positions` is not versioned by the ingestion
        // cursor. Re-reading under the per-wallet writer lock closes the
        // out-of-band-row-change gap: no active omission may be deactivated
        // unless this exact preparation proved its bigint balance was zero.
        return "superseded";
      }
      return await persistPreparedCurrentPositions(
        tx,
        input.wallet,
        input.prepared,
        input.beforePositionCursorPublish
      );
    }
  );
}

function samePositionKeys(
  left: readonly Pick<MissingCurrentPosition, "conditionId" | "tokenId">[],
  right: readonly Pick<MissingCurrentPosition, "conditionId" | "tokenId">[]
): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(
    left.map((position) => `${position.conditionId}\u0000${position.tokenId}`)
  );
  return right.every((position) =>
    keys.has(`${position.conditionId}\u0000${position.tokenId}`)
  );
}

async function persistPreparedCurrentPositions(
  db: Db,
  wallet: PolyTraderWallet,
  prepared: PreparedPositionPublication,
  beforePositionCursorPublish?: () => void | Promise<void>
): Promise<PersistedCurrentPositions> {
  const positions = prepared.positions;
  const capturedAt = new Date(prepared.state.capturedAt);
  const values = positions.map((position) => {
    const contentHash = hashPosition(position);
    return {
      traderWalletId: wallet.id,
      conditionId: position.conditionId,
      tokenId: position.asset,
      shares: Math.max(0, position.size).toFixed(8),
      costBasisUsdc: positionCostUsdc(position).toFixed(8),
      currentValueUsdc: Math.max(0, position.currentValue).toFixed(8),
      avgPrice: Math.max(0, position.avgPrice).toFixed(8),
      contentHash,
      capturedAt,
      raw: position as unknown as Record<string, unknown>,
    };
  });
  if (values.length > 0) {
    await db
      .insert(polyTraderPositionSnapshots)
      .values(values)
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
        values.map((value) => ({
          traderWalletId: value.traderWalletId,
          conditionId: value.conditionId,
          tokenId: value.tokenId,
          active: true,
          shares: value.shares,
          costBasisUsdc: value.costBasisUsdc,
          currentValueUsdc: value.currentValueUsdc,
          avgPrice: value.avgPrice,
          contentHash: value.contentHash,
          lastObservedAt: capturedAt,
          raw: value.raw,
        }))
      )
      .onConflictDoUpdate({
        target: [
          polyTraderCurrentPositions.traderWalletId,
          polyTraderCurrentPositions.conditionId,
          polyTraderCurrentPositions.tokenId,
        ],
        set: {
          active: true,
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
  // Resolved-loser terminality is independent of Data-API omission and is
  // retained from the existing writer contract. It executes in this same
  // publication transaction so a later cursor failure rolls it back with
  // snapshots/current upserts and exact-zero omission deactivations.
  await db
    .update(polyTraderCurrentPositions)
    .set({ active: false, lastObservedAt: capturedAt })
    .where(
      and(
        eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
        eq(polyTraderCurrentPositions.active, true),
        exists(
          db
            .select({ one: sql`1` })
            .from(polyMarketOutcomes)
            .where(
              and(
                eq(
                  polyMarketOutcomes.conditionId,
                  polyTraderCurrentPositions.conditionId
                ),
                eq(
                  polyMarketOutcomes.tokenId,
                  polyTraderCurrentPositions.tokenId
                ),
                eq(polyMarketOutcomes.outcome, "loser")
              )
            )
        )
      )
    );
  if (prepared.omitted.length > 0) {
    const omittedKeys = JSON.stringify(
      prepared.omitted.map((position) => ({
        condition_id: position.conditionId,
        token_id: position.tokenId,
      }))
    );
    await db.execute(sql`
      UPDATE poly_trader_current_positions p
      SET
        active = false,
        shares = 0,
        cost_basis_usdc = 0,
        current_value_usdc = 0,
        avg_price = 0,
        last_observed_at = ${prepared.state.capturedAt}::timestamptz
      WHERE p.trader_wallet_id = ${wallet.id}::uuid
        AND p.active = true
        AND EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${omittedKeys}::jsonb)
            AS omitted(condition_id text, token_id text)
          WHERE omitted.condition_id = p.condition_id
            AND omitted.token_id = p.token_id
        )
    `);
  }

  // This hook deliberately executes after every current/snapshot/terminal
  // write but before the cursor write, inside the same transaction. Component
  // tests use it to prove a cursor-publication failure rolls the whole bundle
  // back without requiring privileged trigger DDL.
  await beforePositionCursorPublish?.();

  await db
    .insert(polyTraderIngestionCursors)
    .values({
      traderWalletId: wallet.id,
      source: POSITION_SOURCE,
      lastSuccessAt: capturedAt,
      status: "ok",
      errorMessage: null,
      updatedAt: capturedAt,
    })
    .onConflictDoUpdate({
      target: [
        polyTraderIngestionCursors.traderWalletId,
        polyTraderIngestionCursors.source,
      ],
      set: {
        lastSuccessAt: capturedAt,
        status: "ok",
        errorMessage: null,
        updatedAt: capturedAt,
      },
    });

  return {
    observedPositions: positions,
    positionRows: values.length,
    complete: true,
    stalePositionRowsDeactivated: prepared.omitted.length,
    stalePositionRowsPreserved: 0,
  };
}

async function publishPositionFailure(input: {
  db: Db;
  wallet: PolyTraderWallet;
  state: PositionPrepareState;
  signal?: AbortSignal | undefined;
  reason: PositionObservationFailureReason;
  detail: string;
}): Promise<"published" | "superseded"> {
  input.signal?.throwIfAborted();
  return await withStatementTimeout(
    input.db,
    OBSERVATION_STATEMENT_TIMEOUT_MS,
    async (tx) => {
      await lockPositionWriter(tx, input.wallet.id);
      if (!(await positionCursorStillCurrent(tx, input.wallet.id, input.state))) {
        return "superseded";
      }
      const status =
        input.reason === "data_api_incomplete" ||
        input.reason === "omission_over_cap"
          ? "partial"
          : input.reason === "authority_nonzero"
            ? "stale"
            : "error";
      const capturedAt = new Date(input.state.capturedAt);
      await tx
        .insert(polyTraderIngestionCursors)
        .values({
          traderWalletId: input.wallet.id,
          source: POSITION_SOURCE,
          status,
          errorMessage: `${input.reason}: ${input.detail}`,
          updatedAt: capturedAt,
        })
        .onConflictDoUpdate({
          target: [
            polyTraderIngestionCursors.traderWalletId,
            polyTraderIngestionCursors.source,
          ],
          set: {
            status,
            errorMessage: `${input.reason}: ${input.detail}`,
            updatedAt: capturedAt,
          },
        });
      return "published";
    }
  );
}

async function lockPositionWriter(db: Db, traderWalletId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`poly:positions:${traderWalletId}`}, 0))`
  );
}

async function positionCursorStillCurrent(
  db: Db,
  traderWalletId: string,
  state: PositionPrepareState
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT
      c.xmin::text AS cursor_xmin,
      c.last_success_at::text AS last_success_at,
      (
        c.last_success_at IS NULL
        OR c.last_success_at < ${state.capturedAt}::timestamptz
      ) AS monotonic
    FROM poly_trader_ingestion_cursors c
    WHERE c.trader_wallet_id = ${traderWalletId}::uuid
      AND c.source = ${POSITION_SOURCE}
    FOR UPDATE
  `);
  const row = executionRows<{
    cursor_xmin: string;
    last_success_at: string | null;
    monotonic: boolean;
  }>(result)[0];
  if (state.cursor.rowExists !== (row !== undefined)) return false;
  if (!state.cursor.rowExists) return true;
  return row?.cursor_xmin === state.cursor.xmin && row.monotonic;
}

function executionRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function isValidObservedPosition(position: PolymarketUserPosition): boolean {
  return (
    typeof position.conditionId === "string" &&
    position.conditionId.length > 0 &&
    typeof position.asset === "string" &&
    position.asset.length > 0 &&
    Number.isFinite(position.size) &&
    position.size >= 0 &&
    Number.isFinite(position.avgPrice) &&
    position.avgPrice >= 0 &&
    Number.isFinite(position.initialValue) &&
    position.initialValue >= 0 &&
    Number.isFinite(position.currentValue) &&
    position.currentValue >= 0
  );
}

export async function fetchTraderPositionsPages(params: {
  client: PolymarketDataApiClient;
  walletAddress: string;
  maxPages: number;
  /** Cooperative cancellation (task.5015): checked before each page and passed to the fetch. */
  signal?: AbortSignal | undefined;
}): Promise<{
  positions: PolymarketUserPosition[];
  complete: boolean;
  pages: number;
}> {
  const maxPages = Math.min(
    DEFAULT_POSITION_MAX_PAGES,
    Math.max(1, params.maxPages)
  );
  const positions: PolymarketUserPosition[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    params.signal?.throwIfAborted();
    const pagePositions = await params.client.listUserPositions(
      params.walletAddress,
      {
        sizeThreshold: 0,
        limit: POSITION_FETCH_LIMIT,
        offset: page * POSITION_FETCH_LIMIT,
        signal: params.signal,
      }
    );
    positions.push(...pagePositions.slice(0, POSITION_FETCH_LIMIT));
    if (pagePositions.length > POSITION_FETCH_LIMIT) {
      return { positions, complete: false, pages: page + 1 };
    }
    if (pagePositions.length < POSITION_FETCH_LIMIT) {
      return {
        positions: dedupePositions(positions),
        complete: true,
        pages: page + 1,
      };
    }
  }
  return { positions, complete: false, pages: maxPages };
}

function dedupePositions(
  positions: readonly PolymarketUserPosition[]
): PolymarketUserPosition[] {
  return [
    ...new Map(
      positions.map((position) => [
        `${position.conditionId}\u0000${position.asset}`,
        position,
      ])
    ).values(),
  ];
}

async function markCursorError(
  db: Db,
  traderWalletId: string,
  err: unknown,
  source = TRADE_SOURCE
): Promise<void> {
  await db
    .insert(polyTraderIngestionCursors)
    .values({
      traderWalletId,
      source,
      lastErrorAt: new Date(),
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        polyTraderIngestionCursors.traderWalletId,
        polyTraderIngestionCursors.source,
      ],
      set: {
        lastErrorAt: new Date(),
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      },
    });
}

function positionCostUsdc(
  position: Pick<PolymarketUserPosition, "initialValue" | "size" | "avgPrice">
): number {
  if (Number.isFinite(position.initialValue) && position.initialValue > 0) {
    return position.initialValue;
  }
  return Math.max(0, position.size * position.avgPrice);
}

/**
 * Content hash for snapshot dedupe (`onConflictDoNothing` on
 * `poly_trader_position_snapshots_hash_idx`). Covers ONLY position-defining
 * fields: `conditionId`, `asset`, `size`, `avgPrice`, `initialValue`.
 *
 * Mark-to-market fields (`currentValue`, `curPrice`) are deliberately
 * EXCLUDED (task.5012): including them made every 5-min poll of an active
 * position in a liquid market produce a new full-JSONB row (~288 rows/day/
 * position) because the mark always moves. Mark-to-market history is
 * delegated to `poly_market_price_history` + `poly_trader_user_pnl_points`;
 * live marks for still-held positions come from
 * `poly_trader_current_positions` (upserted fresh every tick). A snapshot
 * row therefore means "the position itself changed", and its embedded
 * `current_value_usdc`/`raw.currentValue` are only the mark as of that
 * change — readers needing a live mark must join current_positions (see
 * `market-exposure-service.ts` `readTargetLegs`).
 */
export function hashPosition(position: PolymarketUserPosition): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        conditionId: position.conditionId,
        asset: position.asset,
        size: position.size,
        avgPrice: position.avgPrice,
        initialValue: position.initialValue,
      })
    )
    .digest("hex");
}

/**
 * Retention helper (task.5012): prune `poly_trader_position_snapshots` rows
 * older than {@link SNAPSHOT_RETENTION_DAYS}, EXCEPT the newest row of each
 * (trader_wallet_id, condition_id, token_id) group — that row is the durable
 * last-observed record `readTargetLegs` depends on (see the retention-days
 * docstring). Deletes run in `batchSize`-bounded statements, at most
 * `maxBatches` per call, so the first prune of a multi-million-row backlog
 * never holds a long-running delete; the remainder drains on later ticks.
 *
 * Index support: the candidate scan (`captured_at < cutoff`) uses
 * `poly_trader_position_snapshots_captured_at_idx`; the has-newer-row probe
 * uses `poly_trader_position_snapshots_market_latest_idx`.
 */
/**
 * Per-statement ceiling for the observation loop's maintenance writes
 * (bug.5297). These run inside a tick whose abort CANNOT reach them —
 * drizzle/postgres-js take no `AbortSignal` — so the only thing that can stop a
 * wedged one is Postgres itself.
 *
 * Aimed, not guessed: prod stage telemetry (added for bug.5273) named the
 * hanging stages as `prune_position_snapshots` (3x) and
 * `refresh_market_metadata` (2x), and the operator's VM evidence independently
 * showed those same tables wedged — `poly_trader_position_snapshots` INSERTs at
 * 729s and autovacuum on `poly_trader_current_positions` blocked 1240s.
 *
 * Well under TICK_TIMEOUT_MS (120s) so the statement dies before the tick does:
 * a killed statement is a logged, bounded failure the next tick retries, while
 * a wedged one holds locks and stacks writes until the box swaps.
 */
export const OBSERVATION_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Wall-clock budget for ONE maintenance stage (bug.5297). Sized so that even a
 * stage that uses its whole budget leaves the 120s tick room to finish the
 * others: 3 maintenance stages x 30s = 90s < TICK_TIMEOUT_MS.
 *
 * This is the bound `statement_timeout` could not provide — see
 * OBSERVATION_STATEMENT_TIMEOUT_MS.
 */
export const OBSERVATION_STAGE_DEADLINE_MS = 30_000;

/**
 * Run `fn` with a session-local `statement_timeout`. SET LOCAL is
 * transaction-scoped, so the ceiling cannot leak to other pool users — the
 * pool is shared with request-path reads that must not inherit it.
 */
export async function withStatementTimeout<T>(
  db: Db,
  timeoutMs: number,
  fn: (tx: Db) => Promise<T>
): Promise<T> {
  return await (db as unknown as {
    transaction: <R>(cb: (tx: Db) => Promise<R>) => Promise<R>;
  }).transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`)
    );
    return await fn(tx);
  });
}

export async function pruneOldPositionSnapshots(
  db: Db,
  options?: {
    batchSize?: number;
    maxBatches?: number;
    /**
     * STAGE_DEADLINE_BOUNDS_THE_LOOP (bug.5297) — wall-clock ceiling for the
     * WHOLE stage. A per-statement `statement_timeout` cannot bound a loop:
     * bug.5297's 30s cap left a worst case of maxBatches x 30s = 300s, still
     * 2.5x over the 120s tick budget, with every individual statement legally
     * under its ceiling. Prod f695861 proved it — 10 tick timeouts still at
     * `prune_position_snapshots`, and ZERO statement-timeout errors, which is
     * exactly the signature of a loop whose statements are each fine.
     *
     * Absent, behaviour is unchanged (batch count is the only bound).
     */
    deadlineMs?: number;
    /**
     * Clock seam. The deadline is wall-clock by nature, so a test that races a
     * real `setTimeout` against a real `Date.now()` is flaky under load — it
     * can spend the whole budget before the first batch even starts. Tests
     * drive time explicitly instead. Production leaves this unset.
     */
    now?: () => number;
  }
): Promise<{ deleted: number; exhaustedBudget: boolean }> {
  const batchSize = options?.batchSize ?? SNAPSHOT_PRUNE_BATCH_SIZE;
  const maxBatches = options?.maxBatches ?? SNAPSHOT_PRUNE_MAX_BATCHES;
  const now = options?.now ?? Date.now;
  const deadline =
    options?.deadlineMs === undefined ? undefined : now() + options.deadlineMs;
  // ISO string + explicit cast: postgres-js cannot serialize a raw Date
  // parameter through `db.execute(sql...)` (no drizzle column mapper here).
  const cutoff = new Date(
    Date.now() - SNAPSHOT_RETENTION_DAYS * 86_400_000
  ).toISOString();
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    // Stop STARTING new batches once the stage has spent its budget. Checked
    // before the statement, never mid-statement: a half-killed DELETE would
    // leave the prune non-idempotent, and the next tick resumes from the same
    // cutoff anyway, so stopping early only defers work.
    if (deadline !== undefined && now() >= deadline) {
      return { deleted, exhaustedBudget: true };
    }
    const result = await db.execute(sql`
      DELETE FROM poly_trader_position_snapshots
      WHERE id IN (
        SELECT s.id
        FROM poly_trader_position_snapshots s
        WHERE s.captured_at < ${cutoff}::timestamptz
          AND EXISTS (
            SELECT 1
            FROM poly_trader_position_snapshots newer
            WHERE newer.trader_wallet_id = s.trader_wallet_id
              AND newer.condition_id = s.condition_id
              AND newer.token_id = s.token_id
              AND newer.captured_at > s.captured_at
          )
        LIMIT ${batchSize}
      )
    `);
    // drizzle returns driver-specific shapes; cast loosely for
    // postgres-js (`count`) / node-postgres (`rowCount`) parity.
    const rowCount =
      (result as unknown as { rowCount?: number; count?: number }).rowCount ??
      (result as unknown as { rowCount?: number; count?: number }).count ??
      0;
    deleted += rowCount;
    if (rowCount < batchSize) {
      return { deleted, exhaustedBudget: false };
    }
  }
  return { deleted, exhaustedBudget: true };
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string
): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

export async function listObservedTraderWallets(db: Db): Promise<
  Array<{
    id: string;
    walletAddress: string;
    kind: string;
    label: string;
    lastSuccessAt: Date | null;
    status: string | null;
  }>
> {
  const rows = await db
    .select({
      id: polyTraderWallets.id,
      walletAddress: polyTraderWallets.walletAddress,
      kind: polyTraderWallets.kind,
      label: polyTraderWallets.label,
      lastSuccessAt: polyTraderIngestionCursors.lastSuccessAt,
      status: polyTraderIngestionCursors.status,
    })
    .from(polyTraderWallets)
    .leftJoin(
      polyTraderIngestionCursors,
      and(
        eq(polyTraderIngestionCursors.traderWalletId, polyTraderWallets.id),
        eq(polyTraderIngestionCursors.source, TRADE_SOURCE)
      )
    )
    .where(
      and(
        eq(polyTraderWallets.activeForResearch, true),
        isNull(polyTraderWallets.disabledAt)
      )
    )
    .orderBy(polyTraderWallets.kind, polyTraderWallets.label);
  return rows;
}
