// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/trading/order-ledger-mode-stamp.test`
 * Purpose: Prove MODE_STAMPED_FROM_ACCOUNT — the ledger stamps
 *   `poly_copy_trade_decisions.mode` from the row's OWN billing account, so two
 *   accounts writing through one ledger instance get different labels. The dep
 *   this replaces (`paperEnforceMode`) was read once at construction, which made
 *   every row on a pod carry the same mode no matter who produced it.
 * Scope: Unit. The injected `db` is an insert-capture, not a database: the
 *   assertion is about WHICH value the writer is handed, not about SQL. The SQL
 *   side of this change (the venue predicate itself) is proven in
 *   `tests/component/db/execution-venue.int.test.ts` against real Postgres.
 * Invariants:
 *   - mode comes from the account, per write
 *   - an unresolvable account fails the write rather than guessing `'live'`
 * Side-effects: none
 * Links: src/features/trading/order-ledger.ts
 * @internal
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";

import { createOrderLedger } from "@/features/trading/order-ledger";
import type { RecordDecisionInput } from "@/features/trading/order-ledger.types";

const LIVE_ACCOUNT = "acct-live";
const PAPER_ACCOUNT = "acct-paper";

function silentLogger(): Logger {
	const logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	return logger as unknown as Logger;
}

/**
 * Captures what the ledger hands the writer. Not a database.
 *
 * `@tests/_fakes/drizzle-query-chain` covers the read side; this is the insert
 * side, where the VALUES object is the thing under test.
 */
function captureDb() {
	const rows: Array<Record<string, unknown>> = [];
	const db = {
		insert: () => ({
			values: async (value: Record<string, unknown>) => {
				rows.push(value);
			},
		}),
	} as unknown as PostgresJsDatabase<Record<string, unknown>>;
	return { db, rows };
}

function decision(billingAccountId: string): RecordDecisionInput {
	return {
		billing_account_id: billingAccountId,
		created_by_user_id: "user-1",
		target_id: "11111111-1111-4111-8111-111111111111",
		fill_id: "data-api:abc",
		outcome: "skipped",
		reason: "already_placed",
		intent: {},
		receipt: null,
		decided_at: new Date("2026-10-07T00:00:00.000Z"),
	};
}

describe("order ledger mode stamping (MODE_STAMPED_FROM_ACCOUNT)", () => {
	it("stamps each row from its own account, in one ledger instance", async () => {
		const { db, rows } = captureDb();
		const ledger = createOrderLedger({
			db,
			logger: silentLogger(),
			resolveExecutionMode: async (billingAccountId) =>
				billingAccountId === PAPER_ACCOUNT ? "paper" : "live",
		});

		await ledger.recordDecision(decision(LIVE_ACCOUNT));
		await ledger.recordDecision(decision(PAPER_ACCOUNT));

		expect(rows.map((row) => row.mode)).toEqual(["live", "paper"]);
		expect(rows.map((row) => row.billingAccountId)).toEqual([
			LIVE_ACCOUNT,
			PAPER_ACCOUNT,
		]);
	});

	it("fails the write when the account's mode cannot be resolved", async () => {
		const { db, rows } = captureDb();
		const ledger = createOrderLedger({
			db,
			logger: silentLogger(),
			resolveExecutionMode: async () => {
				throw new Error("no_connection");
			},
		});

		await expect(ledger.recordDecision(decision(LIVE_ACCOUNT))).rejects.toThrow(
			"no_connection",
		);
		// NO_FABRICATED_VALUES: nothing was written with a guessed label.
		expect(rows).toEqual([]);
	});
});
