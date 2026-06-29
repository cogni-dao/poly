// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-watch/polymarket-chain-source`
 * Purpose: `WalletActivitySource` implementation that listens to Polygon `OrderFilled` events on Polymarket's CTF Exchange V2 + NegRisk Exchange V2 contracts, filtered at the RPC layer by indexed target-wallet topics. Replaces the `polymarket-ws-source` Data-API drain — the wake-up path was sub-second already, but `WS_NO_WALLET_IDENTITY` forced a ~5min `/trades` poll to attach wallet identity. Chain logs carry maker/taker as indexed event fields, so identity arrives with the data and the drain is gone.
 * Scope: One source instance per (target wallet). Holds 2 viem `watchContractEvent` subscriptions — one per exchange contract (V2 + NegRisk V2), filtered at the RPC layer by `maker = target_wallet`. Polymarket emits one `OrderFilled` per party per match, so the maker-only filter catches every target trade and the event's `side` field is target's side directly. Decodes price/size/side from log fields alone; enriches `(condition_id, outcome, end_date)` from a fully-paginated `listAllUserPositions(wallet)` snapshot refreshed every `refreshAssetsIntervalMs`. Pushes via `subscribeWake` callbacks; `fetchSince` drains the in-memory ring buffer.
 * Invariants:
 *   - FILL_ID_SHAPE_CHAIN — `fill_id = "chain:" + txHash + ":" + logIndex + ":" + side`. `(txHash, logIndex)` is a globally unique log coordinate, so the id is deterministic from chain state alone: two readers of the same log produce the same `fill_id` and `(target_id, fill_id)` unique-index dedupes correctly across replays + multi-pod. Cross-source collision with `data-api:` is structurally impossible (different prefix).
 *   - OBSERVED_AT_IS_BLOCK_TIMESTAMP — `observed_at` is the Polygon `block.timestamp` (ISO-8601) — same semantic as the prior data-api source's `trade.timestamp`, so the task.5042 lag histogram measures actual target → mirror latency and remains comparable across sources. `block.timestamp` is fetched via memoized `getBlock` (one RPC per unique block; logs in the same block share the cached value). On `getBlock` failure we fall back to wall-clock with a warn log + `getBlockTimestampFallback` counter — fills are NEVER dropped for a transient RPC issue; lag histogram degrades to a ≤ ~2 s under-report rather than silently losing trades.
 *   - CHAIN_REORG_POLICY_V0 — `watchContractEvent` delivers logs with no confirmations buffer; reorg retractions arrive as `log.removed === true` on the next poll, are dropped + counted (`poly_mirror_chain_skip_total{reason="reorg"}`), but already-emitted Fills are NOT recalled. Mirror orders placed on a reorged log sit on CLOB until the order-reconciler (`bootstrap/jobs/order-reconciler.job`) hits its `clob_not_found` grace window (default 900 s). v1 hardening: 1-block delay-buffer or `getLogs(toBlock: latest - N)`. task.5043 follow-up.
 *   - CURSOR_IS_MAX_TIMESTAMP — `newSince` = max `block.timestamp` (unix seconds) emitted this drain.
 *   - CHAIN_TRANSPORT_IS_PUSH — the caller-supplied `publicClient` MUST use viem's `webSocket()` transport so `watchContractEvent` issues `eth_subscribe` (push, server-side filter). HTTP transport falls back to `eth_newFilter` + `eth_getFilterChanges` polling, which Alchemy garbage-collects and viem 2.39 does not recreate (bug.5051 — observed ~98% event miss rate). Same WSS client multiplexes all per-target subscriptions + `getBlock` lookups onto one connection.
 *   - METADATA_FROM_POSITIONS — `(condition_id, outcome, end_date)` enriched from `listAllUserPositions(wallet)` (paginated to exhaustion — bug.5055; the single-page `listUserPositions` silently caps at ~100 rows per bug.5027, which would drop everything past the top page), refreshed every `refreshAssetsIntervalMs`. Cache miss triggers an immediate refresh + retry; still-missing OR empty-outcome → skip with `metadata_unresolved` + warn. Empty-outcome skip prevents wrong-leg mirroring on NegRisk multi-outcome markets.
 * Side-effects: opens 2 viem RPC subscriptions; HTTPS GETs to data-api.polymarket.com on each metadata refresh; logger + metrics; periodic heartbeat info log.
 * Links: docs/spec/poly-copy-trade-execution.md, work/items/task.5043, work/items/task.5042
 * @public
 */

