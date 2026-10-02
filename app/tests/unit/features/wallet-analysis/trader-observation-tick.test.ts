// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/trader-observation-tick`
 * Purpose: Prove `runTraderObservationTick` wiring for task.5015: the
 *          `tick_ok` log carries the new summary fields (wallets_processed,
 *          wallets_aborted, tick_ms), one wallet's upstream failure doesn't
 *          kill the tick, and an aborted signal skips the post-loop
 *          prunes/metadata maintenance so the tick settles fast.
 * Scope: Orchestration test with a thenable-chain fake db (resolves empty
 *        rows; no SQL is ever executed) and a fake Data-API client. DB
 *        *behavior* is proven in the component lane — this only exercises
 *        the loop/log wiring, which is why a fake is acceptable here.
 * Invariants:
 *   - TICK_SUMMARY_FIELDS: tick_ok emits wallets_processed/wallets_aborted/
 *     tick_ms alongside the existing counters.
 *   - ERROR_ISOLATION: an upstream error on one wallet bumps `errors` while
 *     sibling wallets still process.
 *   - ABORT_SKIPS_MAINTENANCE: with an aborted signal, no wallet work runs
 *     and `db.execute` (snapshot prune + metadata refresh) is never called.
 * Side-effects: none
 * Links: work/items/task.5015,
 *        src/features/wallet-analysis/server/trader-observation-service.ts
 * @public
 */

import { polyTraderWallets } from "@cogni/poly-db-schema/trader-activity";
import type { PolymarketDataApiClient } from "@cogni/poly-market-provider/adapters/polymarket";
import { describe, expect, it, vi } from "vitest";
import {
  OBSERVATION_STATEMENT_TIMEOUT_MS,
  pruneOldPositionSnapshots,
  runTraderObservationTick,
} from "@/features/wallet-analysis/server/trader-observation-service";

const WALLET_A = `0x${"a".repeat(40)}`;
const WALLET_B = `0x${"b".repeat(40)}`;

const walletRow = (id: string, walletAddress: string) => ({
  id,
  walletAddress,
  kind: "target",
  label: `wallet ${id}`,
  activeForResearch: true,
  disabledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/**
 * Thenable-chain fake db: every builder method returns the chain; awaiting it
 * resolves `[]` except a SELECT ... FROM poly_trader_wallets, which resolves
 * the provided wallet rows. `execute` is tracked so tests can assert the
 * abort path skips the prune/metadata statements.
 */
function createFakeDb(walletRows: unknown[]) {
  const executeCalls: unknown[] = [];
  const makeChain = (kind: "select" | "insert" | "update") => {
    let fromTable: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed drizzle chain
    const chain: any = {};
    for (const method of [
      "where",
      "orderBy",
      "limit",
      "values",
      "onConflictDoNothing",
      "onConflictDoUpdate",
      "set",
      "returning",
      "leftJoin",
    ]) {
      chain[method] = () => chain;
    }
    chain.from = (table: unknown) => {
      fromTable = table;
      return chain;
    };
    // biome-ignore lint/suspicious/noThenProperty: fake drizzle chain must be thenable to emulate awaitable query builders
    chain.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (err: unknown) => unknown
    ) => {
      const rows =
        kind === "select" && fromTable === polyTraderWallets ? walletRows : [];
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    };
    return chain;
  };
  // `SET LOCAL statement_timeout` is bookkeeping, not maintenance work, so it
  // is recorded separately — otherwise it would leak into `executeCalls` and
  // silently defeat the ABORT_SKIPS_MAINTENANCE assertion, which proves the
  // prune/metadata statements are skipped by counting execute calls.
  const timeoutStatements: string[] = [];
  const isStatementTimeout = (query: unknown): boolean => {
    try {
      return JSON.stringify(query)?.includes("statement_timeout") === true;
    } catch {
      return false;
    }
  };
  const db: Record<string, unknown> = {
    select: () => makeChain("select"),
    insert: () => makeChain("insert"),
    update: () => makeChain("update"),
    execute: async (query: unknown) => {
      if (isStatementTimeout(query)) {
        timeoutStatements.push(JSON.stringify(query));
        return { rowCount: 0 };
      }
      executeCalls.push(query);
      return { rowCount: 0 };
    },
  };
  // withStatementTimeout runs its body inside a transaction; the fake hands
  // back the same chain so the body's queries behave identically.
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) =>
    await cb(db);
  return { db: db as never, executeCalls, timeoutStatements };
}

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

const metrics = { incr: vi.fn(), observeDurationMs: vi.fn() };

function tickOkCall(logger: ReturnType<typeof makeLogger>) {
  const calls = logger.info.mock.calls.filter((call) => {
    const payload = call[0] as { event?: string; phase?: string };
    return (
      payload.event === "poly.trader.observe" && payload.phase === "tick_ok"
    );
  });
  expect(calls).toHaveLength(1);
  return calls[0]?.[0] as Record<string, unknown>;
}

