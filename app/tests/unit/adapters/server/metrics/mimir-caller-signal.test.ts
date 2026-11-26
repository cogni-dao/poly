// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/metrics/mimir-caller-signal`
 * Purpose: A caller's AbortSignal ends the Mimir instant query, so a metric read that times out frees its request (task.0171).
 * Scope: Instant query only, with a mocked fetch. No real Mimir.
 * Side-effects: none
 * Links: src/adapters/server/metrics/mimir.adapter.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MimirMetricsAdapter } from "@/adapters/server/metrics/mimir.adapter";

describe("MimirMetricsAdapter caller signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Defect guarded: the adapter ignored the caller's signal, so an aborted metric read kept its HTTP request open until the adapter timeout.
  it("aborts the in-flight fetch when the caller's signal aborts", async () => {
    let sent: AbortSignal | undefined;
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      sent = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        sent?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    }) as unknown as typeof fetch;
    const adapter = new MimirMetricsAdapter({
      url: "https://mimir.example.com",
      username: "u",
      password: "p",
      timeoutMs: 60_000,
    });
    const caller = new AbortController();
    const pending = adapter.queryInstant({ query: "up", signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toThrow();
    expect(sent?.aborted).toBe(true);
  });
  it("rejects without sending when the caller's signal is already aborted", async () => {
    let sent: AbortSignal | undefined;
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      sent = init?.signal ?? undefined;
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }) as unknown as typeof fetch;
    const adapter = new MimirMetricsAdapter({
      url: "https://mimir.example.com",
      username: "u",
      password: "p",
      timeoutMs: 60_000,
    });
    const caller = new AbortController();
    caller.abort();
    await expect(adapter.queryInstant({ query: "up", signal: caller.signal })).rejects.toThrow();
    expect(sent?.aborted).toBe(true);
  });

  // Defect guarded: the abort listener stayed on a long-lived caller signal after every query.
  it("removes its abort listener from the caller's signal when the query ends", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "success", data: { resultType: "vector", result: [] } }),
    })) as unknown as typeof fetch;
    const adapter = new MimirMetricsAdapter({
      url: "https://mimir.example.com",
      username: "u",
      password: "p",
      timeoutMs: 60_000,
    });
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    await adapter.queryInstant({ query: "up", signal: caller.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
