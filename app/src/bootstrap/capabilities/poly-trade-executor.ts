// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/poly-trade-executor`
 * Purpose: Per-tenant Polymarket trade executor. Given a `billingAccountId`,
 *   returns a `PolyTradeExecutor` with `placeIntent` / `closePosition` /
 *   `exitPosition` / `listPositions` methods. Entry and mirror-placement
 *   flows route through `PolyTraderWalletPort.authorizeIntent` before
 *   signing so scope + cap + grant-revoke checks run on the hot path.
 *   User-initiated exits are authorized by active tenant connection instead
 *   of grant caps so users can always unwind their own positions. Caches
 *   the per-tenant `PolymarketClobAdapter` + viem `WalletClient` so the
 *   Privy resolve / clob-client construction costs are paid once per tenant
 *   per process. CLOB credential provisioning lives in `poly-clob-creds.ts`;
 *   this module re-exports that boundary for legacy callers while keeping
 *   order execution separate from wallet setup.
 *
 *   Redeem is NOT a method on this executor — task.0388 moved it to the
 *   event-driven pipeline (`@bootstrap/redeem-pipeline`). The manual route
 *   enqueues a job through `RedeemJobsPort` directly.
 * Scope: Runtime composition. Does not read env directly (`serverEnv` supplies
 *   strings at the caller); does not persist anything. All HTTPS + signing
 *   happens inside the cached adapter.
 * Invariants:
 *   - AUTHORIZED_PLACE_ONLY — `placeIntent` calls `authorizeIntent` first and
 *     refuses to signal `placeOrder` when the result is `{ok: false}`. The
 *     branded `AuthorizedSigningContext` is the only way the adapter reaches
 *     the CLOB; bypassing the executor bypasses the brand.
 *   - TENANT_CACHE_KEYS_BILLING_ACCOUNT — cached entries are keyed on
 *     `billingAccountId`. No wallet-id / address keys; those can rotate while
 *     the billing account id stays stable.
 *   - CACHE_INVALIDATED_BY_AUTHORIZE — cached signing state is NOT consulted
 *     for auth decisions. Every `placeIntent` call re-runs `authorizeIntent`,
 *     which reads connection + grant rows fresh, so a revoke that lands after
 *     the executor was constructed cannot bypass it.
 *   - NO_STATIC_CLOB_IMPORT — CLOB SDKs are pulled in via dynamic imports at
 *     the bootstrap / provider boundaries so pods without Polymarket creds
 *     never load them on unrelated paths.
 *   - LAZY_INIT_ADAPTER — adapter construction happens on first per-tenant
 *     call. Subsequent calls reuse the cached instance until the process exits
 *     or an ops path invalidates that tenant after CLOB credential rotation.
 *   - SHARED_PUBLIC_CLIENT — the `viem.PublicClient` used for RPC reads is a
 *     process-level singleton; wallet clients fan out per tenant.
 *   - DATA_API_DISCOVERY_HINT_FOR_EXIT — `exitPosition` uses Data API as the
 *     cheap discovery path only. If a ledger-backed token is omitted there,
 *     CTF ERC-1155 `balanceOf(funder, tokenId)` is the close authority before
 *     deciding there is no position to sell.
 *   - PAPER_DISPATCH_IS_ENV_ONLY — `PAPER_ENFORCE_MODE=paper` is the ONLY thing
 *     that activates paper routing. The factory chooses between `buildExecutor`
 *     (live CLOB) and `buildPaperOnlyExecutor` (sidecar) once, at executor-
 *     construction time, based on the env. Pairs with
 *     `MODE_STAMPED_AT_LEDGER_FROM_ENV` (order-ledger.ts) — the ledger writes
 *     the same env-derived value to `poly_copy_trade_{fills,decisions}.mode`,
 *     so audit + dispatch agree by construction. Per-target `mode` columns
 *     and `intent.attributes.mode` shadows were removed (task.5003); any new
 *     attribute placed on an intent is purely advisory and the executor never
 *     reads it.
 * Side-effects: on first `placeIntent` for a new tenant: HTTPS to Polymarket
 *   CLOB + Privy API. Subsequent calls reuse cached clients.
 * Links: work/items/task.0318 (Phase B3), work/items/task.0388,
 *   docs/spec/poly-tenant-and-collateral.md
 * @public
 */

