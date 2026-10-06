// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/capability-plane/execute-account-read`
 * Purpose: Pin the dispatch ORDER of the account-read executor, because the
 *   order IS the security contract: read-only isolation before any query,
 *   authorization before any cache, exactly one terminal event on every path.
 * Scope: The executor in isolation. Real authorization SQL lives in the
 *   component lane; route rendering lives in the contract lane.
 * Invariants: AUTHORIZE_BEFORE_CACHE; EXACTLY_ONE_TERMINAL_EVENT;
 *   FAIL_CLOSED_NON_DISCLOSING; NO_FABRICATED_VALUES.
 * Side-effects: none
 * Links: task.1791070961
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { authorize, calls, logEvent, resolvePrincipalAccountId, tx } =
  vi.hoisted(() => {
    const calls: string[] = [];
    return {
      authorize: vi.fn(),
      calls,
      logEvent: vi.fn(),
      resolvePrincipalAccountId: vi.fn(),
      tx: {
        execute: vi.fn(async (query: { statement?: string }) => {
          calls.push(`execute:${query?.statement ?? "unknown"}`);
          return [];
        }),
      },
    };
  });

// Only `sql` is consumed from drizzle-orm inside the executor; the stub keeps
// the emitted statement readable so the ordering assertions can see it.
vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    statement: String.raw({ raw: strings }, ...values),
  }),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    fn: (transaction: typeof tx) => Promise<unknown>
  ) => {
    calls.push("withTenantScope");
    return fn(tx);
  },
}));

vi.mock("@/features/agent-grants/authorization", () => ({
  authorize: (...args: unknown[]) => {
    calls.push("authorize");
    return authorize(...args);
  },
  resolvePrincipalAccountId: (...args: unknown[]) => {
    calls.push("resolvePrincipalAccountId");
    return resolvePrincipalAccountId(...args);
  },
}));

vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_AGENT_GRANT_ACCESS_DECISION:
      "feature.poly_agent_grant.access_decision",
  },
  logEvent: (...args: unknown[]) => {
    logEvent(...args);
  },
}));

import { executeAccountRead } from "@/features/capability-plane/execute-account-read";

const PRINCIPAL = "10000000-0000-4000-a000-000000000001";
const ACCOUNT = "20000000-0000-4000-b000-000000000001";
const TERMINAL_EVENT = "feature.poly_test.complete";
const ISOLATION =
  "execute:SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";

const operation = {
  id: "poly.test-account-read.v1",
  summary: "Test account read",
  input: z.object({
    billing_account_id: z.string().uuid(),
    limit: z.coerce.number().int().min(1).default(10),
  }),
  output: z.object({ rows: z.array(z.string()) }),
  requiredScope: "account:read",
  method: "GET",
  path: "/api/v1/poly/test",
  readOnly: true,
  accountFrom: "input",
} as const;

const ctx = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  reqId: "request-1",
  routeId: "poly.test",
} as never;

const OWNER = { accessKind: "owner" as const, grantId: null };
const DELEGATE = {
  accessKind: "delegated" as const,
  grantId: "30000000-0000-4000-b000-000000000001",
};

type Args = Parameters<typeof executeAccountRead>[0];

function run(overrides: Record<string, unknown> = {}) {
  return executeAccountRead({
    db: { kind: "app-role-db" },
    ctx,
    operation,
    principalId: PRINCIPAL,
    rawInput: { billing_account_id: ACCOUNT },
    eventName: TERMINAL_EVENT,
    handler: async () => ({ rows: ["a"] }),
    ...overrides,
  } as unknown as Args);
}

function terminalEvents(): Record<string, unknown>[] {
  return logEvent.mock.calls
    .filter(([, name]) => name === TERMINAL_EVENT)
    .map(([, , fields]) => fields as Record<string, unknown>);
}

function accessDecisions(): Record<string, unknown>[] {
  return logEvent.mock.calls
    .filter(([, name]) => name === "feature.poly_agent_grant.access_decision")
    .map(([, , fields]) => fields as Record<string, unknown>);
}

