// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { toWorkItemId } from "@cogni/work-items";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresPolyWorkItemAdapter } from "@/adapters/server/db/doltgres/work-items-adapter";

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
	created_at: "2026-10-02T12:00:00.000Z",
	updated_at: "2026-10-02T12:00:00.000Z",
};

function fakeSql(respond: (query: string) => unknown[]): {
	sql: Sql;
	queries: string[];
} {
	const queries: string[] = [];
	const unsafe = async (query: string) => {
		queries.push(query);
		return respond(query);
	};
	return {
		sql: { unsafe } as unknown as Sql,
		queries,
	};
}

describe("DoltgresPolyWorkItemAdapter", () => {
	it("persists extended patch fields and commits the mutation", async () => {
		const { sql, queries } = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				return [{ ...ROW, revision: 2, deploy_verified: true }];
			}
			if (query.startsWith("SELECT dolt_commit")) return [{}];
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(sql);

		const item = await adapter.patch(
			{
				id: toWorkItemId("task.5001"),
				set: { deployVerified: true, blockedBy: null },
			},
			"actor:test",
		);

		expect(item.deployVerified).toBe(true);
		expect(queries[0]).toContain("deploy_verified = TRUE");
		expect(queries[0]).toContain("blocked_by = NULL");
		expect(queries[0]).toContain("revision = revision + 1");
		expect(queries[1]).toContain("dolt_commit");
	});

	it("claims and releases against Doltgres instead of markdown", async () => {
		let updateCount = 0;
		const { sql, queries } = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				updateCount += 1;
				return [
					{
						...ROW,
						revision: 1 + updateCount,
						claimed_by_run: updateCount === 1 ? "run-1" : null,
						claimed_at: updateCount === 1 ? "2026-10-02T12:01:00.000Z" : null,
						last_command: "implement",
					},
				];
			}
			if (query.startsWith("SELECT dolt_commit")) return [{}];
			return [];
		});
		const adapter = new DoltgresPolyWorkItemAdapter(sql);

		expect(
			(
				await adapter.claim({
					id: toWorkItemId("task.5001"),
					runId: "run-1",
					command: "implement",
				})
			).claimedByRun,
		).toBe("run-1");
		expect(
			(
				await adapter.release({
					id: toWorkItemId("task.5001"),
					runId: "run-1",
				})
			).claimedByRun,
		).toBeUndefined();
		expect(
			queries.filter((query) => query.includes("dolt_commit")),
		).toHaveLength(2);
	});
});
