// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Route-level tenant-isolation proof for owner-scoped wallet reset.
 * The wire contract rejects account selectors, while the handler resolves the
 * only reachable billing account from the authenticated session user.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OWN_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const resolveBillingAccountId = vi.fn();
const checkConnectRateLimit = vi.fn();
const getPolyTraderWalletAdapter = vi.fn();
const select = vi.fn();

const emptySelect = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(async () => []),
};

vi.mock("@/app/api/v1/poly/_lib/billing-account-cache", () => ({
  resolveBillingAccountId: (...args: unknown[]) =>
    resolveBillingAccountId(...args),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    serviceAccountService: { marker: "session-account-service" },
    invalidatePolyTradeExecutorFor: vi.fn(),
  }),
  resolveServiceDb: () => ({ select }),
}));

vi.mock("@/bootstrap/poly-trader-wallet", () => ({
  checkConnectRateLimit: (...args: unknown[]) =>
    checkConnectRateLimit(...args),
  getPolyTraderWalletAdapter: (...args: unknown[]) =>
    getPolyTraderWalletAdapter(...args),
  WalletAdapterUnconfiguredError: class extends Error {},
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-owner-reset",
          routeId: "poly.wallet.reset_connection",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        request,
        { id: USER_ID }
      ),
}));

vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_WALLET_RESET_CONNECTION_COMPLETE:
      "poly.wallet.reset_connection.complete",
  },
  logEvent: vi.fn(),
}));

import { POST } from "@/app/api/v1/poly/wallet/reset-connection/route";

function request(body: unknown): Request {
  return new Request(
    "http://localhost:3200/api/v1/poly/wallet/reset-connection",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /api/v1/poly/wallet/reset-connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    select.mockReturnValue(emptySelect);
    resolveBillingAccountId.mockResolvedValue(OWN_ACCOUNT);
    checkConnectRateLimit.mockResolvedValue({ retryAfterSeconds: 0 });
    getPolyTraderWalletAdapter.mockReturnValue({});
  });

  it("rejects a caller-supplied billing account before any account lookup", async () => {
    const response = await POST(
      request({
        confirmation: "RESET_WALLET_CONNECTION",
        billing_account_id: FOREIGN_ACCOUNT,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_reset_request" });
    expect(resolveBillingAccountId).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("derives the only reachable account from the authenticated session", async () => {
    const response = await POST(
      request({ confirmation: "RESET_WALLET_CONNECTION" })
    );

    expect(response.status).toBe(200);
    expect(resolveBillingAccountId).toHaveBeenCalledOnce();
    expect(resolveBillingAccountId).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID
    );
    expect(await response.json()).toMatchObject({
      billing_account_id: OWN_ACCOUNT,
      outcome: "no_active_connection",
    });
  });
});
