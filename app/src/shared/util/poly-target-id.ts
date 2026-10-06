// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure, deterministic identity shared by copy placement and saved-position correlation. */
import { v5 as uuidv5 } from "uuid";

const POLY_TARGET_WALLET_NAMESPACE =
	"e2a38b91-7b7d-5f8e-9c0d-4a1e6f8b2c3d" as const;

export function targetIdFromWallet(wallet: `0x${string}`): string {
	return uuidv5(wallet.toLowerCase(), POLY_TARGET_WALLET_NAMESPACE);
}
