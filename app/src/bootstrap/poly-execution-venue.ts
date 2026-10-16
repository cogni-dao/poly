// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/poly-execution-venue`
 * Purpose: One process-wide wiring point for "which venue does this account
 *   trade on, and who authorizes its paper intents?". Memoizes the resolver +
 *   paper venue over the service DB client so the container, the wallet-refresh
 *   route, and the manual-close route all dispatch through the same objects
 *   instead of each re-deriving execution mode.
 *   Also exposes the paper venue's READ side (`getPaperPortfolio`): the
 *   executor's position seam and the NAV the mirror's `position_gap` denominator
 *   needs, both adapted from the migration-0083 paper fact projection.
 * Scope: Bootstrap wiring only. Contains no decision logic — the resolver lives
 *   in `@features/paper-accounts` and the fact reads in
 *   `@features/wallet-analysis/server/paper-fact-source`, which is where each is
 *   tested.
 * Invariants:
 *   - ONE_VENUE_RESOLVER_PER_PROCESS: the executor factory (dispatch) and the
 *     order ledger (`mode` stamping) must consume the SAME resolver, or a row
 *     could be labeled `live` while its order went to the sidecar.
 *   - NO_ENV_READ: nothing here reads `PAPER_ENFORCE_MODE`. Venue comes from
 *     `poly_wallet_connections.kind` — the env var is declared (bug.5277 keeps
 *     the declaration) and deliberately unread.
 * Side-effects: constructs the service Drizzle client on first call.
 * Links: docs/spec/capability-plane.md, migration 0082
 * @internal
 */

import { normalizePositionIdentity, positionIdentityKey } from "@cogni/poly-market-provider";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import type { PaperPositionSource } from "@/bootstrap/capabilities/poly-trade-executor";
import {
  createExecutionVenueResolver,
  createPaperVenue,
  type ExecutionVenueResolver,
  type PaperVenuePort,
} from "@/features/paper-accounts";
import {
  PaperFactsUnavailableError,
  readPaperAccountNavUsdc,
  readPaperAccountPositionFacts,
} from "@/features/wallet-analysis/server/paper-fact-source";

let cachedResolver: ExecutionVenueResolver | null = null;
let cachedPaperVenue: PaperVenuePort | null = null;
let cachedPaperPortfolio: PaperPortfolioReader | null = null;

/**
 * The service client, cast to the postgres-js shape the feature slice declares.
 * Same cast the container uses when handing `serviceDb` to `dbTargetSource` —
 * one driver, two slightly different generic spellings.
 */
function serviceDbForVenue(): PostgresJsDatabase<Record<string, unknown>> {
  return getServiceDb() as unknown as PostgresJsDatabase<
    Record<string, unknown>
  >;
}

/** Process-memoized `billingAccountId → 'live' | 'paper'`. */
export function getExecutionVenueResolver(): ExecutionVenueResolver {
  if (!cachedResolver) {
    cachedResolver = createExecutionVenueResolver({ db: serviceDbForVenue() });
  }
  return cachedResolver;
}

/** Process-memoized paper-account authorizer + identity reader. */
export function getPaperVenue(): PaperVenuePort {
  if (!cachedPaperVenue) {
    cachedPaperVenue = createPaperVenue({ db: serviceDbForVenue() });
  }
  return cachedPaperVenue;
}

/**
 * The paper venue's read side: the executor's position seam plus the NAV the
 * mirror's `position_gap` denominator needs. One object because both come from
 * one writer — the migration-0083 paper fact projection — and a caller holding
 * the positions without the NAV (or vice versa) would be reading half a
 * portfolio.
 */
export interface PaperPortfolioReader extends PaperPositionSource {
  /**
   * Published paper NAV: `seed − bought + sold − fees + Σ(shares × mid)`.
   *
   * @throws {PaperFactsUnavailableError} when the projection withheld the NAV
   *   (an open position could not be marked), never published one, or published
   *   one too long ago. Callers must NOT substitute 0 — `position_gap` treats a
   *   throw as "cannot size now" and skips, which is the correct response to an
   *   unknown denominator.
   */
  getNavUsdc(billingAccountId: string): Promise<number>;
}

/**
 * Same driver, two generic spellings: the fact source declares the
 * `NodePgDatabase | PostgresJsDatabase` union and this node's service client is
 * the latter at runtime. Matches the cast the paper-projection job wiring uses
 * for the identical handle.
 */
