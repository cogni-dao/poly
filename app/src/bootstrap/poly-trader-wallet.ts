// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/poly-trader-wallet`
 * Purpose: Constructs and memoizes the PrivyPolyTraderWalletAdapter from env so
 *   route handlers can consume it without importing `@/adapters/**` directly
 *   (architectural constraint enforced by eslint no-restricted-imports).
 * Scope: Bootstrap wiring only. Does not implement the port or read DB rows.
 * Invariants:
 *   - SEPARATE_PRIVY_APP: this module reads PRIVY_USER_WALLETS_* never PRIVY_APP_* (the operator-wallet triple).
 * Side-effects: IO (PrivyClient construction) on first call.
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/task.0318.poly-wallet-multi-tenant-auth.md
 * @internal
 */

import { polyWalletConnections } from "@cogni/poly-db-schema";
import type { PolyClobApiKeyCreds } from "@cogni/poly-wallet";
import {
  createSecureClient,
  type Signer,
  type TransactionHandle,
} from "@polymarket/client";
import { getContractConfig as getClobV2ContractConfig } from "@polymarket/clob-client-v2";
import {
  createBuilderApiKey,
  prepareGaslessTransaction,
} from "@polymarket/client/actions";
import { builderApiKey } from "@polymarket/client/node";
import { signerFrom as polymarketSignerFrom } from "@polymarket/client/viem";
import { PrivyClient } from "@privy-io/node";
import { and, desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type LocalAccount,
  maxUint256,
  parseAbi,
} from "viem";
import { polygon } from "viem/chains";
import { getAppDb } from "@/adapters/server/db/drizzle.client";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import {
  DrizzlePolyWalletResetStateAdapter,
  PrivyPolyTraderWalletAdapter,
  type VerifiedPusdAllowanceStateV1,
} from "@/adapters/server/wallet";
import {
  classifyClobCredentialRotationError,
  createOrDerivePolymarketApiKeyForSigner,
  normalizePolymarketApiKeyCreds,
  rotatePolymarketApiKeyForSigner,
} from "@/bootstrap/capabilities/poly-clob-creds";
import { LIVE_CONNECTION_KIND } from "@/features/paper-accounts";
import { serverEnv } from "@/shared/env/server-env";

export class WalletAdapterUnconfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `PolyTraderWalletAdapter not configured: missing env vars: ${missing.join(", ")}`
    );
    this.name = "WalletAdapterUnconfiguredError";
  }
}

let cached: PrivyPolyTraderWalletAdapter | null = null;

/** Pure local-config readiness check for DB-only status/read routes. */
export function isPolyTraderWalletConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.PRIVY_USER_WALLETS_APP_ID &&
      env.PRIVY_USER_WALLETS_APP_SECRET &&
      env.PRIVY_USER_WALLETS_SIGNING_KEY &&
      env.POLY_WALLET_AEAD_KEY_HEX &&
      env.POLY_WALLET_AEAD_KEY_ID &&
      env.POLYGON_RPC_URL
  );
}

