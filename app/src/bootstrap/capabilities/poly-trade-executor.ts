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
 *   - VENUE_RESOLVED_FROM_ACCOUNT — the account's `poly_wallet_connections.kind`
 *     is the ONLY thing that selects a venue. The factory resolves it per
 *     `billingAccountId` (`deps.resolveExecutionVenue`) and then chooses
 *     `buildExecutor` (live CLOB) or `buildPaperOnlyExecutor` (paper sidecar)
 *     once, at executor-construction time. Because the cache key is already the
 *     billing account (TENANT_CACHE_KEYS_BILLING_ACCOUNT), two accounts in one
 *     process can hold different venues — which the previous
 *     `PAPER_ENFORCE_MODE` switch made structurally impossible. Pairs with
 *     `MODE_STAMPED_FROM_ACCOUNT` (order-ledger.ts): the ledger stamps
 *     `poly_copy_trade_{fills,decisions}.mode` from the SAME resolver, so audit
 *     and dispatch agree by construction. Per-target `mode` columns and
 *     `intent.attributes.mode` shadows were removed (task.5003); any attribute
 *     placed on an intent is purely advisory and the executor never reads it.
 *   - NO_PAPER_BYPASSES — the paper venue runs the real authorization path
 *     against its own `poly_wallet_grants` row, reports its own synthetic
 *     funder address, and throws a typed unavailable for any position read it
 *     cannot serve. It never skips authorize, never answers a share balance
 *     with a hardcoded 0, and never queries the zero address.
 * Side-effects: on first `placeIntent` for a new tenant: HTTPS to Polymarket
 *   CLOB + Privy API. Subsequent calls reuse cached clients.
 * Links: work/items/task.0318 (Phase B3), work/items/task.0388,
 *   docs/spec/poly-tenant-and-collateral.md
 * @public
 */

import type {
  GetOrderResult,
  LoggerPort,
  MarketConstraintPlacement,
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
import type {
  ExecutionVenueResolver,
  PaperVenuePort,
} from "@/features/paper-accounts";
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
const BUY_COLLATERAL_RESERVE_BPS = 1_000;
const USDC_ATOMIC_SCALE = 1_000_000;

/** Conservative CLOB fee/rounding reserve; never resizes the algorithm intent. */
export function requiredBuyCollateralAtomic(usdcAmount: number): bigint {
  if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) return 0n;
  return BigInt(
    Math.ceil(
      usdcAmount * USDC_ATOMIC_SCALE * (1 + BUY_COLLATERAL_RESERVE_BPS / 10_000)
    )
  );
}

export function evaluateClobCollateralPreflight(input: {
  requiredAtomic: bigint;
  balanceAtomic: bigint;
  allowanceAtomic: bigint;
}): "insufficient_balance" | "insufficient_allowance" | null {
  if (input.balanceAtomic < input.requiredAtomic) return "insufficient_balance";
  if (input.allowanceAtomic < input.requiredAtomic)
    return "insufficient_allowance";
  return null;
}

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
   * `VENUE_RESOLVED_FROM_ACCOUNT`: a paper account's executor reads the
   * sidecar, a live account's reads the CLOB.
   */
  getOrder: (orderId: string) => Promise<GetOrderResult>;
  /**
   * Per-tenant cancel seam (task.5001). Wraps the underlying adapter's
   * `cancelOrder` with an audit log so the cancel boundary is tenant-
   * attributed in Loki the same way placement is. The adapter swallows
   * 404s (`CANCEL_404_SWALLOWED_IN_ADAPTER`); callers see only success /
   * non-404 error. Dispatch follows `VENUE_RESOLVED_FROM_ACCOUNT`.
   */
  cancelOrder: (orderId: string) => Promise<void>;
  /**
   * Market-constraints fetch — returns market floors + tick for a token id. Used
   * by the mirror pipeline to pre-flight sizing against the market's share
   * minimum and normalize limit prices. Raw passthrough to
   * `PolymarketClobAdapter.getMarketConstraints`.
   */
  getMarketConstraints: (
    tokenId: string,
    placement?: MarketConstraintPlacement
  ) => Promise<{
    minShares: number;
    minUsdcNotional?: number;
    tickSize?: number;
  }>;
  /** Per-tenant live open orders from the CLOB. */
  listOpenOrders: () => Promise<OpenOrderSummary[]>;
  /**
   * Share balance for the tenant's account and token id. Live accounts read CTF
   * ERC-1155 `balanceOf`. Paper accounts read the paper position projection;
   * until that projection exists this throws a typed unavailable. It MUST NOT
   * answer 0 — `NO_FABRICATED_VALUES`, and a fabricated 0 is what pinned
   * `position_gap`'s gap math at `desired - 0` on every paper deployment.
   */
  getPositionShareBalance: (tokenId: string) => Promise<number>;
  /** The tenant's current EOA address (used for profile URLs + position queries). */
  readonly funderAddress: `0x${string}`;
}