describe("runTraderObservationTick wiring (task.5015)", () => {
  it("emits tick_ok summary fields and isolates a failing wallet", async () => {
    const { db } = createFakeDb([
      walletRow("wallet-a", WALLET_A),
      walletRow("wallet-b", WALLET_B),
    ]);
    const logger = makeLogger();
    const client = {
      listUserActivity: vi.fn(async (wallet: string) => {
        if (wallet === WALLET_B) throw new Error("data-api 500");
        return [];
      }),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;

    const result = await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
    });

    expect(result).toMatchObject({
      wallets: 2,
      walletsProcessed: 2,
      walletsAborted: 0,
      errors: 1,
    });
    expect(tickOkCall(logger)).toMatchObject({
      event: "poly.trader.observe",
      phase: "tick_ok",
      wallets: 2,
      wallets_processed: 2,
      wallets_aborted: 0,
      tick_ms: expect.any(Number),
      errors: 1,
    });
    // The healthy wallet's per-wallet log carries its duration.
    const walletOk = logger.info.mock.calls.find(
      (call) => (call[0] as { phase?: string }).phase === "wallet_ok"
    );
    expect(walletOk?.[0]).toMatchObject({
      wallet: WALLET_A,
      duration_ms: expect.any(Number),
    });
    // The failing wallet was logged, not thrown.
    const walletError = logger.error.mock.calls.find(
      (call) => (call[0] as { phase?: string }).phase === "error"
    );
    expect(walletError?.[0]).toMatchObject({ wallet: WALLET_B });
  });

  it("emits a structured retention_prune line when the snapshot prune runs (observability follow-up to #102)", async () => {
    const { db } = createFakeDb([walletRow("wallet-a", WALLET_A)]);
    const logger = makeLogger();
    const client = {
      listUserActivity: vi.fn(async () => []),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;

    await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
    });

    // The run is observable as ONE structured line (not inferable from
    // tick_ok, whose pruned_position_snapshots=0 can't tell ran from skipped).
    const pruneLog = logger.info.mock.calls.find(
      (call) => (call[0] as { phase?: string }).phase === "retention_prune"
    );
    expect(pruneLog?.[0]).toMatchObject({
      event: "poly.trader.observe",
      phase: "retention_prune",
      outcome: "ran",
      deleted: 0,
      exhausted_budget: false,
      duration_ms: expect.any(Number),
    });
  });

  it("does not emit retention_prune (nor enter the stage) when the prune is gated off by cadence", async () => {
    const { db } = createFakeDb([walletRow("wallet-a", WALLET_A)]);
    const logger = makeLogger();
    const client = {
      listUserActivity: vi.fn(async () => []),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;

    const stages: string[] = [];
    await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
      runRetentionPrune: false,
      onStage: (s) => stages.push(s),
    });

    const pruneLog = logger.info.mock.calls.find(
      (call) => (call[0] as { phase?: string }).phase === "retention_prune"
    );
    expect(pruneLog).toBeUndefined();
    expect(stages).not.toContain("prune_position_snapshots");
  });

  it("bounds the pre-loop DB stages with a statement_timeout, since no signal can interrupt them (bug.5297)", async () => {
    // `sync_tenant_wallets` and `select_wallets` run BEFORE the bounded wallet
    // loop, and drizzle/postgres-js accept no AbortSignal — so an abort sets a
    // flag those two stages cannot observe. Only a server-side
    // `statement_timeout` bounds them; without it either can hold the tick past
    // its 120s budget, which is what `stage=select_wallets` on a hung tick
    // means.
    //
    // Asserted by ORDER, not by count: the post-loop prune/metadata stages have
    // been wrapped since bug.5297's first pass, so counting `SET LOCAL`s over
    // the whole tick passes with or without this fix. What only holds once the
    // PRE-loop stages are wrapped is that timeouts are already in place before
    // the first wallet touches upstream.
    const { db, timeoutStatements } = createFakeDb([
      walletRow("wallet-a", WALLET_A),
    ]);
    const logger = makeLogger();
    let timeoutsBeforeFirstWalletCall = -1;
    const client = {
      listUserActivity: vi.fn(async () => {
        if (timeoutsBeforeFirstWalletCall < 0) {
          timeoutsBeforeFirstWalletCall = timeoutStatements.length;
        }
        return [];
      }),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;

    const result = await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
    });

    expect(result).toMatchObject({ wallets: 1, walletsProcessed: 1 });
    // Both pre-loop stages bounded before any wallet work began.
    expect(timeoutsBeforeFirstWalletCall).toBeGreaterThanOrEqual(2);
    for (const statement of timeoutStatements) {
      expect(statement).toContain(String(OBSERVATION_STATEMENT_TIMEOUT_MS));
    }
  });

  it("reports every stage it enters, in order, so a hung tick is diagnosable (bug.5273)", async () => {
    // The job holds the latest stage in a plain variable OUTSIDE its
    // timeout/grace race, because a tick that never settles returns nothing
    // and its `wallets*` log fields are all null. Observed on prod 51bd530:
    // `settled_after_abort: false` with every field null — the stall could not
    // be localized. `sync_tenant_wallets` / `select_wallets` in that field is
    // the signal that the tick hung in a pre-loop DB call, which takes no
    // AbortSignal under drizzle/postgres-js.
    const { db } = createFakeDb([walletRow("wallet-a", WALLET_A)]);
    const logger = makeLogger();
    const client = {
      listUserActivity: vi.fn(async () => []),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;
    const stages: string[] = [];

    await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
      onStage: (stage) => {
        stages.push(stage);
      },
    });

    // The two pre-loop DB stages must be reported BEFORE the loop — that
    // ordering is the whole diagnostic value.
    expect(stages.slice(0, 3)).toEqual([
      "sync_tenant_wallets",
      "select_wallets",
      "wallet_loop",
    ]);
    expect(stages).toContain("prune_position_snapshots");
    expect(stages).toContain("refresh_market_metadata");
  });

  it("stops reporting stages at the wallet loop when the signal is already aborted (bug.5273)", async () => {
    // Abort must not advance past the loop into the prunes — otherwise a
    // hung-tick stage reading would point at maintenance work that never ran.
    const { db } = createFakeDb([walletRow("wallet-a", WALLET_A)]);
    const logger = makeLogger();
    const client = {
      listUserActivity: vi.fn(async () => []),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;
    const controller = new AbortController();
    controller.abort(new Error("tick timeout"));
    const stages: string[] = [];

    await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
      signal: controller.signal,
      onStage: (stage) => {
        stages.push(stage);
      },
    });

    expect(stages).toContain("wallet_loop");
    expect(stages).not.toContain("prune_position_snapshots");
    expect(stages).not.toContain("refresh_market_metadata");
  });

  it("counts all wallets aborted and skips prunes/metadata when the signal is aborted", async () => {
    const { db, executeCalls } = createFakeDb([
      walletRow("wallet-a", WALLET_A),
      walletRow("wallet-b", WALLET_B),
    ]);
    const logger = makeLogger();
    const client = {
      listUserActivity: vi.fn(async () => []),
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;
    const controller = new AbortController();
    controller.abort(new Error("tick timeout"));

    const result = await runTraderObservationTick({
      db,
      client,
      logger: logger as never,
      metrics,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      wallets: 2,
      walletsProcessed: 0,
      walletsAborted: 2,
      errors: 0,
      prunedPositionSnapshots: 0,
    });
    expect(client.listUserActivity).not.toHaveBeenCalled();
    // Snapshot prune + metadata refresh both go through db.execute — the
    // aborted tick must not run either (no orphan writers).
    expect(executeCalls).toHaveLength(0);
    expect(tickOkCall(logger)).toMatchObject({
      wallets_processed: 0,
      wallets_aborted: 2,
    });
  });
});

