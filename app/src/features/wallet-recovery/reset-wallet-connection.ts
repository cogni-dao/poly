// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fail-closed owner wallet-reset orchestration. */

import type { ActorId } from "@cogni/ids";
import type { PolyTraderWalletPort } from "@cogni/poly-wallet";
import type { PolyWalletResetStatePort } from "@/ports";

export type WalletResetBlockedReason =
  | "residual_balance"
  | "balance_read_failed"
  | "unsettled_orders"
  | "open_positions"
  | "copy_targets_disabled";

export interface WalletResetResult {
  billingAccountId: string;
  outcome: "reset" | "no_active_connection" | "blocked";
  blockedReason: WalletResetBlockedReason | null;
  connection: {
    connectionId: string;
    funderAddress: string | null;
    signerAddress: string;
    revokedAt: Date | null;
  } | null;
  balances: {
    usdcE: number | null;
    pusd: number | null;
    pol: number | null;
    readErrors: readonly string[];
  };
  unsettledOrderCount: number;
  openPositionCount: number;
  grantsRevokedCount: number;
  targetsDisabledCount: number;
  reprovisionAvailableInSeconds: number;
}

export interface ResetWalletConnectionDeps {
  state: PolyWalletResetStatePort;
  wallet: Pick<PolyTraderWalletPort, "getBalances">;
  getReprovisionWaitSeconds(billingAccountId: string): Promise<number>;
  now(): Date;
}

/** One mirror-poll window between target shutdown and credential revocation. */
export const TARGET_QUIESCE_MS = 60_000;

export async function resetWalletConnection(
  deps: ResetWalletConnectionDeps,
  input: {
    actorId: ActorId;
    userId: string;
    billingAccountId: string;
  }
): Promise<WalletResetResult> {
  const state = await deps.state.inspect(input);
  const emptyBalances = {
    usdcE: null,
    pusd: null,
    pol: null,
    readErrors: [] as readonly string[],
  };

  if (!state.connection) {
    return {
      billingAccountId: input.billingAccountId,
      outcome: "no_active_connection",
      blockedReason: null,
      connection: null,
      balances: emptyBalances,
      unsettledOrderCount: 0,
      openPositionCount: 0,
      grantsRevokedCount: 0,
      targetsDisabledCount: 0,
      reprovisionAvailableInSeconds:
        await deps.getReprovisionWaitSeconds(input.billingAccountId),
    };
  }

  const connection = {
    connectionId: state.connection.id,
    funderAddress: state.connection.funderAddress,
    signerAddress: state.connection.address,
    revokedAt: null as Date | null,
  };
  const balanceRead = await deps.wallet.getBalances(input.billingAccountId);
  const balances = {
    usdcE: balanceRead?.usdcE ?? null,
    pusd: balanceRead?.pusd ?? null,
    pol: balanceRead?.pol ?? null,
    readErrors: [...(balanceRead?.errors ?? [])],
  };
  const balanceUnreadable =
    balanceRead === null ||
    balances.readErrors.length > 0 ||
    balances.usdcE === null ||
    balances.pusd === null ||
    balances.pol === null;
  const hasResidualBalance =
    (balances.usdcE ?? 0) > 0 ||
    (balances.pusd ?? 0) > 0 ||
    (balances.pol ?? 0) > 0;

  const blocked = (
    blockedReason: WalletResetBlockedReason,
    targetsDisabledCount = 0
  ): WalletResetResult => ({
    billingAccountId: input.billingAccountId,
    outcome: "blocked",
    blockedReason,
    connection,
    balances,
    unsettledOrderCount: state.unsettledOrderCount,
    openPositionCount: state.openPositionCount,
    grantsRevokedCount: 0,
    targetsDisabledCount,
    reprovisionAvailableInSeconds: 0,
  });

  if (state.unsettledOrderCount > 0) return blocked("unsettled_orders");
  if (state.openPositionCount > 0) return blocked("open_positions");
  if (balanceUnreadable) return blocked("balance_read_failed");
  if (hasResidualBalance) return blocked("residual_balance");

  if (state.activeTargetCount > 0) {
    const disabled = await deps.state.disableActiveTargets(input);
    return blocked("copy_targets_disabled", disabled);
  }

  if (
    state.latestTargetDisabledAt !== null &&
    deps.now().getTime() - state.latestTargetDisabledAt.getTime() <
      TARGET_QUIESCE_MS
  ) {
    return blocked("copy_targets_disabled");
  }

  const revokedAt = deps.now();
  const grantsRevokedCount = await deps.state.revokeConnection({
    actorId: input.actorId,
    billingAccountId: input.billingAccountId,
    revokedByUserId: input.userId,
    revokedAt,
  });

  return {
    billingAccountId: input.billingAccountId,
    outcome: "reset",
    blockedReason: null,
    connection: { ...connection, revokedAt },
    balances,
    unsettledOrderCount: 0,
    openPositionCount: 0,
    grantsRevokedCount,
    targetsDisabledCount: 0,
    reprovisionAvailableInSeconds:
      await deps.getReprovisionWaitSeconds(input.billingAccountId),
  };
}
