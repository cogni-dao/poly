// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/target-source`
 * Purpose: Strongly-typed seam for "which wallets is the operator monitoring right now?".
 *          Two query shapes: `listForActor(userId)` for user-scoped HTTP routes (RLS via
 *          appDb), and `listAllActive()` for the cross-tenant mirror-poll enumerator
 *          (BYPASSRLS via serviceDb — the ONE sanctioned cross-tenant read path).
 *          Per docs/spec/poly-tenant-and-collateral.md.
 * Scope: Two impls today — `envTargetSource` (local-dev fallback) and `dbTargetSource`
 *        (production, reads `poly_copy_trade_targets`). Target rows carry the user-facing
 *        mirror filter percentile and max bet. No per-target enable flag and no mode
 *        switches — add/remove rows is the activation model.
 * Invariants:
 *   - TARGET_SOURCE_TENANT_SCOPED — `listForActor(userId)` returns only the rows whose
 *     `created_by_user_id` equals `userId` under appDb's RLS clamp. The cross-tenant
 *     enumerator is a separate, explicitly-named method (`listAllActive`) that runs
 *     under serviceDb and is the ONLY place that observes more than one tenant.
 *   - NO_KILL_SWITCH (bug.0438): the active-target × active-connection × active-grant
 *     join in `listAllActive` is the sole gate. There is no per-tenant kill-switch
 *     table; target policy fields live directly on the tracked target row.
 *   - ENV_IMPL_LOCAL_DEV_ONLY — `envTargetSource` is wired only when APP_ENV=test;
 *     production wires `dbTargetSource`.
 * Side-effects: dbTargetSource → DB I/O. envTargetSource → none.
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/task.0318
 *
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import type { ActorId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared/constants";
import {
  polyCopyTradeTargets,
  polyWalletConnections,
  polyWalletGrants,
} from "@cogni/poly-db-schema";
import type { LoggerPort } from "@cogni/poly-market-provider";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  type PositionGapBudgetGroup,
  summarizePositionGapBudgetGroup,
} from "@/features/copy-trade/position-gap-budget";
import { targetIdFromWallet } from "@/features/copy-trade/target-id";

export type WalletAddress = `0x${string}`;

/**
 * One enumerated target row carrying enough tenant attribution for the
 * mirror-coordinator to set `withTenantScope` for fills/decisions writes.
 */
export type SizingPolicyKind =
  | "auto"
  | "min_bet"
  | "target_percentile_scaled"
  | "position_gap"
  | "mirror_fill_exact";

export interface EnumeratedTarget {
  billingAccountId: string;
  createdByUserId: string;
  targetWallet: WalletAddress;
  /**
   * Monotonic assignment revision advanced by every successful policy PATCH.
   * The target reconciler fingerprints this value so a saved algorithm change
   * replaces the running poll on its next (at most 30 second) tick.
   */
  mirrorActivatedAt: Date;
  mirrorFilterPercentile: number;
  mirrorMaxUsdcPerTrade: number;
  /**
   * Per-target sizing-policy kind. `'auto'` (default) preserves legacy
   * snapshot-derived behavior; explicit kinds pin a target to a specific
   * planner policy. Threaded into `buildMirrorTargetConfig`.
   */
  sizingPolicyKind: SizingPolicyKind;
  /** Legacy position_gap v1 field; ignored by v2 sizing. */
  targetRangeMaxUsdc: number | null;
  /** Legacy position_gap v1 field; ignored by v2 sizing. */
  mirrorMaxAllocPerConditionUsdc: number | null;
  /** Null means automatic allocation from the account's remaining mirror NAV. */
  mirrorCapitalBudgetUsdc: number | null;
  /** Account-wide allocation inputs, computed from the same eligible row set. */
  positionGapBudgetGroup: PositionGapBudgetGroup;
}

/**
 * One row returned to per-user list/CRUD callers. `id` is the DB row PK —
 * the value DELETE accepts, distinct from the deterministic UUIDv5
 * (`targetIdFromWallet`) used internally for `client_order_id` correlation
 * in the fills ledger.
 */
export interface UserTargetRow {
  id: string;
  targetWallet: WalletAddress;
  mirrorFilterPercentile: number;
  mirrorMaxUsdcPerTrade: number;
  sizingPolicyKind: SizingPolicyKind;
  /** Legacy position_gap v1 field. */
  targetRangeMaxUsdc: number | null;
  /** Legacy position_gap v1 field. */
  mirrorMaxAllocPerConditionUsdc: number | null;
  /** Position-gap portfolio-scale budget; null is automatic/full-NAV compatible. */
  mirrorCapitalBudgetUsdc: number | null;
}