export function createRealClobCredsFactory({
  logger,
  polygonRpcUrl,
  geoBlockToken,
  deriveCreds = createOrDerivePolymarketApiKeyForSigner,
  rotateCreds = rotatePolymarketApiKeyForSigner,
}: {
  logger: Logger;
  polygonRpcUrl?: string | undefined;
  geoBlockToken?: string | undefined;
  deriveCreds?: (input: {
    signer: LocalAccount;
    polygonRpcUrl?: string | undefined;
    geoBlockToken?: string | undefined;
  }) => Promise<{
    key: string;
    secret: string;
    passphrase: string;
  }>;
  rotateCreds?: (input: {
    signer: LocalAccount;
    currentCreds: { key: string; secret: string; passphrase: string };
    polygonRpcUrl?: string | undefined;
  }) => Promise<{
    key: string;
    secret: string;
    passphrase: string;
  }>;
}) {
  return {
    derive: async (signer: LocalAccount) => {
      try {
        return normalizePolymarketApiKeyCreds(
          await deriveCreds({ signer, polygonRpcUrl, geoBlockToken })
        );
      } catch (err) {
        const failure = classifyClobCredentialRotationError(err);
        logger.error(
          {
            component: "poly-trader-wallet-bootstrap",
            funder_address: signer.address,
            reason_code: failure.reasonCode,
            http_status: failure.httpStatus,
            error_class: failure.errorClass,
            cloudflare_ray_id: failure.cloudflareRayId,
          },
          "poly.wallet.provision failed to derive live CLOB creds"
        );
        throw Object.assign(
          new Error(
            "Failed to derive Polymarket CLOB API credentials for the tenant wallet"
          ),
          { code: failure.reasonCode }
        );
      }
    },
    rotate: async (
      signer: LocalAccount,
      currentCreds: { key: string; secret: string; passphrase: string }
    ) => {
      try {
        return normalizePolymarketApiKeyCreds(
          await rotateCreds({ signer, currentCreds, polygonRpcUrl })
        );
      } catch (err) {
        const failure = classifyClobCredentialRotationError(err);
        logger.error(
          {
            component: "poly-trader-wallet-bootstrap",
            funder_address: signer.address,
            reason_code: failure.reasonCode,
            http_status: failure.httpStatus,
            error_class: failure.errorClass,
            cloudflare_ray_id: failure.cloudflareRayId,
          },
          "poly.wallet.rotate failed to rotate live CLOB creds"
        );
        throw Object.assign(
          new Error(
            "Failed to rotate Polymarket CLOB API credentials for the tenant wallet"
          ),
          { code: failure.reasonCode }
        );
      }
    },
  };
}

const POLYMARKET_CONTRACTS = getClobV2ContractConfig(polygon.id);
const PUSD_POLYGON = POLYMARKET_CONTRACTS.collateral as Address;
const LEGACY_NEG_RISK_ADAPTER = POLYMARKET_CONTRACTS.negRiskAdapter as Address;
const PUSD_TRADE_SPENDERS: readonly Address[] = [
  POLYMARKET_CONTRACTS.exchangeV2 as Address,
  POLYMARKET_CONTRACTS.negRiskExchangeV2 as Address,
  LEGACY_NEG_RISK_ADAPTER,
];
const USDC_E_POLYGON =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const COLLATERAL_ONRAMP_POLYGON =
  "0x93070a847efEf7F70739046A929D47a521F5B8ee" as const;
const COLLATERAL_OFFRAMP_POLYGON =
  "0x2957922Eb93258b93368531d39fAcCA3B4dC5854" as const;
const COLLATERAL_ONRAMP_WRAP_ABI = parseAbi([
  "function wrap(address asset, address to, uint256 amount)",
]);
const COLLATERAL_OFFRAMP_UNWRAP_ABI = parseAbi([
  "function unwrap(address asset, address to, uint256 amount)",
]);

async function completeGaslessWorkflow(
  workflow: Awaited<ReturnType<typeof prepareGaslessTransaction>>,
  signer: Signer
): Promise<TransactionHandle> {
  let result = await workflow.next();
  while (!result.done) {
    try {
      switch (result.value.kind) {
        case "requestAddress":
          result = await workflow.next(await signer.getAddress());
          break;
        case "signGaslessTypedData":
          result = await workflow.next(
            await signer.signTypedData(result.value.payload)
          );
          break;
        case "signGaslessMessage":
          result = await workflow.next(
            await signer.signMessage(result.value.payload)
          );
          break;
      }
    } catch (error) {
      result = await workflow.throw(error);
    }
  }
  return result.value;
}

export async function createOfficialDepositWalletClient({
  signer,
  clobCreds,
  polygonRpcUrl,
}: {
  signer: LocalAccount;
  clobCreds: PolyClobApiKeyCreds;
  polygonRpcUrl: string;
}) {
  const walletClient = createWalletClient({
    // biome-ignore lint/suspicious/noExplicitAny: Privy/viem peer minor drift
    account: signer as any,
    chain: polygon,
    transport: http(polygonRpcUrl),
  });
  const polySigner = polymarketSignerFrom(walletClient);
  const eoaClient = await createSecureClient({
    signer: polySigner,
    wallet: signer.address,
    credentials: clobCreds as never,
  });
  const builderCredentials = await createBuilderApiKey(eoaClient);
  const depositClient = await createSecureClient({
    signer: polySigner,
    credentials: clobCreds as never,
    apiKey: builderApiKey(builderCredentials),
  });
  return { depositClient, eoaClient, polySigner };
}