import {
  type Fill,
  FillSchema,
  type LoggerPort,
  type MetricsPort,
} from "@cogni/poly-market-provider";
import {
  POLYGON_POLYMARKET_EXCHANGE_V2,
  POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
  type PolymarketDataApiClient,
  type PolymarketUserPosition,
  polymarketExchangeOrderFilledAbi,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { Log, PublicClient } from "viem";
import { EVENT_NAMES } from "@/shared/observability/events";

import {
  type NextFillsResult,
  WALLET_WATCH_METRICS,
  type WalletActivitySource,
} from "./types";

/** Counter / histogram names emitted by the chain source. */
export const WALLET_WATCH_CHAIN_METRICS = {
  /** `poly_mirror_chain_logs_total` — every raw `OrderFilled` log received from any subscription before decode. */
  logsTotal: "poly_mirror_chain_logs_total",
  /** `poly_mirror_chain_fills_total` — decoded + enriched Fills emitted to the buffer. */
  fillsTotal: "poly_mirror_chain_fills_total",
  /** `poly_mirror_chain_skip_total{reason}` — log dropped. Bounded reason enum: `reorg` | `decode_no_target_match` | `metadata_unresolved` | `schema_invalid`. */
  skipTotal: "poly_mirror_chain_skip_total",
  /** `poly_mirror_chain_metadata_refresh_total{trigger}` — listUserPositions refresh fires. Bounded trigger enum: `interval` | `cache_miss` | `cold_start`. */
  metadataRefreshTotal: "poly_mirror_chain_metadata_refresh_total",
  /** `poly_mirror_chain_metadata_refresh_duration_ms{trigger}` — round-trip + parse for the position snapshot. */
  metadataRefreshDurationMs: "poly_mirror_chain_metadata_refresh_duration_ms",
  /** `poly_mirror_chain_block_timestamp_fallback_total` — `getBlock` failed; observed_at fell back to wall-clock. Non-zero → Polygon RPC degradation; lag histogram under-reports by ≤ ~2 s for the duration. */
  blockTimestampFallbackTotal:
    "poly_mirror_chain_block_timestamp_fallback_total",
} as const;

/** Default cadence for `listUserPositions` refresh. Matches the legacy WS source's `refreshAssetsIntervalMs`. */
const DEFAULT_REFRESH_ASSETS_INTERVAL_MS = 60_000;
/** Default heartbeat info-log cadence (ms). Loki absence-alert key. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface PolymarketChainActivitySourceDeps {
  publicClient: PublicClient;
  /** Per-wallet Data-API client — used only for the `listUserPositions` enrichment cache. */
  client: PolymarketDataApiClient;
  /** Target's on-chain proxy wallet. */
  wallet: `0x${string}`;
  logger: LoggerPort;
  metrics: MetricsPort;
  /** Cadence to refresh the tokenId → metadata cache. Default 60 000. */
  refreshAssetsIntervalMs?: number;
  /** Heartbeat info-log cadence (ms); 0 disables. Default 5 min. */
  heartbeatIntervalMs?: number;
}

export interface PolymarketChainActivitySource extends WalletActivitySource {
  /** Drop subscriptions + cancel timers. Idempotent. */
  stop(): void;
}

interface TokenMetadata {
  conditionId: string;
  outcome: string;
  endDate: string | null;
  title: string | null;
  slug: string | null;
}

interface BufferedFill {
  fill: Fill;
  blockTs: number;
}

type Unwatch = () => void;