export interface CopyTradeTargetSource {
  /**
   * Rows the calling user is monitoring. Caller passes their session user
   * UUID (branded `ActorId`). Implementation uses appDb under
   * `withTenantScope(actorId)` so RLS enforces tenant boundary at the DB layer.
   * Caller-visible order is preserved (`created_at` ascending — stable rendering).
   * Returns `{ id, targetWallet }` so callers can route DELETE by the DB row PK.
   */
  listForActor(actorId: ActorId): Promise<readonly UserTargetRow[]>;

  /**
   * **The ONE sanctioned cross-tenant read path.** Returns every active
   * (target_wallet, billing_account_id, created_by_user_id) triple for tenants
   * with an active target × active wallet connection × active grant. Runs
   * under serviceDb (BYPASSRLS) — used exclusively by the autonomous mirror
   * poll. Every downstream write fans out under
   * `withTenantScope(appDb, createdByUserId)`.
   */
  listAllActive(): Promise<readonly EnumeratedTarget[]>;
}

// ── env impl (local-dev / tests only) ───────────────────────────────────────

/**
 * Env-backed target source. Captures a list of (system-tenant) wallets at
 * construction time. **Not wired in production** — only when APP_ENV=test or
 * a developer needs a dependency-free dev loop.
 *
 * `listForActor` returns the env wallets to ANY caller (no real RLS — there
 * is no DB to clamp against). `listAllActive` attributes everything to the
 * system tenant.
 *
 * @public
 */
export function envTargetSource(
  wallets: readonly WalletAddress[]
): CopyTradeTargetSource {
  // Synthesize stable per-wallet UUIDs so the test impl behaves like the DB
  // impl: each wallet has a single `id` consistent across listForActor calls.
  // Use the same UUIDv5 helper the fills ledger uses; consumers (the dashboard)
  // need a stable id to round-trip through DELETE.
  const userRows: readonly UserTargetRow[] = Object.freeze(
    wallets.map((targetWallet) => ({
      id: targetIdFromWallet(targetWallet),
      targetWallet,
      mirrorFilterPercentile: 75,
      mirrorMaxUsdcPerTrade: 5,
      sizingPolicyKind: "auto" as const,
      targetRangeMaxUsdc: null,
      mirrorMaxAllocPerConditionUsdc: null,
      mirrorCapitalBudgetUsdc: null,
    }))
  );
  const enumerated: readonly EnumeratedTarget[] = Object.freeze(
    wallets.map((targetWallet) => ({
      billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
      createdByUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      targetWallet,
      mirrorActivatedAt: new Date(0),
      mirrorFilterPercentile: 75,
      mirrorMaxUsdcPerTrade: 5,
      sizingPolicyKind: "auto" as const,
      targetRangeMaxUsdc: null,
      mirrorMaxAllocPerConditionUsdc: null,
      mirrorCapitalBudgetUsdc: null,
      positionGapBudgetGroup: {
        explicitBudgetTotalUsdc: 0,
        automaticTargetCount: 0,
        unbudgetedTargetCount: wallets.length,
      },
    }))
  );
  return {
    listForActor: async () => userRows,
    listAllActive: async () => enumerated,
  };
}

// ── DB impl (production) ────────────────────────────────────────────────────

export interface DbTargetSourceDeps {
  /**
   * RLS-enforced client for per-user reads. `withTenantScope` opens a
   * transaction with `app.current_user_id` SET LOCAL to the caller's actorId.
   */
  appDb: PostgresJsDatabase<Record<string, unknown>>;
  /**
   * BYPASSRLS client for the cross-tenant enumerator. Used exclusively by
   * `listAllActive` — every other code path goes through `appDb`.
   */
  serviceDb: PostgresJsDatabase<Record<string, unknown>>;
  /**
   * Optional. When present, `listAllActive` explains WHY a live tenant was
   * excluded (bug.5288). Optional so existing constructions keep working —
   * absence costs only the diagnostic, never correctness.
   */
  logger?: LoggerPort | undefined;
  /**
   * When true, `listAllActive` skips the wallet_connections + wallet_grants
   * joins. The deploy-wide `PAPER_ENFORCE_MODE=paper` makes every placement
   * route through the paper sidecar (no signing → no trader wallet needed),
   * so requiring a Privy-provisioned wallet to activate a target excludes
   * exactly the population this env is meant to serve. Set by bootstrap from
   * the same env var the executor dispatcher reads.
   *
   * In live deployments (paperEnforced=false), the joins remain — a target
   * without a wallet has no way to sign live CLOB orders, which is the
   * pre-existing activation invariant.
   */
  paperEnforced?: boolean;
}