/**
 * Canonical V2 onboarding proved against production CLOB: Privy signer EOA →
 * account-minted Builder key → deterministic Deposit Wallet → gasless trading
 * approvals. Existing pUSD is moved only from the explicit enable-trading
 * migration path.
 */
export function createOfficialDepositWalletFactory({
  logger,
  polygonRpcUrl,
}: {
  logger: Logger;
  polygonRpcUrl: string;
}) {
  return async (
    signer: LocalAccount,
    clobCreds: PolyClobApiKeyCreds,
    options: {
      readonly transferExistingPusd: boolean;
      readonly setupTradingApprovals: boolean;
    }
  ): Promise<{
    funderAddress: `0x${string}`;
    allowanceState: VerifiedPusdAllowanceStateV1 | null;
  }> => {
    const { depositClient, eoaClient } =
      await createOfficialDepositWalletClient({
        signer,
        clobCreds,
        polygonRpcUrl,
      });
    const publicClient = createPublicClient({
      chain: polygon,
      transport: http(polygonRpcUrl),
    });

    if (options.transferExistingPusd) {
      const balance = await publicClient.readContract({
        address: PUSD_POLYGON,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [signer.address],
      });
      if (balance > 0n) {
        const transfer = await eoaClient.transferErc20({
          amount: balance,
          recipientAddress: depositClient.account.wallet,
          tokenAddress: PUSD_POLYGON,
        });
        await transfer.wait();
      }
    }

    let allowanceState: VerifiedPusdAllowanceStateV1 | null = null;
    if (options.setupTradingApprovals) {
      await depositClient.setupTradingApprovals();

      // @polymarket/client 0.11's setup list covers both V2 exchanges but
      // omits the legacy NegRiskAdapter that the production CLOB still asks
      // to spend pUSD on some neg-risk BUYs. Repair that exact gap through
      // the same gasless Deposit Wallet, idempotently.
      const legacyAdapterAllowance = await publicClient.readContract({
        address: PUSD_POLYGON,
        abi: erc20Abi,
        functionName: "allowance",
        args: [
          depositClient.account.wallet,
          LEGACY_NEG_RISK_ADAPTER,
        ],
      });
      if (legacyAdapterAllowance !== maxUint256) {
        const approval = await depositClient.approveErc20({
          amount: "max",
          spenderAddress: LEGACY_NEG_RISK_ADAPTER,
          tokenAddress: PUSD_POLYGON,
        });
        await approval.wait();
      }

      const verifiedAllowances = await Promise.all(
        PUSD_TRADE_SPENDERS.map((spender) =>
          publicClient.readContract({
            address: PUSD_POLYGON,
            abi: erc20Abi,
            functionName: "allowance",
            args: [depositClient.account.wallet, spender],
          })
        )
      );
      if (verifiedAllowances.some((allowance) => allowance !== maxUint256)) {
        throw new Error(
          "Deposit Wallet trading approvals did not post-verify for every pUSD spender"
        );
      }
      allowanceState = {
        kind: "polymarket_pusd_buy_allowances_v1",
        chainId: polygon.id,
        funderAddress: depositClient.account.wallet,
        tokenAddress: PUSD_POLYGON,
        verifiedAt: new Date().toISOString(),
        spenders: PUSD_TRADE_SPENDERS.map((address, index) => ({
          address,
          allowanceAtomic: (verifiedAllowances[index] ?? 0n).toString(),
        })),
      };
    }
    logger.info(
      {
        component: "poly-trader-wallet-bootstrap",
        signer_address: signer.address,
        funder_address: depositClient.account.wallet,
        migrated_existing_pusd: options.transferExistingPusd,
      },
      options.setupTradingApprovals
        ? "poly.wallet.deposit_wallet.ready"
        : "poly.wallet.deposit_wallet.derived"
    );
    return { funderAddress: depositClient.account.wallet, allowanceState };
  };
}

