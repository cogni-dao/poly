// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorize,
  getEvidence,
  InvalidInvestigationCapturedAtError,
  InvalidInvestigationCursorError,
  logEvent,
  tenantTransaction,
} = vi.hoisted(() => ({
  authorize: vi.fn(),
  getEvidence: vi.fn(),
  InvalidInvestigationCapturedAtError: class extends Error {},
  InvalidInvestigationCursorError: class extends Error {},
  logEvent: vi.fn(),
  tenantTransaction: {
    kind: "app-role-transaction",
    execute: vi.fn(async () => []),
  },
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
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          reqId: "investigation-request-1",
          routeId: "poly.research-copy-trade-investigation-evidence",
        } as never,
        request as never,
        { id: "10000000-0000-4000-a000-000000000001" } as never
      ),
}));
vi.mock("@/features/agent-grants/authorization", () => ({
  authorize: (...args: unknown[]) => authorize(...args),
  resolvePrincipalAccountId: vi.fn(),
}));
vi.mock("@/features/wallet-analysis/server/copy-trade-investigation-service", () => ({
  getCopyTradeInvestigationEvidence: (...args: unknown[]) => getEvidence(...args),
  getCopyTradeInvestigationSummary: vi.fn(),
  InvalidInvestigationCapturedAtError,
  InvalidInvestigationCursorError,
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

import { GET } from "@/app/api/v1/poly/research/copy-trade-investigation/evidence/route";

const ACCOUNT = "20000000-0000-4000-b000-000000000001";
const CONDITION = "prediction-market:polymarket:0xcondition";
const CAPTURED_AT = "2026-10-04T00:00:00.000Z";

function request(kind: "fills" | "decisions", extra = ""): Request {
  return new Request(
    "http://localhost/api/v1/poly/research/copy-trade-investigation/evidence" +
      `?billing_account_id=${ACCOUNT}&condition_id=${CONDITION}` +
      `&mode=paper&kind=${kind}&captured_at=${CAPTURED_AT}${extra}`
  );
}

function response(kind: "fills" | "decisions") {
  return {
    billing_account_id: ACCOUNT,
    condition_id: CONDITION,
    mode: "paper" as const,
    kind,
    since: null,
    until: null,
    captured_at: CAPTURED_AT,
    limit: 100,
    items: [],
    next_cursor: null,
    truncated: false,
  };
}

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
 * The TERMINAL event mirrors the response, so it must stay non-disclosing. The
 * separate `access_decision` audit event intentionally names the principal,
 * account and grant — story.5004 needs exact-SHA Loki proof that one specific
 * cross-tenant read was denied, which cannot be shown without them.
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
  expect(serialized).not.toContain(ACCOUNT);
  expect(serialized).not.toContain(CONDITION);
  expect(serialized).not.toContain("30000000-0000-4000-b000-000000000001");
}

describe("copy-trade investigation evidence observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEvidence.mockReset();
    authorize.mockReset();
    authorize.mockResolvedValue({
      accessKind: "delegated",
      grantId: "30000000-0000-4000-b000-000000000001",
    });
  });

  it("emits a correlated error event for invalid page bounds", async () => {
    const result = await GET(request("fills", "&limit=201"));

    expect(result.status).toBe(400);
    expectSingleCompletion({
      reqId: "investigation-request-1",
      status: 400,
      outcome: "error",
      authorizationOutcome: "not_evaluated",
      errorCode: "invalid_query",
      evidenceCount: 0,
    });
    expect(authorize).not.toHaveBeenCalled();
    expectNoExplicitIdentifiers();
  });

  it("emits a correlated non-disclosing denial event", async () => {
    authorize.mockResolvedValue(null);

    const result = await GET(request("fills"));

    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ error: "not_found" });
    expectSingleCompletion({
      reqId: "investigation-request-1",
      status: 404,
      authorizationOutcome: "denied",
      evidenceKind: "fills",
      errorCode: "not_found",
    });
    expectNoExplicitIdentifiers();
  });

  it.each(["fills", "decisions"] as const)(
    "emits the evidence kind for a successful %s page",
    async (kind) => {
      getEvidence.mockResolvedValue(response(kind));

      const result = await GET(request(kind));

      expect(result.status).toBe(200);
      expectSingleCompletion({
        reqId: "investigation-request-1",
        status: 200,
        outcome: "success",
        authorizationOutcome: "allowed",
        accessKind: "delegated",
        evidenceKind: kind,
        evidenceCount: 0,
        truncated: false,
      });
      expectNoExplicitIdentifiers();
    }
  );

  it("emits a correlated service failure without tenant identifiers", async () => {
    getEvidence.mockRejectedValue(new Error("database unavailable"));

    const result = await GET(request("decisions"));

    expect(result.status).toBe(500);
    expectSingleCompletion({
      reqId: "investigation-request-1",
      status: 500,
      outcome: "error",
      // The executor reports the decision it already made before the handler
      // threw; the old route blanket-logged "not_evaluated".
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      evidenceKind: "decisions",
      errorCode: "service_failed",
    });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("database unavailable");
    expectNoExplicitIdentifiers();
  });

  it("emits a correlated invalid-cursor event", async () => {
    getEvidence.mockRejectedValue(new InvalidInvestigationCursorError());

    const result = await GET(request("fills", "&cursor=opaque"));

    expect(result.status).toBe(400);
    expectSingleCompletion({
      reqId: "investigation-request-1",
      status: 400,
      authorizationOutcome: "allowed",
      evidenceKind: "fills",
      errorCode: "invalid_query",
    });
    expectNoExplicitIdentifiers();
  });

  it("emits exactly one completion for an invalid captured-at snapshot", async () => {
    getEvidence.mockRejectedValue(new InvalidInvestigationCapturedAtError());

    const result = await GET(request("decisions"));

    expect(result.status).toBe(400);
    expectSingleCompletion({
      status: 400,
      authorizationOutcome: "allowed",
      evidenceKind: "decisions",
      errorCode: "invalid_query",
    });
    expectNoExplicitIdentifiers();
  });

  it("emits exactly one completion when allowed evidence is absent", async () => {
    getEvidence.mockResolvedValue(null);

    const result = await GET(request("fills"));

    expect(result.status).toBe(404);
    expectSingleCompletion({
      status: 404,
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      evidenceKind: "fills",
      errorCode: "not_found",
    });
    expectNoExplicitIdentifiers();
  });

  it("emits exactly one completion for response validation failure", async () => {
    getEvidence.mockResolvedValue({ invalid: true });

    const result = await GET(request("fills"));

    expect(result.status).toBe(500);
    expectSingleCompletion({
      status: 500,
      authorizationOutcome: "allowed",
      accessKind: "delegated",
      evidenceKind: "fills",
      errorCode: "response_validation_failed",
    });
    expectNoExplicitIdentifiers();
  });
});
