// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/paper/paper.adapter`
 * Purpose: Paper-trading adapter — typed IPC client over the `agent-next/polymarket-paper-trader`
 *   sidecar. Same `MarketProviderPort` shape as `PolymarketClobAdapter`, but Run-phase methods
 *   route to a loopback HTTP endpoint instead of the CLOB. Read-phase methods
 *   (`listMarkets`, `getMarketConstraints`) delegate to an injected live `readSource` so paper
 *   trades respect real tick + min-size constraints from Polymarket production.
 * Scope: HTTP IPC + Zod parsing. **No fill logic.** The fill model lives upstream in the
 *   `agent-next/polymarket-paper-trader` sidecar (MIT). If the sidecar misreports fees or fills,
 *   the bug is upstream — we do not patch it locally.
 * Invariants:
 *   - ADAPTERS_NOT_IN_CORE, PACKAGES_NO_ENV — sidecar URL is constructor-injected.
 *   - MARKET_PROVIDER_SHAPE_FROZEN — constructor + method list is stable from P1 on.
 *   - PAPER_DELEGATES_READS_TO_LIVE — `listMarkets` + `getMarketConstraints` must return live
 *     data so the copy-trade algorithm exercises real tick + min-size code paths under paper
 *     mode. Without delegation, `PRICE_TICK_NORMALIZED` cannot fire correctly.
 *   - PAPER_POPULATES_FILLED_USDC — the receipt's `filled_size_usdc` must reflect the sidecar's
 *     actual fill amount (0 for resting, partial for partial fills, full notional for fills).
 *     Required for `CAP_COUNTS_REALIZED_ON_CANCEL`; without it, cap accounting drifts on paper.
 *   - PAPER_GETORDER_NEVER_NULL — the discriminated `GetOrderResult` is enforced exactly as in
 *     the CLOB adapter (task.0328 CP1).
 * Side-effects: HTTP IO to the loopback sidecar.
 * Links: docs/research/poly-paper-trading-mode.md, work/projects/proj.poly-paper-trading.md
 * @public
 */

import { z } from "zod";

import {
  type GetOrderResult,
  type OrderIntent,
  OrderReceiptSchema,
} from "../../domain/order.js";
import type {
  ListMarketsParams,
  MarketProvider,
  NormalizedMarket,
} from "../../domain/schemas.js";
import {
  type MarketConstraints,
  type MarketProviderConfig,
  type MarketProviderPort,
  OrderNotSupportedError,
} from "../../port/market-provider.port.js";

const DEFAULT_SIDECAR_BASE_URL = "http://localhost:9100";

