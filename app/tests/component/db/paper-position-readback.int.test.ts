// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/paper-position-readback.int.test`
 * Purpose: Prove the read-back half of the paper fact projection — the path by
 *   which a paper account's own positions and NAV reach `position_gap` sizing
 *   and the SELL-close branch. The value this replaces was
 *   `getPositionShareBalance: async () => 0`, so the assertions that matter most
 *   here are the REFUSALS: every state in which the facts are absent,
 *   incomplete, or stale must raise rather than read as a flat book.
 * Scope: Real Postgres via testcontainers. Drives the REAL writer
 *   (`observePaperWallet`) and then reads it back, so a drift between the two
 *   halves fails this file rather than surfacing as a mis-sized paper order.
 *   No HTTP, no Privy, no CLOB (the mid-price reader is injected).
 * Invariants:
 *   - READS_THE_PROJECTION_NEVER_REAGGREGATES — the numbers read back are the
 *     ones the writer stored, marked at the injected mid.
 *   - FRESHNESS_IS_A_PRECONDITION — never_projected / projection_incomplete /
 *     projection_stale each raise, and an empty book is returned ONLY when a
 *     complete recent tick proves the account holds nothing.
 *   - NAV_IS_THE_PAPER_ACCOUNT'S — a NAV row written for a different address is
 *     not borrowed.
 * Side-effects: IO (testcontainers Postgres)
 * Links: migrations/0082, migrations/0083, docs/spec/capability-plane.md
 * @internal
 */

import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { derivePaperAccountAddress } from "@/features/paper-accounts";
import { readCurrentWalletPositionModel } from "@/features/wallet-analysis/server/current-position-read-model";
import {
  type EnrolledPaperWallet,
  observePaperWallet,
  PAPER_FACTS_MAX_STALENESS_MS,
  PAPER_POSITION_CURSOR_SOURCE,
  type PaperFactsUnavailableError,
  type PaperMidPriceReader,
  readActivePaperAccounts,
  readPaperAccountNavUsdc,
  readPaperAccountPositionFacts,
  syncPaperTraderWallets,
} from "@/features/wallet-analysis/server/paper-fact-source";
import {
  billingAccounts,
  polyCopyTradeFills,
  polyTraderIngestionCursors,
  polyWalletBalanceSnapshots,
  polyWalletConnections,
  users,
} from "@/shared/db/schema";

type PaperDb = Parameters<typeof observePaperWallet>[0]["db"];

/** Quiet logger — this file asserts returned facts, not log text. */
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as Parameters<typeof observePaperWallet>[0]["logger"];

type Tenant = { userId: string; billingAccountId: string; name: string };

function tenant(name: string): Tenant {
  return { userId: randomUUID(), billingAccountId: randomUUID(), name };
}

function address(): `0x${string}` {
  const hex = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  return `0x${hex.slice(0, 40)}` as `0x${string}`;
}

function paperDb(): PaperDb {
  return getSeedDb() as unknown as PaperDb;
}

/** A mid-price reader over a fixed table; absent token => `null` (unknown). */
function midPrices(table: Record<string, number>): PaperMidPriceReader {
  return async (tokenId) => table[tokenId] ?? null;
}

