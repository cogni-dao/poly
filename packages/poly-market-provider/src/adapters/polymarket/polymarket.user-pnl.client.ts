// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/polymarket.user-pnl.client`
 * Purpose: Read-only client for Polymarket's public user P/L chart service.
 * Scope: HTTP fetch + Zod validation only. Does not read env, persist state, or write to upstreams.
 * Invariants:
 *   - READ_ONLY: only GET requests against the public P/L endpoint.
 *   - FAILS_CLOSED: malformed upstream payloads throw instead of being silently reshaped into fake chart points.
 *   - OUTBOUND_OBSERVABLE: callers may pass a structured logger; when provided, every fetch emits one `poly.user-pnl.outbound` event tagged with `component`, used to assert PAGE_LOAD_DB_ONLY (task.5012) in Loki.
 * Side-effects: IO (HTTP fetch to https://user-pnl-api.polymarket.com); optional structured log emit on each call.
 * Links: docs/spec/poly-copy-trade-execution.md, work/items/task.5012
 * @public
 */

import { z } from "zod";

const DEFAULT_USER_PNL_BASE_URL = "https://user-pnl-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 5_000;

export const PolymarketUserPnlIntervalSchema = z.enum([
  "6h",
  "12h",
  "1d",
  "1w",
  "1m",
  "all",
  "max",
]);
export type PolymarketUserPnlInterval = z.infer<
  typeof PolymarketUserPnlIntervalSchema
>;

export const PolymarketUserPnlFidelitySchema = z.enum([
  "1h",
  "3h",
  "12h",
  "18h",
  "1d",
]);
export type PolymarketUserPnlFidelity = z.infer<
  typeof PolymarketUserPnlFidelitySchema
>;

export const PolymarketUserPnlPointSchema = z.object({
  t: z.coerce.number().int().nonnegative(),
  p: z.coerce.number(),
});
export type PolymarketUserPnlPoint = z.infer<
  typeof PolymarketUserPnlPointSchema
>;

export const PolymarketUserPnlResponseSchema = z.array(
  PolymarketUserPnlPointSchema
);

export interface PolymarketUserPnlClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface GetUserPnlParams {
  interval: PolymarketUserPnlInterval;
  fidelity?: PolymarketUserPnlFidelity;
}

/**
 * Optional structured-log hook. When supplied, the client emits one
 * `poly.user-pnl.outbound` event per fetch — used to assert PAGE_LOAD_DB_ONLY
 * (task.5012) by tagging caller component (e.g. `trader-observation`).
 */
// Type ALIAS, not interface: only alias object types get an implicit index
// signature, which is what makes these assignable to `LoggerPort`'s
// `Record<string, unknown>` parameter. An interface here breaks every caller
// that passes a pino-shaped logger.
export type UserPnlOutboundEvent = {
  event: "poly.user-pnl.outbound";
  component: string;
  wallet: string;
  interval: PolymarketUserPnlInterval;
  fidelity?: PolymarketUserPnlFidelity;
};

/**
 * OUTCOME_NOT_JUST_ATTEMPT (bug.5306) — the `outbound` event above records that
 * a fetch was STARTED and nothing about how it ended, so a degraded P/L feed is
 * indistinguishable from a healthy one in the logs. Prod showed 120 `outbound`
 * lines in 11 minutes with no way to tell success from failure; the only proof
 * ingestion worked came from the observation tick's insert counts, one layer up
 * and one job away. This event closes that.
 */
export type UserPnlResultEvent = {
  event: "poly.user-pnl.result";
  component: string;
  wallet: string;
  interval: PolymarketUserPnlInterval;
  fidelity?: PolymarketUserPnlFidelity;
  outcome: "ok" | "error";
  duration_ms: number;
  /** Points returned, on `ok`. Zero is a legitimate answer, not a failure. */
  points?: number;
  /** Message only, on `error`. This client's messages carry status/timeout and
   *  the pathname — never wallet secrets or response bodies. */
  err?: string;
};

export interface UserPnlOutboundLogger {
  info(payload: UserPnlOutboundEvent | UserPnlResultEvent): void;
  /** Failures land here when the logger has it; `info` is the fallback, so a
   *  minimal logger still gets the outcome rather than silently dropping it. */
  warn?(payload: UserPnlResultEvent): void;
}

export class PolymarketUserPnlClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config?: PolymarketUserPnlClientConfig) {
    this.baseUrl = config?.baseUrl ?? DEFAULT_USER_PNL_BASE_URL;
    this.fetchImpl = config?.fetch ?? fetch;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getUserPnl(
    wallet: string,
    params: GetUserPnlParams,
    opts?: {
      logger?: UserPnlOutboundLogger;
      component?: string;
      /** Cooperative cancellation — aborts the underlying fetch (task.5015). */
      signal?: AbortSignal | undefined;
    }
  ): Promise<PolymarketUserPnlPoint[]> {
    assertWallet(wallet);

    const url = new URL("/user-pnl", this.baseUrl);
    url.searchParams.set("user_address", wallet);
    url.searchParams.set("interval", params.interval);
    if (params.fidelity) {
      url.searchParams.set("fidelity", params.fidelity);
    }

    opts?.logger?.info({
      event: "poly.user-pnl.outbound",
      component: opts.component ?? "unknown",
      wallet,
      interval: params.interval,
      ...(params.fidelity !== undefined ? { fidelity: params.fidelity } : {}),
    });

    const startedAt = Date.now();
    const base = {
      component: opts?.component ?? "unknown",
      wallet,
      interval: params.interval,
      ...(params.fidelity !== undefined ? { fidelity: params.fidelity } : {}),
    } as const;
    try {
      const json = await this.fetchJson(url, opts?.signal);
      const points = PolymarketUserPnlResponseSchema.parse(json);
      opts?.logger?.info({
        event: "poly.user-pnl.result",
        ...base,
        outcome: "ok",
        duration_ms: Date.now() - startedAt,
        points: points.length,
      });
      return points;
    } catch (err: unknown) {
      const payload: UserPnlResultEvent = {
        event: "poly.user-pnl.result",
        ...base,
        outcome: "error",
        duration_ms: Date.now() - startedAt,
        err: err instanceof Error ? err.message : "non-error thrown",
      };
      // Prefer `warn` so a failing feed is filterable by level, but never lose
      // the event when the caller's logger lacks it.
      if (opts?.logger?.warn) opts.logger.warn(payload);
      else opts?.logger?.info(payload);
      throw err;
    }
  }

  /**
   * `signal` (task.5015): optional caller-owned cancellation, combined with
   * the per-request timeout controller; caller aborts reject distinctly from
   * timeouts.
   */
  private async fetchJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Polymarket user-pnl API error: ${response.status} ${response.statusText} (${url.pathname})`
        );
      }
      return await response.json();
    } catch (err) {
      if (signal?.aborted) {
        throw new Error(
          `Polymarket user-pnl API request aborted by caller (${url.pathname})`
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Polymarket user-pnl API timeout after ${this.timeoutMs}ms (${url.pathname})`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

function assertWallet(wallet: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
}
