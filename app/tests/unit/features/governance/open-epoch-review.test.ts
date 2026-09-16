// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `open-epoch-review.test`
 * Purpose: Prove opening review posts once and refreshes governance reads.
 * Scope: Mutation and invalidation only; lifecycle readiness belongs to the read-only rail.
 * Invariants: SERVER_AUTHORITY, GOVERNANCE_READS_REFRESH_AFTER_MUTATION.
 * Side-effects: mocked HTTP
 * Links: src/features/governance/hooks/useOpenEpochReview.ts, work item bug.5042
 * @public
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOpenEpochReview } from "@/features/governance/hooks/useOpenEpochReview";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOpenEpochReview", () => {
  it("posts once and invalidates governance data after success", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ epoch: { id: "epoch-7", status: "review" } }),
    } as Response);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useOpenEpochReview(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("epoch-7");
    });

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/attribution/epochs/epoch-7/review",
      { method: "POST", credentials: "same-origin" }
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["governance"] })
    );
  });
});