import type {
  GetOrderResult,
  LoggerPort,
  MetricsPort,
  OrderIntent,
  OrderReceipt,
} from "@cogni/poly-market-provider";
import type { PolymarketUserPosition } from "@cogni/poly-market-provider/adapters/polymarket";
import type {
  OrderIntentSummary,
  PolyTraderWalletPort,
} from "@cogni/poly-wallet";
import type { Logger } from "pino";
import {
  type ClobExecutor,
  createClobExecutor,
} from "@/features/trading/clob-executor";

export {
  classifyClobCredentialRotationError,
  createOrDerivePolymarketApiKeyForSigner,
  normalizePolymarketApiKeyCreds,
  rotatePolymarketApiKeyForSigner,
} from "./poly-clob-creds";

const DEFAULT_CLOB_HOST = "https://clob.polymarket.com";

/** Parameters for the autonomous SELL-to-close path. */
export interface ClosePositionParams {
  /** ERC-1155 asset id (Polymarket token). */
  tokenId: string;
  /** Notional USDC cap. Actual size = min(cap, position_size * curPrice). */
  max_size_usdc: number;
  /** Limit price for the SELL; if omitted, executor uses aggressive take-bid. */
  limit_price?: number;
  /** Caller-supplied idempotency key. */
  client_order_id: `0x${string}`;
}

/** User-initiated full exit of the current wallet position. */
export interface ExitPositionParams {
  /** ERC-1155 asset id (Polymarket token). */
  tokenId: string;
  /** Caller-supplied idempotency key. */
  client_order_id: `0x${string}`;
}

export interface OpenOrderSummary {
  orderId: string;
  marketId: string | null;
  tokenId: string | null;
  outcome: string | null;
  side: "BUY" | "SELL" | null;
  price: number | null;
  originalShares: number | null;
  matchedShares: number | null;
  remainingUsdc: number | null;
  submittedAt: string;
  status: string;
}

/** Thrown when close preconditions fail or the executor refuses to sign. */
export class PolyTradeExecutorError extends Error {
  /**
   * Structured details shaped like `ClobFailureDetails` so the mirror-pipeline
   * catch (`err.details.error_code`) surfaces this denial in Loki instead of
   * falling back to the generic `placement_failed` bucket. `error_code` keeps
   * the `authorize_denied` namespace distinct from CLOB-side codes
   * (`insufficient_balance` etc.); `reason` carries the specific cause
   * (`cap_exceeded_per_order`, `no_connection`, `trading_not_ready`, ...).
   */
  public readonly details: {
    error_code: "authorize_denied" | "no_position_to_close";
    reason: string | null;
    error_class: "PolyTradeExecutorError";
  };

  constructor(
    public readonly code: "no_position_to_close" | "not_authorized",
    message: string,
    public readonly reason?: string
  ) {
    super(message);
    this.name = "PolyTradeExecutorError";
    this.details = {
      error_code:
        code === "not_authorized" ? "authorize_denied" : "no_position_to_close",
      reason: reason ?? null,
      error_class: "PolyTradeExecutorError",
    };
  }
}

/**
 * Per-tenant surface for placing, closing, and listing orders. Every
 * `placeIntent` / `closePosition` call routes through `authorizeIntent` so
 * scope + cap checks run on the hot path.
 */
