// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real Doltgres 0.57.3 acceptance for the deployed work-item mutation flow.
 *
 * node-template owns `@cogni/work-items`' Doltgres adapter, so the real-engine
 * proof belongs here rather than only in a fork (task.5199). Fake-SQL unit
 * tests cannot see Dolt branch semantics; bug.5358 shipped green against them.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toWorkItemId } from "@cogni/work-items";
import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DoltgresWorkItemAdapter,
	WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATE_SCRIPT = path.resolve(
	REPO_ROOT,
	"scripts/db/migrate-doltgres.mjs",
);
const MIGRATIONS_DIR = path.resolve(
	REPO_ROOT,
	"app/src/adapters/server/db/doltgres-migrations",
);
const DOLTGRES_IMAGE = "dolthub/doltgresql:0.57.3";
const DB_NAME = "knowledge_poly_work_items";
const PASSWORD = "doltgres";

describe("Doltgres 0.57.3 work-item acceptance", () => {
	let container: StartedTestContainer;
	let sql: Sql;
	let dbUrl: string;
	const stageLogger = {
		info: (fields: unknown, message?: string) =>
			console.info(message, JSON.stringify(fields)),
		warn: (fields: unknown, message?: string) =>
			console.warn(message, JSON.stringify(fields)),
		error: (fields: unknown, message?: string) =>
			console.error(message, JSON.stringify(fields)),
	};

	beforeAll(async () => {
		container = await new GenericContainer(DOLTGRES_IMAGE)
			.withEnvironment({ DOLTGRES_PASSWORD: PASSWORD })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();

		const host = container.getHost();
		const port = container.getMappedPort(5432);
		const baseUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/postgres`;
		dbUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/${DB_NAME}`;
		const bootstrap = postgres(baseUrl, { max: 1, fetch_types: false });
		try {
			await bootstrap.unsafe(`CREATE DATABASE ${DB_NAME}`);
		} finally {
			await bootstrap.end({ timeout: 5 });
		}

		execFileSync(process.execPath, [MIGRATE_SCRIPT, MIGRATIONS_DIR], {
			env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "poly-test" },
			encoding: "utf8",
			stdio: "pipe",
		});
		sql = postgres(dbUrl, { max: 1, fetch_types: false });
	}, 180_000);

	afterAll(async () => {
		if (sql) await sql.end({ timeout: 5 });
		if (container) await container.stop();
	});

	it("creates, lists, patches, coordinates, and deletes through Dolt branches", async () => {
		const createWorkItemClient = () =>
			postgres(dbUrl, { max: 1, fetch_types: false });
		// An EXPLICIT read pool, so `recreateClient` below stays a pure
		// write-pool factory and `sql` keeps tracking the write pool — which the
		// pool-death scenario further down depends on. The 0.1.7 derivation path
		// (no readClient, pool built from recreateClient) is covered in the unit
		// lane; mixing it in here would mean `sql` sometimes pointed at the read
		// pool and the pool-death assertions would kill the wrong connection.
		const readSql = createWorkItemClient();
		const adapter = new DoltgresWorkItemAdapter(sql, {
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
			readClient: readSql,
			recreateClient: () => {
				sql = createWorkItemClient();
				return sql;
			},
		});
		const id = toWorkItemId("task.9501");
		const principalId = "doltgres-acceptance-agent";

		const created = await adapter.create(
			{ id, type: "task", title: "Doltgres acceptance" },
			principalId,
		);
		expect(created.id).toBe(id);
		expect((await adapter.list({ ids: [id] })).items).toHaveLength(1);

		const patched = await adapter.patch(
			{ id, set: { title: "Doltgres accepted" } },
			principalId,
		);
		expect(patched.title).toBe("Doltgres accepted");

		// bug.5358's core guarantee, against a REAL held lock: a write holding
		// the global work-items lock must not take reads down with it. Before
		// 0.1.7 this same lock made `get` reject with WorkItemsBusyError, because
		// reads shared the write lane. The write lane still fails closed — the
		// `patch` below proves that on the same held lock.
		const blocker = createWorkItemClient();
		try {
			await blocker.unsafe("SELECT pg_advisory_lock(5001001)");
			await expect(adapter.get(id)).resolves.toMatchObject({ id });
			await expect(
				adapter.patch({ id, set: { title: "blocked" } }, principalId),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
		} finally {
			await blocker
				.unsafe("SELECT pg_advisory_unlock(5001001)")
				.catch(() => undefined);
			await blocker.end({ timeout: 0 });
		}

		const maintenance = createWorkItemClient();
		try {
			await maintenance.unsafe(
				"SELECT dolt_checkout('-b', 'work-item-op/acceptance-orphan', 'main')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");
		} finally {
			await maintenance.end({ timeout: 0 });
		}

		const oldPool = sql;
		const lockHolder = createWorkItemClient();
		try {
			await lockHolder.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedQuery = oldPool.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedResult = blockedQuery.then(
				() => undefined,
				(error) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			// A WRITE, not a read: the write pool is the only pool a write uses,
			// so it is the only operation that can observe that pool dying and
			// then prove `recreateClient` rebuilt it. Before 0.1.7 a read shared
			// that pool and stood in for this; it no longer does, and a read
			// standing in would now assert nothing.
			const recoveryAttempt = adapter.patch(
				{ id, set: { title: "pool death" } },
				principalId,
			);
			const destroyTimer = setTimeout(() => {
				void oldPool.end({ timeout: 0 });
			}, 100);
			await expect(blockedResult).resolves.toBeInstanceOf(Error);
			await expect(recoveryAttempt).rejects.toBeInstanceOf(WorkItemsBusyError);
			clearTimeout(destroyTimer);
		} finally {
			await oldPool.end({ timeout: 0 });
			await lockHolder
				.unsafe("SELECT pg_advisory_unlock(9501002)")
				.catch(() => undefined);
			await lockHolder.end({ timeout: 0 });
		}

		// Reads kept serving throughout — including while the write pool was
		// dead, which is the bug.5358 guarantee.
		await expect(adapter.get(id)).resolves.toMatchObject({ id });
		// ...and the next WRITE both proves the pool was rebuilt and sweeps the
		// orphan branch. Sweeping is a branch mutation, so it belongs to the
		// write plane (COMMAND_QUERY_SEPARATION); a read used to do it here only
		// because a read used to take the write lock.
		await expect(
			adapter.patch({ id, set: { title: "Doltgres accepted" } }, principalId),
		).resolves.toMatchObject({ id, title: "Doltgres accepted" });
		const verifier = createWorkItemClient();
		try {
			await expect(
				verifier.unsafe(
					"SELECT name FROM dolt.branches WHERE name = 'work-item-op/acceptance-orphan'",
				),
			).resolves.toHaveLength(0);
		} finally {
			await verifier.end({ timeout: 0 });
		}

		const claimed = await adapter.claim({
			id,
			runId: "acceptance-run",
			command: "implement",
			principalId,
		});
		expect(claimed.claimedByRun).toBe("acceptance-run");

		const heartbeat = await adapter.heartbeat({
			id,
			runId: "acceptance-run",
			command: "verify",
			principalId,
		});
		expect(heartbeat.lastCommand).toBe("verify");

		const released = await adapter.release({
			id,
			runId: "acceptance-run",
			principalId,
		});
		expect(released.claimedByRun).toBeUndefined();
		await expect(adapter.delete(id, principalId)).resolves.toBe(true);
		await expect(adapter.get(id)).resolves.toBeNull();
		await readSql.end({ timeout: 0 });
	}, 60_000);

	it("serves reads past an unprovable operation branch and quarantines it so writes recover", async () => {
		const branch = "work-item-op/component-unreachable";
		const maintenance = postgres(dbUrl, { max: 1, fetch_types: false });
		try {
			await maintenance.unsafe(
				`SELECT dolt_checkout('-b', '${branch}', 'main')`,
			);
			await maintenance.unsafe(
				"INSERT INTO work_items (id, type, title, status, node, created_by_principal_id) VALUES ('task.9599', 'task', 'Unreachable evidence', 'needs_implement', 'shared', 'component-agent')",
			);
			await maintenance.unsafe(
				"SELECT dolt_commit('-Am', 'component unreachable evidence')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			const adapter = new DoltgresWorkItemAdapter(sql, {
			logger: stageLogger,
				lockWaitMs: 250,
				lockRetryMs: 25,
			});
			// bug.5358: an unprovable branch must not take reads down. The read is
			// served from committed `main` — which does not carry task.9599, so null
			// is the correct answer — while the evidence branch stays untouched.
			// Reads still fail closed on lock contention and on a destroyed
			// connection; both are asserted above. Only branch-proof residue is
			// tolerated.
			await expect(
				adapter.get(toWorkItemId("task.9599")),
			).resolves.toBeNull();
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(1);

			// CONTRACT CHANGE, deliberate (bug.5358). This case previously asserted
			// that the write stays 503 forever. That is what made operator
			// production unwritable: nothing deletes this ref, the sweep re-walks
			// `dolt.branches` on every request, and no restart clears it — 88
			// consecutive write 503s over two hours while reads stayed 200.
			//
			// The safety property is unchanged: the write still does not build on
			// unproven evidence. Instead the ref is RENAMED out of the swept
			// namespace, so its commits survive byte-for-byte for a human to
			// merge, and the write then proceeds. Here it proceeds to a genuine
			// "not found", because committed `main` does not carry task.9599 —
			// which is exactly the point: the branch no longer decides the
			// outcome.
			await expect(
				adapter.patch(
					{
						id: toWorkItemId("task.9599"),
						set: { title: "must not land" },
					},
					"component-agent",
				),
			).rejects.toThrow(/Work item not found/);
			// Parked, never deleted: gone from the op namespace, present under
			// quarantine with its row intact.
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(0);
			const quarantined = `work-item-quarantine/${branch.slice(
				"work-item-op/".length,
			)}`;
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${quarantined}'`,
				),
			).resolves.toHaveLength(1);
			// Proving the ROW survived is the point of quarantine. Doltgres is
			// Postgres dialect, so MySQL backtick branch-qualification does not
			// parse; check the branch out on the maintenance session instead.
			await maintenance.unsafe(`SELECT dolt_checkout('${quarantined}')`);
			await expect(
				maintenance.unsafe(
					"SELECT id FROM work_items WHERE id = 'task.9599'",
				),
			).resolves.toHaveLength(1);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			// `branch` no longer exists — quarantine renamed it — so drop the
			// quarantined ref to prove a clean store still reads null.
			await maintenance.unsafe(`SELECT dolt_branch('-D', '${quarantined}')`);
			await expect(
				adapter.get(toWorkItemId("task.9599")),
			).resolves.toBeNull();
		} finally {
			await maintenance
				.unsafe("SELECT dolt_checkout('main')")
				.catch(() => undefined);
			await maintenance
				.unsafe(`SELECT dolt_branch('-D', '${branch}')`)
				.catch(() => undefined);
			await maintenance
				.unsafe(
					`SELECT dolt_branch('-D', 'work-item-quarantine/${branch.slice("work-item-op/".length)}')`,
				)
				.catch(() => undefined);
			await maintenance.end({ timeout: 0 });
		}
	}, 60_000);

	it("commits only work_items while preserving and deterministically cleaning dirty knowledge", async () => {
		const adapter = new DoltgresWorkItemAdapter(sql, {
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
		});
		const id = toWorkItemId("task.9502");
		const knowledgeId = "component-dirty-knowledge";
		const knowledgeBranch = "knowledge-component-dirty";
		const principalId = "doltgres-scoped-staging-agent";
		const knowledgeSql = postgres(dbUrl, { max: 1, fetch_types: false });
		let knowledgeSession:
			| Awaited<ReturnType<typeof knowledgeSql.reserve>>
			| undefined;
		let workItemCreated = false;
		let before = "";
		let beforeBranches: ReadonlyArray<Record<string, unknown>> = [];
		let beforeStatus: ReadonlyArray<Record<string, unknown>> = [];

		try {
			const beforeRows = await sql.unsafe(
				"SELECT dolt_hashof('main') AS hash",
			);
			before = String(beforeRows[0]?.hash ?? "");
			expect(before).not.toBe("");
			beforeBranches = await sql.unsafe(
				"SELECT name, hash FROM dolt.branches ORDER BY name",
			);
			beforeStatus = await sql.unsafe(
				"SELECT table_name, staged FROM dolt.status ORDER BY table_name",
			);
			// Pin checkout, dirty write, assertions, and cleanup to one Dolt session.
			// A max:1 pool limits concurrency but does not itself reserve a session.
			await knowledgeSql.unsafe("SELECT 1 AS knowledge_ready");
			knowledgeSession = await knowledgeSql.reserve();
			await knowledgeSession.unsafe(
				`SELECT dolt_checkout('-b', '${knowledgeBranch}', 'main')`,
			);
			await knowledgeSession.unsafe(
				`INSERT INTO knowledge (id, domain, title, content, source_type) VALUES ('${knowledgeId}', 'shared', 'Dirty fixture', 'Must remain outside work-item commit', 'agent')`,
			);

			await adapter.create(
				{ id, type: "task", title: "Scoped staging acceptance" },
				principalId,
			);
			workItemCreated = true;

			const afterRows = await sql.unsafe(
				"SELECT dolt_hashof('main') AS hash",
			);
			const after = String(afterRows[0]?.hash ?? "");
			expect(after).not.toBe(before);
			await expect(
				sql.unsafe(
					`SELECT * FROM dolt_diff('${before}', '${after}', 'knowledge')`,
				),
			).resolves.toHaveLength(0);
			await expect(
				knowledgeSession.unsafe(
					`SELECT table_name FROM dolt.status WHERE table_name = 'public.knowledge'`,
				),
			).resolves.toHaveLength(1);
			await expect(
				knowledgeSession.unsafe(
					`SELECT id FROM knowledge WHERE id = '${knowledgeId}'`,
				),
			).resolves.toHaveLength(1);
		} finally {
			if (workItemCreated) {
				await adapter.delete(id, principalId).catch(() => undefined);
			}
			if (knowledgeSession) {
				await knowledgeSession
					.unsafe("SELECT dolt_reset('--hard', 'HEAD')")
					.catch(() => undefined);
				await knowledgeSession
					.unsafe("SELECT dolt_checkout('main')")
					.catch(() => undefined);
				await knowledgeSession
					.unsafe(`SELECT dolt_branch('-D', '${knowledgeBranch}')`)
					.catch(() => undefined);
				knowledgeSession.release();
			}
			await knowledgeSql.end({ timeout: 0 });
			await sql.unsafe("SELECT dolt_checkout('main')").catch(() => undefined);
			if (before) {
				await sql.unsafe(`SELECT dolt_reset('--hard', '${before}')`);
			}
			await expect(sql.unsafe("SELECT dolt_hashof('main') AS hash")).resolves.toEqual(
				[{ hash: before }],
			);
			await expect(
				sql.unsafe("SELECT name, hash FROM dolt.branches ORDER BY name"),
			).resolves.toEqual(beforeBranches);
			await expect(
				sql.unsafe(
					"SELECT table_name, staged FROM dolt.status ORDER BY table_name",
				),
			).resolves.toEqual(beforeStatus);
		}
	}, 60_000);
});
