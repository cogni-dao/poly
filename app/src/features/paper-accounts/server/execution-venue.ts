// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/paper-accounts/server/execution-venue`
 * Purpose: Resolve WHICH venue one tenant's orders execute against — the live
 *   Polymarket CLOB or the paper sidecar — from that account's
 *   `poly_wallet_connections.kind`. This is the replacement for the
 *   process-wide `PAPER_ENFORCE_MODE` env switch: execution mode is a property
 *   of the account, so a single process can serve a live tenant and a paper
 *   tenant at the same time.
 * Scope: One indexed read of `poly_wallet_connections`. No writes, no Privy,
 *   no chain, no env reads.
 * Invariants:
 *   - VENUE_IS_ACCOUNT_STATE: the only input is the account's un-revoked
 *     connection rows. Not an env var, not a per-target column, not an
 *     `intent.attributes.mode` shadow (task.5003 deleted those and they stay
 *     deleted).
 *   - LIVE_WINS_DISPATCH: a tenant holding BOTH an active live and an active
 *     paper connection (0082's partial unique index permits exactly one of
 *     each) dispatches LIVE. Same precedence the presentation readers use
 *     (`LIVE_WINS_PAPER_SHOWS`), so what a tenant reads and what its orders do
 *     cannot disagree.
 *   - NO_DEFAULT_VENUE: zero active connections throws
 *     `ExecutionVenueUnresolvedError`. Defaulting either way is exactly the
 *     fabrication this module exists to delete — guessing `live` points an
 *     unprovisioned tenant at the real CLOB, and guessing `paper` silently
 *     demotes a live tenant to simulation.
 *   - READ_FRESH: no cache here. The executor factory caches per
 *     `billingAccountId` and owns its own invalidation; the order ledger
 *     deliberately re-resolves per write so a venue change can never mislabel
 *     a row it is stamping.
 * Side-effects: IO (one SELECT).
 * Links: docs/spec/capability-plane.md, docs/spec/poly-tenant-and-collateral.md,
 *   migration 0082
 * @public
 */

import { polyWalletConnections } from "@cogni/poly-db-schema";
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** The `kind` discriminator for a real Privy-custodied wallet (0082). */
export const LIVE_CONNECTION_KIND = "privy_live";

/** Where an account's orders actually go. */
export type ExecutionVenue = "live" | "paper";

/**
 * Why a venue could not be resolved. Mirrors the `AuthorizationFailure`
 * vocabulary so a caller can forward the reason into the same
 * `authorize_denied` log/metric bucket instead of inventing a second one.
 */
export type ExecutionVenueUnresolvedReason =
  | "no_connection"
  | "backend_unreachable";

/**
 * Thrown instead of returning a guessed venue. FAIL_CLOSED_NON_DISCLOSING: the
 * message names the tenant and the reason for the operator, and carries no
 * wallet, address, or balance detail.
 */
export class ExecutionVenueUnresolvedError extends Error {
  constructor(
    public readonly billingAccountId: string,
    public readonly reason: ExecutionVenueUnresolvedReason,
    cause?: unknown
  ) {
    super(
      `poly execution venue unresolved for billingAccountId=${billingAccountId} (${reason})`
    );
    this.name = "ExecutionVenueUnresolvedError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Resolves one account's execution venue. Injected at every consumer. */
export type ExecutionVenueResolver = (
  billingAccountId: string
) => Promise<ExecutionVenue>;

/**
 * Upper bound on rows read per account. 0082 allows at most one active row per
 * `(billing_account_id, kind)` and there are two kinds, so 2 is the real
 * ceiling; reading a few more costs nothing and means a future `kind` cannot
 * silently truncate the scan into a wrong answer.
 */
const ACTIVE_CONNECTION_SCAN_LIMIT = 8;

/**
 * Build the resolver over a Drizzle handle.
 *
 * @param deps.db - Any Drizzle client that can read `poly_wallet_connections`.
 *   Callers on the cross-tenant hot path (executor factory, order ledger) pass
 *   the service client; the row is tenant-keyed by the predicate below.
 * @public
 */
export function createExecutionVenueResolver(deps: {
  db: PostgresJsDatabase<Record<string, unknown>>;
}): ExecutionVenueResolver {
  return async function resolveExecutionVenue(
    billingAccountId: string
  ): Promise<ExecutionVenue> {
    let kinds: readonly string[];
    try {
      const rows = await deps.db
        .select({ kind: polyWalletConnections.kind })
        .from(polyWalletConnections)
        .where(
          and(
            eq(polyWalletConnections.billingAccountId, billingAccountId),
            isNull(polyWalletConnections.revokedAt)
          )
        )
        .limit(ACTIVE_CONNECTION_SCAN_LIMIT);
      kinds = rows.map((row) => row.kind);
    } catch (err) {
      // FAIL_CLOSED: an unreachable DB is not evidence of either venue.
      throw new ExecutionVenueUnresolvedError(
        billingAccountId,
        "backend_unreachable",
        err
      );
    }

    if (kinds.length === 0) {
      throw new ExecutionVenueUnresolvedError(billingAccountId, "no_connection");
    }
    // LIVE_WINS_DISPATCH.
    return kinds.includes(LIVE_CONNECTION_KIND) ? "live" : "paper";
  };
}