export interface PolyTradeExecutor {
  /** Tenant this executor is bound to. */
  readonly billingAccountId: string;
  /**
   * Authorized placement seam. Refuses (throws) when `authorizeIntent` denies.
   * The mirror-pipeline consumes this verbatim; the caller has already
   * selected sizing + client_order_id via `planMirrorFromFill`.
   */
  placeIntent: (intent: OrderIntent) => Promise<OrderReceipt>;
  /**
   * Autonomous SELL-to-close path. Finds the operator's position for the
   * token, caps size at position value, then routes through `placeIntent`
   * so `authorizeIntent` enforces scope + caps.
   */
  closePosition: (params: ClosePositionParams) => Promise<OrderReceipt>;
  /**
   * User-facing full exit path. Sells the wallet's entire share balance for
   * the token via a market FOK order and bypasses grant caps so users can
   * always unwind exposure. Data API is only a discovery hint; Data API
   * omission falls through to CTF ERC-1155 `balanceOf` before refusing close.
   */
  exitPosition: (params: ExitPositionParams) => Promise<OrderReceipt>;
  /** Per-tenant position query for the operator address. */
  listPositions: () => Promise<PolymarketUserPosition[]>;
  /**
   * Per-tenant getOrder for the reconciler path. Dispatch follows
   * `PAPER_DISPATCH_IS_ENV_ONLY`: when `PAPER_ENFORCE_MODE=paper` the executor
   * is the paper-only build (sidecar reads); otherwise the live CLOB.
   */
  getOrder: (orderId: string) => Promise<GetOrderResult>;
  /**
   * Per-tenant cancel seam (task.5001). Wraps the underlying adapter's
   * `cancelOrder` with an audit log so the cancel boundary is tenant-
   * attributed in Loki the same way placement is. The adapter swallows
   * 404s (`CANCEL_404_SWALLOWED_IN_ADAPTER`); callers see only success /
   * non-404 error. Dispatch follows `PAPER_DISPATCH_IS_ENV_ONLY`.
   */
  cancelOrder: (orderId: string) => Promise<void>;
  /**
   * Market-constraints fetch — returns market floors + tick for a token id. Used
   * by the mirror pipeline to pre-flight sizing against the market's share
   * minimum and normalize limit prices. Raw passthrough to
   * `PolymarketClobAdapter.getMarketConstraints`.
   */
  getMarketConstraints: (tokenId: string) => Promise<{
    minShares: number;
    minUsdcNotional?: number;
    tickSize?: number;
  }>;
  /** Per-tenant live open orders from the CLOB. */
  listOpenOrders: () => Promise<OpenOrderSummary[]>;
  /** CTF ERC-1155 share balance for the tenant wallet and token id. */
  getPositionShareBalance: (tokenId: string) => Promise<number>;
  /** The tenant's current EOA address (used for profile URLs + position queries). */
  readonly funderAddress: `0x${string}`;
}

export interface PolyTradeExecutorFactoryDeps {
  walletPort: PolyTraderWalletPort;
  logger: Logger;
  metrics: MetricsPort;
  host?: string | undefined;
  polygonRpcUrl?: string | undefined;
  /**
   * Base URL of the `agent-next/polymarket-paper-trader` sidecar. The sidecar
   * runs as a sibling container in the same k8s pod; defaults to loopback.
   * Bootstrap supplies this from the `PAPER_SIDECAR_URL` env var. Only
   * consumed by `buildPaperOnlyExecutor`; ignored by the live builder.
   */
  paperSidecarUrl?: string | undefined;
  /**
   * `"paper"` triggers `buildPaperOnlyExecutor` (sidecar-only, no wallet
   * resolve). Any other value (including `undefined`) selects `buildExecutor`
   * (live CLOB). This is the ONLY paper-mode switch — see
   * `PAPER_DISPATCH_IS_ENV_ONLY` in the module docstring. Bootstrap supplies
   * this from the `PAPER_ENFORCE_MODE` env var.
   */
  paperEnforceMode?: "paper" | undefined;
}

type MarketExitAdapter = {
  sellPositionAtMarket: (params: {
    tokenId: string;
    shares: number;
    client_order_id: `0x${string}`;
    orderType?: "FOK" | "FAK";
  }) => Promise<OrderReceipt>;
};

type CachedExecutor = {
  executor: PolyTradeExecutor;
  funderAddress: `0x${string}`;
};

/**
 * Process-level factory. Returns a function that caches executors per
 * `billingAccountId`. Every cached entry reuses the same
 * `PolymarketClobAdapter` (one HTTPS client) + shared `PublicClient` for RPC
 * reads. Scope + cap checks go through `walletPort.authorizeIntent` on every
 * call — the cache never makes auth decisions.
 *
 * @public
 */
