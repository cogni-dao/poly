// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, investigate, logEvent, principal, tenantTransaction } =
  vi.hoisted(() => ({
    authorize: vi.fn(),
    investigate: vi.fn(),
    logEvent: vi.fn(),
    principal: { id: "10000000-0000-4000-a000-000000000001" },
    tenantTransaction: {
      kind: "app-role-transaction",
      execute: vi.fn(async () => []),
    },
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
        {
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          reqId: "request-1",
          routeId: "poly.research-copy-trade-investigation",
        } as never,
        request as never,
        { id: principal.id } as never
      ),
}));
vi.mock("@/features/agent-grants/authorization", () => ({
  authorize: (...args: unknown[]) => authorize(...args),
  resolvePrincipalAccountId: vi.fn(),
}));
vi.mock("@/features/wallet-analysis/server/copy-trade-investigation-service", () => ({
  getCopyTradeInvestigationSummary: (...args: unknown[]) => investigate(...args),
  getCopyTradeInvestigationEvidence: vi.fn(),
  InvalidInvestigationCursorError: class extends Error {},
  InvalidInvestigationCapturedAtError: class extends Error {},
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_AGENT_GRANT_ACCESS_DECISION: "feature.poly_agent_grant.access_decision",
    POLY_RESEARCH_COPY_TRADE_PNL_COMPLETE:
      "feature.poly_research.copy_trade_pnl.complete",
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

function completionFields(): Record<string, unknown>[] {
  return logEvent.mock.calls
    .filter(
      ([, eventName]) =>
        eventName === "feature.poly_research.copy_trade_investigation.complete"
    )
    .map(([, , fields]) => fields as Record<string, unknown>);
}

function expectSingleCompletion(expected: Record<string, unknown>): void {
  expect(completionFields()).toHaveLength(1);
  expect(completionFields()[0]).toEqual(expect.objectContaining(expected));
}

/**
 * The TERMINAL event is the non-disclosing one: it mirrors the response, which
 * must not distinguish "wrong tenant" from "no such account".
 *
 * The separate `access_decision` audit event deliberately DOES carry the
 * principal, account and grant id — story.5004 requires exact-SHA Loki proof
 * that a specific cross-tenant read was denied, which is unprovable without
 * naming the subject and object. Before this task the three research routes
 * disagreed on that point (the P/L route logged identifiers, the investigation
 * routes did not); the capability plane unifies them on the audited behavior.
 */
function expectNoExplicitIdentifiers(): void {
  const fields = completionFields();
  for (const eventFields of fields) {
    for (const key of [
      "billingAccountId",
      "conditionId",
      "principalId",
      "grantId",
      "fillId",
      "decisionId",
      "items",
    ]) {
      expect(eventFields).not.toHaveProperty(key);
    }
  }
  const serialized = JSON.stringify(fields);
  expect(serialized).not.toContain(ACCOUNT_A);
  expect(serialized).not.toContain(ACCOUNT_B);
  expect(serialized).not.toContain("condition-a");
  expect(serialized).not.toContain("30000000-0000-4000-b000-000000000001");
}

describe("copy-trade investigation authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    investigate.mockReset();
    authorize.mockReset();
    principal.id = "10000000-0000-4000-a000-000000000001";
    authorize.mockResolvedValue({
      accessKind: "delegated",
      grantId: "30000000-0000-4000-b000-000000000001",
    });
  });

  it("emits exactly one completion for invalid input", async () => {
    const result = await GET(request("not-an-account"));

    expect(result.status).toBe(400);
    expectSingleCompletion({
      status: 400,
      outcome: "error",
      authorizationOutcome: "not_evaluated",
      errorCode: "invalid_query",
      evidenceCount: 0,
    });
    expect(authorize).not.toHaveBeenCalled();
    expectNoExplicitIdentifiers();
  });

  it("returns the same non-disclosing 404 for every denied account", async () => {
    authorize.mockResolvedValue(null);
    const first = await GET(request(ACCOUNT_A));
    expectSingleCompletion({
      status: 404,
      outcome: "error",
      authorizationOutcome: "denied",
      errorCode: "not_found",
    });
    expectNoExplicitIdentifiers();
    logEvent.mockClear();
    const second = await GET(request(ACCOUNT_B));
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await first.json()).toEqual({ error: "not_found" });
    expect(await second.json()).toEqual({ error: "not_found" });
    expect(investigate).not.toHaveBeenCalled();
    expectSingleCompletion({
      reqId: "request-1",
      status: 404,
      outcome: "error",
      authorizationOutcome: "denied",
      errorCode: "not_found",
    });
    expectNoExplicitIdentifiers();
  });

  it("emits exactly one completion when allowed data is absent", async () => {
    investigate.mockResolvedValue(null);

    const result = await GET(request(ACCOUNT_A));

    expect(result.status).toBe(404);
    expectSingleCompletion({
      status: 404,
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      errorCode: "not_found",
    });
    expectNoExplicitIdentifiers();
  });

  it("emits exactly one completion for service failure", async () => {
    investigate.mockRejectedValue(new Error("database unavailable"));

    const result = await GET(request(ACCOUNT_A));

    expect(result.status).toBe(500);
    expectSingleCompletion({
      status: 500,
      // The executor records the decision it already made before the handler
      // threw, which is strictly more informative than the old route's
      // blanket "not_evaluated".
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      errorCode: "service_failed",
    });
    expectNoExplicitIdentifiers();
  });

  it("emits exactly one completion for response validation failure", async () => {
    investigate.mockResolvedValue({ invalid: true });

    const result = await GET(request(ACCOUNT_A));

    expect(result.status).toBe(500);
    expectSingleCompletion({
      status: 500,
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      errorCode: "response_validation_failed",
    });
    expectNoExplicitIdentifiers();
  });

  it("returns the identical payload for owner and delegate access", async () => {
    investigate.mockResolvedValue(payload);
    authorize.mockResolvedValueOnce({ accessKind: "owner", grantId: null });
    const owner = await GET(request(ACCOUNT_A));
    expectSingleCompletion({
      status: 200,
      authorizationOutcome: "allowed",
      accessKind: "owner",
    });
    expectNoExplicitIdentifiers();
    logEvent.mockClear();
    principal.id = "10000000-0000-4000-a000-000000000002";
    authorize.mockResolvedValueOnce({
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
    expectSingleCompletion({
      reqId: "request-1",
      status: 200,
      outcome: "success",
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      evidenceCount: 2,
      complete: false,
    });
    expectNoExplicitIdentifiers();
  });
});
