// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/auth/proxy-routing`
 * Purpose: Unit tests for proxy.ts auth routing — the single authority for redirect logic.
 * Scope: Tests page-level routing (authed on / → /chat, unauthed on app routes → /) and API protection. Does not test NextAuth internals.
 * Invariants: Single authority for auth routing; no client-side redirect logic.
 * Side-effects: none (mocked getToken)
 * Links: src/proxy.ts, docs/spec/security-auth.md
 * @public
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetToken = vi.fn();

vi.mock("next-auth/jwt", () => ({
	getToken: (...args: unknown[]) => mockGetToken(...args),
}));

vi.mock("@/auth", () => ({
	authSecret: "test-secret",
	authOptions: { secret: "test-secret" },
}));

// Perimeter observability — keep this a true unit (no pino/prom-client) and
// capture the denial event the proxy emits before any route handler runs.
const mockLoggerInfo = vi.fn();
vi.mock("@/shared/observability", () => ({
	EVENT_NAMES: { AUTH_PERIMETER_DENIED: "auth.perimeter.denied" },
	makeLogger: () => ({ info: mockLoggerInfo }),
}));
vi.mock("@/shared/config", () => ({
	getNodeId: () => "test-node",
}));

// Import after mocks
import {
	formatRevocableKey,
	REVOCABLE_KEY_PREFIX,
} from "@cogni/agent-grants/credentials";
import { proxy } from "@/proxy";

// --- Helpers ---

function makeRequest(path: string): NextRequest {
	return new NextRequest(new URL(path, "http://localhost:3000"));
}

function makeAgentRequest(
	path: string,
	authorization = "Bearer cogni_ag_sk_v1_test.payload.signature",
): NextRequest {
	return new NextRequest(new URL(path, "http://localhost:3000"), {
		headers: { authorization },
	});
}

function expectRedirectTo(res: Response, pathname: string): void {
	expect(res.status).toBe(307);
	const location = res.headers.get("location") ?? "";
	expect(new URL(location).pathname).toBe(pathname);
}

// --- Tests ---

describe("proxy — page-level routing", () => {
	beforeEach(() => {
		mockGetToken.mockReset();
	});

	it("redirects authenticated user on / to /chat", async () => {
		mockGetToken.mockResolvedValue({ id: "user-1" });

		const res = await proxy(makeRequest("/"));

		expectRedirectTo(res, "/chat");
	});

	it("passes through unauthenticated user on /", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/"));

		expect(res.status).toBe(200);
	});

	it("redirects unauthenticated user on /chat to /", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/chat"));

		expectRedirectTo(res, "/");
	});

	it("redirects unauthenticated user on /profile to /", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/profile"));

		expectRedirectTo(res, "/");
	});

	it("redirects unauthenticated user on /dashboard to /", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/dashboard"));

		expectRedirectTo(res, "/");
	});

	it("redirects unauthenticated user on /knowledge inbox permalink to /", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(
			makeRequest("/knowledge/inbox/contrib-example-123"),
		);

		expectRedirectTo(res, "/");
	});

	it("redirects unauthenticated user on /chat/some-id to /", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/chat/some-id"));

		expectRedirectTo(res, "/");
	});

	it("passes through authenticated user on /chat", async () => {
		mockGetToken.mockResolvedValue({ id: "user-1" });

		const res = await proxy(makeRequest("/chat"));

		expect(res.status).toBe(200);
	});

	it("passes through authenticated user on /profile", async () => {
		mockGetToken.mockResolvedValue({ id: "user-1" });

		const res = await proxy(makeRequest("/profile"));

		expect(res.status).toBe(200);
	});
});