/**
 * Per-account paper position reads. SEAM_ONLY: the implementation is the paper
 * position / NAV projection, which lands separately. Until it is wired, the
 * paper executor throws `paper_positions_unavailable` for every position read —
 * deliberately louder than the hardcoded `0` it replaces.
 */
export interface PaperPositionSource {
  /** Paper positions for one account, shaped like the Data-API read. */
  listPositions: (
    billingAccountId: string
  ) => Promise<PolymarketUserPosition[]>;
  /** Paper share balance for one account + token id. */
  getPositionShareBalance: (
    billingAccountId: string,
    tokenId: string
  ) => Promise<number>;
}

export interface PolyTradeExecutorFactoryDeps {
  /**
   * Live custody + authorization port. Optional because a deployment can serve
   * paper accounts with no Privy / AEAD credentials at all (the case bug.5253
   * papered over with a Proxy whose every property access threw). When an
   * account resolves to the LIVE venue and this is absent, the build fails
   * loudly with `no_connection` — it never degrades to paper.
   */
  walletPort?: PolyTraderWalletPort | undefined;
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
   * VENUE_RESOLVED_FROM_ACCOUNT — maps a `billingAccountId` to its venue by
   * reading that account's `poly_wallet_connections.kind`. Required: there is
   * no default venue, and an account with no active connection must fail rather
   * than be guessed at. Bootstrap wires
   * `createExecutionVenueResolver({ db })`.
   */
  resolveExecutionVenue: ExecutionVenueResolver;
  /**
   * Authorization + identity for paper accounts — the paper analogue of
   * `walletPort`. Required to build a paper executor; absent means a paper
   * account cannot be served on this deployment, which fails loudly instead of
   * placing unauthorized simulated orders.
   */
  paperVenue?: PaperVenuePort | undefined;
  /** Paper position reads. See `PaperPositionSource`. */
  paperPositions?: PaperPositionSource | undefined;
}

/**
 * The exact intent fields an authorization decision is made against. Shared by
 * both venues so a paper account's grant sees the same summary its live twin
 * would — `GRANT_CAPS_MIRROR_LIVE` is only meaningful if the input is identical.
 */
