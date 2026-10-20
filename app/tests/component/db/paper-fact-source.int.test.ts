// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/paper-fact-source.int.test`
 * Purpose: Real-Postgres proofs that a paper account's facts land in the SAME
 *   `poly_trader_*` tables a live account's do, that the dashboard's balance
 *   read goes from `no_wallet` to `available` because of it, and that none of
 *   it perturbs a live account.
 * Scope: Real Postgres via testcontainers. Service role for seeding and
 *   projection, app role under `withTenantScope` for the balance read. No HTTP,
 *   no Polymarket, no chain — the mid-price reader is injected.
 * Invariants:
 *   - THE_NAV_ROW_IS_WHY_THE_DASHBOARD_RENDERS — `readWalletBalanceFact` drives
 *     FROM `poly_wallet_connections` and LEFT JOINs
 *     `poly_wallet_balance_snapshots`. Before 0083 a paper tenant had a
 *     connection but never a snapshot, so the dashboard read `missing` and
 *     rendered empty. The `available` assertion here is the regression gate for
 *     the measured candidate-a failure (100 decisions in 9 minutes, dashboard
 *     showing "No trading wallet connected yet").
 *   - NO_FABRICATED_VALUES — the single most important test in this file is the
 *     unpriced one. A mid price we could not read must withhold the NAV, NOT
 *     publish it with the position marked to 0. A hardcoded 0 is the exact bug
 *     that made paper trading useless, and it would make every OTHER assertion
 *     here still pass.
 *   - PROJECT_ONLY_TERMINAL_REALIZED — a resting order's realized size can grow,
 *     and `poly_trader_fills` is append-only with an additive rollup
 *     accumulator behind it, so projecting a non-terminal row would freeze a
 *     wrong size permanently.
 *   - LIVE_IS_UNTOUCHED — `poly_trader_*` have no tenant FK and therefore NO
 *     RLS. The capability plane is the only clamp, so a projection whose WHERE
 *     clause is wrong corrupts another tenant's facts with no database
 *     backstop. This file asserts the live rows byte-for-byte after a paper
 *     tick for exactly that reason.
 *   - SWEEPS_ARE_DISJOINT — the live retirement sweep filters
 *     `kind='cogni_wallet'` and the paper one filters `kind='paper_wallet'`.
 *     Both run every tick; either one retiring the other's population loses a
 *     dashboard.
 * Side-effects: IO (testcontainers Postgres)
 * Links: migrations/0083_poly_paper_fact_source.sql, docs/spec/capability-plane.md
 * @internal
 */

