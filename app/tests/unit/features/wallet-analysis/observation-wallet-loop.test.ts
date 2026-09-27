// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/observation-wallet-loop`
 * Purpose: Prove the bounded-parallel wallet fan-out contract (task.5015):
 *          the concurrency cap is respected, an aborted signal stops
 *          remaining wallets promptly, and one wallet's failure never kills
 *          sibling wallets.
 * Scope: Pure orchestration tests for `runBoundedWalletLoop` using deferred
 *        promises as fake per-wallet work. No DB, no I/O, no timers.
 * Invariants:
 *   - BOUNDED_PARALLEL_WALLETS: never more than `concurrency` in flight.
 *   - COOPERATIVE_CANCELLATION: wallets not yet started when the signal
 *     aborts never run; abort-interrupted rejections count `aborted` and do
 *     not reach `onError`.
 *   - ERROR_ISOLATION: a rejecting wallet routes to `onError`; siblings run
 *     and the loop resolves.
 * Side-effects: none
 * Links: work/items/task.5015,
 *        src/features/wallet-analysis/server/trader-observation-service.ts
 * @public
 */

import { describe, expect, it, vi } from "vitest";
import { runBoundedWalletLoop } from "@/features/wallet-analysis/server/trader-observation-service";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runBoundedWalletLoop (task.5015)", () => {
  it("never runs more than `concurrency` wallets in flight", async () => {
    const wallets = Array.from({ length: 10 }, (_, i) => `wallet-${i}`);
    const gates = wallets.map(() => deferred());
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;

    const loopPromise = runBoundedWalletLoop({
      wallets,
      concurrency: 3,
      run: async (wallet) => {
        inFlight += 1;
        started += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gates[wallets.indexOf(wallet)]?.promise;
        inFlight -= 1;
      },
    });

    // The first 3 start; the 4th must wait for a slot.
    await vi.waitFor(() => expect(started).toBe(3));
    expect(inFlight).toBe(3);

    gates[0]?.resolve();
    await vi.waitFor(() => expect(started).toBe(4));
    expect(inFlight).toBe(3);

    for (const gate of gates) gate.resolve();
    const result = await loopPromise;

    expect(maxInFlight).toBe(3);
    expect(result).toEqual({ processed: 10, aborted: 0 });
  });

  it("abort stops remaining wallets promptly; in-flight completions still count processed", async () => {
    const wallets = ["a", "b", "c", "d", "e", "f"];
    const gates = new Map(wallets.map((w) => [w, deferred()]));
    const startedWallets: string[] = [];
    const controller = new AbortController();

    const loopPromise = runBoundedWalletLoop({
      wallets,
      concurrency: 2,
      signal: controller.signal,
      run: async (wallet) => {
        startedWallets.push(wallet);
        await gates.get(wallet)?.promise;
      },
    });

    await vi.waitFor(() => expect(startedWallets).toEqual(["a", "b"]));
    controller.abort(new Error("tick timeout"));

    // Only the two in-flight wallets need to settle; the loop must then
    // resolve without the remaining four gates ever being touched.
    gates.get("a")?.resolve();
    gates.get("b")?.resolve();
    const result = await loopPromise;

    expect(startedWallets).toEqual(["a", "b"]);
    expect(result).toEqual({ processed: 2, aborted: 4 });
  });

  it("counts an abort-interrupted rejection as aborted, not an error", async () => {
    const wallets = ["a", "b", "c"];
    const gate = deferred();
    const controller = new AbortController();
    const onError = vi.fn();

    const loopPromise = runBoundedWalletLoop({
      wallets,
      concurrency: 1,
      signal: controller.signal,
      run: async (wallet) => {
        if (wallet === "a") await gate.promise;
      },
      onError,
    });

    await vi.waitFor(() => expect(controller.signal.aborted).toBe(false));
    controller.abort(new Error("tick timeout"));
    // Simulate the in-flight fetch rejecting because the signal aborted.
    gate.reject(new Error("request aborted by caller"));
    const result = await loopPromise;

    expect(result).toEqual({ processed: 0, aborted: 3 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("routes one wallet's failure to onError without killing siblings", async () => {
    const wallets = ["good-1", "bad", "good-2"];
    const completed: string[] = [];
    const onError = vi.fn();

    const result = await runBoundedWalletLoop({
      wallets,
      concurrency: 2,
      run: async (wallet) => {
        if (wallet === "bad") throw new Error("wallet exploded");
        completed.push(wallet);
      },
      onError,
    });

    expect(completed.sort()).toEqual(["good-1", "good-2"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("bad", expect.any(Error));
    // A failed wallet still counts processed — the tick ran it to a settle.
    expect(result).toEqual({ processed: 3, aborted: 0 });
  });

  it("resolves immediately with all wallets aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => undefined);

    const result = await runBoundedWalletLoop({
      wallets: ["a", "b"],
      concurrency: 3,
      signal: controller.signal,
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, aborted: 2 });
  });
});
