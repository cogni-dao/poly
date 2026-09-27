// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/poly/trade-size-pnl-oracle`
 * Purpose: TEST-ONLY parity oracle for the trader-comparison trade-size/P-L SQL aggregation (bug.5008).
 * Scope: Verbatim preservation of the legacy JS reducer that used to live in
 *   `src/features/wallet-analysis/server/trader-comparison-service.ts` (buildTradeSizePnl +
 *   computeTokenPnls + classifyHedgeTokenIds + readResolutionFromDb semantics). It is the
 *   reference implementation the SQL rewrite must match bit-for-bit at 8-decimal rounding.
 * Invariants:
 *   - TEST_ONLY_ORACLE: never imported from src/; not reachable from any route. Do not "fix"
 *     behavior here — if the oracle and SQL disagree, the SQL (or a fixture) is wrong.
 *   - Fills passed to `buildTradeSizePnl` must be pre-sorted by observedAt ASC, matching the
 *     legacy read query's `ORDER BY f.observed_at ASC`.
 * Side-effects: none (pure functions)
 * Links: src/features/wallet-analysis/server/trader-comparison-service.ts, work/items/bug.5008
 * @internal
 */

export type OracleFill = {
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  shares: number;
  sizeUsdc: number;
  observedAt: Date;
};

export type OracleResolutionInput = {
  closed: boolean;
  tokens: { token_id: string; winner: boolean }[];
};

export type OracleOutcomeRow = {
  conditionId: string;
  tokenId: string;
  outcome: "winner" | "loser" | "unknown";
};

export type OracleTradeSizePnlBucket = {
  key: string;
  label: string;
  loPercentile: number;
  hiPercentile: number;
  minSizeUsdc: number;
  maxSizeUsdc: number;
  avgSizeUsdc: number;
  buyCount: number;
  resolvedCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  pendingCount: number;
  winRate: number | null;
  pnlUsdc: number;
  buyUsdc: number;
  hedgeBuyCount: number;
  hedgeBuyUsdc: number;
};

export type OracleTradeSizePnl = {
  bucketStep: 5;
  sampleBuyCount: number;
  resolvedCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  pendingCount: number;
  winRate: number | null;
  pnlUsdc: number;
  buyUsdc: number;
  hedgeBuyCount: number;
  hedgeBuyUsdc: number;
  buckets: OracleTradeSizePnlBucket[];
};

const SIZE_BUCKET_STEP = 5;
const SIZE_BUCKET_COUNT = 100 / SIZE_BUCKET_STEP;

/**
 * Replicates the legacy `readResolutionFromDb` mapping from `poly_market_outcomes`
 * rows to per-condition resolution inputs: a condition is closed when every one of
 * its outcome rows is non-unknown; a token is a winner when its row says 'winner'.
 */
export function resolutionsFromOutcomeRows(
  outcomeRows: readonly OracleOutcomeRow[]
): Map<string, OracleResolutionInput> {
  const byCondition = new Map<string, OracleOutcomeRow[]>();
  for (const row of outcomeRows) {
    const rows = byCondition.get(row.conditionId) ?? [];
    rows.push(row);
    byCondition.set(row.conditionId, rows);
  }
  const resolutions = new Map<string, OracleResolutionInput>();
  for (const [conditionId, rows] of byCondition.entries()) {
    if (rows.length === 0) continue;
    const closed = rows.every((r) => r.outcome !== "unknown");
    const tokens = rows.map((r) => ({
      token_id: r.tokenId,
      winner: r.outcome === "winner",
    }));
    resolutions.set(conditionId, { closed, tokens });
  }
  return resolutions;
}

