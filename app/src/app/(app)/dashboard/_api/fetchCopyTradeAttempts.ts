// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { PolyAccountRecentAttemptsResponse } from "@cogni/poly-node-contracts";

/** Owner-session read of the canonical decision-backed attempt tape. */
export async function fetchCopyTradeAttempts(opts?: {
	limit?: number;
}): Promise<PolyAccountRecentAttemptsResponse> {
	const searchParams = new URLSearchParams();
	if (opts?.limit !== undefined) searchParams.set("limit", String(opts.limit));
	const query = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
	const response = await fetch(`/api/v1/poly/copy-trade/attempts${query}`, {
		credentials: "include",
	});
	if (!response.ok) {
		throw new Error(
			`Failed to fetch copy-trade attempts: ${response.status} ${response.statusText}`,
		);
	}
	return (await response.json()) as PolyAccountRecentAttemptsResponse;
}