/** viem `decodeEventLog` result for our pinned `OrderFilled` ABI. */
type OrderFilledLog = Log<bigint, number, false> & {
  args?: {
    orderHash?: `0x${string}`;
    maker?: `0x${string}`;
    taker?: `0x${string}`;
    side?: number;
    tokenId?: bigint;
    makerAmountFilled?: bigint;
    takerAmountFilled?: bigint;
    fee?: bigint;
    builder?: `0x${string}`;
    metadata?: `0x${string}`;
  };
};

/**
 * Decode a single `OrderFilled` event for one target wallet (target must be
 * the `maker` in this event). Returns a partial Fill missing only the
 * enrichment fields `(condition_id, outcome, attributes.*)` — those come from
 * the position cache.
 *
 * Polymarket V2 CTF Exchange emits TWO `OrderFilled` events per match — one
 * for each party — so filtering subscriptions on `maker = target_wallet`
 * catches every target trade, and the event's `side` field is target's order
 * side directly. The amount semantics are then:
 *   - target BUY  → target spent `makerAmountFilled` USDC, received `takerAmountFilled` shares
 *   - target SELL → target spent `makerAmountFilled` shares, received `takerAmountFilled` USDC
 *
 * Returns `null` for malformed logs or when `maker !== target` (shouldn't
 * happen if the topic filter matched, but defensive).
 *
 * @public exported for unit tests.
 */
export function decodeOrderFilledForTarget(
  log: OrderFilledLog,
  target: `0x${string}`
): {
  side: "BUY" | "SELL";
  tokenId: string;
  price: number;
  size_usdc: number;
  shares: number;
  txHash: `0x${string}`;
  logIndex: number;
} | null {
  const a = log.args;
  if (!a) return null;
  const { maker, side, tokenId, makerAmountFilled, takerAmountFilled } = a;
  if (
    !maker ||
    side === undefined ||
    tokenId === undefined ||
    makerAmountFilled === undefined ||
    takerAmountFilled === undefined
  ) {
    return null;
  }

  // We subscribe with `args: { maker: [target] }`, but stay defensive.
  if (maker.toLowerCase() !== target.toLowerCase()) return null;
  if (side !== 0 && side !== 1) return null;

  const targetSide: "BUY" | "SELL" = side === 0 ? "BUY" : "SELL";
  const usdcAmount =
    targetSide === "BUY" ? makerAmountFilled : takerAmountFilled;
  const shareAmount =
    targetSide === "BUY" ? takerAmountFilled : makerAmountFilled;

  if (shareAmount === 0n) return null;
  const shares = Number(shareAmount) / 1_000_000;
  const size_usdc = Number(usdcAmount) / 1_000_000;
  if (shares <= 0 || size_usdc <= 0) return null;
  const price = size_usdc / shares;

  return {
    side: targetSide,
    tokenId: tokenId.toString(),
    price,
    size_usdc,
    shares,
    txHash: log.transactionHash as `0x${string}`,
    logIndex: log.logIndex,
  };
}

/**
 * `fill_id` shape for chain-sourced fills. `(txHash, logIndex)` is a globally
 * unique log coordinate on Polygon, so the id is fully deterministic from
 * chain state — no block timestamp, no wall-clock. Side is included for
 * human-readable log scanning; structurally redundant but cheap.
 *
 * @public exported for unit tests.
 */
export function chainFillId(parts: {
  txHash: `0x${string}`;
  logIndex: number;
  side: "BUY" | "SELL";
}): string {
  return `chain:${parts.txHash}:${parts.logIndex}:${parts.side}`;
}