/**
 * DB-backed target source over `poly_copy_trade_targets`.
 *
 * @public
 */
export function dbTargetSource(
  deps: DbTargetSourceDeps
): CopyTradeTargetSource {
  return {
    async listForActor(actorId: ActorId): Promise<readonly UserTargetRow[]> {
      const rows = await withTenantScope(deps.appDb, actorId, async (tx) =>
        tx
          .select({
            id: polyCopyTradeTargets.id,
            target_wallet: polyCopyTradeTargets.targetWallet,
            mirror_filter_percentile:
              polyCopyTradeTargets.mirrorFilterPercentile,
            mirror_max_usdc_per_trade:
              polyCopyTradeTargets.mirrorMaxUsdcPerTrade,
            sizing_policy_kind: polyCopyTradeTargets.sizingPolicyKind,
            target_range_max_usdc: polyCopyTradeTargets.targetRangeMaxUsdc,
            mirror_max_alloc_per_condition_usdc:
              polyCopyTradeTargets.mirrorMaxAllocPerConditionUsdc,
            mirror_capital_budget_usdc:
              polyCopyTradeTargets.mirrorCapitalBudgetUsdc,
          })
          .from(polyCopyTradeTargets)
          .where(isNull(polyCopyTradeTargets.disabledAt))
          .orderBy(polyCopyTradeTargets.createdAt)
      );
      return rows.map((r) => ({
        id: r.id,
        targetWallet: r.target_wallet as WalletAddress,
        mirrorFilterPercentile: r.mirror_filter_percentile,
        mirrorMaxUsdcPerTrade: Number(r.mirror_max_usdc_per_trade),
        sizingPolicyKind: coerceSizingPolicyKind(r.sizing_policy_kind),
        targetRangeMaxUsdc:
          r.target_range_max_usdc === null
            ? null
            : Number(r.target_range_max_usdc),
        mirrorMaxAllocPerConditionUsdc:
          r.mirror_max_alloc_per_condition_usdc === null
            ? null
            : Number(r.mirror_max_alloc_per_condition_usdc),
        mirrorCapitalBudgetUsdc:
          r.mirror_capital_budget_usdc === null
            ? null
            : Number(r.mirror_capital_budget_usdc),
      }));
    },

    async listAllActive(): Promise<readonly EnumeratedTarget[]> {
      // The ONE sanctioned BYPASSRLS read.
      //
      // Live-mode joins (bug.0438 dropped the poly_copy_trade_config
      // kill-switch join):
      //   targets (disabled_at IS NULL)         — active tracked rows only
      //   × wallet_connections (revoked_at IS NULL) — tenant has a live trader wallet
      //   × wallet_grants (revoked_at IS NULL, expires_at > now or NULL)
      //
      // Net effect (live): only tenants whose per-tenant path can actually
      // sign + that `authorizeIntent` will let through. The act of having an
      // active target row IS the user's opt-in signal.
      //
      // PAPER_ENFORCE_MODE=paper bypass: in candidate-a + preview the
      // executor dispatcher forces every placement through the paper sidecar
      // (no signing, no wallet load). Requiring wallet_connections +
      // wallet_grants there excludes the exact population this env is meant
      // to serve — users iterating on the algorithm without setting up real
      // wallets. When `paperEnforced=true`, drop those joins and activate
      // every target row directly.
      const baseSelect = deps.serviceDb
        .select({
          target_row_id: polyCopyTradeTargets.id,
          billing_account_id: polyCopyTradeTargets.billingAccountId,
          created_by_user_id: polyCopyTradeTargets.createdByUserId,
          target_wallet: polyCopyTradeTargets.targetWallet,
          mirror_activated_at: polyCopyTradeTargets.mirrorActivatedAt,
          mirror_filter_percentile: polyCopyTradeTargets.mirrorFilterPercentile,
          mirror_max_usdc_per_trade: polyCopyTradeTargets.mirrorMaxUsdcPerTrade,
          sizing_policy_kind: polyCopyTradeTargets.sizingPolicyKind,
          target_range_max_usdc: polyCopyTradeTargets.targetRangeMaxUsdc,
          mirror_max_alloc_per_condition_usdc:
            polyCopyTradeTargets.mirrorMaxAllocPerConditionUsdc,
          mirror_capital_budget_usdc:
            polyCopyTradeTargets.mirrorCapitalBudgetUsdc,
        })
        .from(polyCopyTradeTargets);

      const rows = deps.paperEnforced
        ? await baseSelect
            .where(isNull(polyCopyTradeTargets.disabledAt))
            .orderBy(polyCopyTradeTargets.createdAt)
        : await baseSelect
            .innerJoin(
              polyWalletConnections,
              and(
                eq(
                  polyWalletConnections.billingAccountId,
                  polyCopyTradeTargets.billingAccountId
                ),
                isNull(polyWalletConnections.revokedAt)
              )
            )
            .innerJoin(
              polyWalletGrants,
              and(
                eq(
                  polyWalletGrants.walletConnectionId,
                  polyWalletConnections.id
                ),
                isNull(polyWalletGrants.revokedAt),
                or(
                  isNull(polyWalletGrants.expiresAt),
                  gt(polyWalletGrants.expiresAt, sql`now()`)
                )
              )
            )
            .where(isNull(polyCopyTradeTargets.disabledAt))
            .orderBy(polyCopyTradeTargets.createdAt);

      // EXCLUSION_IS_EXPLAINED (bug.5288) — the live-mode joins above are INNER
      // joins, so a tenant whose grant expired is not "skipped" or "errored";
      // it simply stops being enumerated. Trading halts and looks IDENTICAL to
      // idle. Prod 2026-09-28: `poly.mirror.decision` went to ZERO and the
      // owner's funded tenant vanished from the stream with no log line
      // anywhere, while its wallet kept reporting healthy in the same window.
      //
      // Grants are TIME-BOUNDED BY DESIGN (`expires_at` IS the safety
      // mechanism), so this is not an edge case — every live tenant reaches it
      // eventually. One bounded query over a small table buys the operator the
      // reason. Diagnostic only: never changes which targets are returned.
      if (!deps.paperEnforced && deps.logger) {
        await explainExcludedTargets(deps, rows.length);
      }

      const budgetGroups = positionGapBudgetGroups(rows);

      return rows.map((r) => ({
        billingAccountId: r.billing_account_id,
        createdByUserId: r.created_by_user_id,
        targetWallet: r.target_wallet as WalletAddress,
        mirrorActivatedAt: r.mirror_activated_at,
        mirrorFilterPercentile: r.mirror_filter_percentile,
        mirrorMaxUsdcPerTrade: Number(r.mirror_max_usdc_per_trade),
        sizingPolicyKind: coerceSizingPolicyKind(r.sizing_policy_kind),
        targetRangeMaxUsdc:
          r.target_range_max_usdc === null
            ? null
            : Number(r.target_range_max_usdc),
        mirrorMaxAllocPerConditionUsdc:
          r.mirror_max_alloc_per_condition_usdc === null
            ? null
            : Number(r.mirror_max_alloc_per_condition_usdc),
        mirrorCapitalBudgetUsdc:
          r.mirror_capital_budget_usdc === null
            ? null
            : Number(r.mirror_capital_budget_usdc),
        positionGapBudgetGroup:
          budgetGroups.get(r.billing_account_id) ??
          summarizePositionGapBudgetGroup([], 0),
      }));
    },
  };
}

