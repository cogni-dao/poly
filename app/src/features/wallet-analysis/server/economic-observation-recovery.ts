// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Bounded internal observation recovery. No signer, order executor, ledger cursor
 * reset or canonical-fill mutation. Native economics REPLACE an observation
 * envelope; they are never added to fill-rollup totals. PAGE_LOAD_DB_ONLY readers
 * consume these saved facts; this module is reachable only from the observer.
 */
import { createHash } from "node:crypto";
import type { LoggerPort } from "@cogni/poly-market-provider";
import {
  type PolymarketActivityV2,
  type PolymarketDataApiClient,
  type PolymarketUserPositionV2,
  POLYGON_CONDITIONAL_TOKENS,
  POLYGON_PUSD,
  POLYGON_USDC_E,
} from "@cogni/poly-market-provider/adapters/polymarket";
import { type SQL, sql } from "drizzle-orm";
import { createPublicClient, decodeEventLog, http, parseAbi, type TransactionReceipt } from "viem";
import { polygon } from "viem/chains";

const LOOKBACK_MS = 35 * 86_400_000;
const RETRY_MS = 30 * 60_000;
/** GLOBAL per observer tick, not multiplied by wallet count. */
export const ECONOMIC_RECOVERY_BUDGET = {
  conditions: 1,
  dataRequests: 4,
  rpcRequests: 3,
  tokens: 20,
} as const;
type Db = { execute(query: SQL): Promise<unknown> };
const ZERO = "0x0000000000000000000000000000000000000000";
const EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)",
]);

export type EconomicSettlementProof = {
  txHash: string;
  blockNumber: string;
  blockHash: string;
  logIndex: number;
  collateral: string;
  atomicAmount: string;
  recipient: string;
  conditionId: string;
  tokenId: string;
  sharesAtomic: string;
};
export type EconomicSettlementReader = (input: {
  walletAddress: string;
  conditionId: string;
  tokenId: string;
  txHash: string;
  expectedAtomic: bigint;
  signal?: AbortSignal | undefined;
}) => Promise<EconomicSettlementProof | null>;

export type EconomicObservationV1 = {
  version: 1;
  wallet: string;
  conditionId: string;
  tokenId: string;
  fetchedAt: string;
  windowStart: string;
  windowEnd: string;
  coverage: "complete" | "partial";
  reasons: string[];
  closedPosition: PolymarketUserPositionV2;
  lifetimeBuyUsdc: number;
  lifetimeBuyShares: number;
  lifetimeSellUsdc: number;
  lifetimePnlUsdc: number | null;
  redeemUsdc: number;
  constituents: readonly PolymarketActivityV2[];
  settlements: readonly EconomicSettlementProof[];
};

function atoms(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1e9) throw new Error("invalid native amount");
  return BigInt(Math.round(value * 1e6));
}
function units(value: bigint): number {
  return Number(value) / 1e6;
}
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result)
    return (result as { rows: T[] }).rows;
  return [];
}