/** Legacy JS aggregation, preserved verbatim from the pre-bug.5008 service. */
export function buildTradeSizePnl(
  fills: readonly OracleFill[],
  resolutions: ReadonlyMap<string, OracleResolutionInput>,
  windowStart: Date
): OracleTradeSizePnl {
  if (fills.length === 0) return emptyTradeSizePnl();
  const hedgeTokenIds = classifyHedgeTokenIds(fills);
  const tokenPnls = computeTokenPnls(fills, resolutions);
  const buys = fills
    .filter((fill) => fill.side === "BUY" && fill.observedAt >= windowStart)
    .sort((a, b) => a.sizeUsdc - b.sizeUsdc);
  const buckets = emptyTradeSizePnl().buckets.map((bucket) => ({ ...bucket }));

  buys.forEach((fill, index) => {
    const bucketIndex = Math.min(
      SIZE_BUCKET_COUNT - 1,
      Math.floor((index / Math.max(1, buys.length)) * SIZE_BUCKET_COUNT)
    );
    const bucket = buckets[bucketIndex];
    if (!bucket) return;
    const tokenPnl = tokenPnls.get(fill.tokenId);
    const pnl = tokenPnl
      ? (fill.sizeUsdc / Math.max(tokenPnl.buyUsdc, 1)) * tokenPnl.pnl
      : 0;
    const resolved = Boolean(tokenPnl?.resolved);
    bucket.buyCount += 1;
    bucket.buyUsdc += fill.sizeUsdc;
    bucket.avgSizeUsdc += fill.sizeUsdc;
    bucket.minSizeUsdc =
      bucket.buyCount === 1
        ? fill.sizeUsdc
        : Math.min(bucket.minSizeUsdc, fill.sizeUsdc);
    bucket.maxSizeUsdc = Math.max(bucket.maxSizeUsdc, fill.sizeUsdc);
    if (hedgeTokenIds.has(fill.tokenId)) {
      bucket.hedgeBuyCount += 1;
      bucket.hedgeBuyUsdc += fill.sizeUsdc;
    }
    if (!resolved) {
      bucket.pendingCount += 1;
      return;
    }
    bucket.resolvedCount += 1;
    bucket.pnlUsdc += pnl;
    if (pnl > 0.5) bucket.winCount += 1;
    else if (pnl < -0.5) bucket.lossCount += 1;
    else bucket.flatCount += 1;
  });

  const finalized = buckets.map((bucket) => ({
    ...bucket,
    avgSizeUsdc:
      bucket.buyCount > 0 ? roundMoney(bucket.avgSizeUsdc / bucket.buyCount) : 0,
    minSizeUsdc: bucket.buyCount > 0 ? roundMoney(bucket.minSizeUsdc) : 0,
    maxSizeUsdc: bucket.buyCount > 0 ? roundMoney(bucket.maxSizeUsdc) : 0,
    buyUsdc: roundMoney(bucket.buyUsdc),
    hedgeBuyUsdc: roundMoney(bucket.hedgeBuyUsdc),
    pnlUsdc: roundMoney(bucket.pnlUsdc),
    winRate:
      bucket.winCount + bucket.lossCount > 0
        ? bucket.winCount / (bucket.winCount + bucket.lossCount)
        : null,
  }));

  const totals = finalized.reduce(
    (acc, bucket) => ({
      sampleBuyCount: acc.sampleBuyCount + bucket.buyCount,
      resolvedCount: acc.resolvedCount + bucket.resolvedCount,
      winCount: acc.winCount + bucket.winCount,
      lossCount: acc.lossCount + bucket.lossCount,
      flatCount: acc.flatCount + bucket.flatCount,
      pendingCount: acc.pendingCount + bucket.pendingCount,
      pnlUsdc: acc.pnlUsdc + bucket.pnlUsdc,
      buyUsdc: acc.buyUsdc + bucket.buyUsdc,
      hedgeBuyCount: acc.hedgeBuyCount + bucket.hedgeBuyCount,
      hedgeBuyUsdc: acc.hedgeBuyUsdc + bucket.hedgeBuyUsdc,
    }),
    {
      sampleBuyCount: 0,
      resolvedCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      pendingCount: 0,
      pnlUsdc: 0,
      buyUsdc: 0,
      hedgeBuyCount: 0,
      hedgeBuyUsdc: 0,
    }
  );

  return {
    bucketStep: SIZE_BUCKET_STEP,
    ...totals,
    pnlUsdc: roundMoney(totals.pnlUsdc),
    buyUsdc: roundMoney(totals.buyUsdc),
    hedgeBuyUsdc: roundMoney(totals.hedgeBuyUsdc),
    winRate:
      totals.winCount + totals.lossCount > 0
        ? totals.winCount / (totals.winCount + totals.lossCount)
        : null,
    buckets: finalized,
  };
}

