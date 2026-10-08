// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { POSITION_GAP_EPSILON } from "./model";

export type StrictBuyLimitResult =
	| Readonly<{ ok: true; price: number }>
	| Readonly<{ ok: false; reason: "invalid_price" | "invalid_tick" }>;

/** Tick-floor a strict BUY cap. This never rounds into adverse price. */
export function strictBuyLimitPrice(params: {
	targetVwap: number;
	bestAsk: number | null;
	tickSize: number;
}): StrictBuyLimitResult {
	const { targetVwap, bestAsk, tickSize } = params;
	if (
		!Number.isFinite(tickSize) ||
		tickSize <= 0 ||
		tickSize >= 1 ||
		!Number.isInteger(Math.round(1 / tickSize)) ||
		Math.abs(1 / Math.round(1 / tickSize) - tickSize) > POSITION_GAP_EPSILON
	) {
		return { ok: false, reason: "invalid_tick" };
	}
	if (
		!Number.isFinite(targetVwap) ||
		targetVwap <= 0 ||
		targetVwap >= 1 ||
		(bestAsk !== null &&
			(!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1))
	) {
		return { ok: false, reason: "invalid_price" };
	}

	const scale = Math.round(1 / tickSize);
	const sourcePrice = Math.min(targetVwap, bestAsk ?? targetVwap);
	const flooredTicks = Math.floor((sourcePrice + POSITION_GAP_EPSILON) * scale);
	if (flooredTicks < 1 || flooredTicks >= scale) {
		return { ok: false, reason: "invalid_price" };
	}
	const price = flooredTicks / scale;
	if (price > targetVwap + POSITION_GAP_EPSILON) {
		return { ok: false, reason: "invalid_price" };
	}
	return { ok: true, price };
}