/**
 * Collapse join-expanded eligible rows into one budget group per account.
 * Exported so the multi-target allocation boundary stays directly testable.
 */
export function positionGapBudgetGroups(
  rows: readonly {
    target_row_id: string;
    billing_account_id: string;
    sizing_policy_kind: string;
    mirror_capital_budget_usdc: string | null;
  }[]
): ReadonlyMap<string, PositionGapBudgetGroup> {
  const uniqueRows = new Map<string, (typeof rows)[number]>();
  for (const row of rows) uniqueRows.set(row.target_row_id, row);

  const byAccount = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of uniqueRows.values()) {
    const accountRows = byAccount.get(row.billing_account_id) ?? [];
    accountRows.push(row);
    byAccount.set(row.billing_account_id, accountRows);
  }

  return new Map(
    [...byAccount.entries()].map(([accountId, accountRows]) => {
      const positionGapRows = accountRows.filter(
        (row) => row.sizing_policy_kind === "position_gap"
      );
      return [
        accountId,
        summarizePositionGapBudgetGroup(
          positionGapRows.map((row) =>
            row.mirror_capital_budget_usdc === null
              ? null
              : Number(row.mirror_capital_budget_usdc)
          ),
          accountRows.length - positionGapRows.length
        ),
      ];
    })
  );
}

