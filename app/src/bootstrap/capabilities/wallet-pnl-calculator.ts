// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/wallet-pnl-calculator`
 * Purpose: Node calculator `poly.wallet-pnl@1`: net P&L of ONE declared wallet over the last N days, read from Polymarket's public Data API v2 `GET /v2/user-pnl`.
 * Scope: Measurement only. Registered through `createGoalMetrics({ nodeCalculators })`; metric definition rows and goals are hub contributions, never code.
 * Invariants:
 *   - PUBLIC_DATA_ONLY: the only source is the public, unauthenticated Polymarket Data API; the wallet is an on-chain address the caller declares in the metric definition. No private DB read, no connection credential, so no grant check is needed (the @cogni-dao/metrics rule about private connection data does not apply).
 *   - UNKNOWN_IS_NOT_ZERO: an empty, stale or partial series is `unavailable` with a reason (`history_unavailable` / `insufficient_history` / `incomplete_or_invalid_source`); a failed read throws and surfaces as `source_failed`. None of them is ever a 0 reading.
 *   - BOUNDED: one source call, <= 8s, <= MAX_ROWS points, <= MAX_RESPONSE_BYTES, no redirects.
 *   - SAME_SERIES_AS_DASHBOARD: values are the `trade_pnl` composition (the legacy chart's `p`) via PolymarketUserPnlClient, so a reading reproduces the P&L the Poly UI shows.
 * Side-effects: IO (one HTTPS GET to data-api.polymarket.com per compute)
 * Links: https://poly.cognidao.org/work/items/story.5027, https://data-api.polymarket.com/v2/docs
 * @public
 */

import {
	PolymarketUserPnlClient,
	type PolymarketUserPnlInterval,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { MetricCalculator, MetricSample } from "@cogni-dao/metrics";
import { z } from "zod";

export const WALLET_PNL_CALCULATOR_ID = "poly.wallet-pnl@1";

/** Hard bounds (published contract of this calculator; changing one is a version bump). */
export const WALLET_PNL_BUDGET = {
	timeoutMs: 8_000,
	maxSourceCalls: 1,
	maxRows: 4_000,
	maxResponseBytes: 4 * 1024 * 1024,
} as const;

/** Output grid. The upstream source is daily, so a finer grid only adds bytes. */
const FIDELITY = "1d" as const;
/** An edge point further than this from its target time is not evidence for it. */
const MAX_EDGE_GAP_SECONDS = 36 * 3600;

/**
 * `wallet` is canonical lowercase so two spellings can never fork one series.
 * `output` is `net_pnl` only: Data API v2 `/v2/user-pnl` carries no value or
 * cost-basis series, so `return_pct` cannot be computed honestly from it and is
 * omitted (adding it later is a new output value, never a silent estimate).
 */
export const WalletPnlParamsSchema = z.strictObject({
	wallet: z.string().regex(/^0x[0-9a-f]{40}$/, "lowercase 0x-prefixed address"),
	days: z.number().int().min(1).max(30),
	output: z.enum(["net_pnl"]),
});
export type WalletPnlParams = z.infer<typeof WalletPnlParamsSchema>;

/**
 * Smallest upstream window that still holds a point AT OR BEFORE `now - days`.
 * The upstream's first point is the first UTC midnight inside the interval, so
 * the interval must exceed `days` by at least one day.
 */
export function intervalForDays(days: number): PolymarketUserPnlInterval {
	if (days <= 6) return "1w";
	if (days <= 29) return "1m";
	return "all";
}

/** Read the response with a hard byte cap; refuse redirects. */
export function boundedFetch(
	base: typeof fetch,
	maxBytes: number,
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await base(input, {
			...init,
			redirect: "error",
			cache: "no-store",
		});
		if (!res.ok) return res;
		const declared = Number(res.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes)
			throw new Error("provider_response_budget");
		const reader = res.body?.getReader();
		if (!reader) {
			const text = await res.text();
			if (text.length > maxBytes) throw new Error("provider_response_budget");
			return new Response(text, { status: res.status });
		}
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > maxBytes) throw new Error("provider_response_budget");
				chunks.push(part.value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		return new Response(Buffer.concat(chunks), { status: res.status });
	}) as typeof fetch;
}

function incomplete(
	reason: NonNullable<MetricSample["reason"]>,
	evidenceRefs: string[],
	asOf: string,
): MetricSample {
	return {
		value: 0, // never read: `complete: false` makes the engine store null + reason
		unit: "usdc",
		complete: false,
		reason,
		sourceWatermarks: [{ source: "polymarket.data-api.v2", asOf }],
		evidenceRefs,
	};
}

export function createWalletPnlCalculator(deps?: {
	fetch?: typeof fetch;
}): MetricCalculator {
	const client = new PolymarketUserPnlClient({
		fetch: boundedFetch(
			deps?.fetch ?? globalThis.fetch,
			WALLET_PNL_BUDGET.maxResponseBytes,
		),
		// Inside the engine's own deadline, so the client reports its timeout first.
		timeoutMs: WALLET_PNL_BUDGET.timeoutMs - 1_000,
	});

	return {
		id: WALLET_PNL_CALCULATOR_ID,
		unit: "usdc",
		unitFor: () => "usdc",
		display: "volume",
		// Snapshot calculator: the window always ends now (no historicalWindows).
		windowSeconds: (params) =>
			WalletPnlParamsSchema.parse(params).days * 86_400,
		paramsSchema: WalletPnlParamsSchema,
		budget: WALLET_PNL_BUDGET,
		compute: async (params, ctx): Promise<MetricSample> => {
			const p = WalletPnlParamsSchema.parse(params);
			const startSec = Date.parse(ctx.window.start) / 1000;
			const endSec = Date.parse(ctx.window.end) / 1000;
			const windowRef = `polymarket:v2:user-pnl:${p.wallet}:${ctx.window.start}..${ctx.window.end}`;

			const raw = await ctx.read((signal) =>
				client.getUserPnl(
					p.wallet,
					{ interval: intervalForDays(p.days), fidelity: FIDELITY },
					{ signal, component: "metric.poly.wallet-pnl" },
				),
			);
			const points = [...raw].sort((a, b) => a.t - b.t);
			const evidence = [windowRef, `points=${points.length}`];

			if (points.length > ctx.budget.maxRows)
				return incomplete(
					"incomplete_or_invalid_source",
					evidence,
					ctx.window.end,
				);

			// Empty = the source says nothing about this wallet: unknown, not 0.
			const last = points[points.length - 1];
			if (!last)
				return incomplete("history_unavailable", evidence, ctx.window.end);

			// The reading is "as of" the newest point; clamp clock skew to the window end.
			const asOf = new Date(Math.min(last.t, endSec) * 1000).toISOString();
			if (endSec - last.t > MAX_EDGE_GAP_SECONDS)
				return incomplete("history_unavailable", evidence, asOf);

			// Cumulative P&L as of the window start = newest point not after it.
			let base: (typeof points)[number] | undefined;
			for (const pt of points) if (pt.t <= startSec) base = pt;
			if (!base || startSec - base.t > MAX_EDGE_GAP_SECONDS)
				return incomplete("insufficient_history", evidence, asOf);

			const value = Math.round((last.p - base.p) * 1e6) / 1e6;
			return {
				value,
				unit: "usdc",
				complete: Number.isFinite(value),
				sourceWatermarks: [{ source: "polymarket.data-api.v2", asOf }],
				evidenceRefs: [
					...evidence,
					`basis:t0=${new Date(base.t * 1000).toISOString()},t1=${new Date(last.t * 1000).toISOString()}`,
				],
			};
		},
	};
}