/** Pure receipt proof, including V2 routed redemption (wallet -> router -> burn). */
export function verifyEconomicSettlement(input: {
  receipt: TransactionReceipt;
  walletAddress: string;
  conditionId: string;
  tokenId: string;
  expectedAtomic: bigint;
  canonicalBlockHash: string;
  head: bigint;
}): EconomicSettlementProof | null {
  const { receipt } = input;
  if (
    receipt.status !== "success" ||
    receipt.blockHash !== input.canonicalBlockHash ||
    input.head < receipt.blockNumber + 5n ||
    input.expectedAtomic <= 0n
  )
    return null;
  const wallet = input.walletAddress.toLowerCase();
  const decoded = receipt.logs.flatMap((log) => {
    try {
      return [{ log, event: decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics }) }];
    } catch {
      return [];
    }
  });
  const movements = decoded.flatMap(({ log, event }) => {
    if (log.address.toLowerCase() !== POLYGON_CONDITIONAL_TOKENS.toLowerCase()) return [];
    if (event.eventName === "TransferSingle")
      return [
        {
          from: event.args.from.toLowerCase(),
          to: event.args.to.toLowerCase(),
          id: event.args.id,
          amount: event.args.value,
          index: log.logIndex,
        },
      ];
    if (event.eventName === "TransferBatch")
      return event.args.ids.map((id, i) => ({
        from: event.args.from.toLowerCase(),
        to: event.args.to.toLowerCase(),
        id,
        amount: event.args.values[i],
        index: log.logIndex,
      }));
    return [];
  });
  const exits = movements.filter(
    (move) =>
      move.from === wallet &&
      move.id.toString() === input.tokenId &&
      move.amount === input.expectedAtomic,
  );
  // A batched router receipt can contain many tenants: identify this account's
  // exact transfer, its matching burn, condition payout, and collateral credit.
  if (exits.length !== 1) return null;
  const exit = exits[0];
  if (!exit) return null;
  const redeemer = exit.to === ZERO ? wallet : exit.to;
  const burn = movements.find(
    (move) =>
      move.from === redeemer &&
      move.to === ZERO &&
      move.id.toString() === input.tokenId &&
      move.amount === input.expectedAtomic &&
      move.index >= exit.index,
  );
  if (exit.to !== ZERO && !burn) return null;
  const payout = decoded.find(
    ({ log, event }) =>
      log.address.toLowerCase() === POLYGON_CONDITIONAL_TOKENS.toLowerCase() &&
      event.eventName === "PayoutRedemption" &&
      event.args.redeemer.toLowerCase() === redeemer &&
      event.args.conditionId.toLowerCase() === input.conditionId.toLowerCase() &&
      event.args.payout === input.expectedAtomic &&
      log.logIndex >= (burn?.index ?? exit.index),
  );
  if (!payout) return null;
  const credits = decoded.filter(
    ({ log, event }) =>
      [POLYGON_USDC_E.toLowerCase(), POLYGON_PUSD.toLowerCase()].includes(
        log.address.toLowerCase(),
      ) &&
      event.eventName === "Transfer" &&
      event.args.to.toLowerCase() === wallet &&
      event.args.value === input.expectedAtomic &&
      log.logIndex >= payout.log.logIndex,
  );
  if (credits.length !== 1) return null;
  const credit = credits[0];
  if (!credit) return null;
  return {
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    logIndex: credit.log.logIndex,
    collateral: credit.log.address,
    atomicAmount: input.expectedAtomic.toString(),
    recipient: wallet,
    conditionId: input.conditionId.toLowerCase(),
    tokenId: input.tokenId,
    sharesAtomic: input.expectedAtomic.toString(),
  };
}

/** Exactly three RPCs; retries disabled so transport cannot multiply the budget. */
export function createEconomicSettlementReader(input: {
  rpcUrl: string;
}): EconomicSettlementReader {
  const client = createPublicClient({
    chain: polygon,
    transport: http(input.rpcUrl, { timeout: 5_000, retryCount: 0 }),
  });
  return async (request) => {
    request.signal?.throwIfAborted();
    const receipt = await client.getTransactionReceipt({ hash: request.txHash as `0x${string}` });
    request.signal?.throwIfAborted();
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    request.signal?.throwIfAborted();
    const head = await client.getBlockNumber({ cacheTime: 0 });
    request.signal?.throwIfAborted();
    return verifyEconomicSettlement({ ...request, receipt, canonicalBlockHash: block.hash, head });
  };
}