function serviceDbForPaperFacts(): NodePgDatabase<Record<string, unknown>> {
  return getServiceDb() as unknown as NodePgDatabase<Record<string, unknown>>;
}

/**
 * Process-memoized paper portfolio reads.
 *
 * READS_THE_PROJECTION: every method reads back rows the projection wrote and
 * inherits its completeness + freshness gate. There is no fallback branch here
 * on purpose — adding one would be the place a silent 0 comes back.
 */
export function getPaperPortfolio(): PaperPortfolioReader {
  if (!cachedPaperPortfolio) {
    cachedPaperPortfolio = {
      listOpenPositions: async (billingAccountId: string) =>
        (
          await readPaperAccountPositionFacts({
            db: serviceDbForPaperFacts(),
            billingAccountId,
          })
        ).positions,
      getPositionShareBalance: async (
        billingAccountId: string,
        tokenId: string
      ) => {
        const facts = await readPaperAccountPositionFacts({
          db: serviceDbForPaperFacts(),
          billingAccountId,
        });
        // Reachable only past the reader's completeness + freshness gate, so a
        // token that is not in the book is a token this account verifiably does
        // not hold — NOT the unconditional `async () => 0` this replaced.
        return (
          facts.positions.find((position) => position.tokenId === tokenId)
            ?.shares ?? 0
        );
      },
      getNavUsdc: async (billingAccountId: string) =>
        (
          await readPaperAccountNavUsdc({
            db: serviceDbForPaperFacts(),
            billingAccountId,
          })
        ).navUsdc,
    };
  }
  return cachedPaperPortfolio;
}

/**
 * Read the complete paper book once, then select exact requested legs. A
 * missing leg is zero only after the canonical source proves a fresh complete
 * book; identity conflicts and unavailable source facts always fail closed.
 */
export async function readPaperAuthoritativeHoldings(input: {
	source: Pick<PaperPositionSource, "listOpenPositions">;
	billingAccountId: string;
	requested: readonly { conditionId: string; tokenId: string }[];
	signal?: AbortSignal;
}): Promise<{ conditionId: string; tokenId: string; shares: number }[]> {
	const unavailable = () =>
		new PaperFactsUnavailableError(
			input.billingAccountId,
			"projection_incomplete",
		);
	input.signal?.throwIfAborted();
	const requestKeys = new Set<string>();
	const requestConditions = new Map<string, string>();
	const requested = input.requested.map((request) => {
		const identity = normalizePositionIdentity(request);
		const key = positionIdentityKey(request);
		if (
			identity.availability !== "available" ||
			key === null ||
			requestKeys.has(key) ||
			(requestConditions.has(identity.tokenId) &&
				requestConditions.get(identity.tokenId) !== identity.conditionId)
		)
			throw unavailable();
		requestKeys.add(key);
		requestConditions.set(identity.tokenId, identity.conditionId);
		return identity;
	});
	// Await the real operation through settlement even if the caller cancels.
	// No timeout race, detached read, per-token dispatch, or shared book cache.
	const book = await input.source.listOpenPositions(input.billingAccountId);
	input.signal?.throwIfAborted();
	const sharesByKey = new Map<string, number>();
	const conditionsByToken = new Map<string, string>();
	for (const position of book) {
		const identity = normalizePositionIdentity(position);
		const key = positionIdentityKey(position);
		if (
			identity.availability !== "available" ||
			key === null ||
			sharesByKey.has(key) ||
			(conditionsByToken.has(identity.tokenId) &&
				conditionsByToken.get(identity.tokenId) !== identity.conditionId) ||
			!Number.isFinite(position.shares) ||
			position.shares <= 0 ||
			!Number.isFinite(position.currentValueUsdc) ||
			position.currentValueUsdc < 0 ||
			!Number.isFinite(position.avgPrice) ||
			position.avgPrice < 0
		)
			throw unavailable();
		sharesByKey.set(key, position.shares);
		conditionsByToken.set(identity.tokenId, identity.conditionId);
	}
	return requested.map((identity) => {
		if (
			conditionsByToken.has(identity.tokenId) &&
			conditionsByToken.get(identity.tokenId) !== identity.conditionId
		)
			throw unavailable();
		return {
			conditionId: identity.conditionId,
			tokenId: identity.tokenId,
			shares: sharesByKey.get(identity.key) ?? 0,
		};
	});
}

/** For tests only — clears the memoized instances. */
export function __resetPolyExecutionVenueForTests(): void {
  cachedResolver = null;
  cachedPaperVenue = null;
  cachedPaperPortfolio = null;
}