export function createPolymarketChainActivitySource(
  deps: PolymarketChainActivitySourceDeps
): PolymarketChainActivitySource {
  const log = deps.logger.child({
    component: "wallet-watch",
    subcomponent: "polymarket-chain-source",
    wallet: deps.wallet,
  });
  const refreshIntervalMs =
    deps.refreshAssetsIntervalMs ?? DEFAULT_REFRESH_ASSETS_INTERVAL_MS;
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const buffer: BufferedFill[] = [];
  const wakeListeners = new Set<() => void>();
  const tokenMeta = new Map<string, TokenMetadata>();
  // blockNumber → unix-seconds block.timestamp. One `getBlock` per unique
  // block; logs in the same block share the cached value. Entries are tiny
  // (~80B) and rolling-forward keeps the working set bounded by recent block
  // activity; we accept unbounded growth over a long-running process for v0.
  const blockTsCache = new Map<bigint, number>();
  const unwatches: Unwatch[] = [];
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let logsReceivedWindow = 0;
  let fillsEmittedWindow = 0;
  let lastLogAt: number | null = null;
  let refreshInFlight: Promise<void> | null = null;

  async function getBlockTimestamp(
    blockNumber: bigint | null | undefined
  ): Promise<number | null> {
    if (blockNumber === null || blockNumber === undefined) return null;
    const cached = blockTsCache.get(blockNumber);
    if (cached !== undefined) return cached;
    try {
      const block = await deps.publicClient.getBlock({ blockNumber });
      const ts = Number(block.timestamp);
      blockTsCache.set(blockNumber, ts);
      return ts;
    } catch (err) {
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "block_timestamp_fetch_failed",
          block_number: blockNumber.toString(),
          err: err instanceof Error ? err.message : String(err),
        },
        "polymarket-chain-source: getBlock failed; observed_at will fall back to wall-clock for this fill"
      );
      return null;
    }
  }

  async function refreshMetadata(
    trigger: "interval" | "cache_miss" | "cold_start"
  ): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const start = Date.now();
      try {
        deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.metadataRefreshTotal, {
          trigger,
        });
        // bug.5055: must paginate. Single-call `listUserPositions` caps at
        // ~100 rows (Polymarket default page). Active targets hold thousands
        // of positions; any tokenId outside the top page → permanent
        // metadata_unresolved skip. Use the page-walking helper.
        const positions: PolymarketUserPosition[] =
          await deps.client.listAllUserPositions(deps.wallet);
        for (const p of positions) {
          if (!p.asset || !p.conditionId) continue;
          tokenMeta.set(p.asset, {
            conditionId: p.conditionId,
            outcome: p.outcome || "",
            endDate:
              typeof p.endDate === "string" && p.endDate.length > 0
                ? p.endDate
                : null,
            title:
              typeof p.title === "string" && p.title.length > 0
                ? p.title
                : null,
            slug:
              typeof p.slug === "string" && p.slug.length > 0 ? p.slug : null,
          });
        }
        deps.metrics.observeDurationMs(
          WALLET_WATCH_CHAIN_METRICS.metadataRefreshDurationMs,
          Date.now() - start,
          { trigger }
        );
      } catch (err) {
        log.warn(
          {
            event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
            phase: "metadata_refresh_failed",
            err: err instanceof Error ? err.message : String(err),
          },
          "polymarket-chain-source: metadata refresh failed"
        );
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function onLog(rawLog: Log<bigint, number, false>): Promise<void> {
    if (stopped) return;
    if (rawLog.removed) {
      // Reorg retraction of a previously-emitted log. v0 has no confirmations
      // buffer so an order may already have been placed against this log;
      // drop + count the retraction here, but reconciliation of the placed
      // order is the status-sync reconciler's job. CHAIN_REORG_POLICY_V0.
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "reorg_dropped",
          tx_hash: rawLog.transactionHash,
          log_index: rawLog.logIndex,
        },
        "polymarket-chain-source: reorg retraction — log dropped; downstream order reconciliation via status-sync"
      );
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "reorg",
      });
      return;
    }
    logsReceivedWindow += 1;
    lastLogAt = Date.now();
    deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.logsTotal, {});

    const decoded = decodeOrderFilledForTarget(
      rawLog as OrderFilledLog,
      deps.wallet
    );
    if (!decoded) {
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "decode_no_target_match",
      });
      return;
    }

    // `block.timestamp` drives `observed_at` so the task.5042 lag histogram
    // measures actual target → mirror latency (same semantic as the prior
    // data-api source's `trade.timestamp`). One memoized `getBlock` per
    // unique block. Fallback on RPC failure: wall-clock. Lag histogram
    // under-reports by ≤ ~2 s during fallback; fills are NEVER dropped for
    // a transient RPC issue.
    const fetchedBlockTs = await getBlockTimestamp(rawLog.blockNumber);
    const blockTs = fetchedBlockTs ?? Math.floor(Date.now() / 1000);
    if (fetchedBlockTs === null) {
      deps.metrics.incr(
        WALLET_WATCH_CHAIN_METRICS.blockTimestampFallbackTotal,
        {}
      );
    }

    let meta = tokenMeta.get(decoded.tokenId);
    if (!meta) {
      await refreshMetadata("cache_miss");
      meta = tokenMeta.get(decoded.tokenId);
    }
    if (!meta || !meta.outcome) {
      // Empty outcome → cannot safely mirror (NegRisk multi-outcome markets
      // would otherwise default to "YES" and place on the wrong leg). Skip.
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "metadata_unresolved",
      });
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "metadata_unresolved",
          token_id: decoded.tokenId,
          tx_hash: decoded.txHash,
          has_meta: meta !== undefined,
          outcome_empty: meta !== undefined && !meta.outcome,
        },
        "polymarket-chain-source: tokenId metadata unresolved (missing entry or empty outcome) — skipping"
      );
      return;
    }

    const fillCandidate: Fill = {
      target_wallet: deps.wallet,
      fill_id: chainFillId({
        txHash: decoded.txHash,
        logIndex: decoded.logIndex,
        side: decoded.side,
      }),
      source: "chain" as const,
      market_id: `prediction-market:polymarket:${meta.conditionId}`,
      outcome: meta.outcome,
      side: decoded.side,
      price: decoded.price,
      size_usdc: decoded.size_usdc,
      observed_at: new Date(blockTs * 1000).toISOString(),
      attributes: {
        asset: decoded.tokenId,
        condition_id: meta.conditionId,
        transaction_hash: decoded.txHash,
        log_index: decoded.logIndex,
        block_number: rawLog.blockNumber?.toString() ?? null,
        ...(meta.endDate !== null ? { end_date: meta.endDate } : {}),
        ...(meta.title !== null ? { title: meta.title } : {}),
        ...(meta.slug !== null ? { slug: meta.slug } : {}),
      },
    };

    let fill: Fill;
    try {
      fill = FillSchema.parse(fillCandidate);
    } catch (err) {
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "schema_invalid",
      });
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "schema_invalid",
          err: err instanceof Error ? err.message : String(err),
        },
        "polymarket-chain-source: FillSchema rejected synthesized fill"
      );
      return;
    }

    buffer.push({ fill, blockTs });
    fillsEmittedWindow += 1;
    deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.fillsTotal, {});

    // Fan-out to push-on-wake subscribers, isolated per callback.
    for (const cb of [...wakeListeners]) {
      try {
        cb();
      } catch (err) {
        log.warn(
          {
            event: EVENT_NAMES.POLY_WALLET_WATCH_WS_WAKE_CALLBACK_THREW,
            err: err instanceof Error ? err.message : String(err),
          },
          "polymarket-chain-source: wake callback threw — push degraded for this frame"
        );
      }
    }
  }

  function subscribeAll(): void {
    // Polymarket V2 emits OrderFilled twice per match (once per party). The
    // taker-side event has `maker = target_wallet, taker = exchange_address`
    // and carries target's order side directly in the `side` field — so a
    // single `maker = [target]` filter per contract catches every target
    // trade and we read `side` from the event payload. One subscription per
    // exchange contract = 2 total per target (V2 + NegRisk V2).
    const contracts: Array<{
      address: `0x${string}`;
      label: "exchange" | "neg_risk";
    }> = [
      {
        address: POLYGON_POLYMARKET_EXCHANGE_V2,
        label: "exchange",
      },
      {
        address: POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
        label: "neg_risk",
      },
    ];
    for (const c of contracts) {
      const unwatch = deps.publicClient.watchContractEvent({
        address: c.address,
        abi: polymarketExchangeOrderFilledAbi,
        eventName: "OrderFilled",
        args: { maker: [deps.wallet] },
        onLogs: (logs) => {
          for (const lg of logs) {
            void onLog(lg as Log<bigint, number, false>);
          }
        },
        onError: (err: unknown) => {
          log.warn(
            {
              event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
              phase: "watch_contract_event_error",
              contract: c.label,
              err: err instanceof Error ? err.message : String(err),
            },
            "polymarket-chain-source: watchContractEvent error (viem will retry)"
          );
        },
      }) as Unwatch;
      unwatches.push(unwatch);
    }
  }

  function emitHeartbeat(): void {
    log.info(
      {
        event: EVENT_NAMES.POLY_WALLET_WATCH_WS_HEARTBEAT,
        wallet: deps.wallet,
        logs_received_window: logsReceivedWindow,
        fills_emitted_window: fillsEmittedWindow,
        buffer_size: buffer.length,
        cached_tokens: tokenMeta.size,
        last_log_at: lastLogAt,
        subscriptions: unwatches.length,
      },
      "polymarket-chain-source heartbeat"
    );
    logsReceivedWindow = 0;
    fillsEmittedWindow = 0;
  }

  // Cold-start metadata prime + subscription bring-up.
  void refreshMetadata("cold_start");
  subscribeAll();
  refreshTimer = setInterval(
    () => void refreshMetadata("interval"),
    refreshIntervalMs
  );
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(emitHeartbeat, heartbeatIntervalMs);
  }
  log.info(
    {
      event: EVENT_NAMES.POLY_WALLET_WATCH_CHAIN_STARTED,
      wallet: deps.wallet,
      subscriptions: unwatches.length,
      refresh_interval_ms: refreshIntervalMs,
      heartbeat_interval_ms: heartbeatIntervalMs,
      exchange_v2: POLYGON_POLYMARKET_EXCHANGE_V2,
      neg_risk_exchange_v2: POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
    },
    "polymarket-chain-source: started"
  );

  return {
    async fetchSince(since?: number): Promise<NextFillsResult> {
      const start = Date.now();
      if (buffer.length === 0) {
        // Idle drain — no logs since last call. Cursor unchanged.
        deps.metrics.observeDurationMs(
          WALLET_WATCH_METRICS.fetchDurationMs,
          Date.now() - start,
          {}
        );
        return { fills: [], newSince: since ?? 0 };
      }
      // Drain the buffer atomically — splice() empties under the same event
      // loop tick that emission occurs on, so we can't lose fills mid-drain.
      const drained = buffer.splice(0, buffer.length);
      const fills = drained.map((b) => b.fill);
      let newSince = since ?? 0;
      for (const b of drained) {
        if (b.blockTs > newSince) newSince = b.blockTs;
      }
      deps.metrics.observeDurationMs(
        WALLET_WATCH_METRICS.fetchDurationMs,
        Date.now() - start,
        {}
      );
      log.debug(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_FETCH,
          wallet: deps.wallet,
          phase: "ok",
          source_mode: "chain",
          fills: fills.length,
          new_since: newSince,
        },
        "polymarket-chain-source fetch: ok"
      );
      return { fills, newSince };
    },
    subscribeWake(callback) {
      wakeListeners.add(callback);
      return () => {
        wakeListeners.delete(callback);
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const torndown = unwatches.length;
      for (const u of unwatches) {
        try {
          u();
        } catch {
          // ignore — torn down anyway
        }
      }
      unwatches.length = 0;
      wakeListeners.clear();
      tokenMeta.clear();
      blockTsCache.clear();
      buffer.length = 0;
      log.info(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_CHAIN_STOPPED,
          wallet: deps.wallet,
          torndown_subscriptions: torndown,
        },
        "polymarket-chain-source: stopped"
      );
    },
  };
}
