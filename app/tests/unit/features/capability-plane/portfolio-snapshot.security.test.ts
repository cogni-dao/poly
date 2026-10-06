// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/capability-plane/portfolio-snapshot.security`
 * Purpose: Prove the production failure mode is structurally closed. Before
 *   the agent-first inversion, a delegated agent bearer calling
 *   `/wallet/dashboard` was never denied — `resolveBillingAccountId` resolved
 *   the tenant from the CALLER's own id and lazily CREATED a billing account on
 *   miss, so the agent received a 200 describing a brand-new empty tenant of
 *   its own. That is the mechanism behind the fabricated-balance incident.
 * Scope: The real `executeAccountRead` plus the real handler, over a fake
 *   transaction and the real output schema. `authorize` is mocked because the
 *   decision itself is the sibling-owned seam; what is under test here is that
 *   no account data is read without an allow, that denials disclose nothing,
 *   and that the account the snapshot is built for is the account that was
 *   authorized.
 * Links: story.5004, story.5006, task.1791070962
 * @internal
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const {
  authorize,
  resolvePrincipalAccountId,
  readSnapshot,
  logEvent,
  log,
  fakeTx,
} = vi.hoisted(() => ({
  authorize: vi.fn(),
  resolvePrincipalAccountId: vi.fn(),
  readSnapshot: vi.fn(),
  logEvent: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  /** Answers the tenant-GUC probe; the executor's SET TRANSACTION ignores rows. */
  fakeTx: {
    execute: vi.fn(async () => [
      { principal_id: "11111111-1111-4111-8111-111111111111" },
    ]),
  },
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(fakeTx),
}));
vi.mock("@/features/agent-grants/authorization", () => ({
  authorize: (...args: unknown[]) => authorize(...args),
  resolvePrincipalAccountId: (...args: unknown[]) =>
    resolvePrincipalAccountId(...args),
}));
vi.mock(
  "@/features/wallet-analysis/server/tenant-wallet-dashboard-service",
  () => ({
    readTenantWalletDashboardIn: (...args: unknown[]) => readSnapshot(...args),
  })
);
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_WALLET_DASHBOARD_COMPLETE: "feature.poly_wallet_dashboard.complete",
    POLY_AGENT_GRANT_ACCESS_DECISION:
      "feature.poly_agent_grant.access_decision",
  },
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

import {
  polyAccountReadPortfolioSnapshotOperation,
  polyAccountReadPortfolioSnapshotOwnerOperation,
} from "@cogni/poly-node-contracts";
import { executeAccountRead } from "@/features/capability-plane/execute-account-read";
import {
  portfolioSnapshotAccountReadHandler,
  portfolioSnapshotExtra,
  portfolioSnapshotOwnerAccountReadHandler,
} from "@/features/capability-plane/portfolio-snapshot";
import { clearTtlCache } from "@/features/wallet-analysis/server/coalesce";
import { portfolioSnapshotFixture } from "./portfolio-snapshot.fixture";

const TERMINAL_EVENT = "feature.poly_wallet_dashboard.complete";
const ctx = { log, reqId: "req-1", routeId: "poly.wallet.dashboard" } as never;

function runOwner(principalId: string) {
  return executeAccountRead({
    db: {} as never,
    ctx,
    operation: polyAccountReadPortfolioSnapshotOwnerOperation,
    principalId,
    rawInput: { interval: "1W" },
    eventName: TERMINAL_EVENT as never,
    handler: portfolioSnapshotOwnerAccountReadHandler({
      adapterConfigured: true,
    }),
    extra: (context) => portfolioSnapshotExtra(context, "sha-test"),
  });
}

function runAgent(principalId: string, billingAccountId: string) {
  return executeAccountRead({
    db: {} as never,
    ctx,
    operation: polyAccountReadPortfolioSnapshotOperation,
    principalId,
    rawInput: { billing_account_id: billingAccountId, interval: "1W" },
    eventName: TERMINAL_EVENT as never,
    handler: portfolioSnapshotAccountReadHandler({ adapterConfigured: true }),
    extra: (context) => portfolioSnapshotExtra(context, "sha-test"),
  });
}

function terminalEvent(): Record<string, unknown> | undefined {
  const call = logEvent.mock.calls.find((entry) => entry[1] === TERMINAL_EVENT);
  return call?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTtlCache();
  fakeTx.execute.mockResolvedValue([{ principal_id: OWNER }]);
  readSnapshot.mockResolvedValue(portfolioSnapshotFixture());
  resolvePrincipalAccountId.mockResolvedValue(ACCOUNT);
});

