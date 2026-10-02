// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** RLS-scoped persistence adapter for owner wallet-reset preconditions. */

import {
  polyCopyTradeFills,
  polyCopyTradeTargets,
  polyTraderCurrentPositions,
  polyTraderWallets,
  polyWalletConnections,
  polyWalletGrants,
} from "@cogni/poly-db-schema";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "@/adapters/server/db/client";
import { withTenantScope } from "@/adapters/server/db/tenant-scope";
import type {
  PolyWalletResetState,
  PolyWalletResetStatePort,
} from "@/ports";

const UNSETTLED_ORDER_STATUSES = ["pending", "open", "partial"] as const;

const nonTerminalPosition = sql`(
  ${polyCopyTradeFills.positionLifecycle} IS NULL
  OR ${polyCopyTradeFills.positionLifecycle} NOT IN ('closed','redeemed','loser','dust','abandoned')
)`;
const hasPositionExposure = sql`(
  ${polyCopyTradeFills.positionLifecycle} IS NOT NULL
  OR ${polyCopyTradeFills.status} IN ('filled','partial')
  OR CASE
    WHEN ${polyCopyTradeFills.attributes}->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
      THEN (${polyCopyTradeFills.attributes}->>'filled_size_usdc')::numeric
    ELSE 0
  END > 0
)`;

export class DrizzlePolyWalletResetStateAdapter
  implements PolyWalletResetStatePort
{
  constructor(private readonly db: Database) {}

  async inspect(
    input: Parameters<PolyWalletResetStatePort["inspect"]>[0]
  ): Promise<PolyWalletResetState> {
    return withTenantScope(this.db, input.actorId, async (tx) => {
      const connections = await tx
        .select({
          id: polyWalletConnections.id,
          billingAccountId: polyWalletConnections.billingAccountId,
          address: polyWalletConnections.address,
          funderAddress: polyWalletConnections.funderAddress,
        })
        .from(polyWalletConnections)
        .where(
          and(
            eq(
              polyWalletConnections.billingAccountId,
              input.billingAccountId
            ),
            isNull(polyWalletConnections.revokedAt)
          )
        )
        .limit(1);
      const connection = connections[0];
      if (!connection) {
        return {
          connection: null,
          unsettledOrderCount: 0,
          openPositionCount: 0,
          activeTargetCount: 0,
          latestTargetDisabledAt: null,
        };
      }
      if (connection.billingAccountId !== input.billingAccountId) {
        throw new Error("wallet reset tenant mismatch");
      }

      const [
        unsettled,
        ledgerPositions,
        currentPositions,
        targets,
        latestDisabledTarget,
      ] = await Promise.all([
        tx
          .select({ value: count() })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, input.billingAccountId),
              inArray(polyCopyTradeFills.status, [
                ...UNSETTLED_ORDER_STATUSES,
              ])
            )
          ),
        tx
          .select({ value: count() })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, input.billingAccountId),
              nonTerminalPosition,
              hasPositionExposure,
              sql`${polyCopyTradeFills.attributes}->>'closed_at' IS NULL`
            )
          ),
        tx
          .select({ value: count() })
          .from(polyTraderCurrentPositions)
          .innerJoin(
            polyTraderWallets,
            eq(polyTraderCurrentPositions.traderWalletId, polyTraderWallets.id)
          )
          .where(
            and(
              eq(polyTraderCurrentPositions.active, true),
              gt(polyTraderCurrentPositions.shares, "0"),
              eq(polyTraderWallets.kind, "cogni_wallet"),
              or(
                eq(polyTraderWallets.walletAddress, connection.address),
                ...(connection.funderAddress
                  ? [
                      eq(
                        polyTraderWallets.walletAddress,
                        connection.funderAddress
                      ),
                    ]
                  : [])
              )
            )
          ),
        tx
          .select({ value: count() })
          .from(polyCopyTradeTargets)
          .where(
            and(
              eq(polyCopyTradeTargets.billingAccountId, input.billingAccountId),
              isNull(polyCopyTradeTargets.disabledAt)
            )
          ),
        tx
          .select({ disabledAt: polyCopyTradeTargets.disabledAt })
          .from(polyCopyTradeTargets)
          .where(
            and(
              eq(polyCopyTradeTargets.billingAccountId, input.billingAccountId),
              sql`${polyCopyTradeTargets.disabledAt} IS NOT NULL`
            )
          )
          .orderBy(desc(polyCopyTradeTargets.disabledAt))
          .limit(1),
      ]);

      return {
        connection: {
          id: connection.id,
          address: connection.address,
          funderAddress: connection.funderAddress,
        },
        unsettledOrderCount: Number(unsettled[0]?.value ?? 0),
        openPositionCount: Math.max(
          Number(ledgerPositions[0]?.value ?? 0),
          Number(currentPositions[0]?.value ?? 0)
        ),
        activeTargetCount: Number(targets[0]?.value ?? 0),
        latestTargetDisabledAt: latestDisabledTarget[0]?.disabledAt ?? null,
      };
    });
  }

  async disableActiveTargets(
    input: Parameters<PolyWalletResetStatePort["disableActiveTargets"]>[0]
  ): Promise<number> {
    return withTenantScope(this.db, input.actorId, async (tx) => {
      const disabled = await tx
        .update(polyCopyTradeTargets)
        .set({ disabledAt: new Date() })
        .where(
          and(
            eq(
              polyCopyTradeTargets.billingAccountId,
              input.billingAccountId
            ),
            isNull(polyCopyTradeTargets.disabledAt)
          )
        )
        .returning({ id: polyCopyTradeTargets.id });
      return disabled.length;
    });
  }

  async revokeConnection(
    input: Parameters<PolyWalletResetStatePort["revokeConnection"]>[0]
  ): Promise<number> {
    return withTenantScope(this.db, input.actorId, async (tx) => {
      const [connection] = await tx
        .update(polyWalletConnections)
        .set({
          revokedAt: input.revokedAt,
          revokedByUserId: input.revokedByUserId,
          tradingApprovalsReadyAt: null,
        })
        .where(
          and(
            eq(
              polyWalletConnections.billingAccountId,
              input.billingAccountId
            ),
            isNull(polyWalletConnections.revokedAt)
          )
        )
        .returning({ id: polyWalletConnections.id });
      if (!connection) return 0;

      const revokedGrants = await tx
        .update(polyWalletGrants)
        .set({
          revokedAt: input.revokedAt,
          revokedByUserId: input.revokedByUserId,
        })
        .where(
          and(
            eq(polyWalletGrants.walletConnectionId, connection.id),
            isNull(polyWalletGrants.revokedAt)
          )
        )
        .returning({ id: polyWalletGrants.id });
      return revokedGrants.length;
    });
  }
}
