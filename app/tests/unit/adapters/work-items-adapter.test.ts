// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { toWorkItemId } from "@cogni/work-items";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
	DirtyWorkItemsMainError,
	DoltCommitFailedError,
	DoltgresPolyWorkItemAdapter,
	ForeignMergeInProgressError,
	WorkItemAuthorizationError,
	WorkItemLeaseConflictError,
	WorkItemsBusyError,
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

type Responder = (query: string) => unknown[] | Promise<unknown[]> | undefined;

function protocolResponse(query: string): unknown[] {
	if (query === "BEGIN" || query === "ROLLBACK") return [];
	if (query.startsWith("SAVEPOINT") || query.startsWith("RELEASE SAVEPOINT")) {
		return [];
	}
	if (query.startsWith("ROLLBACK TO SAVEPOINT")) return [];
	if (query.startsWith("SELECT pg_try_advisory_lock"))
		return [{ pg_try_advisory_lock: true }];
	if (query.startsWith("SELECT pg_advisory_unlock"))
		return [{ pg_advisory_unlock: true }];
	if (query.startsWith("SELECT dolt_checkout")) {
		return [{ dolt_checkout: [0, "checked out"] }];
	}
	if (query === "SELECT table_name FROM dolt.status") return [];
	if (query.includes("FROM dolt.merge_status")) {
		return [
			{
				is_merging: false,
				source: null,
				source_commit: null,
				target: null,
				unmerged_tables: null,
			},
		];
	}
	if (query === "SELECT name FROM dolt.branches") return [];
	if (query.startsWith("SELECT dolt_branch")) return [{ dolt_branch: 0 }];
	if (query === "SELECT dolt_merge('--abort')")
		return [{ dolt_merge: ["", false, 0, ""] }];
	if (query.startsWith("SELECT dolt_merge_base")) {
		return [{ dolt_merge_base: "branch-commit" }];
	}
	if (query.startsWith("SELECT dolt_merge")) {
		return [{ dolt_merge: ["merge-hash", true, 0, ""] }];
	}
	if (query.startsWith("SELECT dolt_add")) return [{ dolt_add: 0 }];
	return [];
}

