// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/position-observation-control`
 * Purpose: Local single-flight admission and finite invocation allowances.
 * Scope: Position observation only; no durable lease or fleet rate claim.
 * Invariants: retain admission until actual IO settles; one retry token across
 * all preparations/cohorts; charged calls conservatively bound HTTP starts.
 * Side-effects: bounded timers and a process-local in-flight registry.
 * @public
 */
import { PolyDataApiRequestError } from "@cogni/poly-market-provider/adapters/polymarket";

export class PositionBalanceTransportError extends Error {}
export class PositionObservationBudgetError extends Error {
  constructor(readonly component: string) {
    super(`position observation ${component} allowance exhausted`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class PositionObservationController {
  private readonly active = new Map<string, Promise<unknown>>();
  readonly now: () => number;
  readonly random: () => number;
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(
    input: {
      now?: () => number;
      random?: () => number;
      wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {}
  ) {
    this.now = input.now ?? Date.now;
    this.random = input.random ?? Math.random;
    this.wait = input.wait ?? sleep;
  }

  get activeCount(): number {
    return this.active.size;
  }

  async run<T>(
    wallet: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<{ value: T; joined: boolean } | { deferred: "capacity" }> {
    signal?.throwIfAborted();
    const key = wallet.toLowerCase();
    const existing = this.active.get(key);
    if (existing) {
      // A joiner's cancellation abandons only its wait, never the initiator.
      return {
        value: await join(existing as Promise<T>, signal),
        joined: true,
      };
    }
    if (this.active.size >= 3) return { deferred: "capacity" };
    const pending = Promise.resolve().then(operation);
    this.active.set(key, pending);
    try {
      return { value: await pending, joined: false };
    } finally {
      if (this.active.get(key) === pending) this.active.delete(key);
    }
  }
}

async function join<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export const positionObservationController =
  new PositionObservationController();

export class PositionObservationBudget {
  dataApiCalls = 0;
  chunkCount = 0;
  startedAt = 0;
  retryCount = 0;
  retryReason: string | null = null;
  budgetExhausted: string | null = null;
  completedAt: string | null = null;
  constructor(readonly control = positionObservationController) {}

  private check(
    component: "data_api" | "authority",
    signal?: AbortSignal
  ): void {
    signal?.throwIfAborted();
    if (
      (component === "data_api" && this.dataApiCalls >= 21) ||
      (component === "authority" &&
        (this.chunkCount >= 50 ||
          (this.startedAt > 0 &&
            this.control.now() - this.startedAt >= 30_000)))
    ) {
      this.budgetExhausted = component;
      throw new PositionObservationBudgetError(component);
    }
  }

  async call<T>(
    component: "data_api" | "authority",
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const invoke = () => {
      this.check(component, signal);
      if (component === "data_api") this.dataApiCalls += 1;
      else {
        if (this.startedAt === 0) this.startedAt = this.control.now();
        this.chunkCount += 1;
      }
      return operation();
    };
    try {
      return await invoke();
    } catch (err) {
      const retryable =
        err instanceof PolyDataApiRequestError
          ? err.retryable
          : err instanceof PositionBalanceTransportError;
      if (!retryable || this.retryCount > 0 || signal?.aborted) throw err;
      this.check(component, signal);
      this.retryReason = component;
      const delay = 750 + Math.floor(this.control.random() * 501);
      if (
        component === "authority" &&
        this.control.now() + delay - this.startedAt >= 30_000
      ) {
        this.budgetExhausted = component;
        throw new PositionObservationBudgetError(component);
      }
      await this.control.wait(delay, signal);
      this.check(component, signal);
      this.retryCount += 1;
      return invoke();
    }
  }
}
