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
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const LOADER = path.join(REPO_ROOT, "scripts/agent/session-cognition.sh");
const INSTALLER = path.join(
	REPO_ROOT,
	"scripts/agent/install-codex-cognition-hook.sh",
);
const CONDUCTOR_SETUP = path.join(
	REPO_ROOT,
	"scripts/conductor-worktree-setup.sh",
);
const MAX_BYTES = 16 * 1024;
const CACHE_PATH = ".cogni/.cognition-cache.md";
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
	it("never ships or trusts a git-tracked cognition snapshot", () => {
		const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
		expect(gitignore).toContain(CACHE_PATH);
		const tracked = execFileSync("git", ["ls-files", "--", CACHE_PATH], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}).trim();
		if (tracked) {
			const pendingDeletion = execFileSync(
				"git",
				["diff", "--name-only", "--diff-filter=D", "--", CACHE_PATH],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			).trim();
			expect(pendingDeletion).toBe(CACHE_PATH);
		}

		const root = fixture();
		const cache = path.join(root, CACHE_PATH);
		mkdirSync(path.dirname(cache), { recursive: true });
		writeFileSync(cache, "stale committed cognition\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["add", CACHE_PATH], { cwd: root });

		const bin = path.join(root, "bin");
		const curl = path.join(bin, "curl");
		mkdirSync(bin);
		writeFileSync(
			curl,
			"#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"live cognition\"}'\n",
		);
		chmodSync(curl, 0o755);

		const output = execFileSync("bash", [LOADER], {
			cwd: root,
			env: {
				...process.env,
				CODEX_HOME: path.join(root, "no-user-hook"),
				CODEX_THREAD_ID: "",
				COGNI_NODE_API_KEY: "test-key",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
			},
			encoding: "utf8",
		});

		expect(output).toBe("live cognition\n");
		expect(readFileSync(cache, "utf8")).toBe("live cognition\n");
	});

	it("opts out of Codex spilling only behind the strict loader cap", () => {
		const config = readFileSync(
			path.join(REPO_ROOT, ".codex/config.toml"),
			"utf8",
		);
		const loader = readFileSync(LOADER, "utf8");

		expect(config).toContain("additionalContextLimit = 0");
		expect(config).toContain("git rev-parse --show-toplevel");
		expect(loader).toContain(`SESSION_COGNITION_MAX_BYTES=${MAX_BYTES}`);
	});

	it("installs the stable user presenter during local Conductor setup", () => {
		const setup = readFileSync(CONDUCTOR_SETUP, "utf8");
		const guardedInstall = [
			`if [[ "\${CONDUCTOR_IS_LOCAL:-1}" == "1" ]]; then`,
			"  bash scripts/agent/install-codex-cognition-hook.sh",
			"fi",
		].join("\n");
		expect(setup).toContain(guardedInstall);
		expect(setup.indexOf(guardedInstall)).toBeLessThan(
			setup.indexOf("pnpm install --offline --frozen-lockfile"),
		);
	});

	it("documents the node-owned Conductor bootstrap without a monorepo auth root", () => {
		const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
		const agents = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

		expect(readme).toContain("COGNI_NODE_AUTH_ROOT");
		expect(readme).not.toContain("COGNI_TEMPLATE_ROOT");
		expect(readme).toContain("stable user-level\nCodex cognition presenter");
		expect(agents).toContain("pnpm codex:cognition:install");
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
			"complete cognition\n",
		);
		expect(
			execFileSync("bash", [LOADER], { cwd: small, env, encoding: "utf8" }),
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
			}),
		).toBe("");

		const large = path.join(root, "large");
		mkdirSync(path.join(large, ".cogni"), { recursive: true });
		writeFileSync(
			path.join(large, ".cogni/.cognition-cache.md"),
			"x".repeat(MAX_BYTES + 1),
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
			].join("\n"),
		);

		const env = { ...process.env, CODEX_HOME: codexHome };
		execFileSync("bash", [INSTALLER], { env });
		execFileSync("bash", [INSTALLER], { env });
		const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
		const installedHook = readFileSync(hookPath, "utf8");

		expect(config.match(/cogni-session-cognition\.sh/g)).toHaveLength(1);
		expect(config).toContain('command = "echo keep-me"');
		expect(config).toContain('matcher = "startup|resume|clear|compact"');
		expect(config).toContain("additionalContextLimit = 0");
		expect(installedHook).toContain("cache_is_repo_tracked");
		expect(installedHook).toContain(
			'if [[ -s "$CACHE_FILE" ]] && ! cache_is_repo_tracked; then',
		);
		execFileSync("bash", ["-n", hookPath]);

		const repo = fixture();
		const cache = path.join(repo, CACHE_PATH);
		mkdirSync(path.dirname(cache), { recursive: true });
		writeFileSync(
			path.join(repo, ".cogni/repo-spec.yaml"),
			"intent:\n  name: node-template\n",
		);
		writeFileSync(cache, "stale committed cognition\n");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["add", CACHE_PATH], { cwd: repo });

		const bin = path.join(repo, "bin");
		const curl = path.join(bin, "curl");
		mkdirSync(bin);
		writeFileSync(
			curl,
			"#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"live cognition\"}'\n",
		);
		chmodSync(curl, 0o755);

		const output = execFileSync("bash", [hookPath], {
			cwd: repo,
			env: {
				...process.env,
				CODEX_HOME: codexHome,
				CODEX_THREAD_ID: "",
				COGNI_NODE_API_KEY: "test-key",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
			},
			encoding: "utf8",
		});
		expect(output).toBe("live cognition\n");
		expect(readFileSync(cache, "utf8")).toBe("live cognition\n");
	});
});