function toOrderIntentSummary(intent: OrderIntent): OrderIntentSummary {
  return {
    side: intent.side,
    usdcAmount: intent.size_usdc,
    marketConditionId: intent.market_id.replace(
      /^prediction-market:polymarket:/,
      ""
    ),
  };
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

    // VENUE_RESOLVED_FROM_ACCOUNT — read the account's connection `kind` and
    // build the venue it names. The resolver throws
    // `ExecutionVenueUnresolvedError` for an account with no active connection
    // (NO_DEFAULT_VENUE): a tenant that never provisioned anything gets a loud
    // failure, not a silent downgrade to simulation or a live CLOB attempt.
    //
    // Resolution is inside the per-account build promise so it is paid once per
    // account per process and shares the inflight de-duplication below. The
    // cache key is the billing account, so a live account and a paper account
    // coexist in one process with different venues — the thing the old
    // process-wide env switch made impossible.
    const buildPromise = (async () => {
      const venue = await deps.resolveExecutionVenue(billingAccountId);
      return venue === "paper"
        ? buildPaperOnlyExecutor(billingAccountId, deps)
        : buildExecutor(billingAccountId, deps);
    })().then((built) => {
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
  // The live venue cannot be served without the custody port. Deployments that
  // only run paper accounts legitimately boot without Privy / AEAD credentials,
  // so this is a per-account failure rather than a boot failure — and it is a
  // failure, never a fallback to the paper venue.
  const walletPort = deps.walletPort;
  if (!walletPort) {
    throw new PolyTradeExecutorError(
      "not_authorized",
      `poly-trade-executor: account ${billingAccountId} resolves to the live venue but no trader-wallet port is configured on this deployment`,
      "no_connection"
    );
  }
  const resolved = await walletPort.resolve(billingAccountId);
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
  const [{ createSecureClient }, { signerFrom }, { SignatureTypeV2 }] =
    await Promise.all([
      import("@polymarket/client"),
      import("@polymarket/client/viem"),
      import("@polymarket/clob-client-v2"),
    ]);

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
  const officialSigner = signerFrom(walletClient);
  const v2OrderClient = await createSecureClient({
    signer: officialSigner,
    wallet: resolved.funderAddress,
    credentials: {
      key: resolved.clobCreds.key,
      secret: resolved.clobCreds.secret,
      passphrase: resolved.clobCreds.passphrase,
    } as never,
  });
  const usesDepositWallet =
    resolved.funderAddress.toLowerCase() !==
    resolved.account.address.toLowerCase();

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
    signatureType: usesDepositWallet
      ? SignatureTypeV2.POLY_1271
      : SignatureTypeV2.EOA,
    v2OrderClient: v2OrderClient as never,
    host: deps.host ?? DEFAULT_CLOB_HOST,
    logger: loggerPort,
    metrics: deps.metrics,
  });

  const dataApiClient = new PolymarketDataApiClient();

  // VENUE_RESOLVED_FROM_ACCOUNT — `buildExecutor` runs ONLY for an account whose
  // connection `kind` resolved to `privy_live`, so every placement reaching this
  // builder is live by construction. There is no per-target paper dispatch here,
  // no `PaperAdapter` sibling, and no runtime branch on `intent.attributes.mode`;
  // reaching the paper venue requires a `kind = 'paper'` connection row.
  const livePlace: ClobExecutor = createClobExecutor({
    placeOrder: adapter.placeOrder.bind(adapter),
    logger: loggerPort,
    metrics: deps.metrics,
  });

  const authorizedPlace = async (
    intent: OrderIntent
  ): Promise<OrderReceipt> => {
    const authz = await walletPort.authorizeIntent(
      billingAccountId,
      toOrderIntentSummary(intent)
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
    if (intent.side === "BUY") {
      const tokenId =
        typeof intent.attributes?.token_id === "string"
          ? intent.attributes.token_id
          : "";
      const requiredAtomic = requiredBuyCollateralAtomic(intent.size_usdc);
      const collateral = await adapter.getCollateralBalanceAllowance(tokenId);
      const preflightFailure = evaluateClobCollateralPreflight({
        requiredAtomic,
        balanceAtomic: collateral.balanceAtomic,
        allowanceAtomic: collateral.allowanceAtomic,
      });
      if (preflightFailure === "insufficient_balance") {
        deps.metrics.incr("poly_authorize_denied_total", {
          reason: "insufficient_balance",
        });
        deps.logger.warn(
          {
            event: "poly.trade.executor.balance_preflight_denied",
            billing_account_id: billingAccountId,
            client_order_id: intent.client_order_id,
            intent_usdc: intent.size_usdc,
            required_atomic: requiredAtomic.toString(),
            available_atomic: collateral.balanceAtomic.toString(),
          },
          "poly-trade-executor: CLOB balance preflight denied; refusing placeOrder"
        );
        throw new PolyTradeExecutorError(
          "not_authorized",
          "poly-trade-executor: balance preflight denied (insufficient_balance)",
          "insufficient_balance"
        );
      }
      if (preflightFailure === "insufficient_allowance") {
        deps.metrics.incr("poly_authorize_denied_total", {
          reason: "insufficient_allowance",
        });
        deps.logger.warn(
          {
            event: "poly.trade.executor.allowance_preflight_denied",
            billing_account_id: billingAccountId,
            client_order_id: intent.client_order_id,
            intent_usdc: intent.size_usdc,
            required_atomic: requiredAtomic.toString(),
            allowance_atomic: collateral.allowanceAtomic.toString(),
            spender: collateral.spender,
          },
          "poly-trade-executor: CLOB allowance preflight denied; refusing placeOrder"
        );
        throw new PolyTradeExecutorError(
          "not_authorized",
          "poly-trade-executor: collateral preflight denied (insufficient_allowance)",
          "insufficient_allowance"
        );
      }
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
 * Paper-account executor builder. Used when the account's connection
 * `kind = 'paper'` (VENUE_RESOLVED_FROM_ACCOUNT).
 *
 * Differences from `buildExecutor` — and nothing more than these:
 *   - Resolves the account from `paperVenue.resolveAccount` instead of
 *     `walletPort.resolve()`. A paper account holds no key material, so there is
 *     no Privy call and no CLOB credential to decrypt; what it does hold is a
 *     real connection row with a real synthetic funder address.
 *   - Authorizes through `paperVenue.authorizeIntent`, which runs the same
 *     decision sequence the live adapter runs against the paper account's own
 *     `poly_wallet_grants` row. There is NO bypass: the pre-0081 build skipped
 *     authorize entirely and logged `authorize_bypassed: true`, which silently
 *     neutered every cap the algorithm was supposed to be tested against.
 *   - Constructs `PolymarketClobAdapter` with a deterministic no-op signer +
 *     empty CLOB creds. The SDK's `getOrderBook` and `getTickSize` read paths
 *     (used by `getMarketConstraints`) hit Polymarket's public endpoints that
 *     don't auth, so this works for the mirror BUY path's tick/min-size lookup.
 *   - Wires `paperPlace` as the only placement path. `livePlace` doesn't exist
 *     in this builder — every intent routes to the sidecar.
 *   - Position reads (`listPositions`, `getPositionShareBalance`) delegate to
 *     `deps.paperPositions`. When that projection is not wired they throw
 *     `paper_positions_unavailable`. They do NOT return `0` and do NOT query the
 *     Data-API for the zero address, which is what the pre-0081 build did:
 *     `getPositionShareBalance: async () => 0` fabricated a value that pinned
 *     `position_gap`'s gap math at `desired - 0` forever, and the zero-address
 *     Data-API read answered one deployment-wide "portfolio" that belonged to
 *     nobody.
 *   - `closePosition` / `exitPosition` need a position to size the SELL against,
 *     so they surface the same typed unavailable until the paper position
 *     projection lands.
 */
async function buildPaperOnlyExecutor(
  billingAccountId: string,
  deps: PolyTradeExecutorFactoryDeps
): Promise<CachedExecutor> {
  const paperVenue = deps.paperVenue;
  if (!paperVenue) {
    throw new PolyTradeExecutorError(
      "not_authorized",
      `poly-trade-executor: account ${billingAccountId} resolves to the paper venue but no paper venue is configured on this deployment`,
      "no_connection"
    );
  }
  // Throws `PaperAccountUnavailableError` when the paper row vanished between
  // venue resolution and here (a revoke mid-build). Fail, never substitute.
  const account = await paperVenue.resolveAccount(billingAccountId);
  const funderAddress = account.funderAddress;

  const { PolymarketClobAdapter } = await import(
    "@cogni/poly-market-provider/adapters/polymarket"
  );
  const { PaperAdapter } = await import(
    "@cogni/poly-market-provider/adapters/paper"
  );
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  // Stable, well-known throwaway private key. Used only to satisfy the
  // ClobClient SDK constructor's signer requirement — the paper venue never
  // signs, and this key is never the account identity (that is
  // `account.funderAddress`, read off the connection row).
  // pubkey: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf
  const PAPER_NOOP_PRIVATE_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

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
      execution_mode: "paper",
    })
  );

  // CLOB adapter exists ONLY as the read source for getMarketConstraints.
  // Its placeOrder would fail with empty creds — but the dispatcher never
  // calls it because paperPlace is the only placement path.
  const adapter = new PolymarketClobAdapter({
    signer: signerAny,
    creds: { key: "", secret: "", passphrase: "" },
    funderAddress,
    host: deps.host ?? DEFAULT_CLOB_HOST,
    logger: loggerPort,
    metrics: deps.metrics,
  });

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
    // AUTHORIZED_PLACE_ONLY applies to paper exactly as it does to live: the
    // grant row, its scopes, and its per-order / daily / hourly caps decide.
    // Read fresh on every call, so a revoke that lands after this executor was
    // cached still denies (CACHE_INVALIDATED_BY_AUTHORIZE).
    const authz = await paperVenue.authorizeIntent(
      billingAccountId,
      toOrderIntentSummary(intent)
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
          execution_mode: "paper",
        },
        "poly-trade-executor: authorize denied; refusing paper placeOrder"
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
        intent_side: intent.side,
        intent_usdc: intent.size_usdc,
        market_id: intent.market_id,
        client_order_id: intent.client_order_id,
        execution_mode: "paper",
        grant_id: authz.grantId,
      },
      "poly-trade-executor (paper): authorized → placeOrder"
    );
    return paperPlace(intent);
  };

  const paperPositions = deps.paperPositions;

  /**
   * SEAM_ONLY — the paper position / NAV projection is not wired yet. Throwing a
   * typed unavailable is the whole point: the value this replaces was a
   * hardcoded `0`, which read as "no position" to every caller and was
   * indistinguishable from a real flat book.
   */
  function paperPositionsUnavailable(operation: string): never {
    throw new PolyTradeExecutorError(
      "not_authorized",
      `poly-trade-executor: ${operation} unavailable for the paper venue on this deployment (no paper position source wired)`,
      "paper_positions_unavailable"
    );
  }

  const executor: PolyTradeExecutor = {
    billingAccountId,
    placeIntent: authorizedPlace,
    // Both close paths size the SELL from the current position; without a paper
    // position source there is nothing honest to size against.
    closePosition: async () => paperPositionsUnavailable("closePosition"),
    exitPosition: async () => paperPositionsUnavailable("exitPosition"),
    listPositions: async () =>
      paperPositions
        ? paperPositions.listPositions(billingAccountId)
        : paperPositionsUnavailable("listPositions"),
    getOrder: paperAdapter.getOrder.bind(paperAdapter),
    cancelOrder: paperAdapter.cancelOrder.bind(paperAdapter),
    getMarketConstraints: adapter.getMarketConstraints.bind(adapter),
    listOpenOrders: async () => [],
    getPositionShareBalance: async (tokenId: string) =>
      paperPositions
        ? paperPositions.getPositionShareBalance(billingAccountId, tokenId)
        : paperPositionsUnavailable("getPositionShareBalance"),
    funderAddress,
  };

  return { executor, funderAddress };
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
