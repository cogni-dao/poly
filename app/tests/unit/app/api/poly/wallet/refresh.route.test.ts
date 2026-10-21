// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  classify: vi.fn(),
  shareBalance: vi.fn(),
  updateStatus: vi.fn(),
  markPosition: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => unknown) =>
    (request: Request) =>
      handler(
        {
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          reqId: "test",
        },
        request,
        { id: "11111111-1111-4111-8111-111111111111" }
      ),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    serviceDb: {},
    accountsForUser: () => ({
      getOrCreateBillingAccountForUser: async () => ({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    }),
    orderLedger: {
      listTenantPositions: async () => [
        {
          client_order_id: "o",
          order_id: null,
          status: "filled",
          filled_size_usdc: 4,
          position_lifecycle: null,
          attributes: {
            token_id: "123",
            filled_size_usdc: 4,
            side: "BUY",
            size_usdc: 4,
          },
        },
      ],
      updateStatus: mocks.updateStatus,
      markPositionLifecycleByAsset: mocks.markPosition,
      markSynced: vi.fn(),
    },
  }),
}));
vi.mock("@/bootstrap/poly-trader-wallet", () => ({
  WalletAdapterUnconfiguredError: Error,
  getPolyTraderWalletAdapter: () => ({
    getAddress: async () => `0x${"a".repeat(40)}`,
    getBalances: async () => null,
  }),
}));
vi.mock("@/bootstrap/poly-execution-venue", () => ({
  getExecutionVenueResolver: vi.fn(),
  getPaperPortfolio: vi.fn(),
  getPaperVenue: vi.fn(),
}));
vi.mock("@/bootstrap/capabilities/poly-trade-executor", () => ({
  createPolyTradeExecutorFactory: () => ({
    getPolyTradeExecutorFor: async () => ({
      getPositionShareBalance: mocks.shareBalance,
      getMarketConstraints: vi.fn(),
      getOrder: vi.fn(),
    }),
  }),
}));
vi.mock("@/features/trading", async () => ({
  ...(await import("@/features/trading/ledger-lifecycle")),
  classifyPositionActionability: mocks.classify,
}));
vi.mock("@/features/wallet-analysis/server/trader-observation-service", () => ({
  refreshCurrentPositionsForWallet: mocks.refresh,
}));
vi.mock("@/features/wallet-analysis/server/position-balance-authority", () => ({
  createPolygonPositionBalanceBatchReader: vi.fn(),
}));
vi.mock(
  "@/features/wallet-analysis/server/wallet-balance-snapshot-service",
  () => ({ persistWalletBalanceFact: vi.fn() })
);
vi.mock("@/features/wallet-analysis/server/wallet-analysis-service", () => ({
  invalidateWalletAnalysisCaches: mocks.invalidate,
  getExecutionSlice: async () => ({ capturedAt: null, warnings: [] }),
}));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => ({}) }));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { POLY_WALLET_REFRESH_COMPLETE: "poly.wallet.refresh.complete" },
  logEvent: vi.fn(),
}));
vi.mock("@/app/api/v1/poly/wallet/_lib/dashboard-route-cache", () => ({
  invalidateDashboardRouteCaches: mocks.invalidate,
}));

import { POST } from "@/app/api/v1/poly/wallet/refresh/route";

describe("explicit refresh deferred inventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("classifies a real exposed ledger fixture after a complete generation", async () => {
    mocks.refresh.mockResolvedValue({
      positions: [{ asset: "123", size: 8, currentValue: 4 }],
      positionRows: 1,
      complete: true,
      stalePositionRowsDeactivated: 0,
      stalePositionRowsPreserved: 0,
    });
    mocks.classify.mockResolvedValue({
      kind: "data_api_current",
      currentValueUsdc: 4,
    });
    const result = await POST(
      new Request("http://localhost/api/v1/poly/wallet/refresh", {
        method: "POST",
      })
    );
    const body = await result.json();
    expect(result.status).toBe(200);
    expect(body.warnings).toEqual([]);
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ client_order_id: "o", filled_size_usdc: 4 })
    );
  });

  it.each(["floor", "capacity"])(
    "does no actionability RPCs for repeated %s-deferred refreshes",
    async (deferred) => {
      mocks.refresh.mockResolvedValue({
        positions: [],
        positionRows: 0,
        complete: false,
        deferred,
        originalAsOf: "2026-10-03T10:00:00Z",
        stalePositionRowsDeactivated: 0,
        stalePositionRowsPreserved: 0,
      });
      for (let n = 0; n < 2; n += 1) {
        const result = await POST(
          new Request("http://localhost/api/v1/poly/wallet/refresh", {
            method: "POST",
          })
        );
        expect(result.status).toBe(200);
        const body = await result.json();
        expect(body.warnings).not.toContainEqual(
          expect.objectContaining({ code: "ledger_refresh_unavailable" })
        );
        expect(body.warnings).toContainEqual(
          expect.objectContaining({
            code: "positions_reconciliation_partial",
            message: expect.stringContaining("deferred"),
          })
        );
      }
      expect(mocks.classify).not.toHaveBeenCalled();
      expect(mocks.shareBalance).not.toHaveBeenCalled();
      expect(mocks.updateStatus).not.toHaveBeenCalled();
      expect(mocks.markPosition).not.toHaveBeenCalled();
      expect(mocks.invalidate).toHaveBeenCalled();
    }
  );
});