export function createOfficialDepositWalletTransferFactory({
  polygonRpcUrl,
}: {
  polygonRpcUrl: string;
}) {
  return async (
    signer: LocalAccount,
    clobCreds: PolyClobApiKeyCreds,
    input: {
      readonly expectedFunderAddress: `0x${string}`;
      readonly tokenAddress: `0x${string}`;
      readonly recipientAddress: `0x${string}`;
      readonly amount: bigint;
    }
  ): Promise<`0x${string}`> => {
    const { depositClient } = await createOfficialDepositWalletClient({
      signer,
      clobCreds,
      polygonRpcUrl,
    });
    if (
      depositClient.account.wallet.toLowerCase() !==
      input.expectedFunderAddress.toLowerCase()
    ) {
      throw new Error("Deposit Wallet address does not match persisted funder");
    }
    const handle = await depositClient.transferErc20({
      amount: input.amount,
      recipientAddress: input.recipientAddress,
      tokenAddress: input.tokenAddress,
    });
    const outcome = await handle.wait();
    return outcome.transactionHash;
  };
}

export function createOfficialDepositWalletNativeTransferFactory({
  polygonRpcUrl,
}: {
  polygonRpcUrl: string;
}) {
  return async (
    signer: LocalAccount,
    clobCreds: PolyClobApiKeyCreds,
    input: {
      readonly expectedFunderAddress: `0x${string}`;
      readonly recipientAddress: `0x${string}`;
      readonly amount: bigint;
    }
  ): Promise<`0x${string}`> => {
    const { depositClient, polySigner } =
      await createOfficialDepositWalletClient({
        signer,
        clobCreds,
        polygonRpcUrl,
      });
    if (
      depositClient.account.wallet.toLowerCase() !==
      input.expectedFunderAddress.toLowerCase()
    ) {
      throw new Error("Deposit Wallet address does not match persisted funder");
    }
    const workflow = await prepareGaslessTransaction(depositClient, {
      calls: [
        {
          to: input.recipientAddress,
          data: "0x",
          value: input.amount,
        },
      ],
      metadata: "Recover native POL from Deposit Wallet",
    });
    const handle = await completeGaslessWorkflow(workflow, polySigner);
    const outcome = await handle.wait();
    return outcome.transactionHash;
  };
}

export function createOfficialDepositWalletWrapFactory({
  polygonRpcUrl,
}: {
  polygonRpcUrl: string;
}) {
  return async (
    signer: LocalAccount,
    clobCreds: PolyClobApiKeyCreds,
    input: {
      readonly expectedFunderAddress: `0x${string}`;
      readonly amount: bigint;
    }
  ): Promise<`0x${string}`> => {
    const { depositClient, polySigner } =
      await createOfficialDepositWalletClient({
        signer,
        clobCreds,
        polygonRpcUrl,
      });
    if (
      depositClient.account.wallet.toLowerCase() !==
      input.expectedFunderAddress.toLowerCase()
    ) {
      throw new Error("Deposit Wallet address does not match persisted funder");
    }

    const workflow = await prepareGaslessTransaction(depositClient, {
      calls: [
        {
          to: USDC_E_POLYGON,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [COLLATERAL_ONRAMP_POLYGON, input.amount],
          }),
        },
        {
          to: COLLATERAL_ONRAMP_POLYGON,
          data: encodeFunctionData({
            abi: COLLATERAL_ONRAMP_WRAP_ABI,
            functionName: "wrap",
            args: [
              USDC_E_POLYGON,
              input.expectedFunderAddress,
              input.amount,
            ],
          }),
        },
      ],
      metadata: "Wrap Deposit Wallet USDC.e to pUSD",
    });
    const handle = await completeGaslessWorkflow(workflow, polySigner);
    const outcome = await handle.wait();
    return outcome.transactionHash;
  };
}

