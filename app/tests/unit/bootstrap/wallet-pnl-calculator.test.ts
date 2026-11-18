// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * `poly.wallet-pnl@1`: public Data API v2 `/v2/user-pnl` fixtures recorded live
 * on 2026-11-18 for the flagship wallet (1w and 1m, daily grid). No network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CalculatorContext } from "@cogni-dao/metrics";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createGoalMetrics } from "@/bootstrap/capabilities/goal-metrics";
import {
	boundedFetch,
	createWalletPnlCalculator,
	intervalForDays,
	WALLET_PNL_BUDGET,
	WalletPnlParamsSchema,
} from "@/bootstrap/capabilities/wallet-pnl-calculator";

vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node" }));

const here = path.dirname(fileURLToPath(import.meta.url));
type Fixture = {
	data: {
		proxy_wallet: string;
		interval: string;
		fidelity: string;
		source_fidelity: string;
		points: { timestamp: number; trade_pnl: number }[];
	};
};
const load = (name: string): Fixture =>
	JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));
const WEEK = load("polymarket-v2-user-pnl-1w-1d.json");
const MONTH = load("polymarket-v2-user-pnl-1m-1d.json");
const WALLET = "0x41a7ec25dc776bc364452c5c5cc936ffc6d5f296";

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200 });

/** Serves the recorded response whose interval the request asked for. */
function fixtureFetch(byInterval: Record<string, unknown>) {
	const urls: string[] = [];
	const fn = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		urls.push(url.toString());
		const body = byInterval[url.searchParams.get("interval") ?? ""];
		return body ? json(body) : new Response("nope", { status: 400 });
	});
	return { fn: fn as unknown as typeof fetch, urls, spy: fn };
}

function ctxFor(
	endSec: number,
	days: number,
	budget = WALLET_PNL_BUDGET,
): CalculatorContext {
	return {
		window: { start: iso(endSec - days * 86_400), end: iso(endSec) },
		signal: new AbortController().signal,
		budget,
		read: (source) => source(new AbortController().signal, budget),
	};
}

const params = (days: number) => ({
	wallet: WALLET,
	days,
	output: "net_pnl" as const,
});
const lastT = (f: Fixture) =>
	f.data.points[f.data.points.length - 1]?.timestamp ?? 0;

describe("poly.wallet-pnl@1 compute", () => {
	it("normal: end P&L minus P&L at window start, with evidence and one call", async () => {
		const { fn, urls } = fixtureFetch({ "1m": MONTH });
		const calc = createWalletPnlCalculator({ fetch: fn });
		const end = lastT(MONTH) + 60;
		const sample = await calc.compute(params(7), ctxFor(end, 7));
		// 151.518934 (latest) - 110.417638 (last daily point at or before now-7d)
		expect(sample).toMatchObject({
			value: 41.101296,
			unit: "usdc",
			complete: true,
		});
		expect(sample.evidenceRefs).toEqual([
			`polymarket:v2:user-pnl:${WALLET}:${iso(end - 7 * 86_400)}..${iso(end)}`,
			"points=31",
			`basis:t0=${iso(1794355200)},t1=${iso(lastT(MONTH))}`,
		]);
		expect(sample.sourceWatermarks).toEqual([
			{ source: "polymarket.data-api.v2", asOf: iso(lastT(MONTH)) },
		]);
		expect(urls).toHaveLength(1);
		const url = new URL(urls[0] ?? "");
		expect(url.pathname).toBe("/v2/user-pnl");
		expect(url.searchParams.get("user")).toBe(WALLET);
		expect(url.searchParams.get("interval")).toBe("1m");
		expect(url.searchParams.get("fidelity")).toBe("1d");
	});

	it("a negative window is a real value, not unavailable", async () => {
		const { fn } = fixtureFetch({ "1m": MONTH });
		const calc = createWalletPnlCalculator({ fetch: fn });
		const end = lastT(MONTH) + 60;
		// 30d ago is outside the 1m response's first point only by < 1 day: use 20d.
		const sample = await calc.compute(params(20), ctxFor(end, 20));
		const pts = MONTH.data.points;
		const base = [...pts]
			.reverse()
			.find((p) => p.timestamp <= end - 20 * 86_400);
		expect(sample.complete).toBe(true);
		expect(sample.value).toBeCloseTo(
			151.518934 - (base?.trade_pnl ?? Number.NaN),
			6,
		);
	});

	it("empty series is history_unavailable, never 0", async () => {
		const empty = {
			data: { ...WEEK.data, points: [] as Fixture["data"]["points"] },
		};
		const { fn } = fixtureFetch({ "1w": empty });
		const sample = await createWalletPnlCalculator({ fetch: fn }).compute(
			params(6),
			ctxFor(lastT(WEEK) + 60, 6),
		);
		expect(sample.complete).toBe(false);
		expect(sample.reason).toBe("history_unavailable");
		expect(sample.evidenceRefs).toContain("points=0");
	});

	it("partial window (series starts after the window start) is insufficient_history", async () => {
		// A young wallet: the source only holds the last three days.
		const young = {
			data: { ...WEEK.data, points: WEEK.data.points.slice(-3) },
		};
		const { fn } = fixtureFetch({ "1w": young });
		const sample = await createWalletPnlCalculator({ fetch: fn }).compute(
			params(6),
			ctxFor(lastT(WEEK) + 60, 6),
		);
		expect(sample.complete).toBe(false);
		expect(sample.reason).toBe("insufficient_history");
		expect(sample.evidenceRefs).toContain("points=3");
	});

	it("stale series (newest point older than 36h) is history_unavailable", async () => {
		const { fn } = fixtureFetch({ "1w": WEEK });
		const sample = await createWalletPnlCalculator({ fetch: fn }).compute(
			params(6),
			ctxFor(lastT(WEEK) + 3 * 86_400, 6),
		);
		expect(sample.complete).toBe(false);
		expect(sample.reason).toBe("history_unavailable");
	});

	it("a series with more points than maxRows is incomplete, not truncated", async () => {
		const { fn } = fixtureFetch({ "1w": WEEK });
		const budget = { ...WALLET_PNL_BUDGET, maxRows: 3 };
		const sample = await createWalletPnlCalculator({ fetch: fn }).compute(
			params(6),
			ctxFor(lastT(WEEK) + 60, 6, budget),
		);
		expect(sample.complete).toBe(false);
		expect(sample.reason).toBe("incomplete_or_invalid_source");
	});

	it("a failed or mismatched upstream read throws (engine records source_failed)", async () => {
		const down = (async () =>
			new Response("busy", { status: 503 })) as unknown as typeof fetch;
		await expect(
			createWalletPnlCalculator({ fetch: down }).compute(
				params(6),
				ctxFor(lastT(WEEK) + 60, 6),
			),
		).rejects.toThrow(/503/);
		// Response for another wallet fails the client's identity check.
		const other = {
			data: { ...WEEK.data, proxy_wallet: `0x${"1".repeat(40)}` },
		};
		const { fn } = fixtureFetch({ "1w": other });
		await expect(
			createWalletPnlCalculator({ fetch: fn }).compute(
				params(6),
				ctxFor(lastT(WEEK) + 60, 6),
			),
		).rejects.toThrow(/identity mismatch/);
	});
});

