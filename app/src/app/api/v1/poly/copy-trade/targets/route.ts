// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/copy-trade/targets`
 * Purpose: HTTP GET (list) + POST (create) for the calling user's tracked Polymarket
 *          wallets. Per docs/spec/poly-tenant-and-collateral.md.
 * Scope: GET is the owner transport for `poly.account.copy-setup.v1`; POST is
 *        the existing RLS-scoped create path. No cross-tenant access.
 * Invariants:
 *   - TENANT_SCOPED: GET uses the account-read executor; POST uses
 *     `withTenantScope(appDb, sessionUser.id)`. Both keep app-role RLS.
 *   - TENANT_DEFENSE_IN_DEPTH: write paths (POST) verify `row.billing_account_id ===
 *     expected.billingAccountId` after the RLS-scoped INSERT/SELECT (mirrors
 *     `DrizzleConnectionBrokerAdapter.resolve()`).
 *   - NO_KILL_SWITCH (bug.0438): copy-trade no longer has a per-tenant kill-switch
 *     table — the act of having an active target row IS the user's opt-in. The
 *     route writes only the `poly_copy_trade_targets` row; the cross-tenant
 *     enumerator's active-target × active-connection × active-grant join is the
 *     only gate to autonomous mirror placement.
 * Side-effects: IO (Postgres reads + writes via appDb).
 * Notes: DELETE/PATCH live in `[id]/route.ts`. Wallet grants remain downstream
 *        authorization/cap enforcement; target rows own the user-facing copy policy.
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/task.0318
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import { polyCopyTradeTargets } from "@cogni/poly-db-schema";
import {
  type PolyCopyTradeTarget,
  polyAccountReadCopySetupOwnerOperation,
  polyCopyTradeTargetCreateOperation,
} from "@cogni/poly-node-contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { sizingPolicyKindForTargetWallet } from "@/bootstrap/jobs/copy-trade-mirror.job";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  algorithmImplementationRevision,
  copySetupAccountReadHandler,
  copySetupExtra,
} from "@/features/capability-plane";
import { serverEnv } from "@/shared/env/server-env";

export const dynamic = "force-dynamic";

/**
 * `id` is the DB row PK from `poly_copy_trade_targets`, exposed as the
 * contract's `target_id` so DELETE/PATCH can find it.
 *
 * `sizingPolicyKind` carries the stored per-target choice. The wire field
 * `sizing_policy_kind` exposes the EFFECTIVE planner kind (resolves
 * `'auto'` to whatever the snapshot inference would pick at config-build
 * time) — that's what downstream callers act on.
 */
function buildTargetView(params: {
  id: string;
  targetWallet: `0x${string}`;
  billingAccountId: string;
  createdByUserId: string;
  mirrorFilterPercentile: number;
  mirrorMaxUsdcPerTrade: number;
  sizingPolicyKind:
    | "auto"
    | "min_bet"
    | "target_percentile_scaled"
    | "position_gap"
    | "mirror_fill_exact";
  targetRangeMaxUsdc: number | null;
  mirrorMaxAllocPerConditionUsdc: number | null;
  mirrorActivatedAt: Date;
  source: "env" | "db";
}): PolyCopyTradeTarget {
	// Compatibility display field only. position_gap v2 ignores it entirely.
  const effectiveKind = sizingPolicyKindForTargetWallet(
    params.targetWallet,
    params.sizingPolicyKind,
  );
	const mirrorUsdc = params.mirrorMaxUsdcPerTrade;
  return {
    target_id: params.id,
    target_wallet: params.targetWallet,
    mirror_usdc: mirrorUsdc,
    mirror_filter_percentile: params.mirrorFilterPercentile,
    mirror_max_usdc_per_trade: params.mirrorMaxUsdcPerTrade,
    sizing_policy_kind: effectiveKind,
    target_range_max_usdc: params.targetRangeMaxUsdc,
    mirror_max_alloc_per_condition_usdc: params.mirrorMaxAllocPerConditionUsdc,
    mirror_activated_at: params.mirrorActivatedAt.toISOString(),
    source: params.source,
  };
}

/**
 * GET /api/v1/poly/copy-trade/targets — owner transport for the same typed
 * copy-setup capability approved agents read. It adds no owner-only query.
 */
export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.copy_trade.targets.list",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    resolveDb: resolveAppDb,
    operation: polyAccountReadCopySetupOwnerOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadCopySetupOwnerOperation.id],
    createRequestBinding: () => ({
      handler: copySetupAccountReadHandler({
        resolveEffectiveKind: sizingPolicyKindForTargetWallet,
        implementationRevision: algorithmImplementationRevision(
          serverEnv().APP_BUILD_SHA,
        ),
      }),
      extra: copySetupExtra,
    }),
  }),
);

/**
 * POST /api/v1/poly/copy-trade/targets — add a tracked wallet for the session user.
 */
