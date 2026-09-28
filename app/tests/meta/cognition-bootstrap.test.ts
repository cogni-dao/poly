// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/cognition-bootstrap`
 * Purpose: Guard the bounded, single-presenter SessionStart contract.
 * Scope: Repo config plus hermetic loader/legacy-installer subprocesses.
 * Invariants: NO_CODEX_SPILL, STRICT_OUTPUT_CAP, INSTALLER_RECONCILES.
 * Side-effects: Temporary files under the OS temp directory only.
 * Links: .codex/config.toml, scripts/agent/session-cognition.sh
 * @public
 */

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const LOADER = path.join(REPO_ROOT, "scripts/agent/session-cognition.sh");
const INSTALLER = path.join(
	REPO_ROOT,
	"scripts/agent/install-codex-cognition-hook.sh"
);
const MAX_BYTES = 16 * 1024;
const fixtures: string[] = [];

function fixture(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "cogni-bootstrap-"));
	fixtures.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("session cognition hook", () => {
	it("opts out of Codex spilling only behind the strict loader cap", () => {
		const config = readFileSync(
			path.join(REPO_ROOT, ".codex/config.toml"),
			"utf8"
		);
		const loader = readFileSync(LOADER, "utf8");

		expect(config).toContain("additionalContextLimit = 0");
		expect(config).toContain("git rev-parse --show-toplevel");
		expect(loader).toContain(`SESSION_COGNITION_MAX_BYTES=${MAX_BYTES}`);
	});

	it("presents a bounded cache verbatim and rejects an oversized cache whole", () => {
		const root = fixture();
		const noUserHook = path.join(root, "no-user-hook");
		const env = {
			...process.env,
			CODEX_HOME: noUserHook,
			CODEX_THREAD_ID: "",
		};

		const small = path.join(root, "small");
		mkdirSync(path.join(small, ".cogni"), { recursive: true });
		writeFileSync(
			path.join(small, ".cogni/.cognition-cache.md"),
			"complete cognition\n"
		);
		expect(
			execFileSync("bash", [LOADER], { cwd: small, env, encoding: "utf8" })
		).toBe("complete cognition\n");

		mkdirSync(path.join(root, "cogni-cognition-lock-test.lock"));
		expect(
			execFileSync("bash", [LOADER], {
				cwd: small,
				env: {
					...env,
					CODEX_THREAD_ID: "lock-test",
					TMPDIR: root,
				},
				encoding: "utf8",
			})
		).toBe("");

		const large = path.join(root, "large");
		mkdirSync(path.join(large, ".cogni"), { recursive: true });
		writeFileSync(
			path.join(large, ".cogni/.cognition-cache.md"),
			"x".repeat(MAX_BYTES + 1)
		);
		const output = execFileSync("bash", [LOADER], {
			cwd: large,
			env,
			encoding: "utf8",
		});
		expect(output).toContain("bundle rejected before injection");
		expect(Buffer.byteLength(output)).toBeLessThan(1024);
	});

	it("reconciles the legacy user hook idempotently", () => {
		const codexHome = fixture();
		const hookPath = path.join(codexHome, "hooks/cogni-session-cognition.sh");
		writeFileSync(
			path.join(codexHome, "config.toml"),
			[
				'model = "gpt-5.5"',
				"",
				"[[hooks.SessionStart]]",
				'matcher = "startup|resume"',
				"",
				"[[hooks.SessionStart.hooks]]",
				'type = "command"',
				'command = "echo keep-me"',
				"",
				"[[hooks.SessionStart.hooks]]",
				'type = "command"',
				`command = "bash ${hookPath}"`,
				'statusMessage = "Loading Cogni cognition substrate"',
			].join("\n")
		);

		const env = { ...process.env, CODEX_HOME: codexHome };
		execFileSync("bash", [INSTALLER], { env });
		execFileSync("bash", [INSTALLER], { env });
		const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");

		expect(config.match(/cogni-session-cognition\.sh/g)).toHaveLength(1);
		expect(config).toContain('command = "echo keep-me"');
		expect(config).toContain('matcher = "startup|resume|clear|compact"');
		expect(config).toContain("additionalContextLimit = 0");
		execFileSync("bash", ["-n", hookPath]);
	});
});