describe("poly.wallet-pnl@1 contract", () => {
	it("params are strict: lowercase wallet, days 1..30, net_pnl only", () => {
		const ok = WalletPnlParamsSchema.safeParse(params(7));
		expect(ok.success).toBe(true);
		for (const bad of [
			{ ...params(7), wallet: WALLET.toUpperCase().replace("0X", "0x") },
			{ ...params(7), wallet: "0x123" },
			{ ...params(7), days: 0 },
			{ ...params(7), days: 31 },
			{ ...params(7), days: 1.5 },
			{ ...params(7), output: "return_pct" },
			{ ...params(7), extra: true },
		])
			expect(WalletPnlParamsSchema.safeParse(bad).success).toBe(false);
	});

	it("picks an upstream window that reaches past the start of the metric window", () => {
		expect(intervalForDays(1)).toBe("1w");
		expect(intervalForDays(6)).toBe("1w");
		expect(intervalForDays(7)).toBe("1m");
		expect(intervalForDays(29)).toBe("1m");
		expect(intervalForDays(30)).toBe("all");
	});

	it("is bounded: <=10s, one call, byte cap enforced, redirects refused", async () => {
		expect(WALLET_PNL_BUDGET.timeoutMs).toBeLessThanOrEqual(10_000);
		expect(WALLET_PNL_BUDGET.maxSourceCalls).toBe(1);
		const seen: RequestInit[] = [];
		const big = (async (_i: RequestInfo | URL, init?: RequestInit) => {
			seen.push(init ?? {});
			return new Response("x".repeat(100), { status: 200 });
		}) as unknown as typeof fetch;
		await expect(boundedFetch(big, 50)("https://x.test")).rejects.toThrow(
			"provider_response_budget",
		);
		expect(seen[0]?.redirect).toBe("error");
		const res = await boundedFetch(big, 200)("https://x.test");
		expect(await res.text()).toHaveLength(100);
	});

	it("registers through createGoalMetrics without tripping reserved families", () => {
		const empty = Object.assign(async () => [], {
			unsafe: async () => [],
		}) as unknown as Sql;
		const service = createGoalMetrics({
			knowledgeSql: empty,
			observationsSql: empty,
			environment: "test",
			log: () => undefined,
		});
		const calc = service.registry.get("poly.wallet-pnl@1");
		expect(calc.unitFor?.(params(7))).toBe("usdc");
		expect(calc.windowSeconds?.(params(7))).toBe(7 * 86_400);
		expect(calc.historicalWindows).toBeFalsy();
		// Package calculators are still registered beside it.
		expect(service.registry.get("github.stars@1").id).toBe("github.stars@1");
	});
});