export function createPolyTradeExecutorFactory(
  deps: PolyTradeExecutorFactoryDeps
): {
  getPolyTradeExecutorFor: (
    billingAccountId: string
  ) => Promise<PolyTradeExecutor>;
  invalidatePolyTradeExecutorFor: (billingAccountId: string) => void;
} {
  const cache = new Map<string, CachedExecutor>();
  const inflight = new Map<string, Promise<CachedExecutor>>();

  async function getPolyTradeExecutorFor(
    billingAccountId: string
  ): Promise<PolyTradeExecutor> {
    const cached = cache.get(billingAccountId);
    if (cached) return cached.executor;

    const existing = inflight.get(billingAccountId);
    if (existing) return (await existing).executor;

    // PAPER_ENFORCE_MODE=paper short-circuit (closes the TODO on
    // PolyTradeExecutorFactoryDeps.paperEnforceMode): skip wallet.resolve
    // entirely so a deployment without live CLOB credentials boots cleanly.
    // The mirror BUY path needs only `placeIntent` + `getMarketConstraints`;
    // both work without a tenant trader wallet because placement routes
    // through the paper sidecar (no signing) and constraints hit Polymarket's
    // public CLOB read endpoints.
    const builder =
      deps.paperEnforceMode === "paper"
        ? buildPaperOnlyExecutor(billingAccountId, deps)
        : buildExecutor(billingAccountId, deps);
    const buildPromise = builder.then((built) => {
      cache.set(billingAccountId, built);
      inflight.delete(billingAccountId);
      return built;
    });
    inflight.set(billingAccountId, buildPromise);
    try {
      const built = await buildPromise;
      return built.executor;
    } catch (err) {
      inflight.delete(billingAccountId);
      throw err;
    }
  }

  function invalidatePolyTradeExecutorFor(billingAccountId: string): void {
    cache.delete(billingAccountId);
    inflight.delete(billingAccountId);
  }

  return { getPolyTradeExecutorFor, invalidatePolyTradeExecutorFor };
}

