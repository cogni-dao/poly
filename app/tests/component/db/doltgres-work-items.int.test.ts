// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real Doltgres 0.57.3 acceptance for the deployed work-item mutation flow. */

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
	DoltgresPolyWorkItemAdapter,
	WorkItemsBusyError,
} from "@/adapters/server/db/doltgres/work-items-adapter";

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
		const adapter = new DoltgresPolyWorkItemAdapter(sql, stageLogger, {
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
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

		const blocker = createWorkItemClient();
		try {
			await blocker.unsafe("SELECT pg_advisory_lock(5001001)");
			await expect(adapter.get(id)).rejects.toBeInstanceOf(WorkItemsBusyError);
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
			const recoveryAttempt = adapter.get(id);
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

		await expect(adapter.get(id)).resolves.toMatchObject({ id });
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
	}, 60_000);

	it("preserves an unreachable operation branch and serves after explicit cleanup", async () => {
		const branch = "work-item-op/component-unreachable";
		const maintenance = postgres(dbUrl, { max: 1, fetch_types: false });
		try {
			await maintenance.unsafe(
				`SELECT dolt_checkout('-b', '${branch}', 'main')`,
			);
			await maintenance.unsafe(
				"INSERT INTO work_items (id, type, title, status, node, created_by_principal_id) VALUES ('task.9599', 'task', 'Unreachable evidence', 'needs_implement', 'poly', 'component-agent')",
			);
			await maintenance.unsafe(
				"SELECT dolt_commit('-Am', 'component unreachable evidence')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			const adapter = new DoltgresPolyWorkItemAdapter(sql, stageLogger, {
				lockWaitMs: 250,
				lockRetryMs: 25,
			});
			await expect(
				adapter.get(toWorkItemId("task.9599")),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(1);

			await maintenance.unsafe(`SELECT dolt_branch('-D', '${branch}')`);
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
			await maintenance.end({ timeout: 0 });
		}
	}, 60_000);

	it("commits only work_items while preserving and deterministically cleaning dirty knowledge", async () => {
		const adapter = new DoltgresPolyWorkItemAdapter(sql, stageLogger, {
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
		});
		const id = toWorkItemId("task.9502");
		const knowledgeId = "component-dirty-knowledge";
		const principalId = "doltgres-scoped-staging-agent";
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
			await sql.unsafe(
				`INSERT INTO knowledge (id, domain, title, content, source_type) VALUES ('${knowledgeId}', 'poly', 'Dirty fixture', 'Must remain outside work-item commit', 'agent')`,
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
				sql.unsafe(
					`SELECT table_name FROM dolt.status WHERE table_name = 'knowledge'`,
				),
			).resolves.toHaveLength(1);
			await expect(
				sql.unsafe(`SELECT id FROM knowledge WHERE id = '${knowledgeId}'`),
			).resolves.toHaveLength(1);
		} finally {
			if (workItemCreated) {
				await adapter.delete(id, principalId).catch(() => undefined);
			}
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
