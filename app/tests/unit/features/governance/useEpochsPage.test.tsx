// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `useEpochsPage.test`
 * Purpose: Prove lifecycle evidence is fetched once per page and fails closed without hiding epochs.
 * Scope: React Query hook with HTTP mocked; no database or chain access.
 * Invariants: ONE_PAGE_LIFECYCLE_READ, LIFECYCLE_FAILURE_IS_UNKNOWN.
 * Side-effects: mocked HTTP
 * Links: src/features/governance/hooks/useEpochsPage.ts, task.5039
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEpochsPage } from "@/features/governance/hooks/useEpochsPage";

afterEach(() => vi.restoreAllMocks());

describe("useEpochsPage", () => {
  it("keeps epoch data available and marks one failed lifecycle read unknown", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("settlement-lifecycle")) {
        return {
          ok: false,
          status: 503,
          statusText: "Unavailable",
          text: async () => "rpc unavailable",
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ epochs: [] }),
      } as Response;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useEpochsPage(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({
      current: null,
      pastEpochs: [],
      settlementLifecycle: {
        publicationEvidence: "unknown",
        liveRevision: null,
        latestRevision: null,
        epochs: [],
      },
    });
    expect(
      vi.mocked(global.fetch).mock.calls.filter(([url]) =>
        String(url).includes("settlement-lifecycle")
      )
    ).toHaveLength(1);
  });
});
