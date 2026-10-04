// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/shared/observability/loki-push-stream`
 * Purpose: Verifies the env-gated lease Loki push sink (bug.5127, bug.5366): gating, labels/auth,
 *   acknowledged serialized delivery, bounded retries, immutable active batches, and memory caps.
 * Scope: Pure unit — injected env/fetch/clock; no real network, no pino integration.
 * Invariants: only 2xx retires a batch; every non-2xx retries; one request/timer; active data is never evicted.
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

interface PushBody {
  streams: { values: [string, string][] }[];
}

function makeFetchMock() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
}

function bodyAt(fetchFn: ReturnType<typeof makeFetchMock>, index: number) {
  const [, init] = fetchFn.mock.calls[index] as [string, RequestInit];
  return JSON.parse(init.body as string) as PushBody;
}

async function settlePromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("createLokiPushStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns undefined when LOKI_PUSH_URL is not set", () => {
    expect(
      createLokiPushStream({ env: { ...BASE_ENV, LOKI_PUSH_URL: undefined } })
    ).toBeUndefined();
  });

  it("batches lines and pushes them with lease labels and basic auth", () => {
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
    const body = JSON.parse(init.body as string) as PushBody & {
      streams: { stream: Record<string, string>; values: [string, string][] }[];
    };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]?.stream).toEqual({
      service: "app",
      service_name: "sample-node",
      source: "lease",
      env: "candidate-a",
      node: "123e4567-e89b-12d3-a456-426614174001",
    });
    expect(body.streams[0]?.values).toEqual([
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

  it.each([400, 401, 403, 404, 408, 409, 413, 422])(
    "retains an immutable active batch across HTTP %i until a 2xx acknowledgement",
    async (status) => {
      let request = 0;
      const fetchFn = vi.fn<typeof fetch>(async () => {
        request += 1;
        return new Response(null, { status: request === 1 ? status : 204 });
      });
      const stream = createLokiPushStream({
        env: BASE_ENV,
        fetchFn,
        now: () => 1_700_000_000_000,
      });
      stream?.write('{"msg":"active"}\n');
      stream?.flushNow();
      await settlePromises();
      stream?.write('{"msg":"successor"}\n');
      stream?.flushNow();
      expect(fetchFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settlePromises();

      expect(bodyAt(fetchFn, 1)).toEqual(bodyAt(fetchFn, 0));
      const successorLines = bodyAt(fetchFn, 2).streams[0]?.values.map(
        ([, line]) => line
      );
      expect(successorLines).toContain('{"msg":"successor"}');
      expect(
        successorLines?.some((line) => line.includes("loki_push_recovered"))
      ).toBe(true);
      vi.clearAllTimers();
    }
  );

  it("retries at exact 1/2/4/8/16/30/30 second boundaries", async () => {
    vi.setSystemTime(0);
    const callTimes: number[] = [];
    const fetchFn = vi.fn<typeof fetch>(async () => {
      callTimes.push(Date.now());
      return new Response(null, { status: 500 });
    });
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write('{"msg":"retry"}\n');
    stream?.flushNow();
    await settlePromises();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const callsBeforeBoundary = callTimes.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(callTimes).toHaveLength(callsBeforeBoundary);
      await vi.advanceTimersByTimeAsync(1);
      await settlePromises();
    }
    expect(callTimes).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000,
    ]);
  });

  it.each([
    { status: 429, retryAfter: "0", delay: 1_000 },
    { status: 429, retryAfter: "45", delay: 30_000 },
    { status: 503, retryAfter: "Tue, 14 Nov 2023 22:13:25 GMT", delay: 5_000 },
    { status: 503, retryAfter: "Tue, 14 Nov 2023 22:13:10 GMT", delay: 1_000 },
    { status: 429, retryAfter: "-1", delay: 1_000 },
    { status: 503, retryAfter: "not-a-date", delay: 1_000 },
    { status: 429, retryAfter: "999999999999999999999", delay: 1_000 },
  ])(
    "bounds Retry-After '$retryAfter' on HTTP $status to $delay ms",
    async ({ status, retryAfter, delay }) => {
      const fetchFn = vi.fn<typeof fetch>(async () =>
        new Response(null, { status, headers: { "retry-after": retryAfter } })
      );
      const stream = createLokiPushStream({
        env: BASE_ENV,
        fetchFn,
        now: () => 1_700_000_000_000,
      });
      stream?.write('{"msg":"retry-after"}\n');
      stream?.flushNow();
      await settlePromises();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      vi.clearAllTimers();
    }
  );

  it("falls back to the next exponential delay after an invalid Retry-After", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 503,
        headers: { "retry-after": "invalid" },
      })
    );
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write('{"msg":"fallback"}\n');
    stream?.flushNow();
    await settlePromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await settlePromises();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not start parallel requests or retry timers during writes, flushes, and interval ticks", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let request = 0;
    const fetchFn = vi.fn<typeof fetch>(() => {
      request += 1;
      if (request === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    for (let i = 0; i < 500; i++) stream?.write(`{"active":${i}}\n`);
    for (let i = 0; i < 500; i++) stream?.write(`{"queued":${i}}\n`);
    stream?.flushNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFirst?.(new Response(null, { status: 500 }));
    await settlePromises();
    stream?.flushNow();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settlePromises();
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(bodyAt(fetchFn, 1)).toEqual(bodyAt(fetchFn, 0));
    const successorLines = bodyAt(fetchFn, 2).streams[0]?.values.map(
      ([, line]) => line
    );
    expect(successorLines).toContain('{"queued":0}');
    expect(successorLines?.[0]).toContain("loki_push_recovered");
  });

  it("retains a byte-identical batch after network rejection and reports recovery", async () => {
    let request = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      request += 1;
      if (request === 1) throw new Error("network down");
      return new Response(null, { status: 204 });
    });
    const stream = createLokiPushStream({
      env: BASE_ENV,
      fetchFn,
      now: () => 1_700_000_000_000,
    });
    stream?.write('{"msg":"ambiguous"}\n');
    stream?.flushNow();
    await settlePromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await settlePromises();

    expect(bodyAt(fetchFn, 1)).toEqual(bodyAt(fetchFn, 0));
    expect(
      bodyAt(fetchFn, 2).streams[0]?.values.some(([, line]) =>
        line.includes("loki_push_recovered")
      )
    ).toBe(true);
  });

  it("retains a byte-identical batch after an abort timeout", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let request = 0;
    const fetchFn = vi.fn<typeof fetch>((_input, init) => {
      request += 1;
      if (request > 1) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("timeout"))
        );
      });
    });
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write('{"msg":"timeout"}\n');
    stream?.flushNow();
    timeout.abort();
    await settlePromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await settlePromises();
    expect(bodyAt(fetchFn, 1)).toEqual(bodyAt(fetchFn, 0));
  });

  it("caps active plus queued entries without evicting the active batch", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let request = 0;
    const fetchFn = vi.fn<typeof fetch>(() => {
      request += 1;
      if (request === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    for (let i = 0; i < 500; i++) stream?.write(`{"active":${i}}\n`);
    const activeBody = bodyAt(fetchFn, 0);
    for (let i = 0; i < 2_500; i++) stream?.write(`{"queued":${i}}\n`);
    expect(bodyAt(fetchFn, 0)).toEqual(activeBody);

    resolveFirst?.(new Response(null, { status: 204 }));
    await settlePromises();
    const calls = fetchFn.mock.calls.map((_, index) => bodyAt(fetchFn, index));
    const allValues = calls.flatMap((call) => call.streams[0]?.values ?? []);
    expect(
      allValues.some(([, line]) => line.includes("loki_push_dropped"))
    ).toBe(true);
    for (const call of calls) {
      expect(call.streams[0]?.values.length ?? 0).toBeLessThanOrEqual(500);
    }
  });

  it("caps active plus queued bytes and keeps each request below its byte ceiling", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let request = 0;
    const fetchFn = vi.fn<typeof fetch>(() => {
      request += 1;
      if (request === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    const line = "x".repeat(32_768);
    for (let i = 0; i < 40; i++) stream?.write(`${line}\n`);
    const activeBody = bodyAt(fetchFn, 0);
    resolveFirst?.(new Response(null, { status: 204 }));
    await settlePromises();

    expect(bodyAt(fetchFn, 0)).toEqual(activeBody);
    const calls = fetchFn.mock.calls.map((_, index) => bodyAt(fetchFn, index));
    expect(
      calls.flatMap((call) => call.streams[0]?.values ?? []).some(([, value]) =>
        value.includes("loki_push_dropped")
      )
    ).toBe(true);
    for (const call of calls) {
      const bytes = (call.streams[0]?.values ?? []).reduce(
        (sum, [, value]) => sum + value.length,
        0
      );
      expect(bytes).toBeLessThanOrEqual(262_144);
    }
  });

  it("truncates oversized lines instead of buffering them whole", () => {
    const fetchFn = makeFetchMock();
    const stream = createLokiPushStream({ env: BASE_ENV, fetchFn });
    stream?.write(`${"x".repeat(100_000)}\n`);
    stream?.flushNow();
    expect(bodyAt(fetchFn, 0).streams[0]?.values[0]?.[1]).toHaveLength(32_768);
  });

  it("never throws from write or flush when fetch throws synchronously", () => {
    const stream = createLokiPushStream({
      env: BASE_ENV,
      fetchFn: (() => {
        throw new Error("sync boom");
      }) as unknown as typeof fetch,
    });
    for (let i = 0; i < 600; i++) {
      expect(() => stream?.write(`{"i":${i}}\n`)).not.toThrow();
    }
    expect(() => stream?.flushNow()).not.toThrow();
  });
});