/** Source multiplicity is accepted only after independent quantity corroboration. */
export function buildEconomicObservations(input: {
  walletAddress: string;
  conditionId: string;
  positions: readonly PolymarketUserPositionV2[];
  activity: readonly PolymarketActivityV2[];
  fetchedAt: Date;
  windowStart: Date;
  settlements: readonly EconomicSettlementProof[];
}): EconomicObservationV1[] {
  const ids = new Map<string, PolymarketActivityV2>();
  const source: PolymarketActivityV2[] = [];
  let conflictingId = false;
  for (const row of input.activity) {
    const nativeId =
      row.trade_id ??
      row.id ??
      (row.log_index === undefined ? null : `${row.transaction_hash}:${row.log_index}`);
    if (nativeId !== null) {
      const id = `${row.type}:${String(nativeId)}`;
      const previous = ids.get(id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(row)) conflictingId = true;
        continue;
      }
      ids.set(id, row);
    }
    source.push(row);
  }
  const redemptions = source.filter((row) => row.type === "REDEEM");
  const winners = input.positions.filter((row) => row.current_price === 1);
  const payout = redemptions.reduce((sum, row) => sum + atoms(row.usdc_size), 0n);
  const observations = input.positions.map((position): EconomicObservationV1 => {
    const activity = source.filter(
      (row) => row.type === "TRADE" && row.token_id === position.token_id,
    );
    const buys = activity.filter((row) => row.side === "BUY");
    const sells = activity.filter((row) => row.side === "SELL");
    const bought = buys.reduce((sum, row) => sum + atoms(row.size), 0n);
    const sold = sells.reduce((sum, row) => sum + atoms(row.size), 0n);
    const buy = buys.reduce((sum, row) => sum + atoms(row.usdc_size), 0n);
    const sell = sells.reduce((sum, row) => sum + atoms(row.usdc_size), 0n);
    const proof = input.settlements.filter(
      (row) =>
        row.conditionId === input.conditionId.toLowerCase() &&
        row.tokenId === position.token_id &&
        row.recipient === input.walletAddress.toLowerCase(),
    );
    const proved = proof.reduce((sum, row) => sum + BigInt(row.atomicAmount), 0n);
    const isWinner = position.current_price === 1;
    const completeWindow =
      position.first_entry_at != null &&
      position.first_entry_at * 1000 >= input.windowStart.getTime();
    const quantityMatches = bought === atoms(position.total_size) && bought >= sold;
    const terminalCorroborated =
      winners.length === 1 &&
      payout > 0n &&
      input.settlements.length === 1 &&
      (isWinner ? proved === payout && proved === bought - sold : position.current_price === 0);
    const reasons = [
      ...(!completeWindow ? ["history_window_incomplete"] : []),
      ...(!quantityMatches ? ["native_quantity_conflict"] : []),
      ...(!terminalCorroborated ? ["settlement_unverified"] : []),
      ...(conflictingId ? ["constituent_identity_conflict"] : []),
      ...(source.some((row) => !["TRADE", "REDEEM"].includes(row.type))
        ? ["unsupported_economic_event"]
        : []),
    ];
    const complete = reasons.length === 0;
    const redeem = isWinner ? proved : 0n;
    return {
      version: 1,
      wallet: input.walletAddress.toLowerCase(),
      conditionId: input.conditionId.toLowerCase(),
      tokenId: position.token_id,
      fetchedAt: input.fetchedAt.toISOString(),
      windowStart: input.windowStart.toISOString(),
      windowEnd: input.fetchedAt.toISOString(),
      coverage: complete ? "complete" : "partial",
      reasons,
      closedPosition: position,
      lifetimeBuyUsdc: units(buy),
      lifetimeBuyShares: units(bought),
      lifetimeSellUsdc: units(sell),
      lifetimePnlUsdc: complete ? units(sell + redeem - buy) : null,
      redeemUsdc: units(redeem),
      constituents: activity,
      settlements: proof,
    };
  });
  // A market cash result cannot be called complete while its hedge is missing.
  return observations.every((row) => row.coverage === "complete")
    ? observations
    : observations.map((row) => ({
        ...row,
        coverage: "partial" as const,
        lifetimePnlUsdc: null,
        reasons: [...row.reasons, "cohort_incomplete"],
      }));
}