describe("the delegation trap is closed", () => {
  it("denies an agent with no grant instead of answering about its own tenant", async () => {
    authorize.mockResolvedValue(null);

    const outcome = await runAgent(AGENT, ACCOUNT);

    expect(outcome.status).toBe("denied");
    // The decisive assertion: NO account data was read at all. This path used
    // to return 200 built from a freshly auto-created empty tenant.
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("serves the OWNER's account to an approved delegated agent", async () => {
    authorize.mockResolvedValue({
      accessKind: "delegated",
      grantId: "grant-1",
    });

    const outcome = await runAgent(AGENT, ACCOUNT);

    expect(outcome.status).toBe("ok");
    expect(authorize).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        principalId: AGENT,
        accountId: ACCOUNT,
        requiredScope: "account:read",
      })
    );
    // The snapshot is computed for the account NAMED on the wire and allowed
    // by authorize — never for one derived from the caller's own identity.
    expect(readSnapshot).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ billingAccountId: ACCOUNT })
    );
  });

  it("gives an owner and a delegated agent the identical snapshot", async () => {
    authorize.mockResolvedValue({ accessKind: "owner", grantId: null });
    const ownerOutcome = await runOwner(OWNER);

    authorize.mockResolvedValue({
      accessKind: "delegated",
      grantId: "grant-1",
    });
    const agentOutcome = await runAgent(AGENT, ACCOUNT);

    expect(ownerOutcome.status).toBe("ok");
    expect(agentOutcome.status).toBe("ok");
    // One tenant-keyed cache entry serves both principals, so they receive
    // literally identical facts at one cutoff — parity by construction.
    expect(
      agentOutcome.status === "ok" ? agentOutcome.data : null
    ).toStrictEqual(ownerOutcome.status === "ok" ? ownerOutcome.data : undefined);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("cannot be used to probe which accounts exist", async () => {
    // Wrong tenant and unknown tenant collapse to one indistinguishable result.
    authorize.mockResolvedValue(null);
    const wrongTenant = await runAgent(AGENT, OTHER_ACCOUNT);
    const unknownTenant = await runAgent(AGENT, ACCOUNT);
    expect(wrongTenant).toEqual({ status: "denied" });
    expect(unknownTenant).toEqual(wrongTenant);
  });

  it("never discloses the account id or access kind on a denial", async () => {
    authorize.mockResolvedValue(null);
    await runAgent(AGENT, ACCOUNT);

    const event = terminalEvent();
    expect(event).toMatchObject({ status: 404, authorizationOutcome: "denied" });
    expect(event).not.toHaveProperty("accessKind");
    expect(JSON.stringify(event)).not.toContain(ACCOUNT);
  });
});