describe("pruneOldPositionSnapshots stage deadline (bug.5297)", () => {
  // The loop also exits when a batch deletes fewer rows than batchSize, so the
  // fakes must report a FULL batch (rowCount === batchSize) to keep it looping.
  const fullBatch = (batchSize: number) => ({ rowCount: batchSize });

  it("stops starting batches once the stage budget is spent", async () => {
    // bug.5297 capped each STATEMENT at 30s, which cannot bound a LOOP:
    // maxBatches(10) x 30s = 300s, still 2.5x the 120s tick budget, with every
    // statement legally under its ceiling. Prod confirmed it — tick timeouts
    // still at prune_position_snapshots with ZERO statement-timeout errors.
    // Clock is driven, not raced: the earlier version slept 12ms per batch
    // against a 10ms real deadline, which under full-suite load could expire
    // before the first batch and report `batches: 0`.
    let clock = 1_000;
    let batches = 0;
    const db = {
      execute: async () => {
        batches += 1;
        clock += 12;
        return fullBatch(5);
      },
    } as never;

    const result = await pruneOldPositionSnapshots(db, {
      batchSize: 5,
      maxBatches: 10,
      deadlineMs: 10,
      now: () => clock,
    });

    // Full batches every time, so ONLY the deadline can stop it — and it must,
    // well before maxBatches.
    expect(batches).toBe(1);
    expect(result.exhaustedBudget).toBe(true);
    expect(result.deleted).toBe(5);
  });

  it("without a deadline, batch count remains the only bound (unchanged)", async () => {
    let batches = 0;
    const db = {
      execute: async () => {
        batches += 1;
        return fullBatch(5);
      },
    } as never;
    const result = await pruneOldPositionSnapshots(db, {
      batchSize: 5,
      maxBatches: 4,
    });
    expect(batches).toBe(4);
    expect(result.exhaustedBudget).toBe(true);
  });

  it("a short batch still ends the prune before the deadline (pre-existing exit preserved)", async () => {
    let batches = 0;
    const db = {
      execute: async () => {
        batches += 1;
        return { rowCount: 1 };
      },
    } as never;
    const result = await pruneOldPositionSnapshots(db, {
      batchSize: 5,
      maxBatches: 10,
      deadlineMs: 60_000,
    });
    expect(batches).toBe(1);
    expect(result.exhaustedBudget).toBe(false);
  });
});