async function buildExecutor(
  billingAccountId: string,
  deps: PolyTradeExecutorFactoryDeps
): Promise<CachedExecutor> {
  const resolved = await deps.walletPort.resolve(billingAccountId);
  if (!resolved) {
    throw new PolyTradeExecutorError(
      "not_authorized",
      `poly-trade-executor: no active trading wallet for billingAccountId=${billingAccountId}`,
      "no_connection"
    );
  }

  const {
    POLYGON_CONDITIONAL_TOKENS,
    PolymarketClobAdapter,
    PolymarketDataApiClient,
  } = await import("@cogni/poly-market-provider/adapters/polymarket");
  const {
    createPublicClient,
    createWalletClient,
    formatUnits,
    http,
    parseAbi,
  } = await import("viem");
  const { polygon } = await import("viem/chains");

  // biome-ignore lint/suspicious/noExplicitAny: cross-peerDep viem type drift
  const accountAny: any = resolved.account;
  const walletClient = createWalletClient({
    account: accountAny,
    chain: polygon,
    transport: http(deps.polygonRpcUrl),
  });
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(deps.polygonRpcUrl),
  });
  const conditionalTokensAbi = parseAbi([
    "function balanceOf(address account, uint256 id) view returns (uint256)",
  ]);
  // biome-ignore lint/suspicious/noExplicitAny: cross-peerDep viem type drift
  const signerAny: any = walletClient;

  const loggerPort = adaptLogger(
    deps.logger.child({
      subcomponent: "poly-trade-executor",
      billing_account_id: billingAccountId,
    })
  );

  const adapter = new PolymarketClobAdapter({
    signer: signerAny,
    creds: {
      key: resolved.clobCreds.key,
      secret: resolved.clobCreds.secret,
      passphrase: resolved.clobCreds.passphrase,
    },
    funderAddress: resolved.funderAddress,
    host: deps.host ?? DEFAULT_CLOB_HOST,
    logger: loggerPort,
    metrics: deps.metrics,
  });

  const dataApiClient = new PolymarketDataApiClient();

  // PAPER_DISPATCH_IS_ENV_ONLY (task: paper-mode-env-only-dispatch) —
  // `buildExecutor` runs ONLY when `deps.paperEnforceMode !== "paper"` (the
  // factory at `createPolyTradeExecutorFactory` chooses `buildPaperOnlyExecutor`
  // when env-paper). So every placement reaching this builder is live by
  // construction. There is no per-target paper dispatch here, no `PaperAdapter`
  // sibling, no runtime branch on `intent.attributes.mode`. Activating paper
  // requires `PAPER_ENFORCE_MODE=paper` at process start — period.
  const livePlace: ClobExecutor = createClobExecutor({
    placeOrder: adapter.placeOrder.bind(adapter),
    logger: loggerPort,
    metrics: deps.metrics,
  });

  const authorizedPlace = async (
    intent: OrderIntent
  ): Promise<OrderReceipt> => {
    const summary: OrderIntentSummary = {
      side: intent.side,
      usdcAmount: intent.size_usdc,
      marketConditionId: intent.market_id.replace(
        /^prediction-market:polymarket:/,
        ""
      ),
    };
    const authz = await deps.walletPort.authorizeIntent(
      billingAccountId,
      summary
    );
    if (!authz.ok) {
      deps.metrics.incr("poly_authorize_denied_total", {
        reason: authz.reason,
      });
      deps.logger.warn(
        {
          event: "poly.trade.executor.authorize_denied",
          billing_account_id: billingAccountId,
          intent_side: intent.side,
          intent_usdc: intent.size_usdc,
          reason: authz.reason,
        },
        "poly-trade-executor: authorize denied; refusing placeOrder"
      );
      throw new PolyTradeExecutorError(
        "not_authorized",
        `poly-trade-executor: authorize denied (${authz.reason})`,
        authz.reason
      );
    }
    deps.logger.info(
      {
        event: "poly.mirror.place.tenant",
        billing_account_id: billingAccountId,
        grant_id: authz.context.grantId,
        intent_side: intent.side,
        intent_usdc: intent.size_usdc,
        market_id: intent.market_id,
        client_order_id: intent.client_order_id,
        execution_mode: "live",
        paper_enforced: false,
      },
      "poly-trade-executor: authorized → placeOrder"
    );
    return livePlace(intent);
  };

  // At this point `resolved` has been null-checked at top of `buildExecutor`;
  // TS narrowing doesn't propagate into the closure, so re-anchor the address.
  const funderAddress = resolved.funderAddress;

  async function closePosition(
    params: ClosePositionParams
  ): Promise<OrderReceipt> {
    // bug.5055 — single-page listUserPositions caps at ~100 rows (bug.5027).
    // Funders routinely hold long-tail positions; truncation would throw
    // `no_position_to_close` spuriously on any tokenId outside the top page.
    const positions = await dataApiClient.listAllUserPositions(funderAddress);
    const position = positions.find((p) => p.asset === params.tokenId);
    if (!position || position.size <= 0) {
      throw new PolyTradeExecutorError(
        "no_position_to_close",
        `poly-trade-executor: no open position for tokenId=${params.tokenId} on wallet=${funderAddress}`
      );
    }
    const limit_price =
      params.limit_price ?? Math.max(0.01, position.curPrice - 0.01);
    const positionValueUsdcAtLimit = position.size * limit_price;
    const effective_size_usdc = Math.min(
      params.max_size_usdc,
      positionValueUsdcAtLimit
    );
    const intent: OrderIntent = {
      provider: "polymarket",
      market_id: `prediction-market:polymarket:${position.conditionId}`,
      outcome: position.outcome ?? "",
      side: "SELL",
      size_usdc: effective_size_usdc,
      limit_price,
      client_order_id: params.client_order_id,
      attributes: { token_id: params.tokenId },
    };
    return authorizedPlace(intent);
  }

  async function authorizeWalletExit(params: {
    action: "close" | "redeem";
    requireTradingReady: boolean;
  }): Promise<void> {
    const connection =
      await deps.walletPort.getConnectionSummary(billingAccountId);
    if (!connection) {
      deps.logger.warn(
        {
          event: "poly.trade.executor.exit_denied",
          billing_account_id: billingAccountId,
          action: params.action,
          reason: "no_connection",
        },
        "poly-trade-executor: exit denied; no active tenant wallet connection"
      );
      throw new PolyTradeExecutorError(
        "not_authorized",
        `poly-trade-executor: ${params.action} denied (no_connection)`,
        "no_connection"
      );
    }
    if (params.requireTradingReady && !connection.tradingApprovalsReadyAt) {
      try {
        const ready =
          await deps.walletPort.ensureTradingApprovals(billingAccountId);
        if (ready.ready) return;
      } catch (err) {
        deps.logger.warn(
          {
            event: "poly.trade.executor.exit_denied",
            billing_account_id: billingAccountId,
            action: params.action,
            reason: "trading_not_ready",
            err: err instanceof Error ? err.message : String(err),
          },
          "poly-trade-executor: exit denied; trading approvals bootstrap failed"
        );
        throw new PolyTradeExecutorError(
          "not_authorized",
          `poly-trade-executor: ${params.action} denied (trading_not_ready)`,
          "trading_not_ready"
        );
      }
      deps.logger.warn(
        {
          event: "poly.trade.executor.exit_denied",
          billing_account_id: billingAccountId,
          action: params.action,
          reason: "trading_not_ready",
        },
        "poly-trade-executor: exit denied; trading approvals not ready"
      );
      throw new PolyTradeExecutorError(
        "not_authorized",
        `poly-trade-executor: ${params.action} denied (trading_not_ready)`,
        "trading_not_ready"
      );
    }
  }

  async function exitPosition(
    params: ExitPositionParams
  ): Promise<OrderReceipt> {
    await authorizeWalletExit({
      action: "close",
      requireTradingReady: true,
    });

    const marketExitAdapter = adapter as typeof adapter & MarketExitAdapter;
    // bug.5055 — paginate. Truncation here would silently bypass the
    // minShares-vs-onchain-balance branch and force every long-tail exit
    // through the on-chain fallback, masking the underlying coverage gap.
    const positions = await dataApiClient.listAllUserPositions(funderAddress);
    const position = positions.find((p) => p.asset === params.tokenId);
    const dataApiShares = position?.size ?? 0;
    let shares = dataApiShares;
    let shareSource: "data_api" | "onchain_balance" = "data_api";
    if (dataApiShares > 0) {
      const { minShares } = await adapter.getMarketConstraints(params.tokenId);
      if (dataApiShares < minShares) {
        shares = await getPositionShareBalance(params.tokenId);
        shareSource = "onchain_balance";
      }
    } else {
      shares = await getPositionShareBalance(params.tokenId);
      shareSource = "onchain_balance";
    }
    if (shares <= 0) {
      throw new PolyTradeExecutorError(
        "no_position_to_close",
        `poly-trade-executor: no open position for tokenId=${params.tokenId} on wallet=${funderAddress}`
      );
    }

    deps.logger.info(
      {
        event: "poly.exit.place.tenant",
        billing_account_id: billingAccountId,
        token_id: params.tokenId,
        shares,
        share_source: shareSource,
        client_order_id: params.client_order_id,
        attempt: 1,
      },
      "poly-trade-executor: market exit authorized → placeOrder"
    );

    return marketExitAdapter.sellPositionAtMarket({
      tokenId: params.tokenId,
      shares,
      client_order_id: params.client_order_id,
      orderType: "FAK",
    });
  }

  async function cancelOrder(orderId: string): Promise<void> {
    deps.logger.info(
      {
        event: "poly.mirror.cancel.tenant",
        billing_account_id: billingAccountId,
        order_id: orderId,
        execution_mode: "live",
      },
      "poly-trade-executor: cancelOrder (tenant-scoped)"
    );
    await adapter.cancelOrder(orderId);
  }

  async function getOrder(orderId: string): Promise<GetOrderResult> {
    return adapter.getOrder(orderId);
  }

  async function getPositionShareBalance(tokenId: string): Promise<number> {
    const rawBalance = await publicClient.readContract({
      address: POLYGON_CONDITIONAL_TOKENS,
      abi: conditionalTokensAbi,
      functionName: "balanceOf",
      args: [funderAddress, BigInt(tokenId)],
    });
    return Number(formatUnits(rawBalance, 6));
  }

  const executor: PolyTradeExecutor = {
    billingAccountId,
    placeIntent: authorizedPlace,
    closePosition,
    exitPosition,
    // bug.5055 — paginate. Consumer is mirror-pipeline SELL path
    // (sell_without_position skip); single-page truncation drops long-tail
    // SELLs into the same silent-loss bucket as the chain-source metadata
    // cache miss.
    listPositions: () => dataApiClient.listAllUserPositions(funderAddress),
    getOrder,
    cancelOrder,
    getMarketConstraints: adapter.getMarketConstraints.bind(adapter),
    listOpenOrders: async () =>
      (await adapter.listOpenOrders()).map(mapOpenOrderSummary),
    getPositionShareBalance,
    funderAddress,
  };

  return { executor, funderAddress };
}

