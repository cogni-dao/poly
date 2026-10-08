// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/paper-accounts/execution-venue.test`
 * Purpose: Prove the venue DECISION the resolver makes from a set of active
 *   connection kinds — LIVE_WINS_DISPATCH and NO_DEFAULT_VENUE.
 * Scope: Unit. Rows are stubbed with the shared chainable Drizzle stand-in, so
 *   this asserts nothing about the emitted SQL (SHAPE_IS_NOT_ASSERTED). The
 *   predicate itself — kind, `revoked_at IS NULL`, tenant scoping — is proven
 *   against real Postgres in `tests/component/db/execution-venue.int.test.ts`.
 * Invariants: LIVE_WINS_DISPATCH, NO_DEFAULT_VENUE
 * Side-effects: none
 * Links: src/features/paper-accounts/server/execution-venue.ts
 * @internal
 */

import { fakeSelectDb } from "@tests/_fakes/drizzle-query-chain";
import { describe, expect, it } from "vitest";

import {
	createExecutionVenueResolver,
	ExecutionVenueUnresolvedError,
} from "@/features/paper-accounts";

function resolverOver(kinds: string[]) {
	return createExecutionVenueResolver({
		db: fakeSelectDb(kinds.map((kind) => ({ kind }))),
	});
}

describe("execution venue resolution", () => {
	it("resolves a live-only account to the live venue", async () => {
		expect(await resolverOver(["privy_live"])("acct")).toBe("live");
	});

	it("resolves a paper-only account to the paper venue", async () => {
		expect(await resolverOver(["paper"])("acct")).toBe("paper");
	});

	it("LIVE_WINS_DISPATCH — both kinds active dispatches live", async () => {
		expect(await resolverOver(["paper", "privy_live"])("acct")).toBe("live");
		expect(await resolverOver(["privy_live", "paper"])("acct")).toBe("live");
	});

	it("NO_DEFAULT_VENUE — no active connection throws, never guesses", async () => {
		const err = await resolverOver([])("acct").then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ExecutionVenueUnresolvedError);
		expect((err as ExecutionVenueUnresolvedError).reason).toBe("no_connection");
	});
});
