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
import { seedNativePaperConnection as seedPaperConnection, seedNativePaperFill as seedLedgerFill } from "./native-paper-receipt.fixture";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { __resetPolyExecutionVenueForTests, getPaperPortfolio, readPaperAuthoritativeHoldings } from "@/bootstrap/poly-execution-venue";

// Redirect only the client factory; every SQL statement/result remains real.
vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => getSeedDb(),
}));

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
  polyTraderIngestionCursors,
  polyTraderCurrentPositions,
  polyTraderWallets,
  polyWalletBalanceSnapshots,
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

  const condA = `0x${"1".repeat(64)}`;
  const tokenA = "44444444444444444444444444444444";
  const condB = `0x${"2".repeat(64)}`;
  const tokenB = "55555555555555555555555555555555";
  const condU = `0x${"3".repeat(64)}`;
  const tokenU = "66666666666666666666666666666666";

  const SEED = "1000.00000000";
  const targetId = randomUUID();
  // The shared dashboard reader enforces its production six-hour row TTL
  // against database NOW(). Keep this projection current; refusal tests below
  // advance their own read clock explicitly when proving staleness.
  let observedAt: Date;

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

    const holderWallet = await enrol(holder);
    observedAt = new Date();
    await observePaperWallet({
      db: paperDb(),
      wallet: holderWallet,
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
        billingAccountId: holder.billingAccountId,
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
      // Closed at a $1 realized gain: 1000 - 10 bought + 11 sold.
      expect(nav.navUsdc).toBeCloseTo(1001, 6);
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

/** Independent test cohort: direct fixtures stay inside the disposable PG DB. */
async function freshPaperBook(
	name: string,
	positions: readonly {
		conditionId: string;
		tokenId: string;
		shares: string;
		currentValueUsdc?: string;
		avgPrice?: string;
	}[] = [],
) {
	const owner = tenant(name);
	const db = getSeedDb();
	await db
		.insert(users)
		.values({ id: owner.userId, name, walletAddress: address() });
	await db
		.insert(billingAccounts)
		.values({
			id: owner.billingAccountId,
			ownerUserId: owner.userId,
			balanceCredits: 0n,
		});
	await seedPaperConnection(owner, "1000");
	const wallet = await enrol(owner);
	const observedAt = new Date();
	await db
		.insert(polyTraderIngestionCursors)
		.values({
			traderWalletId: wallet.traderWalletId,
			source: PAPER_POSITION_CURSOR_SOURCE,
			status: "ok",
			lastSuccessAt: observedAt,
		});
	if (positions.length)
		await db.insert(polyTraderCurrentPositions).values(
			positions.map((position) => ({
				traderWalletId: wallet.traderWalletId,
				...position,
				costBasisUsdc: "1",
				currentValueUsdc: position.currentValueUsdc ?? "1",
				avgPrice: position.avgPrice ?? "0.4",
				active: true,
				contentHash: randomUUID(),
				lastObservedAt: observedAt,
			})),
		);
	return { owner, wallet, observedAt };
}
const exactCondition = `0x${"a".repeat(64)}`;
const otherCondition = `0x${"b".repeat(64)}`;
const exactToken =
	"110616094455216194978699423493753093017667578376232016563683270718005271026032";

function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("one coherent canonical paper holdings query", () => {
	it.each([84, 840])(
		"uses the real bootstrap portfolio and ONE physical SELECT for %i legs",
		async (count) => {
			const { owner } = await freshPaperBook(`bounded-${count}`, [
				{
					conditionId: exactCondition,
					tokenId: exactToken,
					shares: "229.28000000",
				},
			]);
			// A different tenant's same token must never leak into this book.
			await freshPaperBook(`other-${count}`, [
				{ conditionId: exactCondition, tokenId: exactToken, shares: "999" },
			]);
			__resetPolyExecutionVenueForTests();
			const portfolio = getPaperPortfolio();
			const source = vi.spyOn(portfolio, "listOpenPositions");
			// Spy through the actual postgres-js dispatch, preserving its implementation.
			const wire = vi.spyOn(getSeedDb().$client, "unsafe");
			try {
				const requested = [
					{ conditionId: exactCondition, tokenId: exactToken },
					...Array.from({ length: count - 1 }, (_, i) => ({
						conditionId: exactCondition,
						tokenId: String(i + 1),
					})),
				];
				const holdings = await readPaperAuthoritativeHoldings({
					source: portfolio,
					billingAccountId: owner.billingAccountId,
					requested,
				});
				expect(source).toHaveBeenCalledTimes(1);
				expect(source).toHaveBeenCalledWith(owner.billingAccountId);
				expect(
					wire.mock.calls.filter(([query]) => /^\s*select\b/i.test(query)),
				).toHaveLength(1);
				expect(holdings).toHaveLength(count);
				expect(holdings[0]).toEqual({
					conditionId: exactCondition,
					tokenId: exactToken,
					shares: 229.28,
				});
				expect(holdings.slice(1).every((leg) => leg.shares === 0)).toBe(true);
			} finally {
				wire.mockRestore();
				source.mockRestore();
				__resetPolyExecutionVenueForTests();
			}
		},
	);

	it("reads complete old and new cursor/book cohorts across a real writer commit barrier", async () => {
		const { owner, wallet, observedAt } = await freshPaperBook(
			"atomic-old-new",
			[{ conditionId: exactCondition, tokenId: exactToken, shares: "7" }],
		);
		const newObservedAt = new Date(observedAt.getTime() + 1);
		const updated = barrier();
		const commit = barrier();
		const writer = getSeedDb().transaction(async (tx) => {
			await tx
				.update(polyTraderCurrentPositions)
				.set({
					shares: "19",
					currentValueUsdc: "9.5",
					lastObservedAt: newObservedAt,
				})
				.where(
					eq(polyTraderCurrentPositions.traderWalletId, wallet.traderWalletId),
				);
			await tx
				.update(polyTraderIngestionCursors)
				.set({ lastSuccessAt: newObservedAt })
				.where(
					and(
						eq(
							polyTraderIngestionCursors.traderWalletId,
							wallet.traderWalletId,
						),
						eq(polyTraderIngestionCursors.source, PAPER_POSITION_CURSOR_SOURCE),
					),
				);
			updated.release();
			await commit.promise;
		});
		try {
			await Promise.race([updated.promise, writer.then(() => { throw new Error("writer ended before barrier"); })]);
			const before = await readPaperAccountPositionFacts({
				db: paperDb(),
				billingAccountId: owner.billingAccountId,
				now: newObservedAt,
			});
			expect([
				before.observedAt.getTime(),
				before.positions[0]?.shares,
				before.positions[0]?.currentValueUsdc,
			]).toEqual([observedAt.getTime(), 7, 1]);
		} finally {
			commit.release();
			await writer;
		}
		const after = await readPaperAccountPositionFacts({
			db: paperDb(),
			billingAccountId: owner.billingAccountId,
			now: newObservedAt,
		});
		expect([
			after.observedAt.getTime(),
			after.positions[0]?.shares,
			after.positions[0]?.currentValueUsdc,
		]).toEqual([newObservedAt.getTime(), 19, 9.5]);
	});

	it("refuses missing, wrong-kind and disabled wallets without borrowing another mode", async () => {
		const never = tenant("not-enrolled-anywhere");
		expect(
			await reasonOf(
				readPaperAccountPositionFacts({
					db: paperDb(),
					billingAccountId: never.billingAccountId,
				}),
			),
		).toBe("no_paper_wallet");
		const { owner, wallet } = await freshPaperBook("wrong-kind");
		await getSeedDb()
			.update(polyTraderWallets)
			.set({ kind: "cogni_wallet" })
			.where(eq(polyTraderWallets.id, wallet.traderWalletId));
		expect(
			await reasonOf(
				readPaperAccountPositionFacts({
					db: paperDb(),
					billingAccountId: owner.billingAccountId,
				}),
			),
		).toBe("no_paper_wallet");
		await getSeedDb()
			.update(polyTraderWallets)
			.set({ kind: "paper_wallet", disabledAt: new Date() })
			.where(eq(polyTraderWallets.id, wallet.traderWalletId));
		expect(
			await reasonOf(
				readPaperAccountPositionFacts({
					db: paperDb(),
					billingAccountId: owner.billingAccountId,
				}),
			),
		).toBe("no_paper_wallet");
	});

	it("rejects future cursor authority", async () => {
		const { owner, wallet, observedAt } = await freshPaperBook("future-cursor");
		await getSeedDb()
			.update(polyTraderIngestionCursors)
			.set({ lastSuccessAt: new Date(observedAt.getTime() + 60_000) })
			.where(
				eq(polyTraderIngestionCursors.traderWalletId, wallet.traderWalletId),
			);
		expect(
			await reasonOf(
				readPaperAccountPositionFacts({
					db: paperDb(),
					billingAccountId: owner.billingAccountId,
					now: observedAt,
				}),
			),
		).toBe("projection_incomplete");
	});

	it.each([
		[{ conditionId: "0xinvalid", tokenId: exactToken, shares: "1" }],
		[{ conditionId: exactCondition, tokenId: "01", shares: "1" }],
		[{ conditionId: exactCondition, tokenId: exactToken, shares: "0" }],
		[{ conditionId: exactCondition, tokenId: exactToken, shares: "NaN" }],
		[
			{
				conditionId: exactCondition,
				tokenId: exactToken,
				shares: "1",
				avgPrice: "-1",
			},
		],
		[
			{ conditionId: exactCondition, tokenId: exactToken, shares: "1" },
			{ conditionId: otherCondition, tokenId: exactToken, shares: "2" },
		],
		[
			{ conditionId: exactCondition, tokenId: exactToken, shares: "1" },
			{ conditionId: `0x${"A".repeat(64)}`, tokenId: exactToken, shares: "2" },
		],
	])(
		"fails closed on persisted malformed, unreadable or conflicting legs %#",
		async (...positions) => {
			const { owner, observedAt } = await freshPaperBook(
				"corrupt-book",
				positions,
			);
			expect(
				await reasonOf(
					readPaperAccountPositionFacts({
						db: paperDb(),
						billingAccountId: owner.billingAccountId,
						now: observedAt,
					}),
				),
			).toBe("projection_incomplete");
		},
	);
});