/**
 * Paper-enforced executor builder. Used when `PAPER_ENFORCE_MODE=paper`.
 *
 * Differences from `buildExecutor`:
 *   - Skips `walletPort.resolve()` — no trader wallet required for paper.
 *   - Skips `walletPort.authorizeIntent()` — caps + scope checks live on the
 *     same tenant gate, but in paper mode there's nothing to authorize against
 *     (no signing, no real USDC). Logged as `paper_enforced` so the bypass is
 *     visible in audit.
 *   - Constructs `PolymarketClobAdapter` with a deterministic no-op signer +
 *     empty CLOB creds. The SDK's `getOrderBook` and `getTickSize` read paths
 *     (used by `getMarketConstraints`) hit Polymarket's public endpoints that
 *     don't auth, so this works for the mirror BUY path's tick/min-size lookup.
 *   - Wires `paperPlace` as the only placement path. `livePlace` doesn't exist
 *     in this builder — every intent routes to the sidecar.
 *   - `closePosition` / `exitPosition` / `listPositions` /
 *     `getPositionShareBalance` throw `paper_enforced_not_supported`. These
 *     are user-driven flows (manual wallet close, position UI) that have no
 *     meaning when the entire deployment is paper-only. The mirror BUY path
 *     does not call them.
 */
async function buildPaperOnlyExecutor(
  billingAccountId: string,
  deps: PolyTradeExecutorFactoryDeps
): Promise<CachedExecutor> {
  const { PolymarketClobAdapter, PolymarketDataApiClient } = await import(
    "@cogni/poly-market-provider/adapters/polymarket"
  );
  const { PaperAdapter } = await import(
    "@cogni/poly-market-provider/adapters/paper"
  );
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  // Stable, well-known throwaway private key. Used only to satisfy the
  // ClobClient SDK constructor's signer requirement — paper mode never signs.
  // pubkey: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf
  const PAPER_NOOP_PRIVATE_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
  const PAPER_FUNDER_ADDRESS =
    "0x0000000000000000000000000000000000000000" as const;

  // biome-ignore lint/suspicious/noExplicitAny: cross-peerDep viem type drift
  const noopAccount: any = privateKeyToAccount(PAPER_NOOP_PRIVATE_KEY);
  const walletClient = createWalletClient({
    account: noopAccount,
    chain: polygon,
    transport: http(deps.polygonRpcUrl),
  });
  // biome-ignore lint/suspicious/noExplicitAny: cross-peerDep viem type drift
  const signerAny: any = walletClient;

  const loggerPort = adaptLogger(
    deps.logger.child({
      subcomponent: "poly-trade-executor",
      billing_account_id: billingAccountId,
      paper_enforced: true,
    })
  );

  // CLOB adapter exists ONLY as the read source for getMarketConstraints.
  // Its placeOrder would fail with empty creds — but the dispatcher never
  // calls it because paperPlace is the only placement path.
  const adapter = new PolymarketClobAdapter({
    signer: signerAny,
    creds: { key: "", secret: "", passphrase: "" },
    funderAddress: PAPER_FUNDER_ADDRESS,
    host: deps.host ?? DEFAULT_CLOB_HOST,
    logger: loggerPort,
    metrics: deps.metrics,
  });

  const dataApiClient = new PolymarketDataApiClient();

  const paperAdapter = new PaperAdapter({
    ...(deps.paperSidecarUrl !== undefined
      ? { sidecarBaseUrl: deps.paperSidecarUrl }
      : {}),
    readSource: adapter,
  });

  const paperPlace: ClobExecutor = createClobExecutor({
    placeOrder: paperAdapter.placeOrder.bind(paperAdapter),
    logger: loggerPort.child({ adapter: "paper" }),
    metrics: deps.metrics,
  });

  const authorizedPlace = async (
    intent: OrderIntent
  ): Promise<OrderReceipt> => {
    // In paper-enforced mode we skip walletPort.authorizeIntent — there's no
    // wallet to authorize against, and paper placements cannot burn real
    // USDC. The decision is audited via the `paper_enforced` log key.
    deps.logger.info(
      {
        event: "poly.mirror.place.tenant",
        billing_account_id: billingAccountId,
        intent_side: intent.side,
        intent_usdc: intent.size_usdc,
        market_id: intent.market_id,
        client_order_id: intent.client_order_id,
        execution_mode: "paper",
        paper_enforced: true,
        authorize_bypassed: true,
      },
      "poly-trade-executor (paper-enforced): authorize bypassed → placeOrder"
    );
    return paperPlace(intent);
  };

  function paperNotSupported(operation: string): never {
    throw new PolyTradeExecutorError(
      "not_authorized",
      `poly-trade-executor: ${operation} not supported in PAPER_ENFORCE_MODE=paper (no trader wallet)`,
      "no_connection"
    );
  }

  const executor: PolyTradeExecutor = {
    billingAccountId,
    placeIntent: authorizedPlace,
    closePosition: async () => paperNotSupported("closePosition"),
    exitPosition: async () => paperNotSupported("exitPosition"),
    listPositions: async () =>
      dataApiClient.listAllUserPositions(PAPER_FUNDER_ADDRESS),
    getOrder: paperAdapter.getOrder.bind(paperAdapter),
    cancelOrder: paperAdapter.cancelOrder.bind(paperAdapter),
    getMarketConstraints: adapter.getMarketConstraints.bind(adapter),
    listOpenOrders: async () => [],
    getPositionShareBalance: async () => 0,
    funderAddress: PAPER_FUNDER_ADDRESS,
  };

  return { executor, funderAddress: PAPER_FUNDER_ADDRESS };
}

