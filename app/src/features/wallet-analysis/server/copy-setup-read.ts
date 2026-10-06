// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/copy-setup-read`
 * Purpose: Capability 1 of task.1791070959 — "what is this account configured
 *   to mirror right now?". Joins the TWO surviving sources of copy-trade setup:
 *   per-target sizing policy from `poly_copy_trade_targets`, and account-wide
 *   wallet safety caps from `poly_wallet_grants`.
 * Scope: Three bounded reads on the dispatcher's app-role tenant transaction.
 *   No authorization, no HTTP, no container, no upstream API.
 * Invariants:
 *   - THERE_IS_NO_CONFIG_TABLE — `poly_copy_trade_config` was DROPPED by
 *     migration 0036 (`DROP TABLE ... CASCADE`, the whole file) and has zero
 *     references in either schema package. The original task text asking for a
 *     delegated SELECT policy on it is obsolete. There is also no per-tenant
 *     kill switch (NO_KILL_SWITCH, bug.0438): having an active target row IS
 *     the opt-in. Effective policy is therefore DERIVED per target row.
 *   - CAPS_LIVE_ON_WALLET_GRANTS — `per_order_usdc_cap`, `daily_usdc_cap`, and
 *     `hourly_fills_cap` are columns on `poly_wallet_grants`, a different table
 *     with a different lifecycle from the targets. The response names both
 *     sources so a caller can tell which half came from where.
 *   - CAPS_ARE_CEILINGS_NOT_TARGETS — carried over from migration 0031. These
 *     bound what `authorizeIntent` will pass POST-sizing; they do not drive
 *     sizing, which is the per-target policy's job.
 *   - ABSENT_CAPS_ARE_NEVER_ZERO — the caps are a discriminated union. A
 *     missing grant is `{status:"absent"}`, never `{per_order_usdc_cap: 0}`,
 *     because zero caps read as "no limits" when the truth is "cannot trade".
 *     This is NO_FABRICATED_VALUES at its most load-bearing.
 *   - AUTO_IS_NOT_RESOLVED_HERE — `sizing_policy_kind='auto'` resolves at plan
 *     time against a curated wallet snapshot. This read reports
 *     `effective_kind: null`, and does NOT read `poly_trader_*` to guess. That
 *     matters twice: guessing would fabricate a value, and `poly_trader_*` has
 *     NO row-level security at all (capability-plane Carve-out 1), so touching
 *     it from a delegated read would put the only tenant clamp in app code.
 *   - SILENT_HALT_IS_NAMED — EXCLUSION_IS_EXPLAINED (bug.5288): the mirror
 *     enumerator INNER-joins targets against an active wallet grant, so an
 *     expired grant makes a tenant silently stop being enumerated. Halted
 *     trading then looks byte-identical to idle, with no log line. The
 *     per-target `activation` block exists to make that state legible.
 *   - CONNECTIONS_ARE_NOT_READ — `poly_wallet_connections` holds encrypted CLOB
 *     credentials and is never read here. Eligibility leans on
 *     REVOKE_CASCADES_FROM_CONNECTION (migration 0031): revoking a connection
 *     revokes its grants in the same transaction, so an active grant implies a
 *     live connection. The `explanation` string says so rather than implying a
 *     stronger proof than the data supports.
 *   - BOUNDED — targets are hard-capped at `POLY_COPY_SETUP_MAX_TARGETS` with
 *     an explicit `truncated` flag; the active count is computed separately so
 *     it stays correct past the page bound.
 * Side-effects: IO (three bounded SELECTs).
 * Links: task.1791070959, story.5004, bug.5288, bug.0438,
 *   docs/spec/dashboard-agent-parity-inventory.md §8
 * @public
 */

import { polyCopyTradeTargets } from "@cogni/poly-db-schema/copy-trade";
import { polyWalletGrants } from "@cogni/poly-db-schema/wallet-grants";
import {
  POLY_COPY_SETUP_MAX_TARGETS,
  type PolyAccountCopySetupQuery,
  type PolyAccountCopySetupResponse,
  type PolyWalletSafetyCaps,
} from "@cogni/poly-node-contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";

/** Statement timeout for this capability, matching the investigation service. */
const STATEMENT_TIMEOUT_MS = 10_000;

type TargetRow = {
  id: string;
  targetWallet: string;
  mirrorFilterPercentile: number;
  mirrorMaxUsdcPerTrade: string | number;
  sizingPolicyKind: string;
  targetRangeMaxUsdc: string | number | null;
  mirrorMaxAllocPerConditionUsdc: string | number | null;
  mirrorActivatedAt: Date;
  createdAt: Date;
  disabledAt: Date | null;
};

type GrantRow = {
  id: string;
  perOrderUsdcCap: string | number;
  dailyUsdcCap: string | number;
  hourlyFillsCap: number;
  scopes: string[];
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

/**
 * `tx.execute()` returns a bare array on postgres-js and `{ rows }` on
 * node-postgres. Both shapes are handled rather than assumed, matching
 * `copy-trade-investigation-service`.
 */
const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result)
    ? (result as T[])
    : (((result as { rows?: T[] }).rows ?? []) as T[]);