export function emptyTradeSizePnl(): OracleTradeSizePnl {
  const buckets = Array.from({ length: SIZE_BUCKET_COUNT }, (_, index) => {
    const lo = index * SIZE_BUCKET_STEP;
    const hi = lo + SIZE_BUCKET_STEP;
    return {
      key: `p${lo}_p${hi}`,
      label: `p${lo}-p${hi}`,
      loPercentile: lo,
      hiPercentile: hi,
      minSizeUsdc: 0,
      maxSizeUsdc: 0,
      avgSizeUsdc: 0,
      buyCount: 0,
      resolvedCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      pendingCount: 0,
      winRate: null,
      pnlUsdc: 0,
      buyUsdc: 0,
      hedgeBuyCount: 0,
      hedgeBuyUsdc: 0,
    };
  });
  return {
    bucketStep: SIZE_BUCKET_STEP,
    sampleBuyCount: 0,
    resolvedCount: 0,
    winCount: 0,
    lossCount: 0,
    flatCount: 0,
    pendingCount: 0,
    winRate: null,
    pnlUsdc: 0,
    buyUsdc: 0,
    hedgeBuyCount: 0,
    hedgeBuyUsdc: 0,
    buckets,
  };
}

function computeTokenPnls(
  fills: readonly OracleFill[],
  resolutions: ReadonlyMap<string, OracleResolutionInput>
): Map<string, { buyUsdc: number; pnl: number; resolved: boolean }> {
  const tokens = new Map<
    string,
    {
      conditionId: string;
      buyUsdc: number;
      sellUsdc: number;
      buyShares: number;
      sellShares: number;
    }
  >();
  for (const fill of fills) {
    const existing = tokens.get(fill.tokenId) ?? {
      conditionId: fill.conditionId,
      buyUsdc: 0,
      sellUsdc: 0,
      buyShares: 0,
      sellShares: 0,
    };
    if (fill.side === "BUY") {
      existing.buyUsdc += fill.sizeUsdc;
      existing.buyShares += fill.shares;
    } else {
      existing.sellUsdc += fill.sizeUsdc;
      existing.sellShares += fill.shares;
    }
    tokens.set(fill.tokenId, existing);
  }

  const out = new Map<
    string,
    { buyUsdc: number; pnl: number; resolved: boolean }
  >();
  for (const [tokenId, token] of tokens.entries()) {
    const resolution = resolutions.get(token.conditionId);
    const tokenInfo = resolution?.tokens.find((x) => x.token_id === tokenId);
    if (!resolution?.closed || !tokenInfo) {
      out.set(tokenId, {
        buyUsdc: token.buyUsdc,
        pnl: 0,
        resolved: false,
      });
      continue;
    }
    const held = token.buyShares - token.sellShares;
    const payout = held > 0 && tokenInfo.winner ? held : 0;
    out.set(tokenId, {
      buyUsdc: token.buyUsdc,
      pnl: token.sellUsdc + payout - token.buyUsdc,
      resolved: true,
    });
  }
  return out;
}

function classifyHedgeTokenIds(
  fills: readonly OracleFill[]
): ReadonlySet<string> {
  const byCondition = new Map<string, Map<string, number>>();
  for (const fill of fills) {
    if (fill.side !== "BUY") continue;
    const condition =
      byCondition.get(fill.conditionId) ?? new Map<string, number>();
    condition.set(
      fill.tokenId,
      (condition.get(fill.tokenId) ?? 0) + fill.sizeUsdc
    );
    byCondition.set(fill.conditionId, condition);
  }

  const hedgeTokenIds = new Set<string>();
  for (const tokenCosts of byCondition.values()) {
    if (tokenCosts.size < 2) continue;
    const ranked = [...tokenCosts.entries()].sort((a, b) => a[1] - b[1]);
    const hedge = ranked[0];
    const primary = ranked.at(-1);
    if (hedge && primary && hedge[1] < primary[1]) {
      hedgeTokenIds.add(hedge[0]);
    }
  }
  return hedgeTokenIds;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(8));
}