export interface PaperAdapterConfig extends MarketProviderConfig {
  /**
   * The underlying platform this paper adapter simulates. Used as a label on
   * telemetry emitted by the sidecar wrapper.
   */
  providerIdentity?: MarketProvider;
  /**
   * Base URL of the `agent-next/polymarket-paper-trader` sidecar. The sidecar
   * is expected to run in the same k8s pod and be reachable on loopback. The
   * adapter itself reads no env vars (`PACKAGES_NO_ENV`); the bootstrap supplies
   * this from `PAPER_SIDECAR_URL`.
   */
  sidecarBaseUrl?: string;
  /**
   * Live `MarketProviderPort` adapter the paper adapter delegates read calls
   * to. `listMarkets` and `getMarketConstraints` must return real Polymarket
   * data — paper trades respect real ticks + min-size + market discovery.
   */
  readSource?: MarketProviderPort;
  /**
   * Injectable for tests. Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
}

/** Network timeout for a single sidecar call (ms). */
const SIDECAR_TIMEOUT_MS = 10_000;

/**
 * Structured failure thrown by every paper-adapter HTTP method. Carries
 * `.details` shaped like the live-CLOB error path so the mirror-pipeline
 * catch (`err.details.error_code`) classifies paper failures the same way it
 * classifies CLOB failures — instead of falling back to the generic
 * `placement_failed` bucket with no `errorReason` (bug.5060).
 */
export class PaperAdapterError extends Error {
  readonly details: {
    error_code:
      | "paper_intent_invalid"
      | "paper_sidecar_http_error"
      | "paper_sidecar_unavailable";
    reason: string;
    error_class: "PaperAdapterError";
    operation: "placeOrder" | "cancelOrder" | "getOrder";
    http_status?: number;
    response_body?: string;
  };
  constructor(
    message: string,
    details: Omit<PaperAdapterError["details"], "error_class">
  ) {
    super(message);
    this.name = "PaperAdapterError";
    this.details = { ...details, error_class: "PaperAdapterError" };
  }
}

/** Request body shape posted to the sidecar's place-order endpoint. */
const PlaceOrderRequestSchema = z.object({
  client_order_id: z.string().min(1),
  market_id: z.string().min(1),
  token_id: z.string().min(1).optional(),
  outcome: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  size_usdc: z.number().positive(),
  limit_price: z.number().positive(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * PaperAdapter — Phase 3 body.
 *
 * Methods that touch order state route HTTP to the sidecar. Methods that read
 * market structure delegate to the injected `readSource`. The adapter holds no
 * credentials and no per-pod state — the sidecar owns the open-order book.
 *
 * @public
 */
export class PaperAdapter implements MarketProviderPort {
  readonly provider: MarketProvider;

  private readonly sidecarBaseUrl: string;
  private readonly readSource: MarketProviderPort | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PaperAdapterConfig = {}) {
    this.provider = config.providerIdentity ?? "polymarket";
    this.sidecarBaseUrl = (
      config.sidecarBaseUrl ?? DEFAULT_SIDECAR_BASE_URL
    ).replace(/\/$/, "");
    this.readSource = config.readSource;
    this.fetchImpl =
      config.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch);
  }

  async listMarkets(
    params?: ListMarketsParams
  ): Promise<NormalizedMarket[]> {
    if (!this.readSource) {
      throw new OrderNotSupportedError(
        this.provider,
        "placeOrder",
        "paper adapter requires `readSource` for market discovery — inject a live adapter at bootstrap"
      );
    }
    return this.readSource.listMarkets(params);
  }

  async placeOrder(intent: OrderIntent): Promise<OrderReceiptSchemaInferred> {
    // Sidecar speaks the same shape as our OrderIntent (minus provider — implied
    // by sidecar identity). Strip provider; the rest passes through.
    const parsed = PlaceOrderRequestSchema.safeParse({
      client_order_id: intent.client_order_id,
      market_id: intent.market_id,
      token_id:
        typeof intent.attributes?.asset === "string"
          ? intent.attributes.asset
          : typeof intent.attributes?.token_id === "string"
            ? intent.attributes.token_id
            : undefined,
      outcome: intent.outcome,
      side: intent.side,
      size_usdc: intent.size_usdc,
      limit_price: intent.limit_price,
      attributes: intent.attributes,
    });
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new PaperAdapterError(
        `paper adapter rejected intent: ${reason}`,
        {
          error_code: "paper_intent_invalid",
          reason,
          operation: "placeOrder",
        }
      );
    }
    const body = parsed.data;

    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.sidecarBaseUrl}/place-order`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PaperAdapterError(
        `paper sidecar unreachable: ${reason}`,
        {
          error_code: "paper_sidecar_unavailable",
          reason,
          operation: "placeOrder",
        }
      );
    }

    if (!response.ok) {
      const text = await this.safeReadText(response);
      throw new PaperAdapterError(
        `paper sidecar place-order failed: ${response.status} ${text}`,
        {
          error_code: "paper_sidecar_http_error",
          reason: text,
          operation: "placeOrder",
          http_status: response.status,
          response_body: text,
        }
      );
    }

    const json = await response.json();
    return OrderReceiptSchema.parse(json);
  }

  async cancelOrder(orderId: string): Promise<void> {
    const response = await this.fetchWithTimeout(
      `${this.sidecarBaseUrl}/orders/${encodeURIComponent(orderId)}/cancel`,
      { method: "POST" }
    );

    // 404 on cancel is idempotent — already-cancelled or never-existed orders
    // should not raise per the port contract.
    if (response.status === 404) return;
    if (!response.ok) {
      const text = await this.safeReadText(response);
      throw new PaperAdapterError(
        `paper sidecar cancel-order failed: ${response.status} ${text}`,
        {
          error_code: "paper_sidecar_http_error",
          reason: text,
          operation: "cancelOrder",
          http_status: response.status,
          response_body: text,
        }
      );
    }
  }

  async getMarketConstraints(tokenId: string): Promise<MarketConstraints> {
    // PAPER_DELEGATES_READS_TO_LIVE — paper trades must respect real ticks +
    // min-size from Polymarket production. The bootstrap factory injects the
    // live read source.
    if (!this.readSource) {
      throw new OrderNotSupportedError(
        this.provider,
        "getMarketConstraints",
        "paper adapter requires `readSource` for tick + min-size — inject a live adapter at bootstrap"
      );
    }
    return this.readSource.getMarketConstraints(tokenId);
  }

  async getOrder(orderId: string): Promise<GetOrderResult> {
    const response = await this.fetchWithTimeout(
      `${this.sidecarBaseUrl}/orders/${encodeURIComponent(orderId)}`,
      { method: "GET" }
    );

    // PAPER_GETORDER_NEVER_NULL — return the discriminated `not_found` sentinel.
    if (response.status === 404) return { status: "not_found" };

    if (!response.ok) {
      const text = await this.safeReadText(response);
      throw new PaperAdapterError(
        `paper sidecar get-order failed: ${response.status} ${text}`,
        {
          error_code: "paper_sidecar_http_error",
          reason: text,
          operation: "getOrder",
          http_status: response.status,
          response_body: text,
        }
      );
    }

    const json = await response.json();
    const receipt = OrderReceiptSchema.parse(json);
    return { found: receipt };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "<no body>";
    }
  }
}

// Inline type alias to avoid re-importing the inferred type from the domain
// module — keeps the public shape stable.
type OrderReceiptSchemaInferred = z.infer<typeof OrderReceiptSchema>;
