// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Typed internal recovery endpoint for funds stranded in tenant wallets.
 * It disables copy targets before signing, rejects known resting orders, and
 * requires the persisted source address plus a repeated irreversible
 * confirmation. It never revokes, unlinks, or deletes a wallet.
 */

import {
  polyCopyTradeFills,
  polyCopyTradeTargets,
} from "@cogni/poly-db-schema";
import {
  type PolyWalletRecoverOutput,
  polyWalletRecoverOperation,
} from "@cogni/poly-node-contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { verifyOperatorNodeAction } from "@/app/_lib/auth/operator-node-action";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  getPolyTraderWalletAdapter,
  WalletAdapterUnconfiguredError,
} from "@/bootstrap/poly-trader-wallet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "recovery_failed";
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "poly.wallet.recover.node_action", auth: { mode: "none" } },
  async (ctx, request) => {
    const verified = await verifyOperatorNodeAction(request, {
      action: "poly.wallet.recover_funds",
      target: "/api/internal/node-actions/poly/wallet/recover",
    });
    if (!verified.ok) {
      return NextResponse.json(
        { error: verified.errorCode },
        { status: verified.errorCode === "verification_unavailable" ? 503 : 401 }
      );
    }

    const parsed = polyWalletRecoverOperation.input.safeParse(
      await request.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_recovery_request", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const body = parsed.data;
    const source = getAddress(body.expected_source_address);
    const destination = getAddress(body.destination);
    const confirmedSource = getAddress(
      body.confirmation.expected_source_address
    );
    const confirmedDestination = getAddress(body.confirmation.destination);
    if (
      confirmedSource !== source ||
      confirmedDestination !== destination ||
      body.confirmation.asset !== body.asset ||
      body.confirmation.amount_atomic !== body.amount_atomic
    ) {
      return NextResponse.json(
        { error: "confirmation_mismatch" },
        { status: 400 }
      );
    }

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

    const persistedSource = await adapter.getAddress(body.billing_account_id);
    if (!persistedSource || getAddress(persistedSource) !== source) {
      return NextResponse.json(
        {
          error: "source_address_mismatch",
          persisted_source_address: persistedSource,
        },
        { status: 409 }
      );
    }

    const db = resolveServiceDb();
    const disabledTargets = await db
      .update(polyCopyTradeTargets)
      .set({ disabledAt: new Date() })
      .where(
        and(
          eq(polyCopyTradeTargets.billingAccountId, body.billing_account_id),
          isNull(polyCopyTradeTargets.disabledAt)
        )
      )
      .returning({ id: polyCopyTradeTargets.id });

    const openLedgerRows = await db
      .select({ id: polyCopyTradeFills.clientOrderId })
      .from(polyCopyTradeFills)
      .where(
        and(
          eq(polyCopyTradeFills.billingAccountId, body.billing_account_id),
          inArray(polyCopyTradeFills.status, ["pending", "open", "partial"])
        )
      )
      .limit(1);
    if (openLedgerRows.length > 0) {
      return NextResponse.json(
        {
          error: "open_orders_present",
          disabled_target_count: disabledTargets.length,
        },
        { status: 409 }
      );
    }

    let repaired = false;
    const execute = () =>
      adapter.withdraw({
        billingAccountId: body.billing_account_id,
        asset: body.asset,
        destination,
        amountAtomic:
          body.amount_atomic === "max" ? 1n : BigInt(body.amount_atomic),
        sweepNative: body.amount_atomic === "max",
        requestedByUserId: verified.claims.actorId,
      });

    try {
      let result;
      try {
        result = await execute();
      } catch (error) {
        if (
          errorCode(error) !== "no_connection" ||
          !body.allow_clob_credential_repair
        ) {
          throw error;
        }
        const repair = await adapter.repairClobCreds(body.billing_account_id);
        if (!repair.ok) throw error;
        repaired = true;
        result = await execute();
      }

      const payload: PolyWalletRecoverOutput = {
        asset: result.asset,
        delivered_asset: result.deliveredAsset,
        source_address: result.sourceAddress,
        destination: result.destination,
        amount_atomic: result.amountAtomic.toString(),
        primary_tx_hash: result.primaryTxHash,
        tx_hashes: [...result.txHashes],
        disabled_target_count: disabledTargets.length,
        clob_credentials_repaired: repaired,
      };
      ctx.log.info(
        {
          event: "poly.wallet.recovery.confirmed",
          billing_account_id: body.billing_account_id,
          source_address: result.sourceAddress,
          destination: result.destination,
          asset: result.asset,
          amount_atomic: result.amountAtomic.toString(),
          tx_hashes: result.txHashes,
          disabled_target_count: disabledTargets.length,
          clob_credentials_repaired: repaired,
        },
        "poly wallet recovery confirmed"
      );
      return NextResponse.json(polyWalletRecoverOperation.output.parse(payload));
    } catch (error) {
      ctx.log.error(
        {
          event: "poly.wallet.recovery.failed",
          billing_account_id: body.billing_account_id,
          expected_source_address: source,
          destination,
          asset: body.asset,
          error_code: errorCode(error),
        },
        "poly wallet recovery failed"
      );
      return NextResponse.json(
        { error: errorCode(error), disabled_target_count: disabledTargets.length },
        { status: 502 }
      );
    }
  }
);
