// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: scripts/local-runtime.test.mjs
 * Purpose: Pin resource ceilings for the Conductor-isolated local runtime.
 * Scope: Pure configuration assertions; never starts Docker or reads secrets.
 * Invariants: A workspace gets one bounded Postgres and five app DB connections.
 * Side-effects: Reads the committed local Compose file.
 * Links: task.1791070986
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import { LOCAL_DB_POOL_LIMITS, localDbPoolEnv } from "./local-runtime.mjs";

const compose = parse(
	readFileSync(
		new URL("../infra/compose/local/docker-compose.yml", import.meta.url),
		"utf8",
	),
);
const postgres = compose.services.postgres;

test("local Postgres has explicit Mac-safe resource ceilings", () => {
	assert.equal(postgres.cpus, 0.5);
	assert.equal(postgres.mem_limit, "384m");
	assert.equal(postgres.mem_reservation, "128m");
	assert.equal(postgres.shm_size, "64mb");
	assert.deepEqual(postgres.command, [
		"postgres",
		"-c",
		"max_connections=32",
		"-c",
		"shared_buffers=64MB",
		"-c",
		"work_mem=2MB",
		"-c",
		"maintenance_work_mem=32MB",
	]);
});

test("local application pools fit comfortably below Postgres capacity", () => {
	assert.deepEqual(LOCAL_DB_POOL_LIMITS, {
		app: "2",
		service: "2",
		read: "1",
	});
	assert.deepEqual(localDbPoolEnv(), {
		DB_POOL_MAX: "2",
		DB_SERVICE_POOL_MAX: "2",
		DB_READ_POOL_MAX: "1",
	});
	const total = Object.values(LOCAL_DB_POOL_LIMITS).reduce(
		(sum, value) => sum + Number(value),
		0,
	);
	assert.equal(total, 5);
	assert.ok(total <= 32 / 4);
});
