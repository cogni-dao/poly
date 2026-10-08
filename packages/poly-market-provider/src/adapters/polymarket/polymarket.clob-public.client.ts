// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/polymarket.clob-public.client`
 * Purpose: Read-only client for the public, unauthenticated Polymarket CLOB endpoints — market resolution (`/markets/{conditionId}`), price history (`/prices-history`), and token midpoint (`/midpoint`).
 * Scope: Public reads only. Does not place orders, does not require auth, does not load env. Distinct from `polymarket.clob.adapter.ts` (which signs orders) — this is a public-read sibling.
 * Invariants:
 *   - PACKAGES_NO_ENV, READ_ONLY.
 *   - UNAVAILABLE_IS_NOT_ZERO: every method returns a typed empty (`null` / `[]`)
 *     when the upstream fails, is unparseable, or returns an out-of-range value.
 *     It never substitutes 0 for "we could not read it" — callers (wallet-metrics
 *     treats a missing resolution as still-open; the paper fact source refuses to
 *     mark a position it cannot price) depend on being able to tell those apart.
 * Side-effects: IO (HTTP fetch to https://clob.polymarket.com)
 * Links: docs/design/wallet-analysis-components.md, nodes/poly/packages/market-provider/src/analysis/wallet-metrics.ts
 * @public
 */

import type { MarketResolutionInput } from "../../analysis/wallet-metrics.js";

const DEFAULT_CLOB_PUBLIC_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_TIMEOUT_MS = 5_000;

export type ClobMarketResolutionConfig = {
  /** CLOB public base URL (default: https://clob.polymarket.com). */
  readonly baseUrl?: string;
  /** Optional fetch implementation for tests. */
  readonly fetch?: typeof fetch;
  /** Hard per-request timeout (default 5000 ms). */
  readonly timeoutMs?: number;
};

export type ClobPriceHistoryPoint = {
  readonly t: number;
  readonly p: number;
};

export type ClobPriceHistoryParams = {
  readonly startTs?: number;
  readonly endTs?: number;
  readonly fidelity?: number;
  readonly interval?: string;
};

/**
 * Optional structured-log hook for `getPriceHistory`. When supplied, the client
 * emits one `poly.market-price-history.outbound` event per fetch — used to
 * assert PAGE_LOAD_DB_ONLY (task.5018) by tagging the caller component
 * (e.g. `trader-price-history`).
 */
export interface PriceHistoryOutboundLogger {
  info(payload: {
    event: "poly.market-price-history.outbound";
    component: string;
    asset: string;
    interval?: string;
    fidelity?: number;
  }): void;
}

export class PolymarketClobPublicClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config?: ClobMarketResolutionConfig) {
    this.baseUrl = config?.baseUrl ?? DEFAULT_CLOB_PUBLIC_BASE_URL;
    this.fetchImpl = config?.fetch ?? fetch;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Fetch market resolution shape — used by wallet-metrics math.
   * Returns `null` on any error (network, parse, 4xx/5xx); callers treat
   * missing entries as "still open" — see `computeWalletMetrics`.
   */
  async getMarketResolution(
    conditionId: string
  ): Promise<MarketResolutionInput | null> {
    const url = new URL(`/markets/${conditionId}`, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as Record<string, unknown>;
      const rawTokens =
        (json.tokens as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        closed: Boolean(json.closed),
        tokens: rawTokens.map((t) => ({
          token_id: String(t.token_id),
          winner: Boolean(t.winner),
        })),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getPriceHistory(
    asset: string,
    params?: ClobPriceHistoryParams,
    opts?: { logger?: PriceHistoryOutboundLogger; component?: string }
  ): Promise<ClobPriceHistoryPoint[]> {
    const url = new URL("/prices-history", this.baseUrl);
    url.searchParams.set("market", asset);
    url.searchParams.set("interval", params?.interval ?? "max");
    if (params?.fidelity !== undefined) {
      url.searchParams.set("fidelity", String(params.fidelity));
    }
    if (params?.startTs !== undefined) {
      url.searchParams.set("startTs", String(params.startTs));
    }
    if (params?.endTs !== undefined) {
      url.searchParams.set("endTs", String(params.endTs));
    }

    opts?.logger?.info({
      event: "poly.market-price-history.outbound",
      component: opts.component ?? "unknown",
      asset,
      ...(params?.interval !== undefined ? { interval: params.interval } : {}),
      ...(params?.fidelity !== undefined ? { fidelity: params.fidelity } : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const json = (await response.json()) as {
        history?: Array<{ t?: unknown; p?: unknown }>;
      };
      const history = json.history ?? [];
      return history.flatMap((point) => {
        const t = Number(point.t);
        const p = Number(point.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) return [];
        return [{ t, p }];
      });
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Current midpoint price for one CTF token, as a probability in `(0, 1)`.
   *
   * The paper fact source's only live-market read: paper simulates *execution*,
   * never price discovery, so an open paper position is marked to the same mid
   * a live position would be marked to (PAPER_DELEGATES_READS_TO_LIVE).
   *
   * @returns The mid, or `null` when the upstream failed, the body was
   *   unparseable, or the value fell outside `(0, 1)`. `null` means
   *   "unknown" and MUST NOT be coerced to 0 — a 0 mark silently writes an
   *   open position's value off to nothing, which is the exact
   *   NO_FABRICATED_VALUES violation that made paper trading unreadable.
   *   A token that genuinely settled to zero is reported by market resolution,
   *   not by a failed price read.
   */
  async getMidpoint(
    tokenId: string,
    signal?: AbortSignal
  ): Promise<number | null> {
    const url = new URL("/midpoint", this.baseUrl);
    url.searchParams.set("token_id", tokenId);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (signal?.aborted) return null;
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as Record<string, unknown>;
      // Tolerant on the key only, strict on the value. The documented shape is
      // `{"mid":"0.52"}`; accepting `midpoint` too costs nothing and avoids a
      // silent total outage if the field is ever renamed. An unrecognised body
      // still yields `null`, never a number we made up.
      const raw = json.mid ?? json.midpoint;
      if (typeof raw !== "string" && typeof raw !== "number") return null;
      const mid = Number(raw);
      // Exclusive bounds: a CTF token mid of exactly 0 or 1 is a resolved
      // market, which is `poly_market_outcomes`' job to report, not a mark.
      if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) return null;
      return mid;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
