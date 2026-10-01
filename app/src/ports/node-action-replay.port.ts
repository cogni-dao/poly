// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export interface NodeActionReplayPort {
	consume(jti: string, ttlSeconds: number): Promise<boolean>;
}
