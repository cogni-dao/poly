// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/agent-tools/copy-trade-orders-tool`
 * Purpose: Pin the properties that make the internal-agent transport SAFE rather
 *   than merely working: the model is never asked who it is reading for, a
 *   denial is indistinguishable from an absence, and no non-ok outcome carries a
 *   number the model could read as a zero.
 * Scope: The tool contract and its outcome rendering in isolation. The executor's
 *   own dispatch order is pinned by
 *   `tests/unit/features/capability-plane/execute-account-read.test.ts`; real
 *   authorization SQL lives in the component lane.
 * Invariants: PRINCIPAL_NEVER_IN_ARGS; CAPABILITY_DEFINED_ONCE;
 *   FAIL_CLOSED_NON_DISCLOSING; NO_FABRICATED_VALUES;
 *   AMBIGUITY_IS_A_MESSAGE_NOT_A_CRASH.
 * Side-effects: none
 * Links: task.1791070967, story.5006
 * @internal
 */

import { type ToolContract, toToolSpec } from "@cogni/ai-tools";
import {
  POLY_ACCOUNT_READ_OPERATIONS,
  polyAccountReadCopyTradeOrdersOperation,
} from "@cogni/poly-node-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeAccountRead } = vi.hoisted(() => ({
  executeAccountRead: vi.fn(),
}));

// Partial mock: only the executor is replaced. The handler binding, the terminal
// event map, and the status table stay REAL, so a drift between this tool and
// the capability's actual wiring surfaces here rather than on candidate.
vi.mock("@/features/capability-plane", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/features/capability-plane")
  >();
  return { ...actual, executeAccountRead };
});

import {
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  polyAccountCopyTradeOrdersBoundTool,
  polyAccountCopyTradeOrdersToolContract,
  runPolyAccountCopyTradeOrdersTool,
} from "@/features/agent-tools";
import { ACCOUNT_READ_TERMINAL_EVENTS } from "@/features/capability-plane";

const ctx = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  reqId: "run-1",
  traceId: "0".repeat(32),
  routeId: "poly.agent.copy_trade.orders",
  clock: { now: () => "2026-10-06T00:00:00.000Z" },
} as unknown as Parameters<typeof runPolyAccountCopyTradeOrdersTool>[0]["ctx"];

const deps = {
  db: {} as never,
  principalId: "user-under-test",
  ctx,
};

