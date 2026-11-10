// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/poly-research`
 * Purpose: Factory — bridges `PolyDataCapability` (ai-tools) to `PolymarketDataApiClient` (market-provider).
 * Scope: Shape-mappers over the Data-API client, adds `count` + `hasMore` derivation for paginated outputs.
 *        Does not write DB, does not place trades, does not hold credentials (Data API is public).
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: Data API is public
 *   - READ_ONLY: All methods are GET wrappers
 *   - PAGINATION_CONSISTENT: `hasMore = items.length >= limit`
 * Side-effects: none (factory; returned closures do IO)
 * Links: work/items/task.0386.poly-agent-wallet-research-v0.md
 * @internal
 */

import type { PolyDataCapability } from "@cogni/poly-ai-tools";
import type {
  PolymarketDataApiClient,
  PolymarketUserPnlClient,
} from "@cogni/poly-market-provider/adapters/polymarket";

export interface CreatePolyResearchCapabilityDeps {
  dataApiClient: PolymarketDataApiClient;
  userPnlClient: PolymarketUserPnlClient;
}

export function createPolyResearchCapability(
  deps: CreatePolyResearchCapabilityDeps
): PolyDataCapability {
  const { dataApiClient, userPnlClient } = deps;

  return {
    getPositions: async (params) => {
      const page = await dataApiClient.listUserPositions(params.user, {
        ...(params.market !== undefined && { market: params.market }),
        ...(params.sizeThreshold !== undefined && {
          sizeThreshold: params.sizeThreshold,
        }),
        limit: params.limit ?? 50,
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      });
      return {
        user: params.user,
        positions: page.rows.map((p) => ({
          proxyWallet: p.proxyWallet,
          asset: p.asset,
          conditionId: p.conditionId,
          size: p.size,
          avgPrice: p.avgPrice,
          currentValue: p.currentValue,
          cashPnl: p.cashPnl,
          percentPnl: p.percentPnl,
          realizedPnl: p.realizedPnl,
          title: p.title ?? "",
          eventSlug: p.eventSlug ?? "",
          outcome: p.outcome ?? "",
        })),
        count: page.rows.length,
        hasMore: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      };
    },

    listActivity: async (params) => {
      const page = await dataApiClient.listActivity(params.user, {
        ...(params.type !== undefined && { type: params.type }),
        ...(params.side !== undefined && { side: params.side }),
        ...(params.start !== undefined && { start: params.start }),
        ...(params.end !== undefined && { end: params.end }),
        limit: params.limit ?? 100,
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      });
      return {
        user: params.user,
        events: page.rows.map((e) => ({
          type: e.type,
          timestamp: e.timestamp,
          conditionId: e.conditionId,
          side: e.side,
          size: e.size,
          price: e.price,
          title: e.title ?? "",
          eventSlug: e.eventSlug ?? "",
          transactionHash: e.transactionHash,
        })),
        count: page.rows.length,
        hasMore: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      };
    },

    getValue: async (params) => {
      const result = await dataApiClient.getValue(params.user, {
        ...(params.market !== undefined && { market: params.market }),
      });
      return {
        user: result.user,
        valueUsdc: result.value,
        computedAt: new Date().toISOString(),
      };
    },

    getHolders: async (params) => {
      const holders = await dataApiClient.getHolders(params.market, {
        ...(params.limit !== undefined && { limit: params.limit }),
      });
      return {
        market: params.market,
        holders: holders.map((h) => ({
          proxyWallet: h.proxyWallet,
          asset: h.asset,
          outcomeIndex: h.outcomeIndex,
          amount: h.amount,
          userName: h.displayUsernamePublic ? h.name : h.pseudonym,
        })),
        count: holders.length,
      };
    },

    listMarketTrades: async (params) => {
      const page = await dataApiClient.listMarketTrades(params.market, {
        ...(params.takerOnly !== undefined && { takerOnly: params.takerOnly }),
        limit: params.limit ?? 100,
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      });
      return {
        market: params.market,
        trades: page.rows.map((t) => ({
          proxyWallet: t.proxyWallet,
          side: t.side,
          asset: t.asset,
          size: t.size,
          price: t.price,
          timestamp: t.timestamp,
          outcome: t.outcome,
        })),
        count: page.rows.length,
        hasMore: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      };
    },

    resolveUsername: async (params) => {
      const profiles = await dataApiClient.resolveUsername(params.query, {
        ...(params.limit !== undefined && { limit: params.limit }),
      });
      return {
        profiles: profiles.map((p) => ({
          userName: p.displayUsername || p.name || p.pseudonym || "",
          proxyWallet: p.proxyWallet,
          verified: false,
        })),
        count: profiles.length,
      };
    },

    getUserPnl: async (params) => {
      const interval = params.interval ?? "all";
      const points = await userPnlClient.getUserPnl(params.user, {
        interval,
        ...(params.fidelity !== undefined && { fidelity: params.fidelity }),
      });
      return {
        user: params.user,
        interval,
        fidelity: params.fidelity ?? null,
        points: points.map((pt) => ({ t: pt.t, p: pt.p })),
        count: points.length,
      };
    },
  };
}
