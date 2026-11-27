// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers the bounded list fetch. The item read is the package client (story.0085), proven in knowledge-base-ui. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWorkItems } from "@/app/(app)/work/_api/fetchWorkItems";

describe("fetchWorkItems bounded page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns one page without fetching the next", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "task.5000" }],
        pageInfo: { endCursor: "next", hasMore: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWorkItems(
      new URLSearchParams({ limit: "10", rankMin: "4" })
    );
    expect(page.items).toHaveLength(1);
    expect(page.pageInfo?.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/summaries?limit=10&rankMin=4",
      expect.any(Object)
    );
  });

  it("reports server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "Work-item store is busy" }),
      })
    );
    await expect(fetchWorkItems(new URLSearchParams())).rejects.toThrow(
      "Work-item store is busy"
    );
  });

  it("passes cancellation to the list request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await fetchWorkItems(new URLSearchParams(), signal);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(signal);
  });
});
