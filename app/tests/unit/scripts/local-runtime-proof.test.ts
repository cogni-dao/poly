// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Purpose: Pin the local runtime's five-field, generated-secret, workspace
 * isolation, and geographic safety contracts without starting Docker or Next.
 * Scope: `prepare` CLI behavior and pure readiness classification only.
 * Invariants: generated values persist at 0600 and never print; each Conductor
 * workspace receives distinct project/database names and adjacent local ports.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { HUMAN_PASTE_FIELDS } from "../../../../scripts/local-live-proof/proof-contract";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const runtimeScript = path.join(repoRoot, "scripts/local-runtime.mjs");
const inputTemplate = path.join(repoRoot, ".env.local.example");
const tempRoots: string[] = [];

const humanValues: Record<string, string> = {
	POLYGON_RPC_URL: "https://polygon.example/rpc-private-value",
	POLYGON_RPC_WSS_URL: "wss://polygon.example/ws-private-value",
	PRIVY_USER_WALLETS_APP_ID: "privy-app-private-value",
	PRIVY_USER_WALLETS_APP_SECRET: "privy-secret-private-value",
	PRIVY_USER_WALLETS_SIGNING_KEY: "privy-signing-private-value",
};

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "poly-local-runtime-proof-"));
	tempRoots.push(root);
	return root;
}

async function runPrepare(options: {
	root: string;
	workspaceId: string;
	port: number;
}): Promise<{ stdout: string; stderr: string; generatedPath: string }> {
	const envPath = path.join(options.root, ".env.local");
	const statePath = path.join(options.root, "state");
	await writeFile(
		envPath,
		`${HUMAN_PASTE_FIELDS.map((name) => `${name}=${humanValues[name]}`).join("\n")}\n`,
		{ mode: 0o600 },
	);
	const result = await execFileAsync(
		process.execPath,
		[runtimeScript, "prepare"],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				LOCAL_RUNTIME_ENV_FILE: envPath,
				LOCAL_RUNTIME_STATE_DIR: statePath,
				CONDUCTOR_WORKSPACE_ID: options.workspaceId,
				CONDUCTOR_PORT: String(options.port),
			},
		},
	);
	return {
		...result,
		generatedPath: path.join(statePath, "generated.env"),
	};
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("local runtime proof contract", () => {
	it("publishes exactly the five human paste fields", async () => {
		const template = parseEnv(await readFile(inputTemplate, "utf8"));
		expect(Object.keys(template).sort()).toEqual(
			[...HUMAN_PASTE_FIELDS].sort(),
		);
	});

	it("creates generated state once at 0600 and never prints secret values", async () => {
		const root = await tempRoot();
		const first = await runPrepare({
			root,
			workspaceId: "workspace-a",
			port: 4300,
		});
		const firstState = await readFile(first.generatedPath, "utf8");
		const generatedValues = Object.values(parseEnv(firstState));
		expect((await stat(first.generatedPath)).mode & 0o777).toBe(0o600);
		expect(first.stdout).toContain("LOCAL_RUNTIME_SECRETS status=generated");

		const second = await runPrepare({
			root,
			workspaceId: "workspace-a",
			port: 4300,
		});
		expect(second.stdout).toContain("LOCAL_RUNTIME_SECRETS status=reused");
		expect(await readFile(second.generatedPath, "utf8")).toBe(firstState);

		const output = `${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`;
		for (const value of [...Object.values(humanValues), ...generatedValues]) {
			expect(output).not.toContain(value);
		}
	});

	it("derives distinct project/database namespaces and adjacent ports per workspace", async () => {
		const first = await runPrepare({
			root: await tempRoot(),
			workspaceId: "workspace-a",
			port: 4300,
		});
		const second = await runPrepare({
			root: await tempRoot(),
			workspaceId: "workspace-b",
			port: 4400,
		});
		const pattern =
			/LOCAL_RUNTIME_SCOPE id=(\w+) project=(\S+) database=(\S+) appPort=(\d+) dbPort=(\d+)/;
		const firstScope = pattern.exec(first.stdout);
		const secondScope = pattern.exec(second.stdout);
		expect(firstScope).not.toBeNull();
		expect(secondScope).not.toBeNull();
		expect(firstScope?.slice(1, 4)).not.toEqual(secondScope?.slice(1, 4));
		expect(firstScope?.slice(4)).toEqual(["4300", "4301"]);
		expect(secondScope?.slice(4)).toEqual(["4400", "4401"]);
		expect(firstScope?.[2]).toBe(`poly-local-${firstScope?.[1]}`);
		expect(firstScope?.[3]).toBe(`cogni_poly_${firstScope?.[1]}`);
	});

	it("keeps app readiness alive while reporting exact geoblock as safety-blocked", async () => {
		const { readinessVerdict } = (await import(
			"../../../../scripts/local-runtime.mjs"
		)) as {
			readinessVerdict: (
				result: {
					ok: boolean;
					status: number;
					body: string;
				},
				signals?: { egressGeoBlocked?: boolean },
			) => {
				readiness: string;
				liveTrading: string;
			};
		};
		expect(
			readinessVerdict({
				ok: false,
				status: 503,
				body: JSON.stringify({ reason: "EGRESS_GEOBLOCKED" }),
			}),
		).toEqual({ readiness: "safety_blocked", liveTrading: "geo_blocked" });
		expect(
			readinessVerdict(
				{ ok: true, status: 200, body: JSON.stringify({ status: "ready" }) },
				{ egressGeoBlocked: true },
			),
		).toEqual({ readiness: "safety_blocked", liveTrading: "geo_blocked" });
		expect(() =>
			readinessVerdict({
				ok: false,
				status: 503,
				body: JSON.stringify({ reason: "DATABASE_UNAVAILABLE" }),
			}),
		).toThrow("App /readyz failed");
	});
});
