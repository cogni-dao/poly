// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Partial component facts remain an observable HTTP 200 snapshot. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readDashboard, logEvent, log, validation, configured } = vi.hoisted(() => ({
  readDashboard: vi.fn(),
  logEvent: vi.fn(),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  validation: { fails: false },
  configured: { value: true },
}));

vi.mock("@cogni/poly-node-contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/poly-node-contracts")>();
  return {
    ...actual,
    PolyWalletDashboardOutputSchema: {
      safeParse: (value: unknown) =>
        validation.fails
          ? { success: false, error: new Error("invalid response") }
          : { success: true, data: value },
    },
  };
});
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ serviceAccountService: {} }),
  resolveServiceReadDb: () => ({ kind: "dedicated-read-pool" }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: never[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        { log, reqId: "request-123", routeId: "poly.wallet.dashboard" } as never,
        request as never,
        { id: "user-1" } as never
      ),
}));
vi.mock("@/bootstrap/poly-trader-wallet", () => ({
  isPolyTraderWalletConfigured: () => configured.value,
}));
vi.mock("@/features/wallet-analysis/server/tenant-wallet-dashboard-service", () => ({
  readTenantWalletDashboard: (...args: unknown[]) => readDashboard(...args),
}));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => ({ APP_BUILD_SHA: "sha-123" }) }));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { POLY_WALLET_DASHBOARD_COMPLETE: "feature.poly_wallet_dashboard.complete" },
  logEvent: (...args: unknown[]) => logEvent(...args),
}));
vi.mock("@/app/api/v1/poly/_lib/billing-account-cache", () => ({
  resolveBillingAccountId: async () => "tenant-1",
}));
vi.mock("@/app/api/v1/poly/wallet/_lib/dashboard-route-cache", () => ({
  unifiedDashboardCacheKey: () => "dashboard-key",
  coalesceUnifiedDashboard: async (_key: string, read: () => Promise<unknown>) => read(),
}));

import { GET } from "@/app/api/v1/poly/wallet/dashboard/route";

const meta = (status: string, source: string, complete: boolean) => ({
  status,
  source,
  observedAt: complete ? "2026-10-03T12:00:00.000Z" : null,
  ageMs: complete ? 0 : null,
  complete,
});

const coverageLeaf = {
  eligible: 0,
  comparable: 0,
  dropped: 0,
  sampled: 0,
  complete: true,
  reasons: [],
};

function partialDashboard() {
  return {
    snapshotId: "11111111-1111-4111-8111-111111111111",
    capturedAt: "2026-10-03T12:00:00.000Z",
    interval: "1W",
    overview: {
      configured: configured.value,
      open_orders: 2,
      usdc_available: null,
      usdc_positions_mtm: 4,
      usdc_total: null,
    },
    execution: {
      live_position_count: 3,
      closed_position_count: 7,
      comparisonCoverage: {
        markets: { live: coverageLeaf, closed: coverageLeaf },
        positions: { live: coverageLeaf, closed: coverageLeaf },
      },
    },
    facts: {
      wallet: meta("fresh", "wallet_connection", true),
      cash: meta("unavailable", "polygon_balance_snapshot", false),
      orders: meta("partial", "local_ledger", false),
      positions: meta("stale", "data_api_current_positions", false),
      history: meta("fresh", "local_ledger", true),
      pnl: meta("unavailable", "user_pnl_snapshot", false),
      activity: meta("fresh", "local_ledger", true),
      markets: meta("partial", "composite", false),
      total: meta("unavailable", "composite", false),
    },
    warnings: [
      { component: "cash", code: "balances_unavailable", message: "unavailable" },
    ],
  };
}

describe("GET /api/v1/poly/wallet/dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readDashboard.mockReset();
    validation.fails = false;
    configured.value = true;
  });

  it("returns partial facts as 200 and emits the complete structured event", async () => {
    readDashboard.mockResolvedValue(partialDashboard());

    const response = await GET(new Request("http://localhost/api/v1/poly/wallet/dashboard?interval=1W"));
    expect(response.status).toBe(200);
    expect(readDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ adapterConfigured: true })
    );
    expect(response.headers.get("X-Wallet-Snapshot-Id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(logEvent).toHaveBeenCalledWith(
      log,
      "feature.poly_wallet_dashboard.complete",
      expect.objectContaining({
        reqId: "request-123",
        buildSha: "sha-123",
        snapshotId: "11111111-1111-4111-8111-111111111111",
        cashStatus: "unavailable",
        cashComplete: false,
        positionStatus: "stale",
        positionComplete: false,
        marketsStatus: "partial",
        marketsComplete: false,
        totalUsdc: null,
        warningCodes: ["balances_unavailable"],
        status: 200,
        outcome: "degraded",
        degraded: true,
      })
    );
  });

  it("injects typed adapter readiness without invoking vendor IO", async () => {
    configured.value = false;
    readDashboard.mockResolvedValue(partialDashboard());
    const response = await GET(new Request("http://localhost/api/v1/poly/wallet/dashboard?interval=1W"));
    expect(response.status).toBe(200);
    expect(readDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ adapterConfigured: false })
    );
    expect((await response.json()).overview.configured).toBe(false);
  });

  it("emits a stable completion event when the service/cache path fails", async () => {
    readDashboard.mockRejectedValue(new Error("database secret detail"));
    const response = await GET(new Request("http://localhost/api/v1/poly/wallet/dashboard?interval=1W"));
    expect(response.status).toBe(500);
    expect(logEvent).toHaveBeenCalledWith(
      log,
      "feature.poly_wallet_dashboard.complete",
      expect.objectContaining({
        status: 500,
        outcome: "error",
        errorCode: "service_failed",
        warningCodes: [],
      })
    );
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("database secret detail");
  });

  it("distinguishes response validation failure from service failure", async () => {
    readDashboard.mockResolvedValue({ invalid: true });
    validation.fails = true;
    const response = await GET(new Request("http://localhost/api/v1/poly/wallet/dashboard?interval=1W"));
    expect(response.status).toBe(500);
    expect(logEvent).toHaveBeenCalledWith(
      log,
      "feature.poly_wallet_dashboard.complete",
      expect.objectContaining({
        status: 500,
        outcome: "error",
        errorCode: "response_validation_failed",
      })
    );
  });

  it("emits a completion event for invalid query input", async () => {
    const response = await GET(new Request("http://localhost/api/v1/poly/wallet/dashboard?interval=wrong"));
    expect(response.status).toBe(400);
    expect(logEvent).toHaveBeenCalledWith(
      log,
      "feature.poly_wallet_dashboard.complete",
      expect.objectContaining({
        status: 400,
        outcome: "error",
        errorCode: "invalid_query",
      })
    );
  });
});
