// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `useCollectEpoch.test`
 * Purpose: Prove contribution sync preserves server cooldowns and refreshes the active epoch overview.
 * Scope: React Query hook with HTTP and query refetch mocked.
 * Invariants: SAME_TEMPORAL_ROUTE, COOLDOWN_VISIBLE, SUCCESS_REFETCHES_EPOCHS.
 * Side-effects: mocked HTTP
 * Links: src/features/governance/hooks/useCollectEpoch.ts, task.5039
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCollectEpoch } from "@/features/governance/hooks/useCollectEpoch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const refetch = vi
    .spyOn(queryClient, "refetchQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useCollectEpoch(), { wrapper });
  return { ...hook, refetch };
}

describe("useCollectEpoch", () => {
  it("uses the existing collect route and refetches active governance data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result, refetch } = setup();

    await act(async () => result.current.trigger());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/attribution/epochs/collect",
      { method: "POST", credentials: "same-origin" }
    );
    expect(refetch).toHaveBeenCalledWith({
      queryKey: ["governance"],
      type: "active",
    });
    expect(result.current.successMessage).toMatch(/sync started/i);
    expect(result.current.cooldownSeconds).toBe(300);
    expect(result.current.loading).toBe(false);
  });

  it("exposes the server cooldown and does not refetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({ error: "cooldown", retryAfterSeconds: 125 }),
      } as Response)
    );
    const { result, refetch } = setup();

    await act(async () => result.current.trigger());

    expect(result.current.cooldownSeconds).toBe(125);
    expect(result.current.error).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("exposes a failed trigger without reporting success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Unavailable",
        json: async () => ({ error: "Schedule unavailable" }),
      } as Response)
    );
    const { result, refetch } = setup();

    await act(async () => result.current.trigger());

    expect(result.current.error).toBe("Schedule unavailable");
    expect(result.current.successMessage).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });
});