import { randomUUID } from "node:crypto";
import { toUserId, userActor } from "@cogni/ids";
import {
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { type SQL, and, eq, inArray, isNull, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { createExecutionVenueResolver, createPaperVenue, derivePaperAccountAddress } from "@/features/paper-accounts";
import { noopMetrics, type OrderReceipt } from "@cogni/poly-market-provider";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import { createOrderLedger } from "@/features/trading/order-ledger";
import { readEconomicPositionProjection } from "@/features/wallet-analysis/server/economic-position-read-model";
import {
  type EnrolledPaperWallet,
  observePaperWallet,
  PAPER_FILL_SOURCE,
  PAPER_POSITION_CURSOR_SOURCE,
  PAPER_WALLET_KIND,
  type PaperMidPriceReader,
  readActivePaperAccounts,
  readPaperAccountNavUsdc,
  runPaperProjectionTick,
  syncPaperTraderWallets,
} from "@/features/wallet-analysis/server/paper-fact-source";
import {
  persistWalletBalanceFact,
  readWalletBalanceFact,
} from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";
import { readTenantWalletDashboard } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import {
  billingAccounts,
  polyCopyTradeFills,
  polyWalletBalanceSnapshots,
  polyWalletConnections,
  polyWalletGrants,
  users,
} from "@/shared/db/schema";

type PaperDb = Parameters<typeof observePaperWallet>[0]["db"];

/** Quiet logger — these tests assert DB state, not log text. */
const logger = {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: silent test logger
  info: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: silent test logger
  warn: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: silent test logger
  error: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: silent test logger
  debug: () => {},
  child: () => logger,
} as unknown as Parameters<typeof observePaperWallet>[0]["logger"];

/**
 * Captures the `phase` of every structured log line, so "idle" is provably
 * distinguishable from "broken" rather than both being silence.
 */
function recordingLogger() {
  const seen: string[] = [];
  const record = (payload: unknown): void => {
    const phase = (payload as { phase?: unknown } | undefined)?.phase;
    if (typeof phase === "string") seen.push(phase);
  };
  const self = {
    info: record,
    warn: record,
    error: record,
    debug: record,
    child: () => self,
  };
  return {
    logger: self as unknown as Parameters<typeof observePaperWallet>[0]["logger"],
    phases: () => [...seen],
  };
}

type Tenant = { userId: string; billingAccountId: string; name: string };

function tenant(name: string): Tenant {
  return { userId: randomUUID(), billingAccountId: randomUUID(), name };
}

function address(): `0x${string}` {
  const hex = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  return `0x${hex.slice(0, 40)}` as `0x${string}`;
}

/**
 * Seed one paper connection row exactly as `provisionPaperAccount` writes it:
 * synthetic deterministic address in BOTH `address` and `funder_address` (the
 * latter is what `readWalletBalanceFact` joins on), custody columns NULL,
 * declared seed.
 */
async function seedPaperConnection(
  owner: Tenant,
  seedUsdc: string
): Promise<`0x${string}`> {
  const paperAddress = derivePaperAccountAddress(owner.billingAccountId);
  await getSeedDb()
    .insert(polyWalletConnections)
    .values({
      billingAccountId: owner.billingAccountId,
      createdByUserId: owner.userId,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      kind: "paper",
      address: paperAddress,
      funderAddress: paperAddress,
      paperSeedUsdc: seedUsdc,
      custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
      custodialConsentActorKind: "user",
      custodialConsentActorId: owner.userId,
      tradingApprovalsReadyAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  const [connection] = await getSeedDb().select({ id: polyWalletConnections.id }).from(polyWalletConnections)
    .where(and(eq(polyWalletConnections.billingAccountId, owner.billingAccountId), eq(polyWalletConnections.kind, "paper")));
  if (!connection) throw new Error("paper connection missing");
  await getSeedDb().insert(polyWalletGrants).values({
    billingAccountId: owner.billingAccountId, walletConnectionId: connection.id,
    createdByUserId: owner.userId, scopes: ["poly:trade:buy", "poly:trade:sell"],
    perOrderUsdcCap: "100000", dailyUsdcCap: "1000000", hourlyFillsCap: 1000,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  });
  return paperAddress;
}

type LedgerFill = {
  tokenId: string;
  conditionId: string;
  side: "BUY" | "SELL";
  /** Realized VWAP. */
  price: string;
  /** Realized shares. */
  shares: string;
  feesUsdc?: string | null;
  status?: string;
  mode?: string;
  observedAt?: Date;
};

/**
 * Seed one `poly_copy_trade_fills` row. `side` and `token_id` go into
 * `attributes` because the ledger has no such columns — `market_id` is the
 * conditionId and everything else lives in the JSONB, which is precisely the
 * shape the projection has to read.
 */
async function seedLedgerFill(
  owner: Tenant,
  targetId: string,
  fill: LedgerFill
) {
  const client = `coid-${randomUUID()}`;
  const order = `order-${randomUUID()}`;
  const observedAt = fill.observedAt ?? new Date("2026-10-05T12:00:00.000Z");
  const db = getSeedDb();
  // Explicit negative fixtures remain unbound; no JSON proof is manufactured.
  if (fill.mode === "live" || fill.feesUsdc === "NaN") {
    await db.insert(polyCopyTradeFills).values({
      billingAccountId: owner.billingAccountId, createdByUserId: owner.userId,
      targetId, fillId: `paper:${randomUUID()}`, marketId: fill.conditionId,
      observedAt, clientOrderId: client, orderId: order, status: fill.status ?? "filled",
      mode: fill.mode ?? "paper", price: fill.price, shares: fill.shares,
      feesUsdc: fill.feesUsdc ?? "0", attributes: {
        side: fill.side, token_id: fill.tokenId, condition_id: fill.conditionId,
        size_usdc: Number(fill.price) * Number(fill.shares), limit_price: Number(fill.price),
      },
    });
    return null;
  }
  const intent = {
    provider: "polymarket" as const, market_id: `prediction-market:polymarket:${fill.conditionId}`,
    outcome: "0", side: fill.side, size_usdc: Number(fill.price) * Number(fill.shares),
    limit_price: Number(fill.price), client_order_id: client,
    attributes: { token_id: fill.tokenId, condition_id: fill.conditionId, placement: "limit" },
  };
  const ledger = createOrderLedger({ db, logger: logger as never, resolveExecutionMode: createExecutionVenueResolver({ db }) });
  await ledger.insertPending({ billing_account_id: owner.billingAccountId, created_by_user_id: owner.userId,
    target_id: targetId, fill_id: `paper:${randomUUID()}`, observed_at: observedAt, intent });
  const accept = async (next: Partial<OrderReceipt> = {}, at = observedAt, first = false) => {
    const native: OrderReceipt = {
      order_id: order, client_order_id: client,
      status: (fill.status ?? "filled") as OrderReceipt["status"],
      filled_size_usdc: Number(fill.price) * Number(fill.shares), fill_price: Number(fill.price),
      total_shares: Number(fill.shares), fees_usdc: fill.feesUsdc === null ? undefined : Number(fill.feesUsdc ?? "0"), submitted_at: observedAt.toISOString(),
      attributes: { market: fill.conditionId, tokenId: fill.tokenId, side: fill.side, sizeMatched: Number(fill.shares) },
      ...next,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://paper.projection.test");
      if (first) expect(JSON.parse(String(init?.body)).client_order_id).toBe(client);
      else expect(url.pathname).toBe(`/orders/${order}`);
      return Response.json(native);
    });
    try {
      const factory = createPolyTradeExecutorFactory({ logger: logger as never, metrics: noopMetrics,
        paperSidecarUrl: "http://paper.projection.test", paperVenue: createPaperVenue({ db }),
        resolveExecutionVenue: createExecutionVenueResolver({ db }) });
      const executor = await factory.getPolyTradeExecutorFor(owner.billingAccountId);
      const fetched = first ? { found: await executor.placeIntent(intent) } : await executor.getOrder(order);
      if (!("found" in fetched)) throw new Error("native paper order unavailable");
      const written = await ledger.markOrderId({ client_order_id: client, receipt: fetched.found });
      expect(written?.accepted).toBe(true);
      return written;
    } finally {
      transport.mockRestore();
      vi.useRealTimers();
    }
  };
  await accept({}, observedAt, true);
  return { client, order, accept };
}

/** A mid-price reader over a fixed table; absent token => `null` (unknown). */
function midPrices(table: Record<string, number>): PaperMidPriceReader {
  return async (tokenId) => table[tokenId] ?? null;
}

/**
 * Enrol EVERY active paper account, then pick one out.
 *
 * Deliberately not "enrol just this account": `syncPaperTraderWallets` retires
 * paper wallets absent from the list it is given, so syncing a single-element
 * list would retire every OTHER paper tenant. That is correct production
 * behaviour (the reader always supplies the full set) and a trap for a test
 * that enrols incrementally.
 */
async function enrolAll(): Promise<Map<string, EnrolledPaperWallet>> {
  const db = getSeedDb() as unknown as PaperDb;
  const accounts = await readActivePaperAccounts(db, logger);
  const enrolled = await syncPaperTraderWallets(db, accounts);
  return new Map(
    enrolled.map((wallet) => [wallet.account.billingAccountId, wallet])
  );
}

async function enrol(owner: Tenant): Promise<EnrolledPaperWallet> {
  const wallet = (await enrolAll()).get(owner.billingAccountId);
  if (!wallet) throw new Error(`paper wallet not enrolled for ${owner.name}`);
  return wallet;
}

async function readBalanceAsTenant(owner: Tenant) {
  return await withTenantScope(
    getAppDb(),
    userActor(toUserId(owner.userId)),
    async (tx) => await readWalletBalanceFact(tx, owner.billingAccountId)
  );
}

describe("paper facts project into the live tables (migration 0083)", () => {
  // One tenant per scenario so their connection and projection state cannot
  // interfere.
  const traded = tenant("Paper tenant with trades");
  const unpriced = tenant("Paper tenant with an unpriceable position");
  const converging = tenant("Paper tenant with a resumable mark sweep");
  const negative = tenant("Paper tenant with inconsistent negative NAV");
  const nonfinite = tenant("Paper tenant with non-finite NAV");
  const dual = tenant("Tenant with live and paper snapshots");
  const live = tenant("Live tenant that must be untouched");
  const tenants = [
    traded,
    unpriced,
    converging,
    negative,
    nonfinite,
    dual,
    live,
  ];

  // Deterministic per-scenario market keys so assertions can name them.
  const condA = `0x${"a".repeat(64)}`;
  const tokenA = "11111111111111111111111111111111";
  const condB = `0x${"b".repeat(64)}`;
  const tokenB = "22222222222222222222222222222222";
  const condU = `0x${"c".repeat(64)}`;
  const tokenU = "33333333333333333333333333333333";

  const SEED_USDC = "1000.00000000";
  const targetId = randomUUID();

  beforeAll(async () => {
    const seedDb = getSeedDb();
    await seedDb.insert(users).values(
      tenants.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        walletAddress: address(),
      }))
    );
    await seedDb.insert(billingAccounts).values(
      tenants.map((entry) => ({
        id: entry.billingAccountId,
        ownerUserId: entry.userId,
        balanceCredits: 0n,
      }))
    );
  });

  describe("the happy path: ledger -> fills -> positions -> NAV", () => {
    let wallet: Awaited<ReturnType<typeof enrol>>;

    beforeAll(async () => {
      await seedPaperConnection(traded, SEED_USDC);

      // Market A: still open. BUY 100 @ 0.40 = 40 USDC, 0.50 fees.
      await seedLedgerFill(traded, targetId, {
        tokenId: tokenA,
        conditionId: condA,
        side: "BUY",
        price: "0.40000000",
        shares: "100.00000000",
        feesUsdc: "0.50000000",
      });
      // Market B: round-tripped. BUY 50 @ 0.60 = 30, SELL 50 @ 0.70 = 35.
      await seedLedgerFill(traded, targetId, {
        tokenId: tokenB,
        conditionId: condB,
        side: "BUY",
        price: "0.60000000",
        shares: "50.00000000",
      });
      await seedLedgerFill(traded, targetId, {
        tokenId: tokenB,
        conditionId: condB,
        side: "SELL",
        price: "0.70000000",
        shares: "50.00000000",
      });
      // Nonterminal cumulative observations are covered separately below: they
      // belong in current inventory, never the immutable fill stream.
      // Must NOT project: a LIVE-mode row belonging to the same tenant. If the
      // projection forgets `mode = 'paper'` it silently fabricates paper facts
      // out of real trades.
      await seedLedgerFill(traded, targetId, {
        tokenId: tokenA,
        conditionId: condA,
        side: "BUY",
        price: "0.41000000",
        shares: "7.00000000",
        mode: "live",
      });

      const accounts = await readActivePaperAccounts(
        getSeedDb() as unknown as PaperDb,
        logger
      );
      const account = accounts.find(
        (entry) => entry.billingAccountId === traded.billingAccountId
      );
      expect(
        account,
        "readActivePaperAccounts must find the seeded paper connection"
      ).toBeDefined();
      // The seed is read verbatim from the connection row, never defaulted.
      expect(account?.seedUsdc).toBe(SEED_USDC);

      wallet = await enrol(traded);

      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({ [tokenA]: 0.5, [tokenB]: 0.65 }),
        logger,
        now: new Date("2026-10-07T18:00:00.000Z"),
      });
    });

    it("enrols the paper account under kind='paper_wallet'", async () => {
      const rows = await getSeedDb()
        .select({
          kind: polyTraderWallets.kind,
          activeForResearch: polyTraderWallets.activeForResearch,
          disabledAt: polyTraderWallets.disabledAt,
        })
        .from(polyTraderWallets)
        .where(eq(polyTraderWallets.id, wallet.traderWalletId));

      expect(rows[0]?.kind).toBe(PAPER_WALLET_KIND);
      expect(rows[0]?.activeForResearch).toBe(true);
      expect(rows[0]?.disabledAt).toBeNull();
    });

    it("projects only terminal, realized, paper-mode fills", async () => {
      const rows = await getSeedDb()
        .select({
          source: polyTraderFills.source,
          conditionId: polyTraderFills.conditionId,
          tokenId: polyTraderFills.tokenId,
          side: polyTraderFills.side,
          price: polyTraderFills.price,
          shares: polyTraderFills.shares,
          sizeUsdc: polyTraderFills.sizeUsdc,
          txHash: polyTraderFills.txHash,
        })
        .from(polyTraderFills)
        .where(eq(polyTraderFills.traderWalletId, wallet.traderWalletId));

      // Three authenticated terminal paper rows; the LIVE row stays out.
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.source === PAPER_FILL_SOURCE)).toBe(true);
      // Paper has no chain transaction — NULL, never a synthesised hash.
      expect(rows.every((row) => row.txHash === null)).toBe(true);

      const buyA = rows.find(
        (row) => row.tokenId === tokenA && row.side === "BUY"
      );
      expect(buyA?.conditionId).toBe(condA);
      expect(Number(buyA?.price)).toBeCloseTo(0.4, 8);
      expect(Number(buyA?.shares)).toBeCloseTo(100, 8);
      // size_usdc is derived as price * shares, not read from attributes.
      expect(Number(buyA?.sizeUsdc)).toBeCloseTo(40, 8);

      const sellB = rows.find(
        (row) => row.tokenId === tokenB && row.side === "SELL"
      );
      expect(Number(sellB?.sizeUsdc)).toBeCloseTo(35, 8);

      // Nor the live-mode row's price (0.41).
      expect(rows.some((row) => Number(row.price) === 0.41)).toBe(false);
    });

    it("is idempotent — a second projection inserts nothing new", async () => {
      const before = await getSeedDb()
        .select({ id: polyTraderFills.id })
        .from(polyTraderFills)
        .where(eq(polyTraderFills.traderWalletId, wallet.traderWalletId));

      const result = await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({ [tokenA]: 0.5, [tokenB]: 0.65 }),
        logger,
        now: new Date("2026-10-07T18:05:00.000Z"),
      });

      const after = await getSeedDb()
        .select({ id: polyTraderFills.id })
        .from(polyTraderFills)
        .where(eq(polyTraderFills.traderWalletId, wallet.traderWalletId));

      expect(result.fills).toBe(0);
      expect(after).toHaveLength(before.length);
    });

    it("aggregates the open position and marks it at the injected mid", async () => {
      const rows = await getSeedDb()
        .select({
          active: polyTraderCurrentPositions.active,
          shares: polyTraderCurrentPositions.shares,
          costBasisUsdc: polyTraderCurrentPositions.costBasisUsdc,
          currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
          avgPrice: polyTraderCurrentPositions.avgPrice,
        })
        .from(polyTraderCurrentPositions)
        .where(
          and(
            eq(
              polyTraderCurrentPositions.traderWalletId,
              wallet.traderWalletId
            ),
            eq(polyTraderCurrentPositions.tokenId, tokenA)
          )
        );

      const row = rows[0];
      expect(row?.active).toBe(true);
      expect(Number(row?.shares)).toBeCloseTo(100, 8);
      // Average-cost basis: 100 shares at the 0.40 BUY VWAP.
      expect(Number(row?.avgPrice)).toBeCloseTo(0.4, 8);
      expect(Number(row?.costBasisUsdc)).toBeCloseTo(40, 8);
      // Marked at the mid (0.50), NOT at cost — this is the number that was
      // 0/100 non-null on candidate-a.
      expect(Number(row?.currentValueUsdc)).toBeCloseTo(50, 8);
    });

    it("closes the round-tripped position without needing a mid price", async () => {
      const rows = await getSeedDb()
        .select({
          active: polyTraderCurrentPositions.active,
          shares: polyTraderCurrentPositions.shares,
          currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
          avgPrice: polyTraderCurrentPositions.avgPrice,
        })
        .from(polyTraderCurrentPositions)
        .where(
          and(
            eq(
              polyTraderCurrentPositions.traderWalletId,
              wallet.traderWalletId
            ),
            eq(polyTraderCurrentPositions.tokenId, tokenB)
          )
        );

      const row = rows[0];
      expect(row?.active).toBe(false);
      expect(Number(row?.shares)).toBe(0);
      // Zero shares are worth zero: arithmetic, not a fabricated mark.
      expect(Number(row?.currentValueUsdc)).toBe(0);
      // The entry VWAP is a fact we know and is retained rather than zeroed.
      expect(Number(row?.avgPrice)).toBeCloseTo(0.6, 8);
    });

    it("writes a position snapshot per position, excluding the mark from the hash", async () => {
      const rows = await getSeedDb()
        .select({
          tokenId: polyTraderPositionSnapshots.tokenId,
          contentHash: polyTraderPositionSnapshots.contentHash,
        })
        .from(polyTraderPositionSnapshots)
        .where(
          eq(
            polyTraderPositionSnapshots.traderWalletId,
            wallet.traderWalletId
          )
        );

      // Two positions, and the second tick (same positions, same mid) added no
      // new snapshot rows — the mark is deliberately not in the content hash,
      // so an unchanged position does not churn history (task.5012).
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.tokenId))).toEqual(
        new Set([tokenA, tokenB])
      );
    });

    it("publishes the NAV so readWalletBalanceFact returns available, not no_wallet", async () => {
      const balance = await readBalanceAsTenant(traded);

      // The regression gate: pre-0083 this was `no_wallet` with a connection
      // present, and the dashboard rendered "No trading wallet connected yet".
      expect(balance.kind).toBe("available");
      if (balance.kind !== "available") throw new Error("unreachable");

      // NAV = seed - bought + sold - fees + marked open value
      //     = 1000 - (40 + 30) + 35 - 0.50 + 50 = 1014.50
      expect(balance.usdcE).toBeCloseTo(1014.5, 6);
      expect(balance.address).toBe(
        derivePaperAccountAddress(traded.billingAccountId)
      );
      expect(balance.connectionKind).toBe("paper");
      // A paper account has no on-chain pUSD and no POL, and never will. NULL
      // plus `partial` says that; writing 0 would assert two measurements that
      // were never taken.
      expect(balance.pusd).toBeNull();
      expect(balance.pol).toBeNull();
      expect(balance.status).toBe("partial");
      expect(balance.errors.length).toBeGreaterThan(0);
    });

    it("deducts known native fees from canonical lifetime economics", async () => {
      const read = await readEconomicPositionProjection({ db: getSeedDb(), billingAccountId: traded.billingAccountId,
        walletAddress: derivePaperAccountAddress(traded.billingAccountId), connectionKind: "paper",
        capturedAt: new Date("2026-10-07T18:05:00.000Z"), interval: "ALL" });
      expect(read.positionFacts.find(fact => fact.tokenId === tokenA)).toMatchObject({ lifetimePnlUsdc: 9.5, economicsCoverage: "complete" });
      expect(read.positionFacts.find(fact => fact.tokenId === tokenB)).toMatchObject({ lifetimePnlUsdc: 5, economicsCoverage: "complete" });
    });

    it("keeps the full paper dashboard visible without Privy configuration", async () => {
      const dashboard = await readTenantWalletDashboard({
        db: getSeedDb(),
        billingAccountId: traded.billingAccountId,
        interval: "1W",
        adapterConfigured: false,
      });

      expect(dashboard.overview.account_kind).toBe("paper");
      expect(dashboard.overview.configured).toBe(true);
      expect(dashboard.overview.connected).toBe(true);
      expect(dashboard.warnings.map((entry) => entry.code)).not.toContain(
        "wallet_adapter_unconfigured"
      );
      expect(dashboard.execution.warnings.map((entry) => entry.code)).not.toContain(
        "wallet_adapter_unconfigured"
      );
      expect(dashboard.facts.positions.actionsAllowed).toBe(false);
    });

    it("marks the position cursor ok when every open position was priced", async () => {
      const rows = await getSeedDb()
        .select({
          status: polyTraderIngestionCursors.status,
          errorMessage: polyTraderIngestionCursors.errorMessage,
        })
        .from(polyTraderIngestionCursors)
        .where(
          and(
            eq(
              polyTraderIngestionCursors.traderWalletId,
              wallet.traderWalletId
            ),
            eq(
              polyTraderIngestionCursors.source,
              PAPER_POSITION_CURSOR_SOURCE
            )
          )
        );

      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.errorMessage).toBeNull();
    });
  });

  describe("NO_FABRICATED_VALUES: an unreadable mid withholds the NAV", () => {
    let wallet: Awaited<ReturnType<typeof enrol>>;

    beforeAll(async () => {
      await seedPaperConnection(unpriced, SEED_USDC);
      await seedLedgerFill(unpriced, targetId, {
        tokenId: tokenU,
        conditionId: condU,
        side: "BUY",
        price: "0.30000000",
        shares: "20.00000000",
      });

      wallet = await enrol(unpriced);

      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        // The CLOB could not be read for this token.
        readMidPrice: midPrices({}),
        logger,
        now: new Date("2026-10-07T18:00:00.000Z"),
      });
    });

    it("still projects the fill — the ledger is knowable even when the price is not", async () => {
      const rows = await getSeedDb()
        .select({ id: polyTraderFills.id })
        .from(polyTraderFills)
        .where(eq(polyTraderFills.traderWalletId, wallet.traderWalletId));
      expect(rows).toHaveLength(1);
    });

    it("writes NO current-position row rather than one valued at 0", async () => {
      const rows = await getSeedDb()
        .select({
          currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
        })
        .from(polyTraderCurrentPositions)
        .where(
          eq(
            polyTraderCurrentPositions.traderWalletId,
            wallet.traderWalletId
          )
        );
      // A row marked 0 would be indistinguishable from a worthless position.
      expect(rows).toHaveLength(0);
    });

    it("withholds the NAV, so the balance reads missing — never available at a made-up number", async () => {
      const balance = await readBalanceAsTenant(unpriced);
      // `missing` means "a wallet exists, no observation yet", which is true.
      expect(balance.kind).toBe("missing");

      const snapshots = await getSeedDb()
        .select({ billingAccountId: polyWalletBalanceSnapshots.billingAccountId })
        .from(polyWalletBalanceSnapshots)
        .where(
          eq(
            polyWalletBalanceSnapshots.billingAccountId,
            unpriced.billingAccountId
          )
        );
      expect(snapshots).toHaveLength(0);
    });

    it("records the reason on the position cursor as partial", async () => {
      const rows = await getSeedDb()
        .select({
          status: polyTraderIngestionCursors.status,
          errorMessage: polyTraderIngestionCursors.errorMessage,
        })
        .from(polyTraderIngestionCursors)
        .where(
          and(
            eq(
              polyTraderIngestionCursors.traderWalletId,
              wallet.traderWalletId
            ),
            eq(
              polyTraderIngestionCursors.source,
              PAPER_POSITION_CURSOR_SOURCE
            )
          )
        );
      expect(rows[0]?.status).toBe("partial");
      expect(rows[0]?.errorMessage).toContain("NAV withheld");
    });

    it("publishes the NAV on a later tick once the price becomes readable", async () => {
      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({ [tokenU]: 0.35 }),
        logger,
        now: new Date("2026-10-07T18:10:00.000Z"),
      });

      const balance = await readBalanceAsTenant(unpriced);
      expect(balance.kind).toBe("available");
      if (balance.kind !== "available") throw new Error("unreachable");
      // 1000 - 6 (20 @ 0.30) + 7 (20 @ 0.35 mark) = 1001
      expect(balance.usdcE).toBeCloseTo(1001, 6);
    });
  });

  describe("a bounded mark sweep converges across ticks", () => {
    const conditionA = `0x${"d".repeat(64)}`;
    const conditionB = `0x${"e".repeat(64)}`;
    const positionA = "44444444444444444444444444444444";
    const positionB = "55555555555555555555555555555555";
    let wallet: Awaited<ReturnType<typeof enrol>>;

    beforeAll(async () => {
      await seedPaperConnection(converging, SEED_USDC);
      await seedLedgerFill(converging, targetId, {
        tokenId: positionA,
        conditionId: conditionA,
        side: "BUY",
        price: "0.20000000",
        shares: "10.00000000",
      });
      await seedLedgerFill(converging, targetId, {
        tokenId: positionB,
        conditionId: conditionB,
        side: "BUY",
        price: "0.30000000",
        shares: "20.00000000",
      });
      wallet = await enrol(converging);
    });

    it("rotates past a failed mark, then reuses only real fresh marks", async () => {
      const calls: string[] = [];
      const reader: PaperMidPriceReader = async (tokenId) => {
        calls.push(tokenId);
        if (calls.length === 1) return null;
        if (tokenId === positionA) return 0.4;
        if (tokenId === positionB) return 0.7;
        return null;
      };

      const first = await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: reader,
        logger,
        now: new Date("2026-10-07T18:30:00.000Z"),
        markRefreshLimit: 1,
      });
      expect(calls).toEqual([positionA]);
      expect(first).toMatchObject({
        marksAttempted: 1,
        marksRefreshed: 0,
        marksReused: 0,
        unpricedPositions: 2,
        navPublished: false,
      });

      const second = await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: reader,
        logger,
        now: new Date("2026-10-07T18:30:30.000Z"),
        markRefreshLimit: 1,
      });
      expect(calls).toEqual([positionA, positionB]);
      expect(second).toMatchObject({
        marksAttempted: 1,
        marksRefreshed: 1,
        marksReused: 0,
        unpricedPositions: 1,
        navPublished: false,
      });

      const third = await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: reader,
        logger,
        now: new Date("2026-10-07T18:31:00.000Z"),
        markRefreshLimit: 1,
      });
      expect(calls).toEqual([positionA, positionB, positionA]);
      expect(third).toMatchObject({
        marksAttempted: 1,
        marksRefreshed: 1,
        marksReused: 1,
        unpricedPositions: 0,
        navPublished: true,
      });

      const balance = await readBalanceAsTenant(converging);
      expect(balance.kind).toBe("available");
      if (balance.kind !== "available") throw new Error("unreachable");
      // seed 1000 - buys 8 + current marks 18 = 1010
      expect(balance.usdcE).toBeCloseTo(1010, 6);

      const stale = await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: () => {
          throw new Error("refresh window is deliberately zero");
        },
        logger,
        now: new Date("2026-10-07T18:42:00.000Z"),
        markRefreshLimit: 0,
      });
      expect(stale).toMatchObject({
        marksAttempted: 0,
        marksRefreshed: 0,
        marksReused: 0,
        unpricedPositions: 2,
        navPublished: false,
      });
      expect(await readBalanceAsTenant(converging)).toMatchObject({
        kind: "missing",
      });
    });
  });

  describe("NO_FABRICATED_VALUES: a negative NAV is never published as zero", () => {
    let wallet: Awaited<ReturnType<typeof enrol>>;

    beforeAll(async () => {
      await seedPaperConnection(negative, "1.00000000");
      wallet = await enrol(negative);
    });

    it("invalidates a previously usable NAV and marks the projection partial", async () => {
      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({}),
        logger,
        now: new Date("2026-10-07T18:19:00.000Z"),
      });
      const prior = await readBalanceAsTenant(negative);
      expect(prior.kind).toBe("available");
      if (prior.kind !== "available") throw new Error("unreachable");
      expect(prior.usdcE).toBeCloseTo(1, 6);

      await seedLedgerFill(negative, targetId, {
        tokenId: "44444444444444444444444444444444",
        conditionId: `0x${"d".repeat(64)}`,
        side: "BUY",
        price: "0.50000000",
        shares: "10.00000000",
      });
      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({
          "44444444444444444444444444444444": 0.1,
        }),
        logger,
        now: new Date("2026-10-07T18:20:00.000Z"),
      });

      const snapshots = await getSeedDb()
        .select({ usdcE: polyWalletBalanceSnapshots.usdcE })
        .from(polyWalletBalanceSnapshots)
        .where(
          eq(
            polyWalletBalanceSnapshots.billingAccountId,
            negative.billingAccountId
          )
        );
      expect(snapshots).toHaveLength(0);

      await expect(
        readPaperAccountNavUsdc({
          db: getSeedDb() as unknown as PaperDb,
          billingAccountId: negative.billingAccountId,
          now: new Date("2026-10-07T18:20:01.000Z"),
        })
      ).rejects.toMatchObject({ reason: "nav_missing" });

      const cursors = await getSeedDb()
        .select({
          status: polyTraderIngestionCursors.status,
          errorMessage: polyTraderIngestionCursors.errorMessage,
        })
        .from(polyTraderIngestionCursors)
        .where(
          and(
            eq(polyTraderIngestionCursors.traderWalletId, wallet.traderWalletId),
            eq(
              polyTraderIngestionCursors.source,
              PAPER_POSITION_CURSOR_SOURCE
            )
          )
        );
      expect(cursors[0]?.status).toBe("partial");
      expect(cursors[0]?.errorMessage).toContain("negative");
    });
  });

  describe("NO_FABRICATED_VALUES: a non-finite NAV invalidates prior truth", () => {
    it("removes a usable snapshot before publishing a partial cursor", async () => {
      await seedPaperConnection(nonfinite, "100.00000000");
      const wallet = await enrol(nonfinite);
      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({}),
        logger,
        now: new Date("2026-10-07T18:21:00.000Z"),
      });
      expect((await readBalanceAsTenant(nonfinite)).kind).toBe("available");

      await seedLedgerFill(nonfinite, targetId, {
        tokenId: "55555555555555555555555555555555",
        conditionId: `0x${"e".repeat(64)}`,
        side: "BUY",
        price: "0.50000000",
        shares: "1.00000000",
        feesUsdc: "NaN",
      });
      await observePaperWallet({
        db: getSeedDb() as unknown as PaperDb,
        wallet,
        readMidPrice: midPrices({
          "55555555555555555555555555555555": 0.5,
        }),
        logger,
        now: new Date("2026-10-07T18:22:00.000Z"),
      });

      await expect(
        readPaperAccountNavUsdc({
          db: getSeedDb() as unknown as PaperDb,
          billingAccountId: nonfinite.billingAccountId,
          now: new Date("2026-10-07T18:22:01.000Z"),
        })
      ).rejects.toMatchObject({ reason: "nav_missing" });
    });
  });

  describe("native receipt authority across inventory and finance", () => {
    async function setup(name: string) {
      const owner = tenant(name);
      const db = getSeedDb();
      await db.insert(users).values({ id: owner.userId, name, walletAddress: address() });
      await db.insert(billingAccounts).values({ id: owner.billingAccountId, ownerUserId: owner.userId, balanceCredits: 0n });
      await seedPaperConnection(owner, "100");
      return { owner, db, wallet: await enrol(owner) };
    }
    const condition = `0x${"f".repeat(64)}`;
    const token = "812345678901234567890";
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    const later = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
    async function project(db: ReturnType<typeof getSeedDb>, wallet: EnrolledPaperWallet, at: Date) {
      return observePaperWallet({ db: db as unknown as PaperDb, wallet, now: at,
        readMidPrice: midPrices({ [token]: 0.5 }), logger });
    }
    async function canonical(db: ReturnType<typeof getSeedDb>, owner: Tenant, at: Date) {
      return readEconomicPositionProjection({ db, billingAccountId: owner.billingAccountId,
        walletAddress: derivePaperAccountAddress(owner.billingAccountId), connectionKind: "paper", capturedAt: at, interval: "ALL" });
    }
    async function current(db: ReturnType<typeof getSeedDb>, wallet: EnrolledPaperWallet) {
      return db.select().from(polyTraderCurrentPositions).where(eq(polyTraderCurrentPositions.traderWalletId, wallet.traderWalletId));
    }
    async function fills(db: ReturnType<typeof getSeedDb>, wallet: EnrolledPaperWallet) {
      return db.select().from(polyTraderFills).where(eq(polyTraderFills.traderWalletId, wallet.traderWalletId));
    }

    it("updates cumulative partial inventory without events, finalizes once, and upgrades unknown fees to known zero", async () => {
      const { owner, db, wallet } = await setup("Native cumulative paper");
      const native = await seedLedgerFill(owner, randomUUID(), { conditionId: condition, tokenId: token,
        side: "BUY", shares: "2", price: "0.4", status: "partial", feesUsdc: null, observedAt: t0 });
      if (!native) throw new Error("native fixture missing");
      expect((await project(db, wallet, later(1))).navPublished).toBe(false);
      expect(await fills(db, wallet)).toHaveLength(0);
      expect(Number((await current(db, wallet))[0]?.shares)).toBe(2);
      let read = await canonical(db, owner, later(1));
      expect(read.positionFacts[0]).toMatchObject({ heldShares: 2, currentValueUsdc: 1, lifetimePnlUsdc: null, economicsCoverage: "partial" });
      expect((await readBalanceAsTenant(owner)).kind).toBe("missing");
      await native.accept({ status: "partial", total_shares: 4, filled_size_usdc: 1.6,
        attributes: { market: condition, tokenId: token, side: "BUY", sizeMatched: 4 } }, later(2));
      await project(db, wallet, later(3));
      expect(await fills(db, wallet)).toHaveLength(0);
      expect(Number((await current(db, wallet))[0]?.shares)).toBe(4);
      await native.accept({ status: "filled", total_shares: 5, filled_size_usdc: 2, fees_usdc: undefined,
        attributes: { market: condition, tokenId: token, side: "BUY", sizeMatched: 5 } }, later(4));
      expect((await project(db, wallet, later(5))).navPublished).toBe(false);
      const immutable = await fills(db, wallet);
      expect(immutable).toHaveLength(1);
      expect(Number(immutable[0]?.shares)).toBe(5);
      expect(Number((await current(db, wallet))[0]?.shares)).toBe(5);
      read = await canonical(db, owner, later(5));
      expect(read.positionFacts[0]?.lifetimePnlUsdc).toBeNull();
      await native.accept({ status: "filled", total_shares: 5, filled_size_usdc: 2, fees_usdc: 0,
        attributes: { market: condition, tokenId: token, side: "BUY", sizeMatched: 5 } }, later(6));
      expect((await project(db, wallet, later(7))).navPublished).toBe(true);
      expect(await fills(db, wallet)).toEqual(immutable);
      expect(Number((await current(db, wallet))[0]?.shares)).toBe(5);
      read = await canonical(db, owner, later(7));
      expect(read.positionFacts[0]).toMatchObject({ heldShares: 5, currentValueUsdc: 2.5, lifetimePnlUsdc: 0.5, economicsCoverage: "complete" });
      expect((await readPaperAccountNavUsdc({ db: db as unknown as PaperDb, billingAccountId: owner.billingAccountId, now: later(7) })).navUsdc).toBe(100.5);
    });

    it("authenticates matching immutable legacy events only after proof time, preserving original bytes", async () => {
      const { owner, db, wallet } = await setup("Matching immutable native paper");
      const native = await seedLedgerFill(owner, randomUUID(), { conditionId: condition, tokenId: token,
        side: "BUY", shares: "5", price: "0.4", observedAt: t0 });
      if (!native) throw new Error("native fixture missing");
      const [ledger] = await db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, native.client));
      if (!ledger) throw new Error("ledger missing");
      await db.insert(polyTraderFills).values({ traderWalletId: wallet.traderWalletId, source: PAPER_FILL_SOURCE,
        nativeId: `${ledger.targetId}:${ledger.fillId}`, conditionId: condition, tokenId: token, side: "BUY", price: "0.4", shares: "5", sizeUsdc: "2",
        observedAt: later(-10), raw: { legacy: "keep byte-for-byte", paper_ledger: { client_order_id: native.client, order_id: native.order } } });
      const immutable = await fills(db, wallet);
      await db.insert(polyTraderIngestionCursors).values({ traderWalletId: wallet.traderWalletId, source: PAPER_POSITION_CURSOR_SOURCE, status: "ok", lastSuccessAt: later(-1) });
      const before = await canonical(db, owner, later(-1));
      expect(before.positionsMtm).toBeNull();
      expect(before.historyIncompleteCount).toBeGreaterThan(0);
      expect((await project(db, wallet, later(1))).navPublished).toBe(true);
      expect(await fills(db, wallet)).toEqual(immutable);
      expect((await canonical(db, owner, later(1))).positionFacts[0]).toMatchObject({ heldShares: 5, economicsCoverage: "complete" });
    });

    it("retains prior inventory and clocks for immutable conflicts and invalidates a still-fresh NAV", async () => {
      const { owner, db, wallet } = await setup("Conflicting immutable native paper");
      const native = await seedLedgerFill(owner, randomUUID(), { conditionId: condition, tokenId: token,
        side: "BUY", shares: "5", price: "0.4", observedAt: t0 });
      if (!native) throw new Error("native fixture missing");
      const [ledger] = await db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, native.client));
      if (!ledger) throw new Error("ledger missing");
      await db.insert(polyTraderFills).values({ traderWalletId: wallet.traderWalletId, source: PAPER_FILL_SOURCE,
        nativeId: `${ledger.targetId}:${ledger.fillId}`, conditionId: condition, tokenId: token, side: "BUY", price: "0.4", shares: "9", sizeUsdc: "3.6",
        observedAt: t0, raw: { paper_ledger: { client_order_id: native.client, order_id: native.order } } });
      await db.insert(polyTraderCurrentPositions).values({ traderWalletId: wallet.traderWalletId,
        conditionId: condition, tokenId: token, active: true, shares: "3", costBasisUsdc: "1.2", avgPrice: "0.4", currentValueUsdc: "1.5",
        contentHash: "retained-native-conflict", firstObservedAt: later(-1), lastObservedAt: later(-1), raw: { retained: true } });
      await persistWalletBalanceFact(db, { billingAccountId: owner.billingAccountId, address: derivePaperAccountAddress(owner.billingAccountId), usdcE: 100.3, pusd: null, pol: null, errors: ["paper NAV"] }, later(-1));
      const prior = await current(db, wallet);
      const immutable = await fills(db, wallet);
      expect((await project(db, wallet, later(1))).navPublished).toBe(false);
      expect(await fills(db, wallet)).toEqual(immutable);
      expect(await current(db, wallet)).toEqual(prior);
      expect((await readBalanceAsTenant(owner)).kind).toBe("missing");
      const read = await canonical(db, owner, later(1));
      expect(read.positionsMtm).toBeNull();
      expect(read.positionFacts[0]).toMatchObject({ heldShares: null, lifetimePnlUsdc: null });
      const dashboard = await readTenantWalletDashboard({ db, billingAccountId: owner.billingAccountId, interval: "1W", adapterConfigured: false });
      expect(dashboard.overview.usdc_total).toBeNull();
    });

    it.each([false, true])("conserves native paper cash and NAV through the real dashboard, fallback=%s", async (fallback) => {
      const { owner, db, wallet } = await setup(`Native paper dashboard ${fallback}`);
      const receiptAt = new Date(Date.now() - 2_000);
      await seedLedgerFill(owner, randomUUID(), { conditionId: condition, tokenId: token,
        side: "BUY", shares: "10", price: "0.4", observedAt: receiptAt });
      const generationAt = new Date(Date.now() - 1_000);
      expect((await observePaperWallet({ db: db as unknown as PaperDb, wallet, now: generationAt,
        readMidPrice: midPrices({ [token]: 0.6 }), logger })).navPublished).toBe(true);
      let injected = false;
      const wrap = <T extends { execute(query: SQL): unknown }>(targetDb: T): T => new Proxy(targetDb, {
        get(targetDb, property) {
          const value = Reflect.get(targetDb, property);
          if (property === "execute") return (query: SQL) => {
            const text = new PgDialect().sqlToQuery(query).sql;
            if (fallback && !injected && text.includes("target_snapshot_source AS MATERIALIZED")) {
              injected = true;
              return targetDb.execute(sql`SELECT paper_dashboard_forced_bundle_failure`);
            }
            return targetDb.execute(query);
          };
          if (property === "transaction") return (...args: unknown[]) => Reflect.apply(value, targetDb, [
            (child: T) => (args[0] as (child: T) => Promise<unknown>)(wrap(child)), ...args.slice(1),
          ]);
          return typeof value === "function" ? value.bind(targetDb) : value;
        },
      });
      const diagnostics: import("@/features/wallet-analysis/server/tenant-wallet-dashboard-service").WalletDashboardReadDiagnostics = {};
      const dashboard = await readTenantWalletDashboard({ db: wrap(db), billingAccountId: owner.billingAccountId,
        interval: "1W", adapterConfigured: false, diagnostics });
      expect(injected).toBe(fallback);
      expect(diagnostics.comparisonPath).toBe(fallback ? "bundle_fallback" : "bundle");
      // Independent accounting: seed100 - actual cost4 = cash96; mark6 => NAV102.
      expect(dashboard.overview).toMatchObject({ usdc_available: 96, usdc_locked: 0, usdc_positions_mtm: 6, usdc_total: 102 });
      await seedLedgerFill(owner, randomUUID(), { conditionId: condition, tokenId: "999",
        side: "BUY", shares: "1", price: "0.4", feesUsdc: null, observedAt: new Date() });
      // The last numeric NAV is still physically present and younger than TTL,
      // but its generation cannot certify a later unknown-fee observation.
      const [oldNav] = await db.select().from(polyWalletBalanceSnapshots)
        .where(eq(polyWalletBalanceSnapshots.billingAccountId, owner.billingAccountId));
      expect(Number(oldNav?.usdcE)).toBe(102);
      const withheld = await readTenantWalletDashboard({ db: wrap(db), billingAccountId: owner.billingAccountId,
        interval: "1W", adapterConfigured: false });
      expect(withheld.overview.usdc_available).toBeNull();
      expect(withheld.overview.usdc_total).toBeNull();
      await observePaperWallet({ db: db as unknown as PaperDb, wallet, now: new Date(),
        readMidPrice: midPrices({ [token]: 0.6, "999": 0.5 }), logger });
      expect((await readBalanceAsTenant(owner)).kind).toBe("missing");
    });

    it("cannot certify an empty book when an unbound row was omitted", async () => {
      const { owner, db, wallet } = await setup("Unbound omitted paper row");
      expect((await project(db, wallet, t0)).navPublished).toBe(true);
      await db.insert(polyCopyTradeFills).values({ billingAccountId: owner.billingAccountId,
        createdByUserId: owner.userId, targetId: randomUUID(), fillId: `unbound:${randomUUID()}`,
        marketId: condition, clientOrderId: randomUUID(), status: "partial", mode: "paper", observedAt: t0,
        price: "0.4", shares: "2", attributes: { condition_id: condition, token_id: token, side: "BUY", realized_fill_source: "paper_order_receipt", filled_size_usdc: 0.8 } });
      expect((await project(db, wallet, later(1))).navPublished).toBe(false);
      expect(await current(db, wallet)).toHaveLength(0);
      const read = await canonical(db, owner, later(1));
      expect(read.positionsMtm).toBeNull();
      expect(read.historyIncompleteCount).toBeGreaterThan(0);
      expect((await readBalanceAsTenant(owner)).kind).toBe("missing");
    });
  });

  describe("dual-kind tenants retain both balance facts", () => {
    const observedAt = new Date("2026-10-07T18:30:00.000Z");
    const liveAddress = address();

    beforeAll(async () => {
      const paperAddress = await seedPaperConnection(dual, SEED_USDC);
      await getSeedDb().insert(polyWalletConnections).values({
        billingAccountId: dual.billingAccountId,
        createdByUserId: dual.userId,
        kind: "privy_live",
        privyWalletId: `privy-${randomUUID()}`,
        address: liveAddress,
        funderAddress: liveAddress,
        clobApiKeyCiphertext: Buffer.from("ciphertext"),
        encryptionKeyId: "test-key",
        custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
        custodialConsentActorKind: "user",
        custodialConsentActorId: dual.userId,
      });
      await persistWalletBalanceFact(
        getSeedDb(),
        {
          billingAccountId: dual.billingAccountId,
          address: paperAddress,
          usdcE: 1000,
          pusd: null,
          pol: null,
          errors: ["paper NAV"],
        },
        observedAt
      );
      await persistWalletBalanceFact(
        getSeedDb(),
        {
          billingAccountId: dual.billingAccountId,
          address: liveAddress,
          usdcE: 10,
          pusd: 20,
          pol: 30,
          errors: [],
        },
        observedAt
      );
    });

    it("serves live to the dashboard and paper to the paper NAV reader", async () => {
      const dashboard = await readBalanceAsTenant(dual);
      expect(dashboard.kind).toBe("available");
      if (dashboard.kind !== "available") throw new Error("unreachable");
      expect(dashboard.address).toBe(liveAddress.toLowerCase());
      expect(dashboard.usdcE).toBe(10);

      const paper = await readPaperAccountNavUsdc({
        db: getSeedDb() as unknown as PaperDb,
        billingAccountId: dual.billingAccountId,
        now: observedAt,
      });
      expect(paper.navUsdc).toBe(1000);

      const rows = await getSeedDb()
        .select({ address: polyWalletBalanceSnapshots.address })
        .from(polyWalletBalanceSnapshots)
        .where(
          eq(polyWalletBalanceSnapshots.billingAccountId, dual.billingAccountId)
        );
      expect(rows).toHaveLength(2);
    });
  });

  describe("LIVE_IS_UNTOUCHED: a live account's facts are unaffected", () => {
    const liveAddress = address();
    let liveWalletId: string;

    beforeAll(async () => {
      const seedDb = getSeedDb();
      await seedDb.insert(polyWalletConnections).values({
        billingAccountId: live.billingAccountId,
        createdByUserId: live.userId,
        kind: "privy_live",
        privyWalletId: `privy-${randomUUID()}`,
        address: liveAddress,
        funderAddress: liveAddress,
        clobApiKeyCiphertext: Buffer.from("ciphertext"),
        encryptionKeyId: "test-key",
        custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
        custodialConsentActorKind: "user",
        custodialConsentActorId: live.userId,
      });

      const [liveWallet] = await seedDb
        .insert(polyTraderWallets)
        .values({
          walletAddress: liveAddress.toLowerCase(),
          kind: "cogni_wallet",
          label: "Tenant trading wallet",
        })
        .returning({ id: polyTraderWallets.id });
      if (!liveWallet) throw new Error("failed to seed live wallet");
      liveWalletId = liveWallet.id;

      // A real Data-API fact and a real on-chain balance snapshot.
      await seedDb.insert(polyTraderFills).values({
        traderWalletId: liveWalletId,
        source: "data-api",
        nativeId: "live-native-1",
        conditionId: condA,
        tokenId: tokenA,
        side: "BUY",
        price: "0.55000000",
        shares: "11.00000000",
        sizeUsdc: "6.05000000",
        observedAt: new Date("2026-10-04T00:00:00.000Z"),
      });
      await seedDb.insert(polyTraderCurrentPositions).values({
        traderWalletId: liveWalletId,
        conditionId: condA,
        tokenId: tokenA,
        active: true,
        shares: "11.00000000",
        costBasisUsdc: "6.05000000",
        currentValueUsdc: "7.00000000",
        avgPrice: "0.55000000",
        contentHash: "live-hash-1",
        lastObservedAt: new Date("2026-10-04T00:00:00.000Z"),
      });
      await seedDb.insert(polyWalletBalanceSnapshots).values({
        billingAccountId: live.billingAccountId,
        address: liveAddress.toLowerCase(),
        usdcE: "12.00000000",
        pusd: "3.00000000",
        pol: "0.500000000000000000",
        status: "ok",
        errors: [],
        observedAt: new Date("2026-10-04T00:00:00.000Z"),
      });

      // Now run a paper tick for every paper tenant — one full-set enrollment
      // followed by one projection each, exactly as the tick does.
      for (const enrolled of (await enrolAll()).values()) {
        await observePaperWallet({
          db: getSeedDb() as unknown as PaperDb,
          wallet: enrolled,
          readMidPrice: midPrices({
            [tokenA]: 0.5,
            [tokenB]: 0.65,
            [tokenU]: 0.35,
          }),
          logger,
          now: new Date("2026-10-07T19:00:00.000Z"),
        });
      }
    });

    it("leaves the live wallet's fills exactly as they were", async () => {
      const rows = await getSeedDb()
        .select({
          source: polyTraderFills.source,
          price: polyTraderFills.price,
          sizeUsdc: polyTraderFills.sizeUsdc,
        })
        .from(polyTraderFills)
        .where(eq(polyTraderFills.traderWalletId, liveWalletId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("data-api");
      expect(Number(rows[0]?.price)).toBeCloseTo(0.55, 8);
      expect(Number(rows[0]?.sizeUsdc)).toBeCloseTo(6.05, 8);
    });

    it("leaves the live wallet's current position exactly as it was", async () => {
      const rows = await getSeedDb()
        .select({
          contentHash: polyTraderCurrentPositions.contentHash,
          currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
          lastObservedAt: polyTraderCurrentPositions.lastObservedAt,
        })
        .from(polyTraderCurrentPositions)
        .where(eq(polyTraderCurrentPositions.traderWalletId, liveWalletId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.contentHash).toBe("live-hash-1");
      expect(Number(rows[0]?.currentValueUsdc)).toBeCloseTo(7, 8);
      expect(rows[0]?.lastObservedAt).toEqual(
        new Date("2026-10-04T00:00:00.000Z")
      );
    });

    it("leaves the live wallet's balance snapshot exactly as it was", async () => {
      const balance = await readBalanceAsTenant(live);
      expect(balance.kind).toBe("available");
      if (balance.kind !== "available") throw new Error("unreachable");
      expect(balance.usdcE).toBeCloseTo(12, 8);
      expect(balance.pusd).toBeCloseTo(3, 8);
      expect(balance.status).toBe("ok");
    });

    it("SWEEPS_ARE_DISJOINT: the paper sweep never retires a cogni_wallet", async () => {
      const rows = await getSeedDb()
        .select({
          activeForResearch: polyTraderWallets.activeForResearch,
          disabledAt: polyTraderWallets.disabledAt,
        })
        .from(polyTraderWallets)
        .where(eq(polyTraderWallets.id, liveWalletId));

      expect(rows[0]?.activeForResearch).toBe(true);
      expect(rows[0]?.disabledAt).toBeNull();
    });

    it("an empty paper account list retires nothing", async () => {
      const paperAddress = derivePaperAccountAddress(traded.billingAccountId);
      await syncPaperTraderWallets(getSeedDb() as unknown as PaperDb, []);

      const rows = await getSeedDb()
        .select({
          activeForResearch: polyTraderWallets.activeForResearch,
          disabledAt: polyTraderWallets.disabledAt,
        })
        .from(polyTraderWallets)
        .where(eq(polyTraderWallets.walletAddress, paperAddress));

      // An empty read is indistinguishable from an outage; retiring on it
      // would lose the dashboard for every paper tenant at once.
      expect(rows[0]?.activeForResearch).toBe(true);
      expect(rows[0]?.disabledAt).toBeNull();
    });
  });
  describe("the gate is the data, not POLY_TRADER_OBSERVATION_WRITER_ENABLED", () => {
    it("projects whenever an active paper account exists, reading no env flag", async () => {
      const events = recordingLogger();
      const result = await runPaperProjectionTick({
        db: getSeedDb() as unknown as PaperDb,
        readMidPrice: midPrices({
          [tokenA]: 0.5,
          [tokenB]: 0.65,
          [tokenU]: 0.35,
        }),
        logger: events.logger,
        now: new Date("2026-10-07T20:00:00.000Z"),
      });

      // Both seeded paper tenants are found and projected. Nothing in this
      // path consults POLY_TRADER_OBSERVATION_WRITER_ENABLED — that lever
      // throttles Data-API observation, whose write load this does not share.
      expect(result.paperAccounts).toBeGreaterThanOrEqual(2);
      expect(result.walletsProjected).toBe(result.paperAccounts);
      expect(result.navsPublished).toBeGreaterThanOrEqual(2);
      expect(result.errors).toBe(0);
      expect(result.idleReason).toBeUndefined();
      expect(events.phases()).toContain("wallet_ok");
    });

    it("logs idle_no_paper_accounts and writes nothing when none exist", async () => {
      const seedDb = getSeedDb();
      // Deterministically reach the zero-account state by revoking every
      // active paper connection, then restoring exactly those rows. Other
      // component files share this database, so write assertions below stay
      // scoped to the captured accounts rather than comparing global counts.
      const active = await seedDb
        .select({
          id: polyWalletConnections.id,
          billingAccountId: polyWalletConnections.billingAccountId,
        })
        .from(polyWalletConnections)
        .where(
          and(
            eq(polyWalletConnections.kind, "paper"),
            isNull(polyWalletConnections.revokedAt)
          )
        );
      expect(active.length).toBeGreaterThan(0);
      const ids = active.map((row) => row.id);
      const billingAccountIds = active.map((row) => row.billingAccountId);

      const navsBefore = await seedDb
        .select({ billingAccountId: polyWalletBalanceSnapshots.billingAccountId })
        .from(polyWalletBalanceSnapshots)
        .where(
          inArray(
            polyWalletBalanceSnapshots.billingAccountId,
            billingAccountIds
          )
        );

      const events = recordingLogger();
      try {
        await seedDb
          .update(polyWalletConnections)
          .set({ revokedAt: new Date("2026-10-07T21:00:00.000Z") })
          .where(inArray(polyWalletConnections.id, ids));

        const result = await runPaperProjectionTick({
          db: seedDb as unknown as PaperDb,
          // Would throw if ever called — proves the gate short-circuits BEFORE
          // any market read, so an idle lane costs one indexed SELECT.
          readMidPrice: () => {
            throw new Error("mid price must not be read when idle");
          },
          logger: events.logger,
        });

        expect(result.idleReason).toBe("no_paper_accounts");
        expect(result.paperAccounts).toBe(0);
        expect(result.walletsProjected).toBe(0);
        expect(result.errors).toBe(0);

        // Observable as IDLE, not BROKEN. A silent no-op here would reproduce
        // exactly the invisible-paper-account failure this slice exists to fix.
        expect(events.phases()).toContain("idle_no_paper_accounts");
        expect(events.phases()).not.toContain("account_failed");

        // And it wrote nothing.
        const navsAfter = await seedDb
          .select({
            billingAccountId: polyWalletBalanceSnapshots.billingAccountId,
          })
          .from(polyWalletBalanceSnapshots)
          .where(
            inArray(
              polyWalletBalanceSnapshots.billingAccountId,
              billingAccountIds
            )
          );
        expect(navsAfter).toHaveLength(navsBefore.length);
      } finally {
        await seedDb
          .update(polyWalletConnections)
          .set({ revokedAt: null })
          .where(inArray(polyWalletConnections.id, ids));
      }
    });

    it("retires nothing on the idle path, so paper wallets survive an empty lane", async () => {
      const paperAddress = derivePaperAccountAddress(traded.billingAccountId);
      const rows = await getSeedDb()
        .select({
          activeForResearch: polyTraderWallets.activeForResearch,
          disabledAt: polyTraderWallets.disabledAt,
        })
        .from(polyTraderWallets)
        .where(eq(polyTraderWallets.walletAddress, paperAddress));

      expect(rows[0]?.activeForResearch).toBe(true);
      expect(rows[0]?.disabledAt).toBeNull();
    });
  });
});