export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.copy_trade.targets.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) throw new Error("sessionUser required");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = polyCopyTradeTargetCreateOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const targetWallet = parsed.data.target_wallet as `0x${string}`;
    const sizingPolicyKindInput = parsed.data.sizing_policy_kind ?? "auto";
    const targetRangeMaxInput = parsed.data.target_range_max_usdc;
    const mirrorMaxAllocPerConditionInput =
      parsed.data.mirror_max_alloc_per_condition_usdc;

    const container = getContainer();
    const account = await container
      .accountsForUser(toUserId(sessionUser.id))
      .getOrCreateBillingAccountForUser({ userId: sessionUser.id });

    const appDb = resolveAppDb() as unknown as PostgresJsDatabase<
      Record<string, unknown>
    >;
    const actorId = userActor(toUserId(sessionUser.id));

    // INSERT target under withTenantScope. Adding a target IS the opt-in act
    // (bug.0438 dropped the per-tenant kill-switch table — there's nothing
    // else to upsert here).
    const insertedRows = await withTenantScope(appDb, actorId, async (tx) =>
      tx
        .insert(polyCopyTradeTargets)
        .values({
          billingAccountId: account.id,
          createdByUserId: sessionUser.id,
          targetWallet,
          sizingPolicyKind: sizingPolicyKindInput,
          ...(targetRangeMaxInput !== undefined
            ? { targetRangeMaxUsdc: targetRangeMaxInput.toString() }
            : {}),
          ...(mirrorMaxAllocPerConditionInput !== undefined
            ? {
                mirrorMaxAllocPerConditionUsdc:
                  mirrorMaxAllocPerConditionInput.toString(),
              }
            : {}),
        })
        // Conflict resolves against the partial unique index
        // `poly_copy_trade_targets_billing_wallet_active_idx` (WHERE disabled_at IS NULL).
        .onConflictDoNothing()
        .returning({
          id: polyCopyTradeTargets.id,
          billing_account_id: polyCopyTradeTargets.billingAccountId,
          created_by_user_id: polyCopyTradeTargets.createdByUserId,
          mirror_filter_percentile: polyCopyTradeTargets.mirrorFilterPercentile,
          mirror_max_usdc_per_trade: polyCopyTradeTargets.mirrorMaxUsdcPerTrade,
          sizing_policy_kind: polyCopyTradeTargets.sizingPolicyKind,
          target_range_max_usdc: polyCopyTradeTargets.targetRangeMaxUsdc,
          mirror_max_alloc_per_condition_usdc:
            polyCopyTradeTargets.mirrorMaxAllocPerConditionUsdc,
          mirror_activated_at: polyCopyTradeTargets.mirrorActivatedAt,
        }),
    );

    let inserted = insertedRows[0];
    if (!inserted) {
      // Conflict: row already exists active. Fetch it (still RLS-clamped).
      const existing = await withTenantScope(appDb, actorId, async (tx) =>
        tx
          .select({
            id: polyCopyTradeTargets.id,
            billing_account_id: polyCopyTradeTargets.billingAccountId,
            created_by_user_id: polyCopyTradeTargets.createdByUserId,
            mirror_filter_percentile:
              polyCopyTradeTargets.mirrorFilterPercentile,
            mirror_max_usdc_per_trade:
              polyCopyTradeTargets.mirrorMaxUsdcPerTrade,
            sizing_policy_kind: polyCopyTradeTargets.sizingPolicyKind,
            target_range_max_usdc: polyCopyTradeTargets.targetRangeMaxUsdc,
            mirror_max_alloc_per_condition_usdc:
              polyCopyTradeTargets.mirrorMaxAllocPerConditionUsdc,
            mirror_activated_at: polyCopyTradeTargets.mirrorActivatedAt,
          })
          .from(polyCopyTradeTargets)
          .where(
            and(
              eq(polyCopyTradeTargets.billingAccountId, account.id),
              eq(polyCopyTradeTargets.targetWallet, targetWallet),
              isNull(polyCopyTradeTargets.disabledAt),
            ),
          )
          .limit(1),
      );
      inserted = existing[0];
      if (!inserted) {
        // Should never happen — RLS rejected after we passed WITH CHECK.
        return NextResponse.json(
          { error: "Failed to persist tracked wallet" },
          { status: 500 },
        );
      }
    }

    // Defense-in-depth: spec § TENANT_DEFENSE_IN_DEPTH. RLS already clamps,
    // but verify the returned row's billing_account_id matches expected.
    if (inserted.billing_account_id !== account.id) {
      ctx.log.warn(
        {
          event: "poly.copy_trade.targets.tenant_mismatch",
          expected: account.id,
          actual: inserted.billing_account_id,
        },
        "tenant verification failed after RLS-scoped insert",
      );
      return NextResponse.json({ error: "Tenant mismatch" }, { status: 500 });
    }

    const target = buildTargetView({
      id: inserted.id,
      targetWallet,
      billingAccountId: account.id,
      createdByUserId: sessionUser.id,
      mirrorFilterPercentile: inserted.mirror_filter_percentile,
      mirrorMaxUsdcPerTrade: Number(inserted.mirror_max_usdc_per_trade),
      sizingPolicyKind: coerceStoredSizingPolicyKind(
        inserted.sizing_policy_kind,
      ),
      targetRangeMaxUsdc:
        inserted.target_range_max_usdc === null
          ? null
          : Number(inserted.target_range_max_usdc),
      mirrorMaxAllocPerConditionUsdc:
        inserted.mirror_max_alloc_per_condition_usdc === null
          ? null
          : Number(inserted.mirror_max_alloc_per_condition_usdc),
      mirrorActivatedAt: inserted.mirror_activated_at,
      source: "db",
    });

    ctx.log.info(
      { target_wallet: targetWallet, target_id: target.target_id },
      "poly.copy_trade.targets.create_success",
    );

    return NextResponse.json(
      polyCopyTradeTargetCreateOperation.output.parse({ target }),
      { status: 201 },
    );
  },
);

/**
 * Narrow a DB text column to the stored-sizing-policy-kind union. The DB
 * CHECK enforces the enum, so an unknown value here means schema drift —
 * fail closed to `'auto'` so behavior matches the pre-cutover default.
 */
function coerceStoredSizingPolicyKind(
  value: string,
):
  | "auto"
  | "min_bet"
  | "target_percentile_scaled"
  | "position_gap"
  | "mirror_fill_exact" {
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
