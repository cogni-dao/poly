// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/poly.research-copy-trade-pnl.authorization`
 * Purpose: Pin the capability-gated HTTP behavior of the tenant P/L route.
 * Scope: Mocked route contract only; database/RLS behavior is covered by the component lane.
 * Invariants: Every authorization denial is the same non-disclosing 404; owner and delegate share one response contract.
 * Side-effects: none
 * Links: src/app/api/v1/poly/research/copy-trade-pnl/route.ts, task.1791070950
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  aggregate,
  logEvent,
  principal,
  resolvePerformanceRead,
  tenantTransaction,
} = vi.hoisted(() => ({
  aggregate: vi.fn(),
  logEvent: vi.fn(),
  principal: { id: "10000000-0000-4000-a000-000000000001" },
  resolvePerformanceRead: vi.fn(),
  tenantTransaction: { kind: "app-role-transaction" },
}));

vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({ kind: "app-role-db" }),
}));
vi.mock("@cogni/db-client", () => ({
  withTenantScope: vi.fn(
    async (
      _db: unknown,
      _actor: unknown,
      fn: (tx: typeof tenantTransaction) => Promise<unknown>
    ) => fn(tenantTransaction)
  ),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: never[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
          reqId: "request-1",
          routeId: "poly.research-copy-trade-pnl",
        } as never,
        request as never,
        { id: principal.id } as never
      ),
}));
vi.mock("@/features/agent-grants/authorization", () => ({
  resolvePerformanceRead: (...args: unknown[]) =>
    resolvePerformanceRead(...args),
}));
vi.mock(
  "@/features/wallet-analysis/server/copy-trade-pnl-service",
  () => ({
    getCopyTradePnlForTenant: (...args: unknown[]) => aggregate(...args),
  })
);
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_AGENT_GRANT_ACCESS_DECISION:
      "feature.poly_agent_grant.access_decision",
    POLY_RESEARCH_COPY_TRADE_PNL_COMPLETE:
      "feature.poly_research.copy_trade_pnl.complete",
  },
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

import { GET } from "@/app/api/v1/poly/research/copy-trade-pnl/route";

const ACCOUNT_A = "20000000-0000-4000-b000-000000000001";
const ACCOUNT_B = "20000000-0000-4000-b000-000000000002";
const GRANT_ID = "30000000-0000-4000-b000-000000000001";

const responseFor = (billingAccountId: string) => ({
  billing_account_id: billingAccountId,
  mode: "all" as const,
  since: null,
  until: null,
  captured_at: "2026-10-04T00:00:00.000Z",
  summary: {
    fills_count: 1,
    filled_count: 1,
    open_count: 0,
    pending_count: 0,
    canceled_count: 0,
    error_count: 0,
    markets_count: 1,
    markets_with_open_position: 1,
    total_intent_usdc: 7,
    total_realized_size_usdc: 7,
    first_fill_at: "2026-10-04T00:00:00.000Z",
    last_fill_at: "2026-10-04T00:00:00.000Z",
  },
  markets: [
    {
      market_id: "market-a",
      target_id: "40000000-0000-4000-b000-000000000001",
      target_wallet: `0x${"a".repeat(40)}`,
      fills_count: 1,
      filled_count: 1,
      open_count: 0,
      pending_count: 0,
      canceled_count: 0,
      error_count: 0,
      buy_count: 1,
      sell_count: 0,
      intent_usdc: 7,
      realized_size_usdc: 7,
      has_open_position: true,
      position_lifecycle: "open",
      first_fill_at: "2026-10-04T00:00:00.000Z",
      last_fill_at: "2026-10-04T00:00:00.000Z",
    },
  ],
});

const requestFor = (billingAccountId: string) =>
  new Request(
    `http://localhost/api/v1/poly/research/copy-trade-pnl?billing_account_id=${billingAccountId}&mode=all`
  );

describe("GET /api/v1/poly/research/copy-trade-pnl authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    principal.id = "10000000-0000-4000-a000-000000000001";
  });

  it("returns the identical non-disclosing response for every denied account", async () => {
    resolvePerformanceRead.mockResolvedValue(null);

    const unknownAccount = await GET(requestFor(ACCOUNT_A));
    const secondTenant = await GET(requestFor(ACCOUNT_B));

    expect(unknownAccount.status).toBe(404);
    expect(secondTenant.status).toBe(404);
    expect(await unknownAccount.json()).toEqual({ error: "not_found" });
    expect(await secondTenant.json()).toEqual({ error: "not_found" });
    expect(aggregate).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledTimes(4);

    const accessCalls = logEvent.mock.calls.filter(
      (call) => call[1] === "feature.poly_agent_grant.access_decision"
    );
    expect(accessCalls.map((call) => call[2])).toEqual([
      expect.objectContaining({
        outcome: "deny",
        requiredScope: "performance:read",
        billingAccountId: ACCOUNT_A,
      }),
      expect.objectContaining({
        outcome: "deny",
        requiredScope: "performance:read",
        billingAccountId: ACCOUNT_B,
      }),
    ]);

    const completionCalls = logEvent.mock.calls.filter(
      (call) => call[1] === "feature.poly_research.copy_trade_pnl.complete"
    );
    expect(completionCalls).toHaveLength(2);
    for (const call of completionCalls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          status: 404,
          outcome: "error",
          authorizationOutcome: "denied",
          errorCode: "not_found",
        })
      );
      expect(JSON.stringify(call[2])).not.toContain(ACCOUNT_A);
      expect(JSON.stringify(call[2])).not.toContain(ACCOUNT_B);
    }
  });

  it("returns the same account payload through owner and delegated access", async () => {
    const payload = responseFor(ACCOUNT_A);
    aggregate.mockResolvedValue(payload);

    resolvePerformanceRead.mockResolvedValueOnce({
      accessKind: "owner",
      grantId: null,
    });
    const ownerResponse = await GET(requestFor(ACCOUNT_A));

    principal.id = "10000000-0000-4000-a000-000000000002";
    resolvePerformanceRead.mockResolvedValueOnce({
      accessKind: "delegated",
      grantId: GRANT_ID,
    });
    const delegateResponse = await GET(requestFor(ACCOUNT_A));

    expect(ownerResponse.status).toBe(200);
    expect(delegateResponse.status).toBe(200);
    expect(await ownerResponse.json()).toEqual(payload);
    expect(await delegateResponse.json()).toEqual(payload);
    expect(aggregate).toHaveBeenCalledTimes(2);
    expect(aggregate).toHaveBeenNthCalledWith(
      1,
      tenantTransaction,
      ACCOUNT_A,
      "all",
      {}
    );
    expect(aggregate).toHaveBeenNthCalledWith(
      2,
      tenantTransaction,
      ACCOUNT_A,
      "all",
      {}
    );
  });
});