export function createOfficialDepositWalletUnwrapFactory({
  polygonRpcUrl,
}: {
  polygonRpcUrl: string;
}) {
  return async (
    signer: LocalAccount,
    clobCreds: PolyClobApiKeyCreds,
    input: {
      readonly expectedFunderAddress: `0x${string}`;
      readonly recipientAddress: `0x${string}`;
      readonly amount: bigint;
    }
  ): Promise<`0x${string}`> => {
    const { depositClient, polySigner } =
      await createOfficialDepositWalletClient({
        signer,
        clobCreds,
        polygonRpcUrl,
      });
    if (
      depositClient.account.wallet.toLowerCase() !==
      input.expectedFunderAddress.toLowerCase()
    ) {
      throw new Error("Deposit Wallet address does not match persisted funder");
    }

    const workflow = await prepareGaslessTransaction(depositClient, {
      calls: [
        {
          to: PUSD_POLYGON,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [COLLATERAL_OFFRAMP_POLYGON, input.amount],
          }),
        },
        {
          to: COLLATERAL_OFFRAMP_POLYGON,
          data: encodeFunctionData({
            abi: COLLATERAL_OFFRAMP_UNWRAP_ABI,
            functionName: "unwrap",
            args: [USDC_E_POLYGON, input.recipientAddress, input.amount],
          }),
        },
      ],
      metadata: "Recover Deposit Wallet pUSD as USDC.e",
    });
    const handle = await completeGaslessWorkflow(workflow, polySigner);
    const outcome = await handle.wait();
    return outcome.transactionHash;
  };
}

/**
 * Lazy-construct + memoize the adapter. Follow-up will move this into the
 * main container; standalone factory keeps the first flight-able commit small.
 *
 * @throws {WalletAdapterUnconfiguredError} when env is missing.
 */
export function getPolyTraderWalletAdapter(
  logger: Logger
): PrivyPolyTraderWalletAdapter {
  if (cached) return cached;

  const env = serverEnv();
  const missing: string[] = [];
  const appId = env.PRIVY_USER_WALLETS_APP_ID;
  const appSecret = env.PRIVY_USER_WALLETS_APP_SECRET;
  const signingKey = env.PRIVY_USER_WALLETS_SIGNING_KEY;
  const aeadKeyHex = env.POLY_WALLET_AEAD_KEY_HEX;
  const aeadKeyId = env.POLY_WALLET_AEAD_KEY_ID;
  const polygonRpcUrl = env.POLYGON_RPC_URL;
  if (!appId) missing.push("PRIVY_USER_WALLETS_APP_ID");
  if (!appSecret) missing.push("PRIVY_USER_WALLETS_APP_SECRET");
  if (!signingKey) missing.push("PRIVY_USER_WALLETS_SIGNING_KEY");
  if (!aeadKeyHex) missing.push("POLY_WALLET_AEAD_KEY_HEX");
  if (!aeadKeyId) missing.push("POLY_WALLET_AEAD_KEY_ID");
  if (!polygonRpcUrl) missing.push("POLYGON_RPC_URL");
  if (
    missing.length ||
    !appId ||
    !appSecret ||
    !signingKey ||
    !aeadKeyHex ||
    !aeadKeyId ||
    !polygonRpcUrl
  ) {
    // NO_UNUSABLE_STUB — this used to return a Proxy whose every property access
    // threw (`createPaperUnusableWalletAdapter`, bug.5253), so that a paper-only
    // deployment with no Privy / AEAD credentials could still construct the
    // executor factory. The paper venue no longer goes through this adapter at
    // all (it has its own authorizer + identity), so the stub's only remaining
    // effect would be to turn a configuration error into a mystery
    // `TypeError`-shaped failure deep inside a live code path. Callers that can
    // serve paper accounts catch this error and wire the factory without a
    // `walletPort`; see `container.ts`.
    throw new WalletAdapterUnconfiguredError(missing);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(aeadKeyHex)) {
    throw new Error(
      "POLY_WALLET_AEAD_KEY_HEX must be exactly 64 hex characters (AES-256-GCM)"
    );
  }
  const encryptionKey = Buffer.from(aeadKeyHex, "hex");

  const privyClient = new PrivyClient({
    appId,
    appSecret,
  });

  const clobCreds = createRealClobCredsFactory({
    logger,
    polygonRpcUrl,
    geoBlockToken: env.POLY_CLOB_GEO_BLOCK_TOKEN,
  });

  cached = new PrivyPolyTraderWalletAdapter({
    privyClient,
    privySigningKey: signingKey,
    serviceDb: getServiceDb(),
    encryptionKey,
    encryptionKeyId: aeadKeyId,
    clobCredsFactory: clobCreds.derive,
    clobCredsRotator: clobCreds.rotate,
    prepareDepositWallet: createOfficialDepositWalletFactory({
      logger,
      polygonRpcUrl,
    }),
    transferDepositWalletToken: createOfficialDepositWalletTransferFactory({
      polygonRpcUrl,
    }),
    transferDepositWalletNative:
      createOfficialDepositWalletNativeTransferFactory({ polygonRpcUrl }),
    wrapDepositWalletUsdcE: createOfficialDepositWalletWrapFactory({
      polygonRpcUrl,
    }),
    unwrapDepositWalletPusd: createOfficialDepositWalletUnwrapFactory({
      polygonRpcUrl,
    }),
    polygonRpcUrl,
    logger,
  });
  return cached;
}

