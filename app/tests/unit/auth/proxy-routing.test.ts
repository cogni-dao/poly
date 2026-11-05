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
vi.mock("@/shared/observability", async () => ({
  createRequestContext: (await import("../../../../packages/node-shared/src/observability/context/factory")).createRequestContext,
	EVENT_NAMES: { AUTH_PERIMETER_DENIED: "auth.perimeter.denied" },
	makeLogger: () => {
    const logger = { info: mockLoggerInfo, warn: vi.fn(), child: () => logger };
    return logger;
  },
  logRequestStart: vi.fn(), logRequestEnd: vi.fn(),
  httpRequestsTotal: { inc: vi.fn() }, httpRequestDurationMs: { observe: vi.fn() },
  statusBucket: (status: number) => `${Math.floor(status / 100)}xx`,
}));
vi.mock("@/shared/config", () => ({
	getNodeId: () => "test-node",
}));

// Import after mocks
import { proxy } from "@/proxy";

// --- Helpers ---

function makeRequest(path: string): NextRequest {
	return new NextRequest(new URL(path, "http://localhost:3000"));
}

function makeAgentRequest(path: string): NextRequest {
	return new NextRequest(new URL(path, "http://localhost:3000"), {
		headers: {
			authorization: "Bearer cogni_ag_sk_v1_test.payload.signature",
		},
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

describe("proxy — release qualification service authentication", () => {
  it("passes the exact proof capability to its own JWT verifier without a browser session", async () => {
    mockGetToken.mockReset();
    const result = await proxy(new NextRequest(new URL("/api/v1/deploy/qualification", "http://localhost:3000"), {
      method: "POST", headers: { authorization: "Bearer service-jwt" },
    }));
    expect(result.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });
  it("does not extend this exception to sibling or nested routes", async () => {
    mockGetToken.mockResolvedValue(null);
    for (const path of ["/api/v1/deploy/qualification/other", "/api/v1/deploy/other"]) {
      expect((await proxy(makeRequest(path))).status).toBe(401);
    }
  });
});

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("@/shared/env/server", () => ({ serverEnv: () => ({ AUTH_SECRET: "purpose-separated-secret-at-least-32-characters" }) }));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: async () => null }));
describe("paper provision consent actor provenance", () => {
  it("takes agent kind only from a verified token for the same authenticated principal", async () => {
    const { resolveRequestActorKind, issueAgentApiKey } = await import("@/app/_lib/auth/request-identity");
    requestHeaders = new Headers({ authorization: `Bearer ${issueAgentApiKey({ userId: "fixture-owner", displayName: "fixture" })}` });
    await expect(resolveRequestActorKind("fixture-owner")).resolves.toBe("agent");
    await expect(resolveRequestActorKind("different-user")).rejects.toThrow("invalid_principal_provenance");
    requestHeaders = new Headers({ authorization: "Bearer invalid" });
    await expect(resolveRequestActorKind("fixture-owner")).rejects.toThrow("invalid_principal_provenance");
    requestHeaders = new Headers();
    await expect(resolveRequestActorKind("browser-owner")).resolves.toBe("user");
  });
});


const qualificationAuth = vi.hoisted(() => vi.fn());
const qualificationRun = vi.hoisted(() => vi.fn());
vi.mock("@/app/_facades/deploy-qualification.server", () => ({
  authenticateQualification: qualificationAuth,
  qualifyDeployment: qualificationRun,
}));


describe("qualification route body admission", () => {
  beforeEach(() => {
    qualificationAuth.mockReset();
    qualificationRun.mockReset();
    qualificationAuth.mockResolvedValue({ mode: "qualify" });
    qualificationRun.mockRejectedValue(new Error("feature boundary reached"));
  });
  async function post(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/v1/deploy/qualification/route");
    const request = new Request("http://localhost/api/v1/deploy/qualification", {
      method: "POST", body, duplex: "half",
      headers: { authorization: "Bearer purpose-token", "content-type": "application/json", ...headers },
    } as RequestInit);
    return POST(request as NextRequest);
  }
  it.each(["oversized", "slow", "malformed"])("rejects %s input before reading when capability authentication fails", async (kind) => {
    const { QualificationError } = await import("@/features/deploy-qualification/challenge");
    qualificationAuth.mockRejectedValue(new QualificationError("qualification_auth_invalid", 401));
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const body = kind === "malformed" ? "{" : stream;
    const response = await post(body, kind === "oversized" ? { "content-length": "1000000000" } : {});
    expect(response.status).toBe(401);
    expect(pull).not.toHaveBeenCalled();
    if (kind !== "malformed") expect(cancel).toHaveBeenCalledTimes(1);
    expect(qualificationRun).not.toHaveBeenCalled();
  });
  it.each(["{", '{"mode":"qualify","accountId":"foreign"}', '{"mode":"qualify","companionReadiness":{"paper-trader":{"port":9100,"path":"/healthz"}}}', '{"mode":"qualify","companionBootIds":{"paper-trader":"boot-a"}}', '{"mode":"other"}', 'null'])("rejects malformed or non-strict authenticated JSON: %s", async body => {
    expect((await post(body)).status).toBe(400);
    expect(qualificationRun).not.toHaveBeenCalled();
  });
  it("bounds both declared bytes and streamed bytes without a content length", async () => {
    expect((await post('{"mode":"qualify"}', { "content-length": "257" })).status).toBe(413);
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(257)); }, cancel() { canceled = true; } });
    expect((await post(stream)).status).toBe(413);
    expect(canceled).toBe(true);
    expect(qualificationRun).not.toHaveBeenCalled();
  });
  it("cancels a slow authenticated stream within the body budget", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
    const start = Date.now();
    expect((await post(stream)).status).toBe(408);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(canceled).toBe(true);
    expect(qualificationRun).not.toHaveBeenCalled();
  });
  it("binds the strict body to the signed mode before starting fixture work", async () => {
    expect((await post('{"mode":"readback"}')).status).toBe(401);
    expect(qualificationAuth).toHaveBeenCalledExactlyOnceWith("Bearer purpose-token");
    expect(qualificationRun).not.toHaveBeenCalled();
  });
  it("cancels feature work on the whole request deadline", async () => {
    await import("@/app/api/v1/deploy/qualification/route");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let canceled = false;
    qualificationRun.mockImplementation((_challenge, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { canceled = true; reject(signal.reason); }, { once: true });
      entered();
    }));
    try {
      const response = post('{"mode":"qualify"}');
      await started;
      await vi.advanceTimersByTimeAsync(19000);
      const result = await response;
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: "qualification_timeout" });
      expect(canceled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("passes the authenticated challenge and common remaining deadline to the feature", async () => {
    await post('{"mode":"qualify"}');
    expect(qualificationRun).toHaveBeenCalledExactlyOnceWith({ mode: "qualify" }, expect.any(AbortSignal), expect.any(Number));
    const deadline = qualificationRun.mock.calls[0]?.[2] as number;
    expect(deadline).toBeLessThanOrEqual(Date.now() + 19000);
  });
});
