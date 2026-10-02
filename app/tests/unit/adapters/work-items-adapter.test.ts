// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { toWorkItemId } from "@cogni/work-items";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
	DoltCommitFailedError,
	DoltCleanupFailedError,
	DoltgresPolyWorkItemAdapter,
	WorkItemAuthorizationError,
	WorkItemLeaseConflictError,
} from "@/adapters/server/db/doltgres/work-items-adapter";

const ROW = {
	id: "task.5001",
	type: "task",
	title: "Restore hub CRUD",
	status: "needs_implement",
	node: "poly",
	assignees: [],
	external_refs: [],
	labels: [],
	spec_refs: [],
	revision: 1,
	deploy_verified: false,
	created_by_principal_id: "agent-1",
	created_at: "2026-10-02T12:00:00.000Z",
	updated_at: "2026-10-02T12:00:00.000Z",
};

function fakeSql(respond: (query: string) => unknown[]): {
	sql: Sql;
	poolQueries: string[];
	reservedQueries: string[];
	reservations: number;
} {
	const poolQueries: string[] = [];
	const reservedQueries: string[] = [];
	let reservations = 0;
	const reservedUnsafe = async (query: string) => {
		reservedQueries.push(query);
		return respond(query);
	};
	const sql = {
		unsafe: async (query: string) => {
			poolQueries.push(query);
			return respond(query);
		},
		reserve: async () => {
			reservations += 1;
			return { unsafe: reservedUnsafe, release: () => undefined };
		},
	} as unknown as Sql;
	return {
		sql,
		poolQueries,
		reservedQueries,
		get reservations() {
			return reservations;
		},
	};
}

function successfulMutation(query: string): unknown[] {
	if (query.startsWith("UPDATE work_items")) {
		return [{ ...ROW, revision: 2, deploy_verified: true, claim_active: true }];
	}
	if (query.startsWith("SELECT dolt_commit")) {
		return [{ dolt_commit: "abc123" }];
	}
	if (query.startsWith("SELECT dolt_add")) return [{ dolt_add: 0 }];
	if (query.startsWith("SELECT dolt_checkout")) {
		return [{ dolt_checkout: [0, "restored work_items"] }];
	}
	return [];
}

