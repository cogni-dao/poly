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

import { DoltgresPolyWorkItemAdapter } from "@/adapters/server/db/doltgres/work-items-adapter";

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
		const dbUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/${DB_NAME}`;
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
		sql = postgres(dbUrl, { max: 2, fetch_types: false });
	}, 180_000);

	afterAll(async () => {
		if (sql) await sql.end({ timeout: 5 });
		if (container) await container.stop();
	});

	it("creates, lists, patches, coordinates, and deletes through Dolt branches", async () => {
		const adapter = new DoltgresPolyWorkItemAdapter(sql, undefined, {
			lockWaitMs: 5_000,
			queryTimeoutMs: 20_000,
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
	});

	it("cancels and drains a blocked query before reusing the session", async () => {
		const holder = await sql.reserve();
		const waiter = await sql.reserve();
		try {
			await holder.unsafe("SELECT pg_advisory_lock(9501001)");
			const pending = waiter.unsafe("SELECT pg_advisory_lock(9501001)");
			const timer = setTimeout(() => pending.cancel(), 100);
			try {
				await expect(pending).rejects.toBeDefined();
			} finally {
				clearTimeout(timer);
			}
			await expect(waiter.unsafe("SELECT 1 AS ready")).resolves.toMatchObject([
				{ ready: 1 },
			]);
		} finally {
			await holder
				.unsafe("SELECT pg_advisory_unlock(9501001)")
				.catch(() => undefined);
			holder.release();
			waiter.release();
		}
	});
});