/**
 * Emit one WARN per non-disabled target that the live-mode joins excluded,
 * naming WHICH condition failed. bug.5288.
 *
 * Deliberately a separate LEFT-JOIN query rather than converting the
 * enumerator itself: the enumerator is on the mirror's hot path and its
 * semantics are load-bearing, so the diagnostic must not be able to change
 * which tenants trade. `activeCount` short-circuits the common healthy case.
 */
async function explainExcludedTargets(
  deps: DbTargetSourceDeps,
  activeCount: number
): Promise<void> {
  const log = deps.logger;
  if (!log) return;
  try {
    const diag = (await deps.serviceDb.execute(sql`
      SELECT t.billing_account_id,
             t.target_wallet,
             (c.id IS NOT NULL) AS has_live_connection,
             (g.id IS NOT NULL) AS has_live_grant,
             g_any.expires_at    AS latest_grant_expires_at
        FROM poly_copy_trade_targets t
        LEFT JOIN poly_wallet_connections c
          ON c.billing_account_id = t.billing_account_id
         AND c.revoked_at IS NULL
        LEFT JOIN poly_wallet_grants g
          ON g.wallet_connection_id = c.id
         AND g.revoked_at IS NULL
         AND (g.expires_at IS NULL OR g.expires_at > now())
        LEFT JOIN LATERAL (
          SELECT g2.expires_at
            FROM poly_wallet_grants g2
           WHERE g2.wallet_connection_id = c.id
           ORDER BY g2.expires_at DESC NULLS FIRST
           LIMIT 1
        ) g_any ON TRUE
       WHERE t.disabled_at IS NULL
    `)) as unknown as Array<{
      billing_account_id: string;
      target_wallet: string;
      has_live_connection: boolean;
      has_live_grant: boolean;
      latest_grant_expires_at: string | null;
    }>;

    const excluded = diag.filter(
      (r) => !r.has_live_connection || !r.has_live_grant
    );
    // HEALTHY_PATH_IS_AUDIBLE (bug.5298) — this used to `return` silently when
    // nothing was excluded, which made ZERO `target_excluded` lines ambiguous
    // between three states I could not tell apart on prod: (a) the enumerator
    // ran and excluded nothing, (b) the enumerator never ran, (c) `deps.logger`
    // was absent so this block was skipped. I asserted (a) from that silence
    // and was wrong to — it is exactly the silent-absence trap this whole
    // diagnostic exists to cure, committed inside the cure.
    //
    // One heartbeat per enumeration makes the healthy pass VISIBLE, so absence
    // now means "not running" rather than "fine". Cheap: one line per mirror
    // poll, with the counts that make a tenant dropping out immediately legible.
    if (excluded.length === 0) {
      log.info(
        {
          event: "poly.copy_trade.enumeration",
          active_targets: activeCount,
          candidate_targets: diag.length,
          excluded_targets: 0,
        },
        "copy-trade: target enumeration healthy — no active target excluded"
      );
      return;
    }

    for (const r of excluded) {
      const reason = !r.has_live_connection
        ? "no_live_wallet_connection"
        : "grant_revoked_or_expired";
      log.warn(
        {
          event: "poly.copy_trade.target_excluded",
          billing_account_id: r.billing_account_id,
          target_wallet: r.target_wallet,
          reason,
          latest_grant_expires_at: r.latest_grant_expires_at,
          active_targets: activeCount,
          excluded_targets: excluded.length,
        },
        `copy-trade: active target excluded from the mirror (${reason}) — this tenant will not trade`
      );
    }
  } catch (err: unknown) {
    // Diagnostic only. It must never take the mirror down; a failure here
    // costs visibility, not trading.
    log.warn(
      {
        event: "poly.copy_trade.target_excluded",
        phase: "diagnostic_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "copy-trade: could not compute target-exclusion reasons"
    );
  }
}

/**
 * Narrow the DB text column to the SizingPolicyKind union. The DB CHECK on
 * `poly_copy_trade_targets.sizing_policy_kind` enforces the enum at write
 * time, so any unknown value here means schema drift — fail closed to
 * `'auto'` (the back-compat sentinel) so the planner inherits legacy
 * snapshot-derived behavior instead of crashing.
 */
function coerceSizingPolicyKind(value: string): SizingPolicyKind {
  if (
    value === "auto" ||
    value === "min_bet" ||
    value === "target_percentile_scaled" ||
    value === "position_gap" ||
    value === "mirror_fill_exact"
  ) {
    return value;
  }
  return "auto";
}
