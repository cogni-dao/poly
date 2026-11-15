// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/cognition-bootstrap`
 * Purpose: Guard fresh, complete session cognition on every harness (story.5070, story.0001).
 * Scope: Repo config plus hermetic loader/legacy-installer subprocesses.
 * Invariants: NATIVE_HARNESS_CHANNELS, NO_CODEX_SPILL, INSTALLER_RECONCILES.
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
// A complete bundle as the hub serves it: the contract and its status-contract.
const LIVE =
	"live cognition\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>";
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
			`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ markdown: LIVE })}'\n`,
		);
		chmodSync(curl, 0o755);

		const output = execFileSync("bash", [LOADER], {
			cwd: root,
			env: {
				...process.env,
				CODEX_HOME: path.join(root, "no-user-hook"),
				CODEX_THREAD_ID: "tracked-snapshot",
				COGNI_NODE_API_KEY: "test-key",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				TMPDIR: root,
			},
			encoding: "utf8",
		});

		// The session presents the hub's bundle, never the committed snapshot.
		expect(output).toBe(`${LIVE}\n`);
		expect(readFileSync(cache, "utf8")).toBe(`${LIVE}\n`);
	});

	it("uses one native, uncapped channel per supported harness (story.5070)", () => {
		const config = readFileSync(
			path.join(REPO_ROOT, ".codex/config.toml"),
			"utf8",
		);
		const claude = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
		const opencode = JSON.parse(
			readFileSync(path.join(REPO_ROOT, "opencode.json"), "utf8"),
		) as { instructions?: string[] };
		const loader = readFileSync(LOADER, "utf8");

		expect(config).toContain("additionalContextLimit = 0");
		expect(config).toContain("git rev-parse --show-toplevel");
		expect(claude).toContain("@AGENTS.md");
		// Claude's bundle arrives fresh through its hooks; importing the cache too
		// would duplicate it with an older copy (story.0001).
		expect(claude).not.toContain(".cognition-cache.md");
		expect(opencode.instructions).toContain(CACHE_PATH);
		// No producer-side byte ceiling survives on any channel.
		expect(loader).not.toContain("SESSION_COGNITION_MAX_BYTES");
		expect(loader).not.toContain("bundle_fits_budget");
		expect(loader).not.toContain("oversized_bundle_notice");
		expect(loader).not.toContain("CLAUDE_CONTEXT_MAX_CHARS");
		// One Claude hook per declared part, each delivering one slice.
		const parts = Number(/^CLAUDE_PARTS=(\d+)$/m.exec(loader)?.[1]);
		const claudeSettings = JSON.parse(
			readFileSync(path.join(REPO_ROOT, ".claude/settings.json"), "utf8"),
		) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
		const commands = claudeSettings.hooks.SessionStart.flatMap((entry) =>
			entry.hooks.map((hook) => hook.command),
		);
		expect(commands).toEqual(
			Array.from(
				{ length: parts },
				(_, i) =>
					`bash "$(git rev-parse --show-toplevel)/scripts/agent/session-cognition.sh" --claude-part ${i + 1}`,
			),
		);
		// OpenCode refreshes the instruction file before it is resolved.
		const plugin = readFileSync(
			path.join(REPO_ROOT, ".opencode/plugin/cogni-cognition.js"),
			"utf8",
		);
		expect(plugin).toContain("scripts/agent/session-cognition.sh --refresh");
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

	it("never copies cognition between checkouts (story.0001)", () => {
		// Each session fetches its own bundle; a copy from the clone root would hand
		// a new worktree cognition another session acquired.
		const settings = readFileSync(path.join(REPO_ROOT, ".conductor/settings.toml"), "utf8");
		expect(settings).not.toContain("file_include_globs");
		expect(settings).toContain('setup = "bash scripts/conductor-worktree-setup.sh"');
		for (const legacy of [".worktreeinclude", "conductor.json"])
			expect(() => readFileSync(path.join(REPO_ROOT, legacy))).toThrow();
		const loader = readFileSync(LOADER, "utf8");
		expect(loader).not.toContain("git-common-dir");
		expect(loader).not.toContain("settings.local.toml");
	});

	it("refresh replaces the cache only with a complete hub bundle (bug.0024)", () => {
		const root = fixture();
		const repo = path.join(root, "repo");
		mkdirSync(path.join(repo, ".cogni"), { recursive: true });
		const previous = "# old\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>";
		writeFileSync(path.join(repo, CACHE_PATH), `${previous}\n`);
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		const curl = path.join(bin, "curl");
		const env = {
			...process.env,
			CODEX_HOME: path.join(root, "no-user-hook"),
			CODEX_THREAD_ID: "",
			COGNI_NODE_API_KEY: "test-key",
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		};
		writeFileSync(curl, "#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"map only\"}'\n");
		chmodSync(curl, 0o755);
		expect(() =>
			execFileSync("bash", [LOADER, "--refresh"], { cwd: repo, env, stdio: "ignore" }),
		).toThrow();
		expect(readFileSync(path.join(repo, CACHE_PATH), "utf8")).toBe(`${previous}\n`);
		writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ markdown: LIVE })}'\n`);
		execFileSync("bash", [LOADER, "--refresh"], { cwd: repo, env, stdio: "ignore" });
		expect(readFileSync(path.join(repo, CACHE_PATH), "utf8")).toBe(`${LIVE}\n`);
	});

	it("warms the cognition cache in workspace setup before anything slow (bug.0018)", () => {
		const setup = readFileSync(CONDUCTOR_SETUP, "utf8");
		// Claude Code resolves the CLAUDE.md @import before its SessionStart hook
		// can write the cache, so setup must warm it before the first agent starts.
		const linkKey = setup.indexOf('\nlink_from_auth_root ".env.cogni"');
		const warm = setup.indexOf("\nwarm_cognition_cache\n");
		expect(linkKey).toBeGreaterThan(-1);
		expect(warm).toBeGreaterThan(linkKey);
		for (const slow of [
			"\nrefresh_workspace_base_ref\n",
			"pnpm install --offline --frozen-lockfile",
			"pnpm build:packages",
		])
			expect(warm).toBeLessThan(setup.indexOf(slow));
		expect(setup).toContain("bash scripts/agent/session-cognition.sh --refresh");
	});

	it("keeps the agent bootstrap automatic", () => {
		const agents = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

		expect(agents).not.toContain("pnpm codex:cognition:install");
		expect(agents).toContain("model-visible before normal work");
	});

	it("presents a freshly fetched bundle, else the last complete cache (story.0001)", () => {
		const root = fixture();
		const repo = path.join(root, "repo");
		mkdirSync(path.join(repo, ".cogni"), { recursive: true });
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		const curl = path.join(bin, "curl");
		const env = {
			...process.env,
			CODEX_HOME: path.join(root, "no-user-hook"),
			CODEX_THREAD_ID: "fresh-first",
			COGNI_NODE_API_KEY: "test-key",
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			TMPDIR: root,
		};
		const cached = "cached\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>";
		writeFileSync(path.join(repo, CACHE_PATH), `${cached}\n`);

		// The hub answers: the session gets its bundle and the cache follows it.
		writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ markdown: LIVE })}'\n`);
		chmodSync(curl, 0o755);
		expect(execFileSync("bash", [LOADER], { cwd: repo, env, encoding: "utf8" })).toBe(`${LIVE}\n`);
		expect(readFileSync(path.join(repo, CACHE_PATH), "utf8")).toBe(`${LIVE}\n`);

		// The hub is down or incomplete: the last complete cache is presented.
		writeFileSync(curl, "#!/bin/sh\nexit 7\n");
		expect(execFileSync("bash", [LOADER], { cwd: repo, env, encoding: "utf8" })).toBe(`${LIVE}\n`);
		writeFileSync(curl, "#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"map only\"}'\n");
		expect(execFileSync("bash", [LOADER], { cwd: repo, env, encoding: "utf8" })).toBe(`${LIVE}\n`);

		// Only Codex reads stdout; a plain call stays silent.
		expect(
			execFileSync("bash", [LOADER], { cwd: repo, env: { ...env, CODEX_THREAD_ID: "" }, encoding: "utf8" }),
		).toBe("");

		// No complete bundle anywhere: an honest notice that names the setup step.
		const keyless = path.join(root, "keyless");
		mkdirSync(keyless);
		writeFileSync(curl, "#!/bin/sh\nexit 22\n");
		expect(
			execFileSync("bash", [LOADER], { cwd: keyless, env: { ...env, COGNI_NODE_API_KEY: "" }, encoding: "utf8" }),
		).toContain("no node credentials yet");
	});

	it("delivers Claude's bundle as labelled parts that fit its context entries (story.0001)", () => {
		const root = fixture();
		const repo = path.join(root, "repo");
		mkdirSync(path.join(repo, ".cogni"), { recursive: true });
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		const curl = path.join(bin, "curl");
		// A bundle like the hub's: sections, one larger than a whole part.
		const section = (title: string, lines: number) =>
			[`## ${title}`, ...Array.from({ length: lines }, (_, i) => `${title} line ${i} ${"x".repeat(60)}`)].join("\n");
		const bundle = [
			"# node — Cogni Session Cognition",
			section("Orientation", 30),
			"## The agent-contract\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>",
			section("Knowledge domains", 200),
			section("Domains", 40),
		].join("\n\n");
		const fixtureJson = path.join(root, "bundle.json");
		writeFileSync(fixtureJson, JSON.stringify({ markdown: bundle }));
		writeFileSync(curl, `#!/bin/sh\ncat '${fixtureJson}'\n`);
		chmodSync(curl, 0o755);
		const env = {
			...process.env,
			CODEX_HOME: path.join(root, "no-user-hook"),
			CODEX_THREAD_ID: "",
			COGNI_NODE_API_KEY: "test-key",
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			TMPDIR: root,
		};
		const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "claude-1", source: "startup" });
		const part = (i: number) =>
			execFileSync("bash", [LOADER, "--claude-part", String(i)], { cwd: repo, env, input, encoding: "utf8" });

		const first = part(1);
		const outputs = [first, ...[2, 3, 4, 5, 6, 7, 8].map(part)];
		const contexts = outputs
			.filter((out) => out !== "")
			.map((out) => (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext);
		const total = contexts.length;
		expect(total).toBeGreaterThan(2);
		contexts.forEach((context, i) => {
			// Claude Code keeps an entry inline only up to about 10,000 characters.
			expect(context.length).toBeLessThan(9500);
			expect(context).toMatch(new RegExp(`^COGNI COGNITION — part ${i + 1} of ${total} `));
		});
		// Lossless: the parts, in order, are the whole bundle.
		const joined = contexts.map((context) => context.split("\n").slice(2).join("\n")).join("");
		expect(joined.replace(/\n+$/, "")).toBe(bundle);
		expect(readFileSync(path.join(repo, CACHE_PATH), "utf8")).toBe(`${bundle}\n`);

		// The hub is down and nothing is cached: part 1 carries the notice alone.
		rmSync(path.join(repo, CACHE_PATH));
		writeFileSync(curl, "#!/bin/sh\nexit 7\n");
		const downInput = JSON.stringify({ hook_event_name: "SessionStart", session_id: "claude-2", source: "startup" });
		const down = execFileSync("bash", [LOADER, "--claude-part", "1"], { cwd: repo, env, input: downInput, encoding: "utf8" });
		expect(JSON.parse(down).hookSpecificOutput.additionalContext).toContain("could not load bundle");
		expect(
			execFileSync("bash", [LOADER, "--claude-part", "2"], { cwd: repo, env, input: downInput, encoding: "utf8" }),
		).toBe("");
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
		// Fresh first: the hub's bundle before any cached one (story.0001).
		expect(installedHook.indexOf('bundle="$(fetch_bundle)"')).toBeLessThan(
			installedHook.indexOf('cat "$CACHE_FILE"'),
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
			`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ markdown: LIVE })}'\n`,
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
		expect(output).toBe(`${LIVE}\n`);
		expect(readFileSync(cache, "utf8")).toBe(`${LIVE}\n`);
	});
});