const ORDER_ROW = {
  target_id: "11111111-1111-4111-8111-111111111111",
  target_wallet: null,
  fill_id: "fill-1",
  client_order_id: "coid-1",
  order_id: null,
  status: "pending",
  market_id: null,
  market_title: null,
  market_tx_hash: null,
  outcome: null,
  side: null,
  size_usdc: null,
  limit_price: null,
  filled_size_usdc: null,
  error: null,
  observed_at: "2026-10-05T00:00:00.000Z",
  created_at: "2026-10-05T00:00:00.000Z",
  updated_at: "2026-10-05T00:00:00.000Z",
  polymarket_profile_url: null,
  synced_at: null,
  staleness_ms: null,
  mode: "paper",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tool contract", () => {
  it("never asks the model for an account identifier", () => {
    // PRINCIPAL_NEVER_IN_ARGS. The single most important assertion in the file:
    // the incident that started story.5006 was an agent stalling to demand a
    // billing account UUID from a human. Asserted against the COMPILED
    // JSONSchema the model actually receives — not the Zod source — and against
    // every id-shaped alias rather than the one field name, so a future rename
    // cannot reintroduce it under a different spelling.
    const { spec } = toToolSpec(
      polyAccountCopyTradeOrdersToolContract as unknown as ToolContract<
        string,
        unknown,
        unknown,
        unknown
      >
    );
    const wire = JSON.stringify(spec.inputSchema);

    for (const forbidden of [
      "billing_account_id",
      "billingAccountId",
      "account_id",
      "accountId",
      "user_id",
      "userId",
      "principal",
      "tenant_id",
      "wallet",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    // Positive control: the compiled schema is non-empty, so the negative
    // assertions above are testing something real.
    expect(wire).toContain("limit");
  });

  it("accepts an empty argument object — calling it requires knowing nothing", () => {
    // The corollary of the above: if every field were required, a model with no
    // context could not call the tool at all and would fall back to asking.
    expect(
      polyAccountCopyTradeOrdersToolContract.inputSchema.safeParse({}).success
    ).toBe(true);
  });

  it("reuses the capability descriptor's input schema by reference", () => {
    // CAPABILITY_DEFINED_ONCE — not a copy that can drift.
    expect(polyAccountCopyTradeOrdersToolContract.inputSchema).toBe(
      polyAccountReadCopyTradeOrdersOperation.input
    );
  });

  it("binds a capability that is a published catalog member", () => {
    // If the bound descriptor were not in the catalog it would be invisible to
    // `.well-known/agent.json`, and the internal agent would be reading
    // something no external agent could — the opposite of interchangeability.
    expect(
      POLY_ACCOUNT_READ_OPERATIONS.some(
        (operation) =>
          operation.id === polyAccountReadCopyTradeOrdersOperation.id
      )
    ).toBe(true);
  });

  it("is declared read-only and resolves its account from the principal", () => {
    expect(polyAccountCopyTradeOrdersToolContract.effect).toBe("read_only");
    expect(polyAccountReadCopyTradeOrdersOperation.accountFrom).toBe(
      "principal"
    );
    expect(polyAccountReadCopyTradeOrdersOperation.readOnly).toBe(true);
  });

  it("tells the model in prose never to ask for an account id", () => {
    // Belt to the schema's braces: the shape makes asking unnecessary, the
    // description makes it forbidden.
    expect(polyAccountCopyTradeOrdersToolContract.description).toMatch(
      /never ask the user for a billing account id/i
    );
  });

  it("has no principal-free implementation", () => {
    // The module-scoped bundle entry exists only to publish the spec. If it is
    // ever resolved for execution, that means the per-request source was not
    // composed in — fail loudly rather than answer with no principal.
    expect(() =>
      polyAccountCopyTradeOrdersBoundTool.implementation.execute({})
    ).toThrow(/PRINCIPAL_NEVER_IN_ARGS/);
  });
});

describe("outcome rendering", () => {
  it("returns the capability's rows unchanged on ok", async () => {
    executeAccountRead.mockResolvedValue({
      status: "ok",
      data: { orders: [ORDER_ROW] },
      access: { accessKind: "owner" },
    });

    const result = await runPolyAccountCopyTradeOrdersTool(deps, {});

    // SAVED_FACTS_ONLY + parity: the agent sees the SAME rows the dashboard
    // renders, not a reshaped summary.
    expect(result).toEqual({
      status: "ok",
      orders: [ORDER_ROW],
      order_count: 1,
    });
  });

  it("forwards the signed-in user's principal, and no account id", async () => {
    executeAccountRead.mockResolvedValue({
      status: "ok",
      data: { orders: [] },
      access: { accessKind: "owner" },
    });

    await runPolyAccountCopyTradeOrdersTool(deps, { limit: 5 });

    const args = executeAccountRead.mock.calls[0]?.[0];
    expect(args.principalId).toBe("user-under-test");
    expect(args.operation).toBe(polyAccountReadCopyTradeOrdersOperation);
    expect(args.rawInput).toEqual({ limit: 5 });
    // The account is the seam's business, never the transport's.
    expect(args).not.toHaveProperty("accountId");
  });

  it("renders denied and not_found identically", async () => {
    // FAIL_CLOSED_NON_DISCLOSING. A model is a fine oracle for an attacker, so
    // "forbidden" and "absent" must be byte-identical here.
    executeAccountRead.mockResolvedValue({ status: "denied" });
    const denied = await runPolyAccountCopyTradeOrdersTool(deps, {});

    executeAccountRead.mockResolvedValue({
      status: "not_found",
      access: { accessKind: "owner" },
    });
    const notFound = await runPolyAccountCopyTradeOrdersTool(deps, {});

    expect(denied).toEqual(notFound);
    expect(denied.reason).toBe("no_readable_account");
  });

  it.each([
    ["denied", { status: "denied" }],
    ["not_found", { status: "not_found", access: { accessKind: "owner" } }],
    ["invalid_input", { status: "invalid_input", message: "2 accounts" }],
    ["invalid_output", { status: "invalid_output" }],
    ["failed", { status: "failed" }],
  ])("fabricates nothing on %s", async (_label, outcome) => {
    // NO_FABRICATED_VALUES as a property of the SHAPE: there is no zero and no
    // empty array for a model to narrate as fact.
    executeAccountRead.mockResolvedValue(outcome);

    const result = await runPolyAccountCopyTradeOrdersTool(deps, {});

    expect(result.status).toBe("unavailable");
    expect(result).not.toHaveProperty("orders");
    expect(result).not.toHaveProperty("order_count");
    expect(result.message).toBeTruthy();
    expect(result.message).toMatch(/do not/i);
  });

  it("turns an ambiguous subject into an instruction to ask the human", async () => {
    // AMBIGUITY_IS_A_MESSAGE_NOT_A_CRASH. The executor's own advice is "specify
    // billing_account_id", which is impossible for this capability — so the
    // message must NOT be forwarded verbatim.
    executeAccountRead.mockResolvedValue({
      status: "invalid_input",
      message: "This principal can read 2 accounts; specify billing_account_id.",
    });

    const result = await runPolyAccountCopyTradeOrdersTool(deps, {});

    expect(result.reason).toBe("account_ambiguous");
    expect(result.message).not.toContain("billing_account_id");
    expect(result.message).toMatch(/ask the user/i);
  });

  it("returns a typed unavailable instead of throwing when injection fails", async () => {
    // A throwing tool becomes an opaque `execution` error to the model, which is
    // exactly when models start guessing.
    executeAccountRead.mockRejectedValue(new Error("no database handle"));

    const result = await runPolyAccountCopyTradeOrdersTool(deps, {});

    expect(result).toEqual({
      status: "unavailable",
      reason: "read_failed",
      message: expect.stringMatching(/read failed/i),
    });
  });

  it("emits the SAME terminal event the dashboard route emits", async () => {
    // One capability, one Loki stream, split only by `routeId`. This is what
    // makes human-vs-agent parity a one-stream comparison.
    executeAccountRead.mockResolvedValue({
      status: "ok",
      data: { orders: [] },
      access: { accessKind: "owner" },
    });
    await runPolyAccountCopyTradeOrdersTool(deps, {});

    expect(executeAccountRead.mock.calls[0]?.[0].eventName).toBe(
      ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadCopyTradeOrdersOperation.id]
    );
  });

  it("uses the namespaced tool id the node catalog allowlists", () => {
    expect(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME).toBe(
      "core__poly_account_copy_trade_orders"
    );
    expect(polyAccountCopyTradeOrdersToolContract.name).toBe(
      POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME
    );
  });
});