const num = (value: string | number): number => Number(value);
const nullableNum = (value: string | number | null): number | null =>
  value === null ? null : Number(value);
const iso = (value: Date): string => value.toISOString();
const nullableIso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const SIZING_POLICY_KINDS = new Set([
  "auto",
  "min_bet",
  "target_percentile_scaled",
  "position_gap",
  "mirror_fill_exact",
]);

/**
 * The DB CHECK already constrains this column, but the wire contract is a
 * closed enum and output validation is strict. An unrecognised kind — only
 * possible if a future migration widens the CHECK without widening the
 * contract — degrades to `auto` + deferred resolution rather than failing the
 * whole read or inventing a policy.
 */
function coerceKind(
  value: string
): PolyAccountCopySetupResponse["targets"][number]["policy"]["declared_kind"] {
  return (
    SIZING_POLICY_KINDS.has(value) ? value : "auto"
  ) as PolyAccountCopySetupResponse["targets"][number]["policy"]["declared_kind"];
}

/**
 * Classify the account's wallet safety caps from the single most relevant grant
 * row: an ACTIVE grant if one exists, else the most recent grant so the caller
 * learns *why* trading is blocked (revoked vs expired) rather than just "no".
 */
function classifyWalletSafety(
  grant: GrantRow | undefined,
  capturedAt: Date
): PolyWalletSafetyCaps {
  if (!grant) {
    return { status: "absent", reason: "no_wallet_grant_on_file" };
  }
  if (grant.revokedAt !== null) {
    return {
      status: "revoked",
      grant_id: grant.id,
      revoked_at: iso(grant.revokedAt),
      reason: "wallet_grant_revoked",
    };
  }
  if (grant.expiresAt !== null && grant.expiresAt <= capturedAt) {
    return {
      status: "expired",
      grant_id: grant.id,
      expires_at: iso(grant.expiresAt),
      reason: "wallet_grant_expired",
    };
  }
  return {
    status: "active",
    grant_id: grant.id,
    per_order_usdc_cap: num(grant.perOrderUsdcCap),
    daily_usdc_cap: num(grant.dailyUsdcCap),
    hourly_fills_cap: grant.hourlyFillsCap,
    scopes: grant.scopes,
    expires_at: nullableIso(grant.expiresAt),
    created_at: iso(grant.createdAt),
  };
}

/**
 * Current copy-trade setup for one authorized account.
 *
 * Returns `null` when the account has no target rows AND no wallet grant — i.e.
 * copy trading was never configured here — which the executor renders as a
 * non-disclosing 404. A configured account with every target disabled is a real
 * answer and returns normally.
 */
