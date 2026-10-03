// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSyncHealthSummary = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockLogError = vi.fn();

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    orderLedger: { syncHealthSummary: mockSyncHealthSummary },
    serviceDb: { select: mockSelect },
  }),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: never[]) => Promise<Response>) =>
    () =>
      handler({ log: { error: mockLogError } } as never),
}));

import { GET } from "@/app/api/v1/poly/internal/sync-health/route";

const summary = {
  oldest_synced_row_age_ms: 1_000,
  rows_stale_over_60s: 2,
  rows_never_synced: 3,
};

describe("GET /api/v1/poly/internal/sync-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncHealthSummary.mockResolvedValue(summary);
  });

  it("reports the latest durable reconciler activity timestamp", async () => {
    mockFrom.mockResolvedValue([
      { reconcilerLastTickAt: new Date("2026-10-03T02:47:15.000Z") },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...summary,
      reconciler_last_tick_at: "2026-10-03T02:47:15.000Z",
    });
    expect(mockSelect).toHaveBeenCalledOnce();
    expect(mockFrom).toHaveBeenCalledOnce();
  });

  it("reports null when no ledger row has ever synced", async () => {
    mockFrom.mockResolvedValue([{ reconcilerLastTickAt: null }]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...summary,
      reconciler_last_tick_at: null,
    });
  });

  it("fails closed when the durable activity query fails", async () => {
    mockFrom.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "sync_health_error" });
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sync_health_error" }),
      "sync-health query failed"
    );
  });
});