async function seedPaperConnection(owner: Tenant, seedUsdc: string) {
  const paperAddress = derivePaperAccountAddress(owner.billingAccountId);
  await getSeedDb()
    .insert(polyWalletConnections)
    .values({
      billingAccountId: owner.billingAccountId,
      createdByUserId: owner.userId,
      kind: "paper",
      address: paperAddress,
      funderAddress: paperAddress,
      paperSeedUsdc: seedUsdc,
      custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
      custodialConsentActorKind: "user",
      custodialConsentActorId: owner.userId,
      tradingApprovalsReadyAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  return paperAddress;
}

async function seedLedgerFill(
  owner: Tenant,
  targetId: string,
  fill: {
    tokenId: string;
    conditionId: string;
    side: "BUY" | "SELL";
    price: string;
    shares: string;
  }
): Promise<void> {
  await getSeedDb()
    .insert(polyCopyTradeFills)
    .values({
      billingAccountId: owner.billingAccountId,
      createdByUserId: owner.userId,
      targetId,
      fillId: `paper:${randomUUID()}`,
      marketId: fill.conditionId,
      observedAt: new Date("2026-10-05T12:00:00.000Z"),
      clientOrderId: `coid-${randomUUID()}`,
      orderId: `order-${randomUUID()}`,
      status: "filled",
      mode: "paper",
      price: fill.price,
      shares: fill.shares,
      feesUsdc: "0",
      attributes: {
        side: fill.side,
        token_id: fill.tokenId,
        condition_id: fill.conditionId,
        size_usdc: Number(fill.price) * Number(fill.shares),
        limit_price: Number(fill.price),
      },
    });
}

/**
 * Enrol EVERY active paper account, then pick one out — `syncPaperTraderWallets`
 * retires paper wallets absent from the list it is handed, so a single-element
 * sync would retire the other tenants in this file.
 */
async function enrol(owner: Tenant): Promise<EnrolledPaperWallet> {
  const db = paperDb();
  const accounts = await readActivePaperAccounts(db, logger);
  const enrolled = await syncPaperTraderWallets(db, accounts);
  const wallet = enrolled.find(
    (entry) => entry.account.billingAccountId === owner.billingAccountId
  );
  if (!wallet) throw new Error(`paper wallet not enrolled for ${owner.name}`);
  return wallet;
}

/** Resolve a rejection into the typed error without `expect().rejects` noise. */
async function reasonOf(run: Promise<unknown>): Promise<string> {
  const err = await run.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, "expected the reader to refuse, but it resolved").not.toBeNull();
  return (err as PaperFactsUnavailableError).reason;
}

describe("paper position + NAV read-back", () => {
  const holder = tenant("Paper tenant holding one position");
  const flat = tenant("Paper tenant that closed out");
  const unmarked = tenant("Paper tenant with an unpriceable position");
  const unenrolled = tenant("Paper tenant never projected");
  const tenants = [holder, flat, unmarked, unenrolled];

  const condA = `0xcond${"1".repeat(60)}`;
  const tokenA = "44444444444444444444444444444444";
  const condB = `0xcond${"2".repeat(60)}`;
  const tokenB = "55555555555555555555555555555555";
  const condU = `0xcond${"3".repeat(60)}`;
  const tokenU = "66666666666666666666666666666666";

  const SEED = "1000.00000000";
  const targetId = randomUUID();
  // The shared dashboard reader enforces its production six-hour row TTL
  // against database NOW(). Keep this projection current; refusal tests below
  // advance their own read clock explicitly when proving staleness.
  const observedAt = new Date();

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
    for (const entry of tenants) {
      await seedPaperConnection(entry, SEED);
    }

    // holder: bought 100 shares @ 0.40, still holds them.
    await seedLedgerFill(holder, targetId, {
      tokenId: tokenA,
      conditionId: condA,
      side: "BUY",
      price: "0.40",
      shares: "100",
    });
    // flat: bought then sold the same size — verifiably holds nothing.
    await seedLedgerFill(flat, targetId, {
      tokenId: tokenB,
      conditionId: condB,
      side: "BUY",
      price: "0.50",
      shares: "20",
    });
    await seedLedgerFill(flat, targetId, {
      tokenId: tokenB,
      conditionId: condB,
      side: "SELL",
      price: "0.55",
      shares: "20",
    });
    // unmarked: holds a position whose mid cannot be read.
    await seedLedgerFill(unmarked, targetId, {
      tokenId: tokenU,
      conditionId: condU,
      side: "BUY",
      price: "0.30",
      shares: "10",
    });

    await observePaperWallet({
      db: paperDb(),
      wallet: await enrol(holder),
      readMidPrice: midPrices({ [tokenA]: 0.5 }),
      logger,
      now: observedAt,
    });
    await observePaperWallet({
      db: paperDb(),
      wallet: await enrol(flat),
      readMidPrice: midPrices({}),
      logger,
      now: observedAt,
    });
    await observePaperWallet({
      db: paperDb(),
      wallet: await enrol(unmarked),
      // No mid for tokenU → NAV withheld, cursor `partial`.
      readMidPrice: midPrices({}),
      logger,
      now: observedAt,
    });
  });

  describe("the open book", () => {
    it("feeds the shared dashboard position model through the paper cursor", async () => {
      const model = await readCurrentWalletPositionModel({
        db: paperDb(),
        walletAddress: derivePaperAccountAddress(holder.billingAccountId),
        capturedAt: observedAt,
      });

      expect(model.warnings).toEqual([]);
      expect(model.summary).toMatchObject({
        positionsMtm: 50,
        activeRows: 1,
        hasSuccessfulObservation: true,
        cursorStatus: "ok",
        stale: false,
      });
      expect(model.positions).toHaveLength(1);
      expect(model.positions[0]).toMatchObject({
        conditionId: condA.toLowerCase(),
        asset: tokenA,
        size: 100,
        currentValue: 50,
      });
    });

    it("reads back the position the writer marked, not a re-aggregation", async () => {
      const facts = await readPaperAccountPositionFacts({
        db: paperDb(),
        billingAccountId: holder.billingAccountId,
        now: observedAt,
      });

      expect(facts.address).toBe(
        derivePaperAccountAddress(holder.billingAccountId)
      );
      expect(facts.observedAt.getTime()).toBe(observedAt.getTime());
      expect(facts.positions).toHaveLength(1);
      const position = facts.positions[0];
      expect(position?.tokenId).toBe(tokenA);
      expect(position?.conditionId).toBe(condA);
      expect(position?.shares).toBe(100);
      // 100 shares × the injected 0.50 mid — the writer's mark, read back.
      expect(position?.currentValueUsdc).toBe(50);
      expect(position?.avgPrice).toBeCloseTo(0.4, 8);
    });

    it("returns an EMPTY book for an account that verifiably holds nothing", async () => {
      const facts = await readPaperAccountPositionFacts({
        db: paperDb(),
        billingAccountId: flat.billingAccountId,
        now: observedAt,
      });
      // Empty is a fact here: the tick completed `ok` and the position closed.
      expect(facts.positions).toEqual([]);
    });

    it("refuses an account the projection has never run for", async () => {
      // `unenrolled` has a paper connection but was never observed.
      expect(
        await reasonOf(
          readPaperAccountPositionFacts({
            db: paperDb(),
            billingAccountId: unenrolled.billingAccountId,
            now: observedAt,
          })
        )
      ).toBe("never_projected");
    });

    it("refuses when the last tick could not mark every position", async () => {
      expect(
        await reasonOf(
          readPaperAccountPositionFacts({
            db: paperDb(),
            billingAccountId: unmarked.billingAccountId,
            now: observedAt,
          })
        )
      ).toBe("projection_incomplete");
    });

    it("refuses a stale projection rather than understate the book", async () => {
      const wayLater = new Date(
        observedAt.getTime() + PAPER_FACTS_MAX_STALENESS_MS + 1_000
      );
      expect(
        await reasonOf(
          readPaperAccountPositionFacts({
            db: paperDb(),
            billingAccountId: holder.billingAccountId,
            now: wayLater,
          })
        )
      ).toBe("projection_stale");
    });
  });

  describe("NAV", () => {
    it("reads the published paper NAV", async () => {
      const nav = await readPaperAccountNavUsdc({
        db: paperDb(),
        billingAccountId: holder.billingAccountId,
        now: observedAt,
      });
      // seed 1000 − 40 spent + 50 marked = 1010.
      expect(nav.navUsdc).toBeCloseTo(1010, 6);
      expect(nav.observedAt.getTime()).toBe(observedAt.getTime());
    });

    it("refuses when the projection withheld the NAV", async () => {
      expect(
        await reasonOf(
          readPaperAccountNavUsdc({
            db: paperDb(),
            billingAccountId: unmarked.billingAccountId,
            now: observedAt,
          })
        )
      ).toBe("nav_missing");
    });

    it("reads the paper NAV while a live-address snapshot coexists", async () => {
      await getSeedDb()
        .insert(polyWalletBalanceSnapshots)
        .values({
          billingAccountId: flat.billingAccountId,
          address: address(),
          usdcE: "77.00000000",
          pusd: "88.00000000",
          pol: "1.000000000000000000",
          status: "ok",
          errors: [],
          observedAt,
        });

      const nav = await readPaperAccountNavUsdc({
        db: paperDb(),
        billingAccountId: flat.billingAccountId,
        now: observedAt,
      });
      expect(nav.navUsdc).toBeCloseTo(1000, 6);
    });

    it("refuses a stale NAV", async () => {
      const wayLater = new Date(
        observedAt.getTime() + PAPER_FACTS_MAX_STALENESS_MS + 1_000
      );
      expect(
        await reasonOf(
          readPaperAccountNavUsdc({
            db: paperDb(),
            billingAccountId: holder.billingAccountId,
            now: wayLater,
          })
        )
      ).toBe("projection_stale");
    });
  });

  describe("the cursor is the gate", () => {
    it("refuses as soon as the cursor regresses, without touching positions", async () => {
      const wallet = await enrol(holder);
      await getSeedDb()
        .update(polyTraderIngestionCursors)
        .set({ status: "error", errorMessage: "injected" })
        .where(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.traderWalletId)
        );

      expect(
        await reasonOf(
          readPaperAccountPositionFacts({
            db: paperDb(),
            billingAccountId: holder.billingAccountId,
            now: observedAt,
          })
        )
      ).toBe("projection_incomplete");
    });
  });
});
