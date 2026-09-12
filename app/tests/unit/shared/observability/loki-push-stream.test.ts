// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/shared/observability/loki-push-stream`
 * Purpose: Verifies the env-gated lease Loki push sink (bug.5127): gating on LOKI_PUSH_URL, batch shape +
 *   labels + basic auth, size-triggered and timer-triggered flushes, memory caps with oldest-first drops,
 *   and fail-open behavior on push failure.
 * Scope: Pure unit — injected env/fetch/clock; no real network, no pino integration.
 * Invariants: createLokiPushStream never throws; a failed push drops the batch; buffer never exceeds caps.
 * Side-effects: none
 * Links: src/shared/observability/server/loki-push-stream.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLokiPushStream } from "@/shared/observability/server/loki-push-stream";

const BASE_ENV = {
  LOKI_PUSH_URL: "https://logs.example.net/loki/api/v1/push",
  LOKI_PUSH_USER: "123456",
  LOKI_PUSH_PASSWORD: "glc_write_only",
  LOKI_PUSH_SOURCE: "lease",
  SERVICE_NAME: "app",
  NODE_NAME: "sample-node",
  DEPLOY_ENVIRONMENT: "candidate-a",
  COGNI_NODE_ID: "123e4567-e89b-12d3-a456-426614174001",
};

function makeFetchMock() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
}

describe("createLokiPushStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined when LOKI_PUSH_URL is not set", () => {
    expect(
      createLokiPushStream({ env: { ...BASE_ENV, LOKI_PUSH_URL: undefined } })
    ).toBeUndefined();
  });

  it("batches lines and pushes them with lease labels and basic auth", async () => {
    const fetchFn = makeFetchMock();
    const stream = createLokiPushStream({
      env: BASE_ENV,
      fetchFn,
      now: () => 1_700_000_000_000,
    });
    stream?.write('{"msg":"one"}\n');
    stream?.write('{"msg":"two"}\n');
    expect(fetchFn).not.toHaveBeenCalled();
    stream?.flushNow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_ENV.LOKI_PUSH_URL);
    expect(
      (init.headers as Record<string, string>).authorization
    ).toBe(`Basic ${Buffer.from("123456:glc_write_only").toString("base64")}`);
    const body = JSON.parse(init.body as string);
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].stream).toEqual({
      service: "app",
      service_name: "sample-node",
      source: "lease",
      env: "candidate-a",
      node: "123e4567-e89b-12d3-a456-426614174001",
    });
    expect(body.streams[0].values).toEqual([
      ["1700000000000000000", '{"msg":"one"}'],
      ["1700000000000000000", '{"msg":"two"}'],
    ]);
  });

  it("flushes on the interval timer without an explicit flush call", () => {
    const fetchFn = makeFetchMock();
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write('{"msg":"timed"}\n');
    expect(fetchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately once the batch threshold is reached", () => {
    const fetchFn = makeFetchMock();
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    for (let i = 0; i < 500; i++) stream?.write(`{"i":${i}}\n`);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("caps the buffer, drops oldest lines, and reports the drop count", async () => {
    const fetchFn = makeFetchMock();
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    // The size-triggered flush at 500 claims one batch and stays in flight for
    // the whole synchronous loop, so the remaining 2500 writes overflow the
    // 2000-entry hard cap and must drop the oldest 500.
    for (let i = 0; i < 3_000; i++) stream?.write(`{"i":${i}}\n`);
    // First advance lets the in-flight push settle; second flushes the
    // capped remainder including the drop report.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const calls = fetchFn.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as {
        streams: { values: [string, string][] }[];
      }
    );
    const allValues = calls.flatMap((c) => c.streams[0]?.values ?? []);
    const dropReport = allValues.find(([, line]) =>
      line.includes("loki_push_dropped")
    );
    expect(dropReport).toBeDefined();
    // No single payload may exceed cap + drop-report line.
    for (const c of calls) {
      expect(c.streams[0]?.values.length ?? 0).toBeLessThanOrEqual(2_001);
    }
  });

  it("stays fail-open when the push rejects and drops the failed batch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write('{"msg":"lost"}\n');
    expect(() => stream?.flushNow()).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    // Batch was claimed and dropped; a later flush sends nothing stale.
    stream?.flushNow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized lines instead of buffering them whole", () => {
    const fetchFn = makeFetchMock();
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write(`${"x".repeat(100_000)}\n`);
    stream?.flushNow();
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.streams[0].values[0][1]).toHaveLength(32_768);
  });

  it("never throws from write even when internals are broken", () => {
    const stream = createLokiPushStream({
      env: BASE_ENV,
      // A fetch that throws synchronously exercises the flush try/catch.
      fetchFn: (() => {
        throw new Error("sync boom");
      }) as unknown as typeof fetch,
    });
    for (let i = 0; i < 600; i++) {
      expect(() => stream?.write(`{"i":${i}}\n`)).not.toThrow();
    }
  });
});