function reset(access: unknown): void {
  vi.clearAllMocks();
  calls.length = 0;
  authorize.mockReset();
  resolvePrincipalAccountId.mockReset();
  authorize.mockResolvedValue(access);
}

describe("executeAccountRead dispatch order", () => {
  beforeEach(() => reset(OWNER));

  it("sets REPEATABLE READ READ ONLY as the first statement, before authorizing", async () => {
    await run();

    // Index 0 is the tenant scope itself, so the isolation statement is the
    // very first thing the transaction does. Postgres rejects SET TRANSACTION
    // once a query has run, which is why nothing may be inserted above it.
    expect(calls[0]).toBe("withTenantScope");
    expect(calls[1]).toBe(ISOLATION);
    expect(calls.indexOf(ISOLATION)).toBeLessThan(calls.indexOf("authorize"));
  });

  it("skips the isolation statement for a non-read-only operation", async () => {
    await run({ operation: { ...operation, readOnly: false } });

    expect(calls).not.toContain(ISOLATION);
    expect(calls).toContain("authorize");
  });

  it("consults the cache strictly after authorize, and never without an allow", async () => {
    const lookup = vi.fn(async () => {
      calls.push("cache.lookup");
      return null;
    });
    const handler = vi.fn(async () => {
      calls.push("handler");
      return { rows: ["a"] };
    });

    await run({ cache: { lookup }, handler });

    expect(calls).toEqual([
      "withTenantScope",
      ISOLATION,
      "authorize",
      "cache.lookup",
      "handler",
    ]);
    // The cache cannot be called without an authorization decision in hand.
    expect(lookup).toHaveBeenCalledWith(
      { billing_account_id: ACCOUNT, limit: 10 },
      OWNER
    );

    reset(null);
    const denied = await run({ cache: { lookup }, handler });

    expect(denied.status).toBe("denied");
    expect(lookup).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the cached value without calling the handler", async () => {
    const handler = vi.fn();
    const result = await run({
      cache: { lookup: async () => ({ rows: ["cached"] }) },
      handler,
    });

    expect(result).toEqual({
      status: "ok",
      data: { rows: ["cached"] },
      access: OWNER,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("gives the handler only validated input and the authorized transaction", async () => {
    const handler = vi.fn(async () => ({ rows: ["a"] }));

    await run({ handler, rawInput: { billing_account_id: ACCOUNT, limit: "5" } });

    expect(handler).toHaveBeenCalledWith(tx, {
      billing_account_id: ACCOUNT,
      limit: 5,
    });
  });

  it("resolves the account from the principal when the descriptor says so", async () => {
    resolvePrincipalAccountId.mockResolvedValue(ACCOUNT);

    await run({ operation: { ...operation, accountFrom: "principal" } });

    expect(resolvePrincipalAccountId).toHaveBeenCalledWith(tx, PRINCIPAL);
    expect(authorize).toHaveBeenCalledWith(tx, {
      principalId: PRINCIPAL,
      accountId: ACCOUNT,
      requiredScope: "account:read",
    });
  });

  it("denies without authorizing when the principal owns no account", async () => {
    resolvePrincipalAccountId.mockResolvedValue(null);

    const result = await run({
      operation: { ...operation, accountFrom: "principal" },
    });

    expect(result.status).toBe("denied");
    expect(authorize).not.toHaveBeenCalled();
    expect(accessDecisions()).toEqual([
      expect.objectContaining({ outcome: "deny" }),
    ]);
  });
});

describe("executeAccountRead terminal event", () => {
  beforeEach(() => reset(DELEGATE));

  it("emits exactly one event on success, carrying the counts from extra", async () => {
    const result = await run({
      extra: ({ data }: { data: { rows: string[] } | null }) => ({
        rowsCount: data ? data.rows.length : 0,
      }),
    });

    expect(result.status).toBe("ok");
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        reqId: "request-1",
        operationId: "poly.test-account-read.v1",
        status: 200,
        outcome: "success",
        authorizationOutcome: "allowed",
        accessKind: "delegated",
        rowsCount: 1,
      }),
    ]);
    expect(terminalEvents()[0]).not.toHaveProperty("errorCode");
  });

  it("emits exactly one event for invalid input, without touching the database", async () => {
    const result = await run({ rawInput: { billing_account_id: "nope" } });

    expect(result.status).toBe("invalid_input");
    expect(calls).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
    expect(accessDecisions()).toEqual([]);
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        status: 400,
        outcome: "error",
        authorizationOutcome: "not_evaluated",
        errorCode: "invalid_query",
      }),
    ]);
  });

  it("emits exactly one non-disclosing event for a denial", async () => {
    reset(null);

    const result = await run();

    expect(result).toEqual({ status: "denied" });
    expect(terminalEvents()).toHaveLength(1);
    const [event] = terminalEvents();
    expect(event).toEqual(
      expect.objectContaining({
        status: 404,
        outcome: "error",
        authorizationOutcome: "denied",
        errorCode: "not_found",
      })
    );
    // A denial leaks neither the access kind nor the account it was denied for.
    expect(event).not.toHaveProperty("accessKind");
    expect(JSON.stringify(event)).not.toContain(ACCOUNT);
  });

  it("reports an absent snapshot as not_found rather than fabricating zeroes", async () => {
    const result = await run({ handler: async () => null });

    expect(result).toEqual({ status: "not_found", access: DELEGATE });
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        status: 404,
        authorizationOutcome: "allowed",
        accessKind: "delegated",
        errorCode: "not_found",
      }),
    ]);
  });

  it("emits exactly one event when handler output violates the contract", async () => {
    const result = await run({ handler: async () => ({ rows: [1, 2] }) });

    expect(result).toEqual({ status: "invalid_output" });
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        status: 500,
        authorizationOutcome: "allowed",
        accessKind: "delegated",
        errorCode: "response_validation_failed",
      }),
    ]);
  });

  it("never hands unvalidated data to extra", async () => {
    // Regression: the handler returned a shape that fails `operation.output`,
    // so `extra` must see null rather than the raw object — an `extra` written
    // against the validated shape would otherwise read undefined fields.
    const extra = vi.fn(() => ({ rowsCount: 0 }));

    const result = await run({
      handler: async () => ({ nope: true }),
      extra,
    });

    expect(result).toEqual({ status: "invalid_output" });
    expect(extra).toHaveBeenCalledWith({
      status: "invalid_output",
      input: { billing_account_id: ACCOUNT, limit: 10 },
      data: null,
    });
  });

  it("still emits the terminal event when extra throws", async () => {
    const result = await run({
      extra: () => {
        throw new Error("bad count builder");
      },
    });

    // A transport bug must not be able to suppress the one terminal event.
    expect(result.status).toBe("ok");
    expect(terminalEvents()).toEqual([
      expect.objectContaining({ status: 200, extraFieldsFailed: true }),
    ]);
  });

  it("emits exactly one event when the handler throws", async () => {
    const result = await run({
      handler: async () => {
        throw new Error("database unavailable");
      },
    });

    expect(result).toEqual({ status: "failed" });
    expect(terminalEvents()).toEqual([
      expect.objectContaining({ status: 500, errorCode: "service_failed" }),
    ]);
  });

  it("classifies a caller-input error as 400, still one event", async () => {
    class BadCursor extends Error {}
    const result = await run({
      handler: async () => {
        throw new BadCursor("bad cursor");
      },
      classifyError: (error: unknown) =>
        error instanceof BadCursor ? "invalid_input" : undefined,
    });

    expect(result).toEqual({ status: "invalid_input" });
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        status: 400,
        errorCode: "invalid_query",
        authorizationOutcome: "allowed",
      }),
    ]);
  });

  it("records the subject and object of every access decision for Loki proof", async () => {
    await run();

    expect(accessDecisions()).toEqual([
      expect.objectContaining({
        outcome: "allow",
        requiredScope: "account:read",
        principalId: PRINCIPAL,
        billingAccountId: ACCOUNT,
        accessKind: "delegated",
        grantId: DELEGATE.grantId,
      }),
    ]);
  });
});