describe("DoltgresPolyWorkItemAdapter", () => {
	it("binds content patches to the immutable creator", async () => {
		const fake = fakeSql(successfulMutation);
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await adapter.patch(
			{
				id: toWorkItemId("task.5001"),
				set: { deployVerified: true, blockedBy: null },
			},
			"agent-1",
		);

		expect(fake.reservedQueries[0]).toContain(
			"created_by_principal_id = 'agent-1'",
		);
		expect(fake.reservedQueries[0]).toContain("deploy_verified = TRUE");
	});

	it("runs mutation, targeted stage, and validated commit on one reserved client", async () => {
		const fake = fakeSql(successfulMutation);
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await adapter.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "Secure" } },
			"agent-1",
		);

		expect(fake.reservations).toBe(1);
		expect(fake.poolQueries).toEqual([]);
		expect(fake.reservedQueries).toEqual([
			expect.stringMatching(/^UPDATE work_items/),
			"SELECT dolt_add('work_items')",
			expect.stringMatching(/^SELECT dolt_commit\('-m'/),
		]);
		expect(fake.reservedQueries.join("\n")).not.toContain("-A");
	});

	it("fails closed when Dolt does not return a commit hash", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [{ ...ROW }];
			if (query.startsWith("SELECT dolt_add")) return [{ dolt_add: 0 }];
			if (query.startsWith("SELECT dolt_commit")) return [{}];
			if (query.startsWith("SELECT dolt_checkout")) {
				return [{ dolt_checkout: [0, "restored work_items"] }];
			}
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Secure" } },
				"agent-1",
			),
		).rejects.toBeInstanceOf(DoltCommitFailedError);
		expect(fake.reservedQueries.at(-1)).toBe(
			"SELECT dolt_checkout('work_items')",
		);
	});

	it("cleans the table when targeted staging reports failure", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [{ ...ROW }];
			if (query.startsWith("SELECT dolt_add")) return [{ dolt_add: 1 }];
			if (query.startsWith("SELECT dolt_checkout")) {
				return [{ dolt_checkout: [0, "restored work_items"] }];
			}
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Secure" } },
				"agent-1",
			),
		).rejects.toThrow("dolt_add did not report success");
		expect(fake.reservedQueries).toEqual([
			expect.stringMatching(/^UPDATE work_items/),
			"SELECT dolt_add('work_items')",
			"SELECT dolt_checkout('work_items')",
		]);
	});

	it("cleans a failed commit before the next mutation can be committed", async () => {
		let workingTitle: string | undefined;
		let stagedTitle: string | undefined;
		let commitAttempt = 0;
		const committedTitles: string[] = [];
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				workingTitle = query.includes("title = 'First'") ? "First" : "Second";
				return [{ ...ROW, title: workingTitle }];
			}
			if (query.startsWith("SELECT dolt_add")) {
				stagedTitle = workingTitle;
				return [{ dolt_add: 0 }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				commitAttempt += 1;
				if (commitAttempt === 1) throw new Error("injected commit failure");
				if (stagedTitle) committedTitles.push(stagedTitle);
				workingTitle = undefined;
				stagedTitle = undefined;
				return [{ dolt_commit: "second-hash" }];
			}
			if (query === "SELECT dolt_checkout('work_items')") {
				workingTitle = undefined;
				stagedTitle = undefined;
				return [{ dolt_checkout: [0, "restored work_items"] }];
			}
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "First" } },
				"agent-1",
			),
		).rejects.toThrow("injected commit failure");
		await adapter.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "Second" } },
			"agent-1",
		);

		expect(committedTitles).toEqual(["Second"]);
		expect(fake.reservedQueries).toContain(
			"SELECT dolt_checkout('work_items')",
		);
	});

	it("poisons the adapter when targeted cleanup fails", async () => {
		let commitAttempts = 0;
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [{ ...ROW }];
			if (query.startsWith("SELECT dolt_add")) return [{ dolt_add: 0 }];
			if (query.startsWith("SELECT dolt_commit")) {
				commitAttempts += 1;
				throw new Error("injected commit failure");
			}
			if (query.startsWith("SELECT dolt_checkout")) {
				throw new Error("injected cleanup failure");
			}
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);
		const patch = () =>
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Never commit" } },
				"agent-1",
			);

		await expect(patch()).rejects.toBeInstanceOf(DoltCleanupFailedError);
		await expect(patch()).rejects.toBeInstanceOf(DoltCleanupFailedError);
		expect(commitAttempts).toBe(1);
		expect(fake.reservations).toBe(1);
	});

	it("fails closed when a different creator patches an existing item", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [];
			if (query.startsWith("SELECT *")) return [ROW];
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Stolen" } },
				"agent-2",
			),
		).rejects.toBeInstanceOf(WorkItemAuthorizationError);
	});

	it("fails closed when a different creator deletes an existing item", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("SELECT created_by_principal_id")) return [ROW];
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.delete(toWorkItemId("task.5001"), "agent-2"),
		).rejects.toBeInstanceOf(WorkItemAuthorizationError);
		expect(fake.reservations).toBe(0);
	});

	it("binds claim, heartbeat, and release to the authenticated principal", async () => {
		const fake = fakeSql(successfulMutation);
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);
		const id = toWorkItemId("task.5001");

		await adapter.claim({
			id,
			runId: "run-1",
			command: "implement",
			principalId: "agent-1",
		});
		await adapter.heartbeat({
			id,
			runId: "run-1",
			principalId: "agent-1",
		});
		await adapter.release({
			id,
			runId: "run-1",
			principalId: "agent-1",
		});

		const updates = fake.reservedQueries.filter((query) =>
			query.startsWith("UPDATE work_items"),
		);
		expect(updates[0]).toContain("claim_expires_at <= NOW()");
		expect(updates[0]).toContain("claim_owner_principal_id = 'agent-1'");
		expect(updates[1]).toContain("claim_owner_principal_id = 'agent-1'");
		expect(updates[1]).toContain("claimed_by_run = 'run-1'");
		expect(updates[1]).toContain("claim_expires_at > NOW()");
		expect(updates[2]).toContain("claim_owner_principal_id = 'agent-1'");
		expect(updates[2]).toContain("claimed_by_run = 'run-1'");
	});

	it("does not let another principal replace an active claim", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [];
			if (query.startsWith("SELECT *")) return [
				{ ...ROW, claimed_by_run: "run-1", claim_active: true },
			];
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.claim({
				id: toWorkItemId("task.5001"),
				runId: "run-2",
				command: "implement",
				principalId: "agent-2",
			}),
		).rejects.toBeInstanceOf(WorkItemLeaseConflictError);
	});

	it("retries an auto-id collision on the reserved client", async () => {
		let insertAttempts = 0;
		const fake = fakeSql((query) => {
			if (query.startsWith("SELECT id FROM")) {
				return insertAttempts === 0 ? [] : [{ id: "task.5000" }];
			}
			if (query.startsWith("INSERT INTO")) {
				insertAttempts += 1;
				if (insertAttempts === 1) {
					throw Object.assign(new Error("duplicate key"), { code: "23505" });
				}
				return [{ ...ROW, id: "task.5001" }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				return [{ dolt_commit: "abc123" }];
			}
			if (query.startsWith("SELECT dolt_add")) return [{ dolt_add: 0 }];
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		const item = await adapter.create(
			{ type: "task", title: "Allocated" },
			"agent-1",
		);

		expect(item.id).toBe("task.5001");
		expect(insertAttempts).toBe(2);
	});
});
