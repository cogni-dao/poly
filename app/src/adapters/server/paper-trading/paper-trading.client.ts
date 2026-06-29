// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/paper-trading/paper-trading.client`
 * Purpose: Typed HTTP client for the pod-loopback paper trading sidecar.
 * Scope: Sidecar IPC only. Does not implement matching, pricing, or live trading.
 * Invariants:
 *   - PAPER_SIDECAR_LOOPBACK: default URL is 127.0.0.1 and deploy wiring must
 *     inject the sidecar into the same pod instead of exposing a Service.
 *   - PAPER_MODE_ONLY: this client refuses to construct unless the app env is
 *     explicitly in paper mode.
 * Side-effects: HTTP IO to PAPER_SIDECAR_URL.
 * @public
 */

import { z } from "zod";

import type { ServerEnv } from "@/shared/env/server-env";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:9100";
const REQUEST_TIMEOUT_MS = 10_000;

export const PaperOrderStatusSchema = z.enum([
  "open",
  "filled",
  "cancelled",
  "expired",
]);

export const PaperPlaceOrderRequestSchema = z.object({
  client_order_id: z.string().min(1),
  market_id: z.string().min(1),
  token_id: z.string().min(1).optional(),
  outcome: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  size_usdc: z.number().positive(),
  limit_price: z.number().positive(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const PaperOrderReceiptSchema = z.object({
  order_id: z.string().min(1),
  client_order_id: z.string().min(1),
  status: PaperOrderStatusSchema,
  filled_size_usdc: z.number().nonnegative(),
  fill_price: z.number().nonnegative().optional(),
  total_shares: z.number().nonnegative().optional(),
  fees_usdc: z.number().nonnegative().optional(),
  submitted_at: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const PaperVersionSchema = z.object({
  buildSha: z.string().min(1),
  upstreamPaperTraderSha: z.string().min(1),
});

export type PaperPlaceOrderRequest = z.infer<
  typeof PaperPlaceOrderRequestSchema
>;
export type PaperOrderReceipt = z.infer<typeof PaperOrderReceiptSchema>;
export type PaperVersion = z.infer<typeof PaperVersionSchema>;

export class PaperTradingSidecarError extends Error {
  constructor(
    message: string,
    readonly details: {
      operation:
        | "health"
        | "ready"
        | "version"
        | "placeOrder"
        | "cancelOrder"
        | "getOrder";
      status?: number;
      responseBody?: string;
    }
  ) {
    super(message);
    this.name = "PaperTradingSidecarError";
  }
}

export interface PaperTradingClientConfig {
  sidecarUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PaperTradingClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: PaperTradingClientConfig = {}) {
    this.baseUrl = (config.sidecarUrl ?? DEFAULT_SIDECAR_URL).replace(/\/$/, "");
    this.fetchImpl =
      config.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async health(): Promise<{ status: string }> {
    return this.requestJson(
      "health",
      "/healthz",
      z.object({ status: z.string() })
    );
  }

  async ready(): Promise<{ status: string }> {
    return this.requestJson(
      "ready",
      "/readyz",
      z.object({ status: z.string() })
    );
  }

  async version(): Promise<PaperVersion> {
    return this.requestJson("version", "/version", PaperVersionSchema);
  }

  async placeOrder(input: PaperPlaceOrderRequest): Promise<PaperOrderReceipt> {
    const body = PaperPlaceOrderRequestSchema.parse(input);
    return this.requestJson("placeOrder", "/place-order", PaperOrderReceiptSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("cancelOrder", `/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
    });
  }

  async getOrder(orderId: string): Promise<PaperOrderReceipt | null> {
    const response = await this.request(
      "getOrder",
      `/orders/${encodeURIComponent(orderId)}`,
      undefined,
      { allowNotFound: true }
    );
    if (response.status === 404) return null;
    return PaperOrderReceiptSchema.parse(await response.json());
  }

  private async requestJson<T>(
    operation: PaperTradingSidecarError["details"]["operation"],
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit
  ): Promise<T> {
    const response = await this.request(operation, path, init);
    return schema.parse(await response.json());
  }

  private async request(
    operation: PaperTradingSidecarError["details"]["operation"],
    path: string,
    init?: RequestInit,
    options?: { allowNotFound?: boolean }
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PaperTradingSidecarError(`paper sidecar unavailable: ${reason}`, {
        operation,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok && !(options?.allowNotFound && response.status === 404)) {
      const responseBody = await safeText(response);
      throw new PaperTradingSidecarError(
        `paper sidecar ${operation} failed: ${response.status} ${responseBody}`,
        { operation, status: response.status, responseBody }
      );
    }

    return response;
  }
}

export function createPaperTradingClientFromEnv(
  env: Pick<ServerEnv, "PAPER_ENFORCE_MODE" | "PAPER_SIDECAR_URL">
): PaperTradingClient {
  if (env.PAPER_ENFORCE_MODE !== "paper") {
    throw new Error(
      `PaperTradingClient requires PAPER_ENFORCE_MODE=paper, got ${env.PAPER_ENFORCE_MODE}.`
    );
  }

  return new PaperTradingClient({ sidecarUrl: env.PAPER_SIDECAR_URL });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