export async function getCopySetupForAccount(
  tx: AgentGrantTransaction,
  query: PolyAccountCopySetupQuery
): Promise<PolyAccountCopySetupResponse | null> {
  await tx.execute(
    sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
  );

  // One frozen read time shared by all three reads below, so the caps cannot be
  // evaluated against a different "now" than the targets.
  const clockRows = rowsOf<{ captured_at: Date | string }>(
    await tx.execute(sql`SELECT clock_timestamp() AS captured_at`)
  );
  const rawCapturedAt = clockRows[0]?.captured_at;
  const capturedAt =
    rawCapturedAt instanceof Date
      ? rawCapturedAt
      : new Date(rawCapturedAt ?? Date.now());

  // Read ONE row past the bound so truncation is observed, never guessed.
  const targetRows = (await tx
    .select({
      id: polyCopyTradeTargets.id,
      targetWallet: polyCopyTradeTargets.targetWallet,
      mirrorFilterPercentile: polyCopyTradeTargets.mirrorFilterPercentile,
      mirrorMaxUsdcPerTrade: polyCopyTradeTargets.mirrorMaxUsdcPerTrade,
      sizingPolicyKind: polyCopyTradeTargets.sizingPolicyKind,
      targetRangeMaxUsdc: polyCopyTradeTargets.targetRangeMaxUsdc,
      mirrorMaxAllocPerConditionUsdc:
        polyCopyTradeTargets.mirrorMaxAllocPerConditionUsdc,
      mirrorActivatedAt: polyCopyTradeTargets.mirrorActivatedAt,
      createdAt: polyCopyTradeTargets.createdAt,
      disabledAt: polyCopyTradeTargets.disabledAt,
    })
    .from(polyCopyTradeTargets)
    .where(eq(polyCopyTradeTargets.billingAccountId, query.billing_account_id))
    // Active rows first — if the account is over the bound, the rows that can
    // actually trade are the ones that survive truncation. `id` breaks ties so
    // the page is deterministic.
    .orderBy(
      sql`(${polyCopyTradeTargets.disabledAt} IS NULL) DESC`,
      asc(polyCopyTradeTargets.createdAt),
      asc(polyCopyTradeTargets.id)
    )
    .limit(POLY_COPY_SETUP_MAX_TARGETS + 1)) as unknown as TargetRow[];

  const targetsTruncated = targetRows.length > POLY_COPY_SETUP_MAX_TARGETS;
  const pagedTargets = targetRows.slice(0, POLY_COPY_SETUP_MAX_TARGETS);

  // Counted separately so it stays correct past the page bound.
  const countRows = (await tx
    .select({ count: sql<string>`count(*)` })
    .from(polyCopyTradeTargets)
    .where(
      and(
        eq(polyCopyTradeTargets.billingAccountId, query.billing_account_id),
        isNull(polyCopyTradeTargets.disabledAt)
      )
    )) as unknown as Array<{ count: string }>;
  const activeTargetCount = Number(countRows[0]?.count ?? 0);

  // Prefer an ACTIVE grant; fall back to the most recent one so a blocked
  // account learns whether it was revoked or merely expired.
  const grantRows = (await tx
    .select({
      id: polyWalletGrants.id,
      perOrderUsdcCap: polyWalletGrants.perOrderUsdcCap,
      dailyUsdcCap: polyWalletGrants.dailyUsdcCap,
      hourlyFillsCap: polyWalletGrants.hourlyFillsCap,
      scopes: polyWalletGrants.scopes,
      expiresAt: polyWalletGrants.expiresAt,
      createdAt: polyWalletGrants.createdAt,
      revokedAt: polyWalletGrants.revokedAt,
    })
    .from(polyWalletGrants)
    .where(eq(polyWalletGrants.billingAccountId, query.billing_account_id))
    .orderBy(
      sql`(${polyWalletGrants.revokedAt} IS NULL AND (${polyWalletGrants.expiresAt} IS NULL OR ${polyWalletGrants.expiresAt} > ${capturedAt.toISOString()}::timestamptz)) DESC`,
      sql`${polyWalletGrants.createdAt} DESC`
    )
    .limit(1)) as unknown as GrantRow[];

  const walletSafety = classifyWalletSafety(grantRows[0], capturedAt);

  // Never configured at all -> non-disclosing not-found.
  if (targetRows.length === 0 && walletSafety.status === "absent") return null;

  const capsActive = walletSafety.status === "active";

  const targets = pagedTargets.map((row) => {
    const declaredKind = coerceKind(row.sizingPolicyKind);
    const isDisabled = row.disabledAt !== null;
    const rangeMax = nullableNum(row.targetRangeMaxUsdc);
    const allocPerCondition = nullableNum(row.mirrorMaxAllocPerConditionUsdc);

    const activation = isDisabled
      ? {
          status: "disabled" as const,
          explanation:
            "Target row is soft-deleted (disabled_at is set), so the mirror enumerator does not see it.",
        }
      : capsActive
        ? {
            status: "eligible" as const,
            explanation:
              "Target row is active and the account holds an active wallet grant. Live placement also requires a non-revoked wallet connection, which an active grant implies via REVOKE_CASCADES_FROM_CONNECTION (enforced app-side, not by a DB trigger).",
          }
        : {
            status: "blocked_no_active_wallet_grant" as const,
            explanation:
              `Target row is active but the account has no active wallet grant (caps status: ${walletSafety.status}). ` +
              "The mirror enumerator INNER-joins targets against an active grant, so this target is silently NOT enumerated and halted trading is indistinguishable from idle (bug.5288).",
          };

    return {
      target_id: row.id,
      target_wallet: row.targetWallet,
      active: !isDisabled,
      created_at: iso(row.createdAt),
      mirror_activated_at: iso(row.mirrorActivatedAt),
      disabled_at: nullableIso(row.disabledAt),
      policy: {
        declared_kind: declaredKind,
        // Deliberately null for `auto` — see AUTO_IS_NOT_RESOLVED_HERE.
        effective_kind: declaredKind === "auto" ? null : declaredKind,
        resolution:
          declaredKind === "auto"
            ? ("auto_resolved_at_plan_time" as const)
            : ("explicit" as const),
        mirror_filter_percentile: row.mirrorFilterPercentile,
        mirror_max_usdc_per_trade: num(row.mirrorMaxUsdcPerTrade),
        target_range_max_usdc: rangeMax,
        mirror_max_alloc_per_condition_usdc: allocPerCondition,
        range_knobs_incomplete:
          declaredKind === "position_gap" &&
          (rangeMax === null || allocPerCondition === null),
      },
      activation,
    };
  });

  return {
    billing_account_id: query.billing_account_id,
    captured_at: capturedAt.toISOString(),
    targets,
    active_target_count: activeTargetCount,
    targets_truncated: targetsTruncated,
    wallet_safety: walletSafety,
    sources: {
      targets: "poly_copy_trade_targets",
      caps: "poly_wallet_grants",
      config_table: "dropped_in_migration_0036",
    },
    completeness: {
      complete: !targetsTruncated && capsActive,
      targets_truncated: targetsTruncated,
      caps_available: capsActive,
    },
  };
}
