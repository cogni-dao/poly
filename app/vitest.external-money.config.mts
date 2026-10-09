// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.external-money.config.mts`
 * Purpose: Vitest configuration for explicitly opted-in external money tests.
 * Scope: Tests in tests/external/money/ — require a running local stack and
 *   human-owned authenticated state. NOT part of CI.
 * Invariants: CI is refused before test discovery; each test has its own exact
 *   confirmation gate; no provider is constructed before the skip gate.
 * Side-effects: process.env injection; opted-in tests can spend real funds.
 * Links: tests/external/AGENTS.md, vitest.external.config.mts (similar pattern)
 * @public
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Flat node layout: app/ is one directory below the repository root.
// Load local real-provider values first, then test defaults without override.
const local = config({ path: path.resolve(__dirname, "../.env.local") });
expand(local);
const test = config({ path: path.resolve(__dirname, "../.env.test") });
expand(test);

if (/^(1|true|yes|on)$/i.test(process.env.CI ?? "")) {
	throw new Error("[external:money] refused: real-money tests never run in CI");
}

export default defineConfig({
	root: __dirname,
	plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
	test: {
		include: ["tests/external/money/*.external.money.test.ts"],
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
		// No globalSetup — expects the local app + Postgres runtime already running.
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
				execArgv: ["--dns-result-order=ipv4first"],
			},
		},
		sequence: { concurrent: false },
		testTimeout: 60_000,
		hookTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@tests": path.resolve(__dirname, "./tests"),
		},
	},
});