/** For tests only — clears the memoized instance. */
export function __resetPolyTraderWalletAdapterForTests(): void {
  cached = null;
}

export function createPolyWalletResetStateAdapter(): DrizzlePolyWalletResetStateAdapter {
  return new DrizzlePolyWalletResetStateAdapter(getAppDb());
}

/**
 * Minimum window between consecutive `/connect` attempts for a single tenant
 * whose latest wallet is *revoked*. Bounds the connect→revoke→connect churn
 * path; idempotent re-hits with an active row do NOT hit this limit.
 */
export const POLY_WALLET_CONNECT_RATE_LIMIT_MS = 5 * 60 * 1000;

export interface ConnectRateLimitResult {
  /** True when the caller should return 429 instead of invoking `provision`. */
  limited: boolean;
  /** Seconds until the cooldown expires; only meaningful when `limited`. */
  retryAfterSeconds: number;
}

/**
 * Check whether a new `/connect` attempt for the given tenant should be
 * rate-limited. Returns `{ limited: false }` when:
 *   - the tenant has no LIVE rows yet (first-ever provision), OR
 *   - the tenant's most-recent live row is still active (idempotent re-hit), OR
 *   - the tenant's most-recent live row was revoked more than the cooldown ago.
 * Returns `{ limited: true, retryAfterSeconds }` when the most-recent live row
 * is revoked AND still inside the cooldown window.
 *
 * LIVE_ROWS_ONLY: `/connect` provisions a `kind='privy_live'` wallet, so the
 * cooldown must be computed over live rows only. Without the filter, a paper
 * account created after a live revoke becomes the "most-recent row", its
 * `revoked_at` is NULL, and the just-revoked live row is masked — the
 * connect→revoke→connect churn this limiter exists to bound sails straight
 * through. The `revoked_at` predicate stays absent on purpose: the decision
 * needs the latest row *whatever its state*, and reads `revoked_at` off it.
 *
 * Kept in bootstrap (not in the route / not in the adapter) so route handlers
 * can consume it without crossing the `@/adapters/**` boundary.
 */
export async function checkConnectRateLimit(
  billingAccountId: string,
  nowMs: number = Date.now()
): Promise<ConnectRateLimitResult> {
  const db = getServiceDb();
  const [latest] = await db
    .select({
      revokedAt: polyWalletConnections.revokedAt,
    })
    .from(polyWalletConnections)
    .where(
      and(
        eq(polyWalletConnections.billingAccountId, billingAccountId),
        eq(polyWalletConnections.kind, LIVE_CONNECTION_KIND)
      )
    )
    .orderBy(desc(polyWalletConnections.createdAt))
    .limit(1);

  if (!latest?.revokedAt) {
    return { limited: false, retryAfterSeconds: 0 };
  }
  const revokedMsAgo = nowMs - latest.revokedAt.getTime();
  if (revokedMsAgo >= POLY_WALLET_CONNECT_RATE_LIMIT_MS) {
    return { limited: false, retryAfterSeconds: 0 };
  }
  return {
    limited: true,
    retryAfterSeconds: Math.ceil(
      (POLY_WALLET_CONNECT_RATE_LIMIT_MS - revokedMsAgo) / 1000
    ),
  };
}
