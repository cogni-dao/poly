// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  investigate,
  logEvent,
  principal,
  resolvePerformanceRead,
  tenantTransaction,
} = vi.hoisted(() => ({
    investigate: vi.fn(),
    logEvent: vi.fn(),
    principal: { id: "10000000-0000-4000-a000-000000000001" },
    resolvePerformanceRead: vi.fn(),
    tenantTransaction: { kind: "app-role-transaction", execute: vi.fn() },
}));

vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ resolveAppDb: () => ({ kind: "app-role-db" }) }));
vi.mock("@cogni/db-client", () => ({
  withTenantScope: vi.fn(
    async (_db: unknown, _actor: unknown, fn: (tx: typeof tenantTransaction) => Promise<unknown>) =>
      fn(tenantTransaction)
  ),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: never[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        { log: {}, reqId: "request-1", routeId: "poly.research-copy-trade-investigation" } as never,
        request as never,
        { id: principal.id } as never
      ),
}));
vi.mock("@/features/agent-grants/authorization", () => ({
  resolvePerformanceRead: (...args: unknown[]) => resolvePerformanceRead(...args),
}));
vi.mock("@/features/wallet-analysis/server/copy-trade-investigation-service", () => ({
  getCopyTradeInvestigationSummary: (...args: unknown[]) => investigate(...args),
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_AGENT_GRANT_ACCESS_DECISION: "feature.poly_agent_grant.access_decision",
    POLY_RESEARCH_COPY_TRADE_INVESTIGATION_COMPLETE:
      "feature.poly_research.copy_trade_investigation.complete",
  },
  logEvent,
}));

import { GET } from "@/app/api/v1/poly/research/copy-trade-investigation/route";

const ACCOUNT_A = "20000000-0000-4000-b000-000000000001";
const ACCOUNT_B = "20000000-0000-4000-b000-000000000002";

const payload = {
  billing_account_id: ACCOUNT_A,
  condition_id: "condition-a",
  mode: "paper" as const,
  since: null,
  until: null,
  captured_at: "2026-10-04T00:00:00.000Z",
  association_sources: ["fill" as const],
  market: {
    condition_id: "condition-a",
    event_title: null,
    event_slug: null,
    market_title: "A market",
    market_slug: "a-market",
    end_date: null,
    metadata_fetched_at: "2026-10-04T00:00:00.000Z",
    outcomes: [],
  },
  account_position: {
    source: "mirror_execution_ledger" as const,
    legs: [],
    truncated: false,
  },
  targets: [],
  aggregates: {
    fills: {
      count: 1,
      placed_count: 1,
      pending_count: 0,
      open_count: 0,
      filled_count: 1,
      partial_count: 0,
      canceled_count: 0,
      error_count: 0,
      first_observed_at: "2026-10-04T00:00:00.000Z",
      last_observed_at: "2026-10-04T00:00:00.000Z",
    },
    decisions: {
      count: 1,
      placed_count: 1,
      skipped_count: 0,
      error_count: 0,
      first_decided_at: "2026-10-04T00:00:00.000Z",
      last_decided_at: "2026-10-04T00:00:00.000Z",
      top_reasons: [{ reason: "placed", count: 1 }],
    },
  },
  completeness: {
    complete: false,
    account_position_truncated: false,
    targets_truncated: false,
    facts: [
      { source: "market_prices" as const, status: "missing" as const, observed_at: null, complete: false },
    ],
  },
};

const request = (account: string) =>
  new Request(
    `http://localhost/api/v1/poly/research/copy-trade-investigation?billing_account_id=${account}&condition_id=condition-a&mode=paper`
  );

describe("copy-trade investigation authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    principal.id = "10000000-0000-4000-a000-000000000001";
  });

  it("returns the same non-disclosing 404 for every denied account", async () => {
    resolvePerformanceRead.mockResolvedValue(null);
    const first = await GET(request(ACCOUNT_A));
    const second = await GET(request(ACCOUNT_B));
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await first.json()).toEqual({ error: "not_found" });
    expect(await second.json()).toEqual({ error: "not_found" });
    expect(investigate).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      {},
      "feature.poly_research.copy_trade_investigation.complete",
      expect.objectContaining({
        reqId: "request-1",
        status: 404,
        outcome: "error",
        authorizationOutcome: "denied",
        errorCode: "not_found",
      })
    );
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("billingAccountId");
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("conditionId");
  });

  it("returns the identical payload for owner and delegate access", async () => {
    investigate.mockResolvedValue(payload);
    resolvePerformanceRead.mockResolvedValueOnce({ accessKind: "owner", grantId: null });
    const owner = await GET(request(ACCOUNT_A));
    principal.id = "10000000-0000-4000-a000-000000000002";
    resolvePerformanceRead.mockResolvedValueOnce({
      accessKind: "delegated",
      grantId: "30000000-0000-4000-b000-000000000001",
    });
    const delegate = await GET(request(ACCOUNT_A));
    expect(owner.status).toBe(200);
    expect(delegate.status).toBe(200);
    expect(await owner.json()).toEqual(payload);
    expect(await delegate.json()).toEqual(payload);
    expect(investigate).toHaveBeenNthCalledWith(1, tenantTransaction, {
      billing_account_id: ACCOUNT_A,
      condition_id: "condition-a",
      mode: "paper",
    });
    expect(logEvent).toHaveBeenCalledWith(
      {},
      "feature.poly_research.copy_trade_investigation.complete",
      expect.objectContaining({
        reqId: "request-1",
        status: 200,
        outcome: "success",
        authorizationOutcome: "allowed",
        evidenceCount: 2,
        complete: false,
      })
    );
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(ACCOUNT_A);
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("condition-a");
  });
});
