// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/ops/poly/wallet/reset-connection`
 * Purpose: Audited operator reset of ONE tenant's Polymarket wallet
 *   connection, so the owner can re-provision a fresh canonical V2 Deposit
 *   Wallet through the normal product UI.
 * Scope: Bearer-auth POST endpoint for operators. Delegates the revoke to
 *   `PolyTraderWalletPort.revoke`; tombstones copy targets directly.
 * Invariants:
 *   - INTERNAL_OPS_AUTH: requires Bearer INTERNAL_OPS_TOKEN — the node's
 *     standard operator token, already valued in every deployed lane. No
 *     bespoke per-feature token.
 *   - NO_STRANDED_FUNDS: refuses while the Deposit Wallet holds USDC.e / pUSD
 *     / POL unless `accept_residual_dust` is set. An ERRORED balance read
 *     always blocks reset and cannot be overridden as dust.
 *   - NOTHING_TO_READ_IS_NOT_A_FAILED_READ: a connection with no
 *     `funder_address` has no Deposit Wallet, so there is no balance to read
 *     and nothing it could strand. It is exempt from the balance guard only —
 *     unsettled orders and live positions still block. Without this exemption
 *     unprovisioned connections were permanently unresettable.
 *   - NO_UNSETTLED_ORDERS: refuses while any mirror fill is pending | open |
 *     partial, so a revoke cannot orphan a resting CLOB order.
 *   - REVOKE_NEVER_DELETES: history, the Privy wallet, and the SIWE/user
 *     identity binding are all preserved. `revokedByUserId` is the connection's
 *     own `createdByUserId` — the reset attributes to the owning user, and
 *     never invents or reassigns an identity.
 *   - NO_FUND_MOVEMENT: this route never transfers, wraps, or withdraws.
 *   - SINGLE_TENANT_ONLY: `billing_account_id` is required. There is no
 *     "reset all" — blast radius is one tenant per call, by construction.
 * Side-effects: DB writes (connection + grants revoke, copy-target tombstone),
 *   process-local executor cache invalidation. Reads Polygon for balances.
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/bug.5310
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import {
  polyCopyTradeFills,
  polyCopyTradeTargets,
  polyWalletConnections,
  polyWalletGrants,
} from "@cogni/poly-db-schema";
import {
  type PolyWalletResetConnectionOutput,
  polyWalletResetConnectionOperation,
} from "@cogni/poly-node-contracts";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  checkConnectRateLimit,
  getPolyTraderWalletAdapter,
  WalletAdapterUnconfiguredError,
} from "@/bootstrap/poly-trader-wallet";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AUTH_HEADER_LENGTH = 512;
const MAX_TOKEN_LENGTH = 256;

