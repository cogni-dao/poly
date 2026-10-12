// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { WalletPosition } from "./types/wallet-analysis";

export type WalletPositionAction = "close" | "redeem";

/** Pure operational action classifier; economic Closed membership is separate. */
export function positionActionKind(
  position: Pick<WalletPosition, "status" | "lifecycleState">
): WalletPositionAction | null {
  const lifecycle = position.lifecycleState ?? null;
  if (
    position.status === "redeemable" &&
    (lifecycle === null || lifecycle === "winner" || lifecycle === "abandoned")
  ) {
    return "redeem";
  }
  if (
    position.status === "open" &&
    (lifecycle === null || lifecycle === "unresolved" || lifecycle === "open")
  ) {
    return "close";
  }
  return null;
}
