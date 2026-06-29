// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/copy-trade/targets/[id]`
 * Purpose: HTTP DELETE/PATCH for one of the calling user's tracked Polymarket wallets.
 *          DELETE soft-deletes by setting `disabled_at`; PATCH updates the per-target
 *          mirror sizing policy. Per docs/spec/poly-tenant-and-collateral.md.
 * Scope: Validators + RLS-scoped UPDATEs. No cross-tenant access.
 * Invariants:
 *   - TENANT_SCOPED: UPDATE runs under `withTenantScope(appDb, sessionUser.id)`. RLS
 *     clamp means a user attempting to delete another user's row sees 0 rows
 *     affected → returns 404. Cross-tenant visibility blocked at the DB layer.
 *   - SOFT_DELETE: writes `disabled_at = now()` rather than DELETE. Preserves
 *     attribution history in `poly_copy_trade_fills`.
 * Side-effects: IO (Postgres UPDATE via appDb).
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/task.0318
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import { polyCopyTradeTargets } from "@cogni/poly-db-schema";
import {
  MIN_ALLOC_TO_RANGE_RATIO,
  polyCopyTradeTargetDeleteOperation,
  polyCopyTradeTargetUpdateOperation,
  type RangeKnobsRuleViolation,
  validatePositionGapRangeKnobs,
} from "@cogni/poly-node-contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { sizingPolicyKindForTargetWallet } from "@/bootstrap/jobs/copy-trade-mirror.job";

export const dynamic = "force-dynamic";

// Same per-violation 400 message map the POST route uses. Kept in lock-step so
// PATCH and POST surface identical contract semantics. See bug.5026.
function rangeKnobsErrorMessage(code: RangeKnobsRuleViolation): string {
  switch (code) {
    case "position_gap_requires_target_range_max_usdc":
    case "position_gap_requires_mirror_max_alloc_per_condition_usdc":
      return "position_gap targets require both target_range_max_usdc and mirror_max_alloc_per_condition_usdc — no defaults, set explicitly";
    case "position_gap_alloc_range_ratio_too_small":
      return `mirror_max_alloc_per_condition_usdc / target_range_max_usdc < ${MIN_ALLOC_TO_RANGE_RATIO} produces sub-floor sizing every fill (bug.5026). The planner peaks at max_alloc at saturation — set max_alloc closer to target_range_max_usdc for a real proportional mirror, or raise both for fractional`;
  }
}

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "poly.copy_trade.targets.delete",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) throw new Error("sessionUser required");

    const { id } = await context.params;
    const parsed = polyCopyTradeTargetDeleteOperation.input.safeParse({ id });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid target id", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const appDb = resolveAppDb() as unknown as PostgresJsDatabase<
      Record<string, unknown>
    >;
    const actorId = userActor(toUserId(sessionUser.id));

    const updatedRows = await withTenantScope(appDb, actorId, async (tx) =>
      tx
        .update(polyCopyTradeTargets)
        .set({ disabledAt: new Date() })
        .where(
          and(
            eq(polyCopyTradeTargets.id, parsed.data.id),
            isNull(polyCopyTradeTargets.disabledAt)
          )
        )
        .returning({ id: polyCopyTradeTargets.id })
    );

    if (updatedRows.length === 0) {
      // RLS-clamped UPDATE returned 0 rows — either the row never existed,
      // already disabled, or belongs to another tenant. All collapse to 404
      // (do not distinguish — would leak existence across tenants).
      return NextResponse.json(
        { error: "Tracked wallet not found" },
        { status: 404 }
      );
    }

    ctx.log.info(
      { target_id: parsed.data.id },
      "poly.copy_trade.targets.delete_success"
    );

    return NextResponse.json(
      polyCopyTradeTargetDeleteOperation.output.parse({ deleted: true })
    );
  }
);

