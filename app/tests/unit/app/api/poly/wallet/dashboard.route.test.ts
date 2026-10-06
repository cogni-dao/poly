// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/wallet/dashboard.route`
 * Purpose: The dashboard route is now a THIN TRANSPORT for
 *   `poly.account.portfolio-snapshot.v1`. These tests assert exactly that: it
 *   forwards the session principal and the app-role handle to the capability
 *   plane, renders each outcome, and preserves the snapshot header — and it
 *   holds no query, no tenant resolution and no authorization of its own.
 * Scope: Transport rendering + wiring. The authorization behaviour it depends
 *   on is proved against the real executor in
 *   `tests/unit/features/capability-plane/portfolio-snapshot.security.test.ts`.
 * Links: story.5004, task.1791070962
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, ownerHandler, extra, log, appDb, configured } = vi.hoisted(
  () => ({
    execute: vi.fn(),
    ownerHandler: vi.fn(() => "owner-handler"),
    extra: vi.fn(() => ({ degraded: true, warningCodes: ["x"] })),
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    appDb: { role: "app" },
    configured: { value: true },
  })
);

vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ resolveAppDb: () => appDb }));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: never[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        { log, reqId: "request-123", routeId: "poly.wallet.dashboard" } as never,
        request as never,
        { id: "11111111-1111-4111-8111-111111111111" } as never
      ),
}));
vi.mock("@/bootstrap/poly-trader-wallet", () => ({
  isPolyTraderWalletConfigured: () => configured.value,
}));
vi.mock("@/features/capability-plane", () => ({
  ACCOUNT_READ_HTTP_STATUS: {
    ok: 200,
    denied: 404,
    not_found: 404,
    invalid_input: 400,
    invalid_output: 500,
    failed: 500,
  },
  ACCOUNT_READ_TERMINAL_EVENTS: {
    "poly.account.portfolio-snapshot.v1": "feature.poly_wallet_dashboard.complete",
  },
  executeAccountRead: (...args: unknown[]) => execute(...args),
  portfolioSnapshotExtra: (...args: unknown[]) => extra(...args),
  portfolioSnapshotOwnerAccountReadHandler: (...args: unknown[]) =>
    ownerHandler(...args),
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "sha-123" }),
}));

import { GET } from "@/app/api/v1/poly/wallet/dashboard/route";

const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";

function request(interval = "1W") {
  return new Request(
    `http://localhost/api/v1/poly/wallet/dashboard?interval=${interval}`
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  configured.value = true;
});

describe("GET /api/v1/poly/wallet/dashboard — transport wiring", () => {
  it("calls the capability plane with the owner descriptor and the APP-ROLE handle", async () => {
    execute.mockResolvedValue({
      status: "ok",
      data: { snapshotId: SNAPSHOT_ID },
      access: { accessKind: "owner", grantId: null },
    });

    await GET(request());

    const args = execute.mock.calls[0]?.[0];
    // NO_PRIVILEGED_TRANSPORT: the handle is the app-role one, so RLS stays
    // the backstop. The old route passed `resolveServiceReadDb()` (BYPASSRLS).
    expect(args.db).toBe(appDb);
    expect(args.principalId).toBe("11111111-1111-4111-8111-111111111111");
    // The account comes from the principal; the route never resolves a tenant.
    expect(args.operation.accountFrom).toBe("principal");
    expect(args.operation.id).toBe("poly.account.portfolio-snapshot.v1");
    expect(args.operation.readOnly).toBe(true);
    expect(args.operation.requiredScope).toBe("account:read");
    expect(args.eventName).toBe("feature.poly_wallet_dashboard.complete");
  });

  it("lifts the query string and lets the descriptor validate it", async () => {
    execute.mockResolvedValue({
      status: "ok",
      data: { snapshotId: SNAPSHOT_ID },
      access: { accessKind: "owner", grantId: null },
    });

    await GET(request("1M"));

    // Raw, unvalidated input — the plane parses it against `operation.input`,
    // so the transport owns no validation of its own.
    expect(execute.mock.calls[0]?.[0].rawInput).toEqual({ interval: "1M" });
  });

  it("injects typed adapter readiness without invoking vendor IO", async () => {
    configured.value = false;
    execute.mockResolvedValue({
      status: "ok",
      data: { snapshotId: SNAPSHOT_ID },
      access: { accessKind: "owner", grantId: null },
    });

    await GET(request());

    expect(ownerHandler).toHaveBeenCalledWith({ adapterConfigured: false });
  });

  it("passes the build sha into the terminal-event extras", async () => {
    execute.mockResolvedValue({
      status: "ok",
      data: { snapshotId: SNAPSHOT_ID },
      access: { accessKind: "owner", grantId: null },
    });

    await GET(request());
    const context = { status: "ok" as const, input: null, data: null };
    execute.mock.calls[0]?.[0].extra(context);

    expect(extra).toHaveBeenCalledWith(context, "sha-123");
  });
});

describe("GET /api/v1/poly/wallet/dashboard — outcome rendering", () => {
  it("returns the snapshot with the snapshot-id and no-store headers", async () => {
    execute.mockResolvedValue({
      status: "ok",
      data: { snapshotId: SNAPSHOT_ID, overview: { usdc_total: null } },
      access: { accessKind: "owner", grantId: null },
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Wallet-Snapshot-Id")).toBe(SNAPSHOT_ID);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Request-Id")).toBe("request-123");
    expect(await response.json()).toEqual({
      snapshotId: SNAPSHOT_ID,
      overview: { usdc_total: null },
    });
  });

  it("renders a denial as a non-disclosing 404", async () => {
    execute.mockResolvedValue({ status: "denied" });

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("renders a missing snapshot identically to a denial", async () => {
    execute.mockResolvedValue({
      status: "not_found",
      access: { accessKind: "owner", grantId: null },
    });
    const notFound = await GET(request());

    execute.mockResolvedValue({ status: "denied" });
    const denied = await GET(request());

    // FAIL_CLOSED_NON_DISCLOSING: an unauthorized principal cannot tell
    // "exists but forbidden" from "absent".
    expect(notFound.status).toBe(denied.status);
    expect(await notFound.json()).toEqual(await denied.json());
  });

  it("renders invalid input as a 400 carrying the parse message", async () => {
    execute.mockResolvedValue({
      status: "invalid_input",
      message: "interval: invalid enum value",
    });

    const response = await GET(request("wrong"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_query",
      message: "interval: invalid enum value",
    });
  });

  it("renders a failure as a 500 that leaks nothing", async () => {
    execute.mockResolvedValue({ status: "failed" });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("renders a response-validation failure as a 500, not a partial body", async () => {
    execute.mockResolvedValue({ status: "invalid_output" });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("emits no terminal event of its own", async () => {
    execute.mockResolvedValue({ status: "denied" });

    await GET(request());

    // EXACTLY_ONE_TERMINAL_EVENT lives in the executor. The transport used to
    // hand-roll a ~70-field emit on five separate paths.
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