function mapOpenOrderSummary(
  order: Awaited<
    ReturnType<
      import("@cogni/poly-market-provider/adapters/polymarket").PolymarketClobAdapter["listOpenOrders"]
    >
  >[number]
): OpenOrderSummary {
  const attrs = (order.attributes ?? {}) as Record<string, unknown>;
  const price = readFinite(attrs.price);
  const originalShares = readFinite(attrs.originalSize);
  const matchedShares = readFinite(attrs.sizeMatched) ?? 0;
  const side =
    attrs.side === "BUY" || attrs.side === "SELL" ? attrs.side : null;
  const remainingShares =
    originalShares !== null
      ? Math.max(0, originalShares - matchedShares)
      : null;
  const remainingUsdc =
    price !== null && remainingShares !== null
      ? roundToCents(price * remainingShares)
      : null;

  return {
    orderId: order.order_id,
    marketId: typeof attrs.market === "string" ? attrs.market : null,
    tokenId: typeof attrs.tokenId === "string" ? attrs.tokenId : null,
    outcome: typeof attrs.outcome === "string" ? attrs.outcome : null,
    side,
    price,
    originalShares,
    matchedShares,
    remainingUsdc,
    submittedAt: order.submitted_at,
    status: order.status,
  };
}

function readFinite(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function adaptLogger(pinoLogger: Logger): LoggerPort {
  return {
    debug(obj, msg) {
      pinoLogger.debug(obj as object, msg);
    },
    info(obj, msg) {
      pinoLogger.info(obj as object, msg);
    },
    warn(obj, msg) {
      pinoLogger.warn(obj as object, msg);
    },
    error(obj, msg) {
      pinoLogger.error(obj as object, msg);
    },
    child(bindings) {
      return adaptLogger(pinoLogger.child(bindings));
    },
  };
}