export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "poly.copy_trade.targets.update",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) throw new Error("sessionUser required");

    const { id } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = polyCopyTradeTargetUpdateOperation.input.safeParse({
      ...(typeof body === "object" && body !== null ? body : {}),
      id,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    // Same range-knobs guard the POST route runs. Catches: switching policy to
    // position_gap without both knobs (would 500 on the DB CHECK), and the
    // bug.5026 ratio class — silent fractional mirroring from a max_alloc that
    // dwarfs range_max.
    const rangeRuleError = validatePositionGapRangeKnobs({
      sizing_policy_kind: parsed.data.sizing_policy_kind,
      ...(parsed.data.target_range_max_usdc !== undefined
        ? { target_range_max_usdc: parsed.data.target_range_max_usdc }
        : {}),
      ...(parsed.data.mirror_max_alloc_per_condition_usdc !== undefined
        ? {
            mirror_max_alloc_per_condition_usdc:
              parsed.data.mirror_max_alloc_per_condition_usdc,
          }
        : {}),
    });
    if (rangeRuleError !== null) {
      return NextResponse.json(
        {
          error: rangeKnobsErrorMessage(rangeRuleError),
          code: rangeRuleError,
        },
        { status: 400 }
      );
    }

    const appDb = resolveAppDb() as unknown as PostgresJsDatabase<
      Record<string, unknown>
    >;
    const actorId = userActor(toUserId(sessionUser.id));

    // Build the UPDATE SET clause: required fields + optional sizing_policy_kind
    // when provided. Omitting the key leaves the stored value untouched (DB
    // CHECK enforces the enum on writes).
    const updateSet: Record<string, unknown> = {
      mirrorFilterPercentile: parsed.data.mirror_filter_percentile,
      mirrorMaxUsdcPerTrade: parsed.data.mirror_max_usdc_per_trade.toFixed(2),
    };
    if (parsed.data.sizing_policy_kind !== undefined) {
      updateSet.sizingPolicyKind = parsed.data.sizing_policy_kind;
    }
    if (parsed.data.target_range_max_usdc !== undefined) {
      updateSet.targetRangeMaxUsdc =
        parsed.data.target_range_max_usdc.toFixed(2);
    }
    if (parsed.data.mirror_max_alloc_per_condition_usdc !== undefined) {
      updateSet.mirrorMaxAllocPerConditionUsdc =
        parsed.data.mirror_max_alloc_per_condition_usdc.toFixed(2);
    }

    const updatedRows = await withTenantScope(appDb, actorId, async (tx) =>
      tx
        .update(polyCopyTradeTargets)
        .set(updateSet)
        .where(
          and(
            eq(polyCopyTradeTargets.id, parsed.data.id),
            isNull(polyCopyTradeTargets.disabledAt)
          )
        )
        .returning({
          id: polyCopyTradeTargets.id,
          target_wallet: polyCopyTradeTargets.targetWallet,
          mirror_filter_percentile: polyCopyTradeTargets.mirrorFilterPercentile,
          mirror_max_usdc_per_trade: polyCopyTradeTargets.mirrorMaxUsdcPerTrade,
          sizing_policy_kind: polyCopyTradeTargets.sizingPolicyKind,
          target_range_max_usdc: polyCopyTradeTargets.targetRangeMaxUsdc,
          mirror_max_alloc_per_condition_usdc:
            polyCopyTradeTargets.mirrorMaxAllocPerConditionUsdc,
        })
    );

    const row = updatedRows[0];
    if (!row) {
      return NextResponse.json(
        { error: "Tracked wallet not found" },
        { status: 404 }
      );
    }

    const storedSizingPolicyKind = coercePatchedSizingPolicyKind(
      row.sizing_policy_kind
    );
    const effectiveKind = sizingPolicyKindForTargetWallet(
      row.target_wallet as `0x${string}`,
      storedSizingPolicyKind
    );
    const targetRangeMaxUsdc =
      row.target_range_max_usdc === null
        ? null
        : Number(row.target_range_max_usdc);
    const mirrorMaxAllocPerConditionUsdc =
      row.mirror_max_alloc_per_condition_usdc === null
        ? null
        : Number(row.mirror_max_alloc_per_condition_usdc);

    ctx.log.info(
      {
        target_id: parsed.data.id,
        mirror_filter_percentile: row.mirror_filter_percentile,
        mirror_max_usdc_per_trade: row.mirror_max_usdc_per_trade,
        sizing_policy_kind: storedSizingPolicyKind,
        target_range_max_usdc: targetRangeMaxUsdc,
        mirror_max_alloc_per_condition_usdc: mirrorMaxAllocPerConditionUsdc,
      },
      "poly.copy_trade.targets.update_success"
    );

    // task.5014 — under `position_gap`, the per-condition cap is the
    // representative per-fill notional for dashboards.
    const mirrorUsdc =
      effectiveKind === "position_gap"
        ? (mirrorMaxAllocPerConditionUsdc ??
          Number(row.mirror_max_usdc_per_trade))
        : Number(row.mirror_max_usdc_per_trade);

    return NextResponse.json(
      polyCopyTradeTargetUpdateOperation.output.parse({
        target: {
          target_id: row.id,
          target_wallet: row.target_wallet,
          mirror_usdc: mirrorUsdc,
          mirror_filter_percentile: row.mirror_filter_percentile,
          mirror_max_usdc_per_trade: Number(row.mirror_max_usdc_per_trade),
          sizing_policy_kind: effectiveKind,
          target_range_max_usdc: targetRangeMaxUsdc,
          mirror_max_alloc_per_condition_usdc: mirrorMaxAllocPerConditionUsdc,
          source: "db",
        },
      })
    );
  }
);

/**
 * Narrow a DB text column to the stored-sizing-policy-kind union. DB CHECK
 * enforces the enum at write time, so an unknown value here means schema
 * drift — fail closed to `'auto'`.
 */
function coercePatchedSizingPolicyKind(
  value: string
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
