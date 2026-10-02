// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Persisted, tenant-scoped wallet cash facts. Polygon RPC is writer-only. */
import {
  polyWalletBalanceSnapshots,
  polyWalletConnections,
} from "@cogni/db-schema/wallet-connections";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

export const WALLET_BALANCE_FRESHNESS_MS = 10 * 60_000;

export type WalletBalanceFact = {
  billingAccountId: string;
  address: `0x${string}`;
  usdcE: number | null;
  pusd: number | null;
  pol: number | null;
  errors: readonly string[];
};

export async function refreshWalletBalanceFacts(input: {
  wallets: readonly { billingAccountId: string; address: `0x${string}` }[];
  read: (billingAccountId: string) => Promise<Omit<WalletBalanceFact, "billingAccountId"> | null>;
  persist: (fact: WalletBalanceFact) => Promise<void>;
  concurrency?: number;
}): Promise<{ succeeded: number; failed: number }> {
  const concurrency = Math.max(1, input.concurrency ?? 3);
  let succeeded = 0;
  let failed = 0;
  for (let offset = 0; offset < input.wallets.length; offset += concurrency) {
    const results = await Promise.allSettled(
      input.wallets.slice(offset, offset + concurrency).map(async (wallet) => {
        const balances = await input.read(wallet.billingAccountId);
        if (!balances) throw new Error("active wallet balance read returned null");
        if (balances.address.toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error("wallet balance address changed during observation");
        }
        await input.persist({ billingAccountId: wallet.billingAccountId, ...balances });
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled") succeeded += 1;
      else failed += 1;
    }
  }
  return { succeeded, failed };
}

export function classifyWalletBalanceStatus(
  fact: Pick<WalletBalanceFact, "usdcE" | "pusd" | "pol" | "errors">
): "ok" | "partial" | "error" {
  const nonNullLegs = [fact.usdcE, fact.pusd, fact.pol].filter(
    (value) => value !== null
  ).length;
  if (nonNullLegs === 3 && fact.errors.length === 0) return "ok";
  return nonNullLegs === 0 ? "error" : "partial";
}

export async function persistWalletBalanceFact(
  db: Db,
  fact: WalletBalanceFact,
  observedAt = new Date()
): Promise<void> {
  const errors = fact.errors.slice(0, 8).map((message) => message.slice(0, 500));
  const status = classifyWalletBalanceStatus({ ...fact, errors });
  await db
    .insert(polyWalletBalanceSnapshots)
    .values({
      billingAccountId: fact.billingAccountId,
      address: fact.address.toLowerCase(),
      usdcE: fact.usdcE?.toString() ?? null,
      pusd: fact.pusd?.toString() ?? null,
      pol: fact.pol?.toString() ?? null,
      status,
      errors,
      observedAt,
    })
    .onConflictDoUpdate({
      target: polyWalletBalanceSnapshots.billingAccountId,
      set: {
        address: sql`excluded.address`,
        usdcE: sql`excluded.usdc_e`,
        pusd: sql`excluded.pusd`,
        pol: sql`excluded.pol`,
        status: sql`excluded.status`,
        errors: sql`excluded.errors`,
        observedAt: sql`excluded.observed_at`,
        updatedAt: sql`now()`,
      },
    });
}

export async function readWalletBalanceFact(db: Db, billingAccountId: string) {
  const rows = await db
    .select({
      address: sql<string>`lower(coalesce(${polyWalletConnections.funderAddress}, ${polyWalletConnections.address}))`,
      snapshot: polyWalletBalanceSnapshots,
    })
    .from(polyWalletConnections)
    .leftJoin(
      polyWalletBalanceSnapshots,
      and(
        eq(
          polyWalletConnections.billingAccountId,
          polyWalletBalanceSnapshots.billingAccountId
        ),
        isNull(polyWalletConnections.revokedAt),
        sql`lower(${polyWalletBalanceSnapshots.address}) = lower(coalesce(${polyWalletConnections.funderAddress}, ${polyWalletConnections.address}))`
      )
    )
    .where(
      and(
        eq(polyWalletConnections.billingAccountId, billingAccountId),
        isNull(polyWalletConnections.revokedAt)
      )
    )
    .limit(1);
  const result = rows[0];
  if (!result) return { kind: "no_wallet" as const };
  const row = result.snapshot;
  if (!row) {
    return { kind: "missing" as const, address: result.address as `0x${string}` };
  }
  return {
    kind: "available" as const,
    address: row.address as `0x${string}`,
    usdcE: row.usdcE === null ? null : Number(row.usdcE),
    pusd: row.pusd === null ? null : Number(row.pusd),
    pol: row.pol === null ? null : Number(row.pol),
    status: row.status as "ok" | "partial" | "error",
    errors: row.errors,
    observedAt: row.observedAt,
  };
}
