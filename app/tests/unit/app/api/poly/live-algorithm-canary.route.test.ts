// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/live-algorithm-canary.route`
 * Purpose: Prove browser auth and geo refusal happen before trade-path I/O.
 * Scope: Route wiring with all persistence and wallet adapters mocked.
 * Invariants: no session returns 401; blocked egress returns 451 without
 *   account lookup, executor construction, DB access, or placement.
 * Side-effects: none.
 * Links: task.1791070987
 * @internal
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	getContainer: vi.fn(),
	createExecutorResolver: vi.fn(),
	runLocalLiveCanary: vi.fn(),
	getEgressGeoblockLatch: vi.fn(),
	serverEnv: vi.fn(),
}));

vi.mock("@/app/_lib/auth/session", () => ({
	getSessionUser: mocks.getSessionUser,
}));
vi.mock("@/bootstrap/container", () => ({ getContainer: mocks.getContainer }));
vi.mock("@/bootstrap/poly-local-live-canary", () => ({
	createLocalLiveCanaryExecutorResolver: mocks.createExecutorResolver,
}));

vi.mock("@/lib/egress-geoblock", () => ({
	getEgressGeoblockLatch: mocks.getEgressGeoblockLatch,
}));

vi.mock("@/shared/env/server", () => ({ serverEnv: mocks.serverEnv }));

vi.mock("@/features/copy-trade/local-live-canary", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@/features/copy-trade/local-live-canary")
		>();
	return { ...actual, runLocalLiveCanary: mocks.runLocalLiveCanary };
});

vi.mock("@/bootstrap/http", () => ({
	wrapRouteHandlerWithLogging:
		(
			config: { auth: { getSessionUser: () => Promise<unknown> } },
			handler: (...args: never[]) => Promise<Response>,
		) =>
		async (request: Request) => {
			const session = await config.auth.getSessionUser();
			if (!session) {
				return NextResponse.json(
					{ error: "Session required" },
					{ status: 401 },
				);
			}
			return handler(
				{
					reqId: "req-local-canary",
					log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
					clock: { now: () => "2026-10-08T12:00:00.000Z" },
				} as never,
				request as never,
				session as never,
			);
		},
}));

import { POST } from "@/app/api/v1/poly/dev/live-algorithm-canary/route";

const validBody = {
	confirmation: "PLACE_REAL_ORDER_UP_TO_2_USDC",
	fixed_input: {
		condition_id: `0x${"ab".repeat(32)}`,
		token_id: "123456789",
		outcome: "YES",
		price: 0.2,
	},
};

function request(body: unknown = validBody): Request {
	return new Request(
		"http://localhost:3200/api/v1/poly/dev/live-algorithm-canary",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

describe("POST /api/v1/poly/dev/live-algorithm-canary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSessionUser.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
		});
		mocks.serverEnv.mockReturnValue({
			NODE_ENV: "development",
			APP_ENV: "production",
			APP_BUILD_SHA: "abcdef123456",
			PAPER_ENFORCE_MODE: undefined,
		});
		mocks.getEgressGeoblockLatch.mockReturnValue({
			latched: true,
			lastVerdict: "blocked",
			egressCountry: "US",
			egressRegion: "CA",
		});
	});

	it("requires a browser session before parsing or trade-path I/O", async () => {
		mocks.getSessionUser.mockResolvedValue(null);

		const response = await POST(request());

		expect(response.status).toBe(401);
		expect(mocks.serverEnv).not.toHaveBeenCalled();
		expect(mocks.getContainer).not.toHaveBeenCalled();
		expect(mocks.createExecutorResolver).not.toHaveBeenCalled();
		expect(mocks.runLocalLiveCanary).not.toHaveBeenCalled();
	});

	it("returns GEO_BLOCKED before account, DB, wallet, or CLOB access", async () => {
		const response = await POST(request());

		expect(response.status).toBe(451);
		expect(await response.json()).toMatchObject({
			schema_version: "poly.local-live-canary.error.v1",
			error: "egress_geoblocked",
			egress: { verdict: "blocked", country: "US", region: "CA" },
		});
		expect(mocks.getContainer).not.toHaveBeenCalled();
		expect(mocks.createExecutorResolver).not.toHaveBeenCalled();
		expect(mocks.runLocalLiveCanary).not.toHaveBeenCalled();
	});

	it("rejects an invalid confirmation before reading runtime state", async () => {
		const response = await POST(
			request({ ...validBody, confirmation: "place it" }),
		);

		expect(response.status).toBe(400);
		expect(mocks.serverEnv).not.toHaveBeenCalled();
		expect(mocks.getEgressGeoblockLatch).not.toHaveBeenCalled();
		expect(mocks.getContainer).not.toHaveBeenCalled();
	});
});