/** Canonical OrderStatus values that mean "still resting at the CLOB". */
const UNSETTLED_STATUSES = ["pending", "open", "partial"] as const;

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  if (token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "poly.wallet.reset_connection.ops", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const configuredToken = env.INTERNAL_OPS_TOKEN;
    if (!configuredToken) {
      ctx.log.error("INTERNAL_OPS_TOKEN not configured");
      return NextResponse.json(
        { error: "service_not_configured" },
        { status: 500 }
      );
    }

    const providedToken = extractBearerToken(
      request.headers.get("authorization")
    );
    if (!providedToken || !safeCompare(providedToken, configuredToken)) {
      ctx.log.warn("Invalid or missing INTERNAL_OPS_TOKEN");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const parsed = polyWalletResetConnectionOperation.input.safeParse(
      await parseBody(request)
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_reset_request" }, { status: 400 });
    }
    const { billing_account_id: billingAccountId, accept_residual_dust } =
      parsed.data;

    const start = performance.now();
    const serviceDb = resolveServiceDb();
    const container = getContainer();

    let adapter: ReturnType<typeof getPolyTraderWalletAdapter>;
    try {
      adapter = getPolyTraderWalletAdapter(ctx.log);
    } catch (error) {
      if (error instanceof WalletAdapterUnconfiguredError) {
        return NextResponse.json(
          { error: "wallet_adapter_unconfigured" },
          { status: 503 }
        );
      }
      throw error;
    }

    const emit = (
      payload: PolyWalletResetConnectionOutput,
      status: number
    ): NextResponse => {
      logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_RESET_CONNECTION_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: Math.round(performance.now() - start),
        outcome: payload.outcome === "reset" ? "success" : "skipped",
        billing_account_id: billingAccountId,
        reset_outcome: payload.outcome,
        ...(payload.blocked_reason
          ? { errorCode: payload.blocked_reason }
          : {}),
        unsettled_fill_count: payload.unsettled_fill_count,
        grants_revoked_count: payload.grants_revoked_count,
        targets_disabled_count: payload.targets_disabled_count,
      });
      return NextResponse.json(
        polyWalletResetConnectionOperation.output.parse(payload),
        { status }
      );
    };

    // --- Inventory the active connection (read-only) -----------------------
    const [active] = await serviceDb
      .select({
        id: polyWalletConnections.id,
        address: polyWalletConnections.address,
        funderAddress: polyWalletConnections.funderAddress,
        createdByUserId: polyWalletConnections.createdByUserId,
      })
      .from(polyWalletConnections)
      .where(
        and(
          eq(polyWalletConnections.billingAccountId, billingAccountId),
          isNull(polyWalletConnections.revokedAt)
        )
      )
      .limit(1);

    const emptyBalances = {
      usdc_e: null,
      pusd: null,
      pol: null,
      read_errors: [] as string[],
    };

    if (!active) {
      const rateLimit = await checkConnectRateLimit(billingAccountId);
      return emit(
        {
          billing_account_id: billingAccountId,
          outcome: "no_active_connection",
          blocked_reason: null,
          connection: null,
          balances: emptyBalances,
          unsettled_fill_count: 0,
          grants_revoked_count: 0,
          targets_disabled_count: 0,
          reprovision_available_in_seconds: rateLimit.retryAfterSeconds,
        },
        200
      );
    }

    const connectionSummary = {
      connection_id: active.id,
      funder_address: active.funderAddress,
      signer_address: active.address,
      revoked_at: null as string | null,
    };

    // --- Precondition: no unsettled mirror orders -------------------------
    const [unsettledRow] = await serviceDb
      .select({ c: count() })
      .from(polyCopyTradeFills)
      .where(
        and(
          eq(polyCopyTradeFills.billingAccountId, billingAccountId),
          inArray(polyCopyTradeFills.status, [...UNSETTLED_STATUSES])
        )
      );
    const unsettledFillCount = Number(unsettledRow?.c ?? 0);

    // --- Precondition: no recoverable balance left behind -----------------
    //
    // NOTHING_TO_READ_IS_NOT_A_FAILED_READ: a connection with no
    // `funder_address` never had a V2 Deposit Wallet provisioned, so there is
    // no deposit-wallet address whose balance could be read — `getAddress`
    // returns null and `getBalances` returns null with an EMPTY `errors` list.
    // Treating that as "unreadable" made exactly the tenants who most need a
    // reset the only ones who can never get one: unprovisioned rows were
    // permanently blocked here, with no `accept_residual_dust` escape (the
    // unreadable branch returns before that flag is consulted).
    //
    // This is safe because there is no deposit wallet to strand funds in, and
    // because REVOKE_NEVER_DELETES still holds: the Privy signer wallet, its
    // on-chain assets, and the user binding all survive the revoke, so
    // anything held at the SIGNER address stays exactly as reachable after
    // this call as before it. The unsettled-orders and position guards below
    // are untouched and still apply.
    const isUnprovisioned = active.funderAddress === null;
    const balancesRead = isUnprovisioned
      ? null
      : await adapter.getBalances(billingAccountId);
    const balances = {
      usdc_e: balancesRead?.usdcE ?? null,
      pusd: balancesRead?.pusd ?? null,
      pol: balancesRead?.pol ?? null,
      read_errors: [...(balancesRead?.errors ?? [])],
    };
    // Fail-closed: an unreadable balance is NOT a zero balance. Only an
    // unprovisioned connection — which has no balance to read at all — is
    // exempt.
    const balanceUnreadable =
      !isUnprovisioned &&
      (balancesRead === null ||
        balances.read_errors.length > 0 ||
        balances.usdc_e === null ||
        balances.pusd === null ||
        balances.pol === null);
    const hasResidualBalance =
      (balances.usdc_e ?? 0) > 0 ||
      (balances.pusd ?? 0) > 0 ||
      (balances.pol ?? 0) > 0;

    if (unsettledFillCount > 0) {
      return emit(
        {
          billing_account_id: billingAccountId,
          outcome: "blocked",
          blocked_reason: "unsettled_orders",
          connection: connectionSummary,
          balances,
          unsettled_fill_count: unsettledFillCount,
          grants_revoked_count: 0,
          targets_disabled_count: 0,
          reprovision_available_in_seconds: 0,
        },
        409
      );
    }

    if (balanceUnreadable) {
      return emit(
        {
          billing_account_id: billingAccountId,
          outcome: "blocked",
          blocked_reason: "balance_read_failed",
          connection: connectionSummary,
          balances,
          unsettled_fill_count: unsettledFillCount,
          grants_revoked_count: 0,
          targets_disabled_count: 0,
          reprovision_available_in_seconds: 0,
        },
        409
      );
    }

    if (!accept_residual_dust && hasResidualBalance) {
      return emit(
        {
          billing_account_id: billingAccountId,
          outcome: "blocked",
          blocked_reason: "residual_balance",
          connection: connectionSummary,
          balances,
          unsettled_fill_count: unsettledFillCount,
          grants_revoked_count: 0,
          targets_disabled_count: 0,
          reprovision_available_in_seconds: 0,
        },
        409
      );
    }

    // --- Mutate: disable targets, then revoke connection + grants ---------
    // Targets first: a disabled target cannot enqueue new mirror work while
    // the revoke lands.
    const disabledTargets = await serviceDb
      .update(polyCopyTradeTargets)
      .set({ disabledAt: new Date() })
      .where(
        and(
          eq(polyCopyTradeTargets.billingAccountId, billingAccountId),
          isNull(polyCopyTradeTargets.disabledAt)
        )
      )
      .returning({ id: polyCopyTradeTargets.id });

    const [grantRow] = await serviceDb
      .select({ c: count() })
      .from(polyWalletGrants)
      .where(
        and(
          eq(polyWalletGrants.billingAccountId, billingAccountId),
          isNull(polyWalletGrants.revokedAt)
        )
      );
    const activeGrantCount = Number(grantRow?.c ?? 0);

    // Transactional: flips revokedAt, clears the readiness stamp in the same
    // transaction (APPROVALS_BEFORE_PLACE cannot leak across a revoke), and
    // cascades the grants.
    await adapter.revoke({
      billingAccountId,
      revokedByUserId: active.createdByUserId,
    });
    container.invalidatePolyTradeExecutorFor(billingAccountId);

    const rateLimit = await checkConnectRateLimit(billingAccountId);
    return emit(
      {
        billing_account_id: billingAccountId,
        outcome: "reset",
        blocked_reason: null,
        connection: {
          ...connectionSummary,
          revoked_at: new Date().toISOString(),
        },
        balances,
        unsettled_fill_count: 0,
        grants_revoked_count: activeGrantCount,
        targets_disabled_count: disabledTargets.length,
        reprovision_available_in_seconds: rateLimit.retryAfterSeconds,
      },
      200
    );
  }
);
