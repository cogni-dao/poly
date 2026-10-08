// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Tenant-scoped persistence needed by the wallet-reset use case. */

import type { ActorId } from "@cogni/ids";

export interface PolyWalletResetConnection {
  id: string;
  address: string;
  funderAddress: string | null;
}

export interface PolyWalletResetState {
  connection: PolyWalletResetConnection | null;
  unsettledOrderCount: number;
  openPositionCount: number;
  activeTargetCount: number;
  latestTargetDisabledAt: Date | null;
}

export interface PolyWalletResetStatePort {
  inspect(input: {
    actorId: ActorId;
    billingAccountId: string;
  }): Promise<PolyWalletResetState>;

  disableActiveTargets(input: {
    actorId: ActorId;
    billingAccountId: string;
  }): Promise<number>;

  revokeConnection(input: {
    actorId: ActorId;
    billingAccountId: string;
    revokedByUserId: string;
    revokedAt: Date;
  }): Promise<number>;
}