describe("proxy — API route protection", () => {
	beforeEach(() => {
		mockGetToken.mockReset();
		mockLoggerInfo.mockReset();
	});

	it("allows /api/v1/public/* without auth", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/api/v1/public/health"));

		expect(res.status).toBe(200);
		// getToken should not even be called for public routes
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows /api/v1/agent/register without auth", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/api/v1/agent/register"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows the attestation start leg without auth — it IS the sign-in bootstrap", async () => {
		// task.5042. Someone signing in with GitHub has no session yet, so gating this
		// leg on one deadlocks: it is the request that gets them a session. Caught by
		// live validation — the route was made session-optional but the proxy still
		// 401'd it at the perimeter.
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(
			makeRequest("/api/v1/identity/bindings/import/start"),
		);

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("still rejects the sibling import leg unauthenticated", async () => {
		// Only the START leg is public. Redeeming a token must keep its session gate.
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/api/v1/identity/bindings/import"));

		expect(res.status).toBe(401);
	});

	it("rejects unauthenticated on /api/v1/cognition", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/api/v1/cognition"));

		expect(res.status).toBe(401);
	});

	it("allows agent bearer on /api/v1/cognition", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/cognition"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows a well-formed revocable bearer through the perimeter, and rejects an unknown bearer prefix (task.0070)", async () => {
		mockGetToken.mockResolvedValue(null);

		const revocable = await proxy(
			makeAgentRequest(
				"/api/v1/agent/credentials/rotate",
				`Bearer ${formatRevocableKey("a".repeat(43))}`,
			),
		);
		expect(revocable.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();

		const v3 = await proxy(
			makeAgentRequest("/api/v1/agent/credentials/rotate", "Bearer cogni_ag_sk_v3_abc"),
		);
		expect(v3.status).toBe(401);
	});

	it("rejects a revocable bearer with a bad shape or checksum at the perimeter, before any route handler (CHECKSUM_BEFORE_DB)", async () => {
		mockGetToken.mockResolvedValue(null);
		mockLoggerInfo.mockClear();
		const good = formatRevocableKey("a".repeat(43));
		const badChecksum = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
		for (const token of [
			`${REVOCABLE_KEY_PREFIX}abc`,
			badChecksum,
			`${good}x`,
		]) {
			const res = await proxy(
				makeAgentRequest("/api/v1/knowledge", `Bearer ${token}`),
			);
			expect(res.status).toBe(401);
		}
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({
				routeId: "auth.perimeter",
				reason: "bad_key_format",
				status: 401,
			}),
			expect.anything(),
		);
		// The denial event never carries the token.
		expect(JSON.stringify(mockLoggerInfo.mock.calls)).not.toContain(good.slice(-10));
	});

	it("rejects unauthenticated on /api/v1/*", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/api/v1/users/me"));

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe("Unauthorized");
	});

	it("logs a perimeter denial event when rejecting an unauthenticated /api/v1 request", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeRequest("/api/v1/users/me"));

		expect(res.status).toBe(401);
		expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
		const [fields, msg] = mockLoggerInfo.mock.calls[0];
		expect(msg).toBe("auth.perimeter.denied");
		expect(fields).toMatchObject({
			event: "auth.perimeter.denied",
			routeId: "auth.perimeter",
			route: "/api/v1/users/me",
			method: "GET",
			reason: "no_session",
			status: 401,
		});
		expect(typeof fields.reqId).toBe("string");
	});

	it("does NOT log a perimeter denial when an agent bearer is allowed through", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/cognition"));

		expect(res.status).toBe(200);
		expect(mockLoggerInfo).not.toHaveBeenCalled();
	});

	it("allows authenticated on /api/v1/*", async () => {
		mockGetToken.mockResolvedValue({ id: "user-1" });

		const res = await proxy(makeRequest("/api/v1/users/me"));

		expect(res.status).toBe(200);
	});

	it("allows agent bearer on /api/v1/chat/completions", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/chat/completions"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows agent bearer on /api/v1/agent/runs", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/agent/runs"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows agent bearer on /api/v1/ai/chat (agent-first)", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/ai/chat"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows agent bearer on /api/v1/ai/models (agent-first)", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/ai/models"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("allows agent bearer on /api/v1/schedules/* (agent-first)", async () => {
		mockGetToken.mockResolvedValue(null);

		const res = await proxy(makeAgentRequest("/api/v1/schedules/my-schedule"));

		expect(res.status).toBe(200);
		expect(mockGetToken).not.toHaveBeenCalled();
	});
});

describe("proxy — Admin area refuses any Authorization header (ADMIN_ACTS_IN_ADMIN)", () => {
	beforeEach(() => {
		mockGetToken.mockReset();
	});

	it.each([
		"/api/v1/admin/ai-access",
		"/admin/ai-access",
		"/admin",
	])("403 human_session_required on %s, even with a valid session, before getToken", async (path) => {
		mockGetToken.mockResolvedValue({ sub: "admin-1" });

		const res = await proxy(makeAgentRequest(path));

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "human_session_required" });
		expect(mockGetToken).not.toHaveBeenCalled();
	});

	it("still lets a session-only request through to /api/v1/admin/*", async () => {
		mockGetToken.mockResolvedValue({ sub: "admin-1" });

		const res = await proxy(makeRequest("/api/v1/admin/ai-access"));

		expect(res.status).toBe(200);
	});
});

describe("proxy — unmatched routes", () => {
	beforeEach(() => {
		mockGetToken.mockReset();
	});

	it("passes through unmatched routes without checking auth", async () => {
		// Routes not in APP_ROUTES and not /api/v1/* should pass through
		const res = await proxy(makeRequest("/api/auth/callback/github"));

		expect(res.status).toBe(200);
		// getToken should not be called for non-auth routes
		expect(mockGetToken).not.toHaveBeenCalled();
	});
});