function fakeSql(respond: Responder): {
	sql: Sql;
	poolQueries: string[];
	reservedQueries: string[];
	reservations: number;
} {
	const poolQueries: string[] = [];
	const reservedQueries: string[] = [];
	let reservations = 0;
	const run = async (query: string) =>
		respond(query) ?? protocolResponse(query);
	const reservedUnsafe = async (query: string) => {
		reservedQueries.push(query);
		return run(query);
	};
	const sql = {
		unsafe: async (query: string) => {
			poolQueries.push(query);
			return run(query);
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

function successfulMutation(query: string): unknown[] | undefined {
	if (query.startsWith("UPDATE work_items")) {
		return [{ ...ROW, revision: 2, deploy_verified: true, claim_active: true }];
	}
	if (query.startsWith("SELECT dolt_commit")) {
		return [{ dolt_commit: "branch-commit" }];
	}
	return undefined;
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

		const update = fake.reservedQueries.find((query) =>
			query.startsWith("UPDATE work_items"),
		);
		expect(update).toContain("created_by_principal_id = 'agent-1'");
		expect(update).toContain("deploy_verified = TRUE");
	});

	it("locks globally and commits the isolated branch without an explicit transaction", async () => {
		const fake = fakeSql(successfulMutation);
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await adapter.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "Secure" } },
			"agent-1",
		);

		expect(fake.reservations).toBe(1);
		expect(fake.poolQueries).toEqual(["SELECT 1 AS work_items_ready"]);
		const joined = fake.reservedQueries.join("\n");
		expect(joined).toContain("SELECT pg_try_advisory_lock(5001001)");
		expect(joined).toMatch(/dolt_checkout\('-b', 'work-item-op\//);
		expect(joined).not.toContain("BEGIN");
		expect(joined).not.toContain("SAVEPOINT");
		expect(joined).not.toContain("SELECT dolt_add");
		expect(joined).toContain("SELECT dolt_commit('-Am'");
		expect(joined).toContain("SELECT dolt_merge('work-item-op/");
		expect(joined).not.toContain("SELECT dolt_merge_base");
		expect(joined).toContain("SELECT dolt_branch('-D', 'work-item-op/");
		expect(joined).toContain("SELECT pg_advisory_unlock(5001001)");
	});

	it("emits stage-attributed durations through the injected logger", async () => {
		const fake = fakeSql(successfulMutation);
		const info = vi.fn();
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql, {
			info,
			warn: vi.fn(),
			error: vi.fn(),
		} as never);

		await adapter.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "Logged" } },
			"agent-1",
		);

		const events = info.mock.calls.map(
			([fields]) => fields as Record<string, unknown>,
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "adapter.work_items.stage_complete",
				operation: "patch task.5001",
				stage: "branch.commit",
				branch: expect.stringMatching(/^work-item-op\//),
				durationMs: expect.any(Number),
			}),
		);
		expect(events.every((event) => typeof event.operationId === "string")).toBe(
			true,
		);
	});

	it("serializes separate adapter instances through the database advisory lock", async () => {
		let lockHeld = false;
		let lockAttempts = 0;
		let activeUpdates = 0;
		let maxActiveUpdates = 0;
		let signalFirstUpdate: (() => void) | undefined;
		let releaseFirstUpdate: (() => void) | undefined;
		const firstUpdateReached = new Promise<void>((resolve) => {
			signalFirstUpdate = resolve;
		});
		const firstUpdateGate = new Promise<void>((resolve) => {
			releaseFirstUpdate = resolve;
		});

		const sql = {
			unsafe: async (query: string) => protocolResponse(query),
			reserve: async () => ({
				unsafe: async (query: string) => {
					if (query.startsWith("SELECT pg_try_advisory_lock")) {
						lockAttempts += 1;
						if (lockHeld) return [{ pg_try_advisory_lock: false }];
						lockHeld = true;
						return [{ pg_try_advisory_lock: true }];
					}
					if (query.startsWith("SELECT pg_advisory_unlock")) {
						lockHeld = false;
						return [{ pg_advisory_unlock: true }];
					}
					if (query.startsWith("UPDATE work_items")) {
						activeUpdates += 1;
						maxActiveUpdates = Math.max(maxActiveUpdates, activeUpdates);
						if (query.includes("title = 'One'")) {
							signalFirstUpdate?.();
							await firstUpdateGate;
						}
						activeUpdates -= 1;
						return [{ ...ROW, revision: 2, claim_active: true }];
					}
					if (query.startsWith("SELECT dolt_commit")) {
						return [{ dolt_commit: "branch-commit" }];
					}
					return protocolResponse(query);
				},
				release: () => undefined,
			}),
		} as unknown as Sql;
		const first = new DoltgresPolyWorkItemAdapter(sql, undefined, {
			lockRetryMs: 1,
			lockWaitMs: 100,
		});
		const second = new DoltgresPolyWorkItemAdapter(sql, undefined, {
			lockRetryMs: 1,
			lockWaitMs: 100,
		});

		const firstPatch = first.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "One" } },
			"agent-1",
		);
		await firstUpdateReached;
		const secondPatch = second.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "Two" } },
			"agent-1",
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		releaseFirstUpdate?.();
		await Promise.all([firstPatch, secondPatch]);

		expect(lockAttempts).toBeGreaterThanOrEqual(2);
		expect(maxActiveUpdates).toBe(1);
	});

	it("fails lock contention within the configured bound", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("SELECT pg_try_advisory_lock")) {
				return [{ pg_try_advisory_lock: false }];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql, undefined, {
			lockWaitMs: 0,
			lockRetryMs: 0,
		});

		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			WorkItemsBusyError,
		);
		expect(fake.reservedQueries).not.toContain(
			"SELECT pg_advisory_lock(5001001)",
		);
	});

	it("rejects a read before pool reservation while a local mutation is active", async () => {
		let signalUpdate: (() => void) | undefined;
		let releaseUpdate: (() => void) | undefined;
		const updateReached = new Promise<void>((resolve) => {
			signalUpdate = resolve;
		});
		const updateGate = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				signalUpdate?.();
				return updateGate.then(() => [
					{ ...ROW, revision: 2, claim_active: true },
				]);
			}
			if (query.startsWith("SELECT dolt_commit")) {
				return [{ dolt_commit: "branch-commit" }];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);
		const patch = adapter.patch(
			{ id: toWorkItemId("task.5001"), set: { title: "Held" } },
			"agent-1",
		);
		await updateReached;

		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			WorkItemsBusyError,
		);
		expect(fake.reservations).toBe(1);
		releaseUpdate?.();
		await patch;
	});

	it("hard-terminates a timed-out pool and recovers on a fresh client", async () => {
		let rejectBlocked: ((error: Error) => void) | undefined;
		let terminated = false;
		let released = false;
		let recreated = 0;
		const fresh = fakeSql((query) => {
			if (query.includes("SELECT *,")) return [ROW];
			return undefined;
		});
		const sql = {
			unsafe: async (query: string) => protocolResponse(query),
			reserve: async () => ({
				unsafe: (query: string) => {
					if (terminated) return Promise.reject(new Error("client terminated"));
					if (query.startsWith("UPDATE work_items")) {
						return new Promise<unknown[]>((_, reject) => {
							rejectBlocked = reject;
						});
					}
					return Promise.resolve(protocolResponse(query));
				},
				release: () => {
					released = true;
				},
			}),
			end: async () => {
				terminated = true;
				rejectBlocked?.(new Error("connection destroyed"));
			},
		} as unknown as Sql;
		const adapter = new DoltgresPolyWorkItemAdapter(sql, undefined, {
			queryTimeoutMs: 5,
			recreateClient: () => {
				recreated += 1;
				return fresh.sql;
			},
		});

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Wedge" } },
				"agent-1",
			),
		).rejects.toBeInstanceOf(WorkItemsBusyError);
		await expect(adapter.get(toWorkItemId("task.5001"))).resolves.toMatchObject(
			{
				id: "task.5001",
			},
		);
		expect(terminated).toBe(true);
		expect(released).toBe(false);
		expect(recreated).toBe(1);
		expect(fresh.reservations).toBe(1);
	});

	it("force-terminates and poisons a connection reservation that never settles", async () => {
		let rejectReserve: ((error: Error) => void) | undefined;
		let terminated = false;
		const sql = {
			unsafe: async (query: string) => protocolResponse(query),
			reserve: () =>
				new Promise<never>((_, reject) => {
					rejectReserve = reject;
				}),
			end: async () => {
				terminated = true;
				rejectReserve?.(new Error("pool terminated"));
			},
		} as unknown as Sql;
		const adapter = new DoltgresPolyWorkItemAdapter(sql, undefined, {
			reserveTimeoutMs: 5,
		});

		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			WorkItemsBusyError,
		);
		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			WorkItemsBusyError,
		);
		expect(terminated).toBe(true);
	});

	it("deletes stale operation branches before serving a read", async () => {
		const fake = fakeSql((query) => {
			if (query === "SELECT name FROM dolt.branches") {
				return [{ name: "main" }, { name: "work-item-op/orphaned" }];
			}
			if (query.includes("SELECT *,")) return [ROW];
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		const item = await adapter.get(toWorkItemId("task.5001"));

		expect(item?.id).toBe("task.5001");
		const cleanupIndex = fake.reservedQueries.findIndex((query) =>
			query.includes("dolt_branch('-D', 'work-item-op/orphaned')"),
		);
		const readIndex = fake.reservedQueries.findIndex((query) =>
			query.includes("FROM work_items WHERE id"),
		);
		expect(cleanupIndex).toBeGreaterThan(-1);
		expect(readIndex).toBeGreaterThan(cleanupIndex);
	});

	it("aborts a persisted work-item merge before restart reconciliation", async () => {
		let mergeActive = true;
		const fake = fakeSql((query) => {
			if (query.includes("FROM dolt.merge_status")) {
				return [
					mergeActive
						? {
								is_merging: true,
								source: "work-item-op/orphaned",
								source_commit: "orphan-commit",
								target: "refs/heads/main",
								unmerged_tables: "work_items",
							}
						: { is_merging: false },
				];
			}
			if (query === "SELECT dolt_merge('--abort')") {
				mergeActive = false;
				return [{ dolt_merge: ["", false, 0, "aborted"] }];
			}
			if (query === "SELECT name FROM dolt.branches") {
				return [{ name: "main" }, { name: "work-item-op/orphaned" }];
			}
			if (query.includes("SELECT *,")) return [ROW];
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(adapter.get(toWorkItemId("task.5001"))).resolves.toMatchObject(
			{
				id: "task.5001",
			},
		);
		const abortIndex = fake.reservedQueries.indexOf(
			"SELECT dolt_merge('--abort')",
		);
		const readIndex = fake.reservedQueries.findIndex((query) =>
			query.includes("FROM work_items WHERE id"),
		);
		expect(abortIndex).toBeGreaterThan(-1);
		expect(readIndex).toBeGreaterThan(abortIndex);
	});

	it("does not abort a persisted merge owned by another subsystem", async () => {
		const fake = fakeSql((query) => {
			if (query.includes("FROM dolt.merge_status")) {
				return [
					{
						is_merging: true,
						source: "contrib/agent-1",
						source_commit: "contrib-commit",
						target: "refs/heads/main",
						unmerged_tables: "knowledge",
					},
				];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			ForeignMergeInProgressError,
		);
		expect(fake.reservedQueries).not.toContain("SELECT dolt_merge('--abort')");
	});

	it("fails reads closed when main has dirty work_items state", async () => {
		const fake = fakeSql((query) => {
			if (query === "SELECT table_name FROM dolt.status") {
				return [{ table_name: "public.work_items" }];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			DirtyWorkItemsMainError,
		);
		expect(
			fake.reservedQueries.some((query) =>
				query.startsWith("SELECT * FROM work_items"),
			),
		).toBe(false);
	});

	it("drops a failed branch so the next commit cannot sweep its mutation", async () => {
		let currentBranch = "main";
		let commitAttempt = 0;
		const titles = new Map<string, string>();
		const mergedTitles: string[] = [];
		const deletedBranches: string[] = [];
		const fake = fakeSql((query) => {
			const create = /dolt_checkout\('-b', '([^']+)', 'main'\)/.exec(query);
			if (create?.[1]) {
				currentBranch = create[1];
				return [{ dolt_checkout: [0, "created"] }];
			}
			if (query === "SELECT dolt_checkout('main')") {
				currentBranch = "main";
				return [{ dolt_checkout: [0, "main"] }];
			}
			if (query.startsWith("UPDATE work_items")) {
				titles.set(
					currentBranch,
					query.includes("title = 'First'") ? "First" : "Second",
				);
				return [{ ...ROW, title: titles.get(currentBranch) }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				commitAttempt += 1;
				if (commitAttempt === 1) throw new Error("injected commit failure");
				return [{ dolt_commit: `commit-${commitAttempt}` }];
			}
			if (query.startsWith("SELECT dolt_merge_base")) {
				return [{ dolt_merge_base: `commit-${commitAttempt}` }];
			}
			const merge = /dolt_merge\('([^']+)'\)/.exec(query);
			if (merge?.[1]) {
				const title = titles.get(merge[1]);
				if (title) mergedTitles.push(title);
				return [{ dolt_merge: ["merge-hash", true, 0, ""] }];
			}
			const remove = /dolt_branch\('-D', '([^']+)'\)/.exec(query);
			if (remove?.[1]) {
				deletedBranches.push(remove[1]);
				titles.delete(remove[1]);
				return [{ dolt_branch: 0 }];
			}
			return undefined;
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

		expect(mergedTitles).toEqual(["Second"]);
		expect(deletedBranches).toHaveLength(2);
	});

	it.each(["status", "branch-delete"] as const)(
		"returns success after a durable merge even when %s housekeeping fails",
		async (failure) => {
			let statusCalls = 0;
			const fake = fakeSql((query) => {
				if (query.startsWith("UPDATE work_items")) {
					return [{ ...ROW, revision: 2, claim_active: true }];
				}
				if (query.startsWith("SELECT dolt_commit")) {
					return [{ dolt_commit: "branch-commit" }];
				}
				if (query === "SELECT table_name FROM dolt.status") {
					statusCalls += 1;
					return failure === "status" && statusCalls > 1
						? [{ table_name: "public.work_items" }]
						: [];
				}
				if (
					failure === "branch-delete" &&
					query.includes("dolt_branch('-D', 'work-item-op/")
				) {
					throw new Error("branch cleanup unavailable");
				}
				return undefined;
			});
			const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

			await expect(
				adapter.patch(
					{ id: toWorkItemId("task.5001"), set: { title: "Durable" } },
					"agent-1",
				),
			).resolves.toMatchObject({ revision: 2 });
			expect(fake.reservations).toBe(1);
		},
	);

	it.each(["create", "patch", "delete"] as const)(
		"does not replay an ambiguously acknowledged %s already reachable from main",
		async (operation) => {
			let mutationCount = 0;
			const fake = fakeSql((query) => {
				if (
					query.startsWith("INSERT INTO work_items") ||
					query.startsWith("UPDATE work_items") ||
					query.startsWith("DELETE FROM work_items")
				) {
					mutationCount += 1;
					if (query.startsWith("DELETE")) return [{ id: "task.5001" }];
					return [{ ...ROW, revision: 2, claim_active: true }];
				}
				if (query.startsWith("SELECT dolt_commit")) {
					return [{ dolt_commit: "branch-commit" }];
				}
				if (query.startsWith("SELECT dolt_merge_base")) {
					return [{ dolt_merge_base: "branch-commit" }];
				}
				if (/^SELECT dolt_merge\('work-item-op\//.test(query)) {
					throw new Error("connection dropped after merge response");
				}
				return undefined;
			});
			const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);
			const result =
				operation === "create"
					? await adapter.create(
							{ id: "task.5001", type: "task", title: "Create once" },
							"agent-1",
						)
					: operation === "patch"
						? await adapter.patch(
								{
									id: toWorkItemId("task.5001"),
									set: { title: "Patch once" },
								},
								"agent-1",
							)
						: await adapter.delete(toWorkItemId("task.5001"), "agent-1");

			expect(result).toBeTruthy();
			expect(mutationCount).toBe(1);
			expect(fake.reservations).toBe(1);
		},
	);

	it("proves reachability before accepting a truncated merge acknowledgement", async () => {
		let mutationCount = 0;
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				mutationCount += 1;
				return [{ ...ROW, revision: 2, claim_active: true }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				return [{ dolt_commit: "branch-commit" }];
			}
			if (query.startsWith("SELECT dolt_merge_base")) {
				return [{ dolt_merge_base: "branch-commit" }];
			}
			if (/^SELECT dolt_merge\('work-item-op\//.test(query)) {
				return [{ dolt_merge: ["hash-only"] }];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Once" } },
				"agent-1",
			),
		).resolves.toMatchObject({ revision: 2 });
		expect(mutationCount).toBe(1);
		expect(
			fake.reservedQueries.some((query) =>
				query.startsWith("SELECT dolt_merge_base"),
			),
		).toBe(true);
	});

	it("does not retry a generic merge error proven uncommitted", async () => {
		let mutationCount = 0;
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				mutationCount += 1;
				return [{ ...ROW, revision: 2, claim_active: true }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				return [{ dolt_commit: "branch-commit" }];
			}
			if (query.startsWith("SELECT dolt_merge_base")) {
				return [{ dolt_merge_base: "main-before-branch" }];
			}
			if (/^SELECT dolt_merge\('work-item-op\//.test(query)) {
				throw new Error("generic merge transport failure");
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Once" } },
				"agent-1",
			),
		).rejects.toThrow("generic merge transport failure");
		expect(mutationCount).toBe(1);
		expect(fake.reservations).toBe(1);
	});

	it("poisons the adapter when ambiguous merge reachability cannot be proven", async () => {
		let mutationCount = 0;
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				mutationCount += 1;
				return [{ ...ROW, revision: 2, claim_active: true }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				return [{ dolt_commit: "branch-commit" }];
			}
			if (query.startsWith("SELECT dolt_merge_base")) {
				throw new Error("reachability unavailable");
			}
			if (/^SELECT dolt_merge\('work-item-op\//.test(query)) {
				throw new Error("merge acknowledgement unavailable");
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Unknown" } },
				"agent-1",
			),
		).rejects.toBeInstanceOf(WorkItemsBusyError);
		await expect(adapter.get(toWorkItemId("task.5001"))).rejects.toBeInstanceOf(
			WorkItemsBusyError,
		);
		expect(mutationCount).toBe(1);
		expect(fake.reservations).toBe(1);
	});

	it("retries only a merge conflict proven not reachable from main", async () => {
		let mutationCount = 0;
		let mergeAttempts = 0;
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) {
				mutationCount += 1;
				return [{ ...ROW, revision: 2, claim_active: true }];
			}
			if (query.startsWith("SELECT dolt_commit")) {
				return [{ dolt_commit: "branch-commit" }];
			}
			if (query.startsWith("SELECT dolt_merge_base")) {
				return [
					{
						dolt_merge_base:
							mergeAttempts === 1 ? "main-before-branch" : "branch-commit",
					},
				];
			}
			if (/^SELECT dolt_merge\('work-item-op\//.test(query)) {
				mergeAttempts += 1;
				if (mergeAttempts === 1) throw new Error("merge conflict");
				return [{ dolt_merge: ["merge-hash", true, 0, ""] }];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Retry" } },
				"agent-1",
			),
		).resolves.toMatchObject({ revision: 2 });
		expect(mutationCount).toBe(2);
		expect(fake.reservations).toBe(2);
	});

	it("fails closed when Dolt does not return a branch commit hash", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [{ ...ROW }];
			if (query.startsWith("SELECT dolt_commit")) return [{}];
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Secure" } },
				"agent-1",
			),
		).rejects.toBeInstanceOf(DoltCommitFailedError);
		expect(
			fake.reservedQueries.some((query) =>
				query.startsWith("SELECT dolt_merge('work-item-op/"),
			),
		).toBe(false);
	});

	it("fails closed when a different creator patches an existing item", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [];
			if (query.startsWith("SELECT *")) return [ROW];
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		await expect(
			adapter.patch(
				{ id: toWorkItemId("task.5001"), set: { title: "Stolen" } },
				"agent-2",
			),
		).rejects.toBeInstanceOf(WorkItemAuthorizationError);
	});

	it("binds claim, heartbeat, and release to authenticated principal and run", async () => {
		const fake = fakeSql(successfulMutation);
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);
		const id = toWorkItemId("task.5001");

		await adapter.claim({
			id,
			runId: "run-1",
			command: "implement",
			principalId: "agent-1",
		});
		await adapter.heartbeat({ id, runId: "run-1", principalId: "agent-1" });
		await adapter.release({ id, runId: "run-1", principalId: "agent-1" });

		const updates = fake.reservedQueries.filter((query) =>
			query.startsWith("UPDATE work_items"),
		);
		expect(updates[0]).toContain("claim_expires_at <= NOW()");
		expect(updates[1]).toContain("claim_owner_principal_id = 'agent-1'");
		expect(updates[1]).toContain("claimed_by_run = 'run-1'");
		expect(updates[2]).toContain("claimed_by_run = 'run-1'");
	});

	it("does not let another principal replace an active claim", async () => {
		const fake = fakeSql((query) => {
			if (query.startsWith("UPDATE work_items")) return [];
			if (query.startsWith("SELECT *")) {
				return [{ ...ROW, claimed_by_run: "run-1", claim_active: true }];
			}
			return undefined;
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

	it("retries auto-id collisions on a fresh operation branch", async () => {
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
				return [{ dolt_commit: "branch-commit" }];
			}
			return undefined;
		});
		const adapter = new DoltgresPolyWorkItemAdapter(fake.sql);

		const item = await adapter.create(
			{ type: "task", title: "Allocated" },
			"agent-1",
		);

		expect(item.id).toBe("task.5001");
		expect(insertAttempts).toBe(2);
		expect(fake.reservations).toBe(2);
		expect(
			fake.reservedQueries.filter((query) =>
				query.includes("dolt_checkout('-b', 'work-item-op/"),
			),
		).toHaveLength(2);
		expect(fake.reservedQueries.join("\n")).not.toContain("SAVEPOINT");
	});
});