describe("owner transport account resolution", () => {
  it("denies a principal that owns no account rather than creating one", async () => {
    // `resolvePrincipalAccountId` is a pure SELECT. The old route's
    // `resolveBillingAccountId` INSERTed on miss, which is precisely what made
    // the delegated path silently succeed against an empty tenant.
    resolvePrincipalAccountId.mockResolvedValue(null);
    authorize.mockResolvedValue(null);

    const outcome = await runOwner(OWNER);

    expect(outcome.status).toBe("denied");
    expect(authorize).not.toHaveBeenCalled();
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("computes the snapshot for the same account the executor authorized", async () => {
    authorize.mockResolvedValue({ accessKind: "owner", grantId: null });

    const outcome = await runOwner(OWNER);

    expect(outcome.status).toBe("ok");
    // Both the executor's decision and the handler's read resolve the account
    // through the ONE shared function, so they cannot select different rows.
    expect(resolvePrincipalAccountId).toHaveBeenCalledWith(fakeTx, OWNER);
    expect(authorize).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ accountId: ACCOUNT, principalId: OWNER })
    );
    expect(readSnapshot).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ billingAccountId: ACCOUNT })
    );
  });

  it("authorizes before the cache is ever consulted, and never caches the decision", async () => {
    const order: string[] = [];
    authorize.mockImplementation(async () => {
      order.push("authorize");
      return { accessKind: "owner", grantId: null };
    });
    readSnapshot.mockImplementation(async () => {
      order.push("read");
      return portfolioSnapshotFixture();
    });

    await runOwner(OWNER);
    await runOwner(OWNER);

    // Second request is a cache hit — one read — but authorize ran again,
    // because access decisions are NEVER cached.
    expect(order).toEqual(["authorize", "read", "authorize"]);
  });

  it("keeps one tenant's snapshot out of another tenant's cache entry", async () => {
    authorize.mockResolvedValue({ accessKind: "owner", grantId: null });
    readSnapshot.mockImplementation(async (_tx: unknown, input: unknown) =>
      portfolioSnapshotFixture({
        snapshotId:
          (input as { billingAccountId: string }).billingAccountId === ACCOUNT
            ? "33333333-3333-4333-8333-333333333333"
            : "44444444-4444-4444-8444-444444444444",
      })
    );

    resolvePrincipalAccountId.mockResolvedValue(ACCOUNT);
    const first = await runOwner(OWNER);
    resolvePrincipalAccountId.mockResolvedValue(OTHER_ACCOUNT);
    const second = await runOwner(AGENT);

    expect(first.status === "ok" ? first.data.snapshotId : null).toBe(
      "33333333-3333-4333-8333-333333333333"
    );
    expect(second.status === "ok" ? second.data.snapshotId : null).toBe(
      "44444444-4444-4444-8444-444444444444"
    );
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("no fabricated values survive the plane", () => {
  it("passes a typed-unavailable snapshot through untouched", async () => {
    authorize.mockResolvedValue({ accessKind: "owner", grantId: null });

    const outcome = await runOwner(OWNER);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    // The fixture's cash fact is unavailable. Nulls must stay null — a zero
    // here is the exact fabrication this capability exists to prevent.
    expect(outcome.data.overview.usdc_total).toBeNull();
    expect(outcome.data.overview.usdc_available).toBeNull();
    expect(outcome.data.facts.cash.status).toBe("unavailable");
    expect(outcome.data.warnings.map((entry) => entry.code)).toContain(
      "wallet_total_unavailable"
    );
  });

  it("reports a null snapshot as not_found rather than an empty one", async () => {
    authorize.mockResolvedValue({ accessKind: "owner", grantId: null });
    readSnapshot.mockResolvedValue(null);

    const outcome = await runOwner(OWNER);

    expect(outcome.status).toBe("not_found");
    expect(terminalEvent()).toMatchObject({
      status: 404,
      errorCode: "not_found",
    });
  });

  it("carries the dashboard Loki fields through the one terminal event", async () => {
    authorize.mockResolvedValue({ accessKind: "owner", grantId: null });

    await runOwner(OWNER);

    expect(logEvent.mock.calls.filter((e) => e[1] === TERMINAL_EVENT)).toHaveLength(
      1
    );
    expect(terminalEvent()).toMatchObject({
      status: 200,
      outcome: "success",
      accessKind: "owner",
      authorizationOutcome: "allowed",
      operationId: "poly.account.portfolio-snapshot.v1",
      snapshotId: "33333333-3333-4333-8333-333333333333",
      cashStatus: "unavailable",
      cashComplete: false,
      totalStatus: "unavailable",
      openOrders: 2,
      livePositionCount: 3,
      closedPositionCount: 7,
      totalUsdc: null,
      tradingReady: true,
      walletConnected: true,
      // The route's former `outcome: "degraded"` is now this boolean, because
      // the executor owns `outcome` and only emits success/error.
      degraded: true,
      warningCodes: ["balances_unavailable", "wallet_total_unavailable"],
    });
  });
});

describe("the inverted transport holds no privilege of its own", () => {
  const root = join(__dirname, "../../../../src");
  const sources: Array<[string, string]> = [
    ["dashboard route", "app/api/v1/poly/wallet/dashboard/route.ts"],
    ["agent route", "app/api/v1/poly/account/portfolio-snapshot/route.ts"],
    ["handler", "features/capability-plane/portfolio-snapshot.ts"],
  ];

  it.each(sources)(
    "%s never reaches for a service-role handle or a lazy account",
    (_name, relativePath) => {
      const source = readFileSync(join(root, relativePath), "utf8");
      // NO_PRIVILEGED_TRANSPORT + NO_LAZY_ACCOUNT_ON_GET, enforced structurally
      // rather than by review. These are the exact names the pre-inversion
      // dashboard route used.
      expect(source).not.toContain("resolveServiceReadDb");
      expect(source).not.toContain("resolveServiceDb(");
      expect(source).not.toContain("resolveBillingAccountId");
    }
  );

  it("the dashboard route performs no query and no authorization itself", () => {
    const source = readFileSync(join(root, sources[0][1]), "utf8");
    expect(source).toContain("resolveAppDb");
    expect(source).not.toContain("coalesceUnifiedDashboard");
    expect(source).not.toContain("readTenantWalletDashboard");
    expect(source).not.toMatch(/\bauthorize\(/);
  });
});