/** One global cohort after the ordinary wallet loop, within the existing leader. */
export async function recoverEconomicObservations(input: {
  db: Db;
  client: PolymarketDataApiClient;
  readSettlement: EconomicSettlementReader;
  logger: LoggerPort;
  now: Date;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const windowStart = new Date(input.now.getTime() - LOOKBACK_MS);
  // Latest missing/retry-old cohort, recent material executions first. Discovery
  // seeds include audit errors but never imply they executed or have lineage.
  const [candidate] = rows<{
    wallet_id: string;
    wallet_address: string;
    condition_id: string;
    token_id: string;
  }>(
    await input.db.execute(sql`
    WITH seeds AS (
      SELECT w.id AS wallet_id, lower(w.wallet_address) AS wallet_address,
        lower(COALESCE(NULLIF(f.attributes->>'condition_id', ''), regexp_replace(f.market_id, '^prediction-market:polymarket:', ''))) AS condition_id,
        max(f.attributes->>'token_id') AS token_id,
        max(f.observed_at) AS latest_at, sum(CASE WHEN COALESCE(f.attributes->>'size_usdc','') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (f.attributes->>'size_usdc')::numeric ELSE 0 END) AS materiality
      FROM poly_trader_wallets w
      JOIN poly_wallet_connections connection ON lower(connection.funder_address) = lower(w.wallet_address) AND connection.revoked_at IS NULL
      JOIN poly_copy_trade_fills f ON f.billing_account_id = connection.billing_account_id AND f.mode = 'live'
      WHERE w.kind = 'cogni_wallet' AND w.active_for_research AND w.disabled_at IS NULL
        AND f.observed_at >= ${windowStart.toISOString()}::timestamptz AND f.observed_at <= ${input.now.toISOString()}::timestamptz
      GROUP BY w.id, lower(w.wallet_address), lower(COALESCE(NULLIF(f.attributes->>'condition_id', ''), regexp_replace(f.market_id, '^prediction-market:polymarket:', '')))
    ), candidates AS (
      SELECT seeds.*, history.captured_at AS last_attempt_at,
        history.raw->'economicObservationV1'->>'coverage' AS coverage
      FROM seeds LEFT JOIN LATERAL (
        SELECT s.captured_at, s.raw FROM poly_trader_position_snapshots s
        WHERE s.trader_wallet_id = seeds.wallet_id AND lower(s.condition_id) = seeds.condition_id
          AND s.raw ? 'economicObservationV1'
        ORDER BY s.captured_at DESC,
          (s.raw->'economicObservationV1'->>'coverage' = 'complete') DESC, s.id LIMIT 1
      ) history ON TRUE
      WHERE seeds.condition_id ~ '^0x[0-9a-f]{64}$'
    ) SELECT wallet_id, wallet_address, condition_id, token_id FROM candidates
    WHERE coverage IS DISTINCT FROM 'complete' AND token_id ~ '^[0-9]+$'
      AND (last_attempt_at IS NULL OR last_attempt_at < ${new Date(input.now.getTime() - RETRY_MS).toISOString()}::timestamptz)
    ORDER BY last_attempt_at ASC NULLS FIRST, materiality DESC, latest_at DESC, wallet_id, condition_id LIMIT 1
  `),
  );
  if (!candidate) return;
  input.signal?.throwIfAborted();
  // Reserve ceilings, not actual counts: 2 CLOSED pages + 2 activity pages +
  // ONE receipt proof (3 RPCs). No per-wallet/cohort nested budget multiplier.
  // Record a bounded attempt first so empty CLOSED cohorts and transient
  // upstream failures cannot monopolize the global slot after every restart.
  await input.db.execute(sql`
    INSERT INTO poly_trader_position_snapshots (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
    VALUES (${candidate.wallet_id}::uuid,${candidate.condition_id},${candidate.token_id},0,0,0,0,
      ${`economic-attempt:${Math.floor(input.now.getTime() / RETRY_MS)}`},${input.now.toISOString()}::timestamptz,
      ${JSON.stringify({ economicObservationV1: { version: 1, coverage: "partial", reasons: ["recovery_pending"], fetchedAt: input.now.toISOString() } })}::jsonb)
    ON CONFLICT (trader_wallet_id,condition_id,token_id,content_hash) DO NOTHING
  `);
  const closed = await input.client.listUserPositionsV2Raw(candidate.wallet_address, {
    conditions: [candidate.condition_id],
    status: "CLOSED",
    maxRequests: 2,
    signal: input.signal,
  });
  if (closed.positions.length === 0 || closed.positions.length > ECONOMIC_RECOVERY_BUDGET.tokens)
    return;
  const native = await input.client.listConditionActivityV2(candidate.wallet_address, {
    conditionId: candidate.condition_id,
    start: Math.floor(windowStart.getTime() / 1000),
    end: Math.floor(input.now.getTime() / 1000),
    maxRequests: 2,
    signal: input.signal,
  });
  const redeems = native.activity.filter((row) => row.type === "REDEEM");
  const winners = closed.positions.filter((row) => row.current_price === 1);
  const settlements: EconomicSettlementProof[] = [];
  let rpcRequestsMax = 0;
  if (redeems.length === 1 && winners.length === 1) {
    const redeem = redeems[0];
    const winner = winners[0];
    if (redeem && winner) {
      rpcRequestsMax = ECONOMIC_RECOVERY_BUDGET.rpcRequests;
      const proof = await input.readSettlement({
        walletAddress: candidate.wallet_address,
        conditionId: candidate.condition_id,
        tokenId: winner.token_id,
        txHash: redeem.transaction_hash,
        expectedAtomic: atoms(redeem.usdc_size),
        signal: input.signal,
      });
      if (proof) settlements.push(proof);
    }
  }
  const observations = buildEconomicObservations({
    walletAddress: candidate.wallet_address,
    conditionId: candidate.condition_id,
    positions: closed.positions,
    activity: native.activity,
    fetchedAt: input.now,
    windowStart,
    settlements,
  });
  input.signal?.throwIfAborted();
  const values = observations.map((observation) => {
    const raw = JSON.stringify({ economicObservationV1: observation });
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          ...observation,
          fetchedAt: undefined,
          windowEnd: undefined,
          retryWindow:
            observation.coverage === "partial"
              ? Math.floor(input.now.getTime() / RETRY_MS)
              : undefined,
        }),
      )
      .digest("hex");
    return sql`(${candidate.wallet_id}::uuid,${observation.conditionId},${observation.tokenId},${`economic-v1:${hash}`},${raw}::jsonb)`;
  });
  // One statement publishes the WHOLE condition cohort atomically. Snapshots
  // carry history only; current quantity/active/mark/timestamps remain untouched.
  await input.db.execute(sql`
    WITH facts(wallet_id,condition_id,token_id,content_hash,raw) AS (VALUES ${sql.join(values, sql`, `)}),
    saved AS (
      INSERT INTO poly_trader_position_snapshots (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
      SELECT wallet_id,condition_id,token_id,0,0,0,0,content_hash,${input.now.toISOString()}::timestamptz,raw FROM facts
      ON CONFLICT (trader_wallet_id,condition_id,token_id,content_hash) DO NOTHING
    ) UPDATE poly_trader_current_positions p SET raw = COALESCE(p.raw,'{}'::jsonb) || facts.raw
      FROM facts WHERE p.trader_wallet_id = facts.wallet_id AND lower(p.condition_id) = facts.condition_id AND p.token_id = facts.token_id
        AND COALESCE(p.raw->'economicObservationV1'->>'fetchedAt','') <= facts.raw->'economicObservationV1'->>'fetchedAt'
  `);
  input.logger.info(
    {
      event: "poly.economic_observation.recovery",
      wallet: candidate.wallet_address,
      condition_id: candidate.condition_id,
      tokens: observations.length,
      complete: observations.filter((row) => row.coverage === "complete").length,
      data_requests: closed.requestCount + native.requestCount,
      rpc_requests_max: rpcRequestsMax,
    },
    "bounded economic history observed",
  );
}
