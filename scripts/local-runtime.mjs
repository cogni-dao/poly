#!/usr/bin/env node

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: scripts/local-runtime.mjs
 * Purpose: Start one Conductor-isolated Poly app + Postgres live-development runtime.
 * Scope: Local developer orchestration only. It does not seed users, fund wallets,
 *   place orders, or change algorithm behavior.
 * Invariants:
 *   - HUMAN_INPUT_IS_FIVE_FIELDS: only the five root .env.local vendor fields are read.
 *   - GENERATED_SECRETS_PERSIST: generated secrets are create-once, chmod 0600,
 *     and live under gitignored .context so AEAD-encrypted CLOB credentials survive restarts.
 *   - LOOPBACK_ONLY: Postgres is published only on 127.0.0.1 and both runtime DSNs
 *     are constructed here; caller-supplied database URLs are never accepted.
 *   - NO_SECRET_OUTPUT: logs contain names, paths, ports, and health states only.
 * Side-effects: creates a local secret file, starts/reuses a Docker Compose Postgres,
 *   runs migrations, and starts a Next.js development process.
 * Links: task.1791070986, https://conductor.build/docs/reference/scripts
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const COMPOSE_FILE = resolve(
	REPO_ROOT,
	"infra/compose/local/docker-compose.yml",
);
const INPUT_FILE = resolve(
	process.env.LOCAL_RUNTIME_ENV_FILE ?? resolve(REPO_ROOT, ".env.local"),
);
const INPUT_TEMPLATE = resolve(REPO_ROOT, ".env.local.example");
const STATE_DIR = resolve(
	process.env.LOCAL_RUNTIME_STATE_DIR ??
		resolve(REPO_ROOT, ".context/local-runtime"),
);
const GENERATED_FILE = resolve(STATE_DIR, "generated.env");
const APP_LOG_FILE = resolve(STATE_DIR, "app.log");
const PUBLIC_BASE_RPC_URL = "https://mainnet.base.org";

const HUMAN_FIELDS = [
	"POLYGON_RPC_URL",
	"POLYGON_RPC_WSS_URL",
	"PRIVY_USER_WALLETS_APP_ID",
	"PRIVY_USER_WALLETS_APP_SECRET",
	"PRIVY_USER_WALLETS_SIGNING_KEY",
];
const REQUIRED_HUMAN_FIELDS = HUMAN_FIELDS.filter(
	(key) => key !== "POLYGON_RPC_WSS_URL",
);
const GENERATED_FIELDS = [
	"LOCAL_POSTGRES_ROOT_PASSWORD",
	"LOCAL_APP_DB_PASSWORD",
	"LOCAL_SERVICE_DB_PASSWORD",
	"LOCAL_AUTH_SECRET",
	"LOCAL_LITELLM_MASTER_KEY",
	"LOCAL_SCHEDULER_API_TOKEN",
	"LOCAL_BILLING_INGEST_TOKEN",
	"LOCAL_METRICS_TOKEN",
	"LOCAL_POLY_WALLET_AEAD_KEY_HEX",
	"LOCAL_CONNECTIONS_ENCRYPTION_KEY_HEX",
];

function fail(message) {
	throw new Error(message);
}

function shortHash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function workspaceIdentity() {
	const raw =
		process.env.CONDUCTOR_WORKSPACE_ID?.trim() ||
		process.env.CONDUCTOR_WORKSPACE_PATH?.trim() ||
		REPO_ROOT;
	return shortHash(raw);
}

function allocatedPorts() {
	const raw = process.env.CONDUCTOR_PORT?.trim();
	const appPort = raw ? Number(raw) : 3200;
	if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65533) {
		fail("CONDUCTOR_PORT must be an integer from 1024 through 65533");
	}
	return { appPort, dbPort: appPort + 1 };
}

function parseFile(path) {
	try {
		return parseEnv(readFileSync(path, "utf8"));
	} catch (error) {
		fail(
			`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function ensureInputFile() {
	if (!existsSync(INPUT_FILE)) {
		mkdirSync(dirname(INPUT_FILE), { recursive: true });
		copyFileSync(INPUT_TEMPLATE, INPUT_FILE);
		chmodSync(INPUT_FILE, 0o600);
		fail(
			`Created ${INPUT_FILE}. Paste the five vendor values there, then rerun pnpm dev:local.`,
		);
	}
}

function assertUrl(name, value, protocols) {
	try {
		const url = new URL(value);
		if (!protocols.includes(url.protocol)) {
			fail(`${name} must use ${protocols.join(" or ")}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`${name} must`)) {
			throw error;
		}
		fail(`${name} must be a valid URL`);
	}
}

function loadHumanInput() {
	ensureInputFile();
	const parsed = parseFile(INPUT_FILE);
	const input = Object.fromEntries(
		HUMAN_FIELDS.map((key) => [key, parsed[key]?.trim() ?? ""]),
	);
	const missing = REQUIRED_HUMAN_FIELDS.filter((key) => !input[key]);
	if (missing.length > 0) {
		fail(`Missing required values in ${INPUT_FILE}: ${missing.join(", ")}`);
	}
	assertUrl("POLYGON_RPC_URL", input.POLYGON_RPC_URL, ["http:", "https:"]);
	if (input.POLYGON_RPC_WSS_URL) {
		assertUrl("POLYGON_RPC_WSS_URL", input.POLYGON_RPC_WSS_URL, [
			"ws:",
			"wss:",
		]);
	}
	return input;
}

function generatedValues() {
	return {
		LOCAL_POSTGRES_ROOT_PASSWORD: randomBytes(32).toString("hex"),
		LOCAL_APP_DB_PASSWORD: randomBytes(32).toString("hex"),
		LOCAL_SERVICE_DB_PASSWORD: randomBytes(32).toString("hex"),
		LOCAL_AUTH_SECRET: randomBytes(48).toString("base64url"),
		LOCAL_LITELLM_MASTER_KEY: randomBytes(32).toString("hex"),
		LOCAL_SCHEDULER_API_TOKEN: randomBytes(32).toString("hex"),
		LOCAL_BILLING_INGEST_TOKEN: randomBytes(32).toString("hex"),
		LOCAL_METRICS_TOKEN: randomBytes(32).toString("hex"),
		LOCAL_POLY_WALLET_AEAD_KEY_HEX: randomBytes(32).toString("hex"),
		LOCAL_CONNECTIONS_ENCRYPTION_KEY_HEX: randomBytes(32).toString("hex"),
	};
}

function ensureGeneratedSecrets() {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	if (existsSync(GENERATED_FILE)) {
		chmodSync(GENERATED_FILE, 0o600);
		const parsed = parseFile(GENERATED_FILE);
		const missing = GENERATED_FIELDS.filter((key) => !parsed[key]?.trim());
		if (missing.length > 0) {
			fail(
				`Generated state is incomplete (${missing.join(", ")}); move ${GENERATED_FILE} aside and rerun.`,
			);
		}
		return { values: parsed, disposition: "reused" };
	}

	const values = generatedValues();
	const body = [
		"# Generated once by scripts/local-runtime.mjs. Do not commit or share.",
		...GENERATED_FIELDS.map((key) => `${key}=${values[key]}`),
		"",
	].join("\n");
	const fd = openSync(GENERATED_FILE, "wx", 0o600);
	try {
		writeFileSync(fd, body, { encoding: "utf8" });
	} finally {
		closeSync(fd);
	}
	chmodSync(GENERATED_FILE, 0o600);
	return { values, disposition: "generated" };
}

function runtimeContext(human, generated) {
	const id = workspaceIdentity();
	const { appPort, dbPort } = allocatedPorts();
	const nodeName = `poly_${id}`;
	const dbName = `cogni_${nodeName}`;
	const appUser = `app_${nodeName}`;
	const serviceUser = `service_${nodeName}`;
	const litellmDb = `litellm_${nodeName}`;
	const project = `poly-local-${id}`;
	const host = "127.0.0.1";

	const databaseUrl = new URL(`postgresql://${host}:${dbPort}/${dbName}`);
	databaseUrl.username = appUser;
	databaseUrl.password = generated.LOCAL_APP_DB_PASSWORD;
	const serviceDatabaseUrl = new URL(databaseUrl);
	serviceDatabaseUrl.username = serviceUser;
	serviceDatabaseUrl.password = generated.LOCAL_SERVICE_DB_PASSWORD;

	if (
		databaseUrl.hostname !== "127.0.0.1" ||
		serviceDatabaseUrl.hostname !== "127.0.0.1"
	) {
		fail("Local runtime database URLs must remain loopback-only");
	}

	const build = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	if (build.status !== 0) fail("Cannot resolve the local git SHA");
	const buildSha = build.stdout.trim();
	const baseUrl = `http://127.0.0.1:${appPort}`;
	const polygonWssUrl =
		human.POLYGON_RPC_WSS_URL ||
		human.POLYGON_RPC_URL.replace(/^http(s?):\/\//, "ws$1://");

	const composeEnv = {
		...process.env,
		COMPOSE_PROGRESS: "plain",
		LOCAL_DB_PORT: String(dbPort),
		LOCAL_DB_NAME: dbName,
		LOCAL_LITELLM_DB_NAME: litellmDb,
		LOCAL_APP_DB_USER: appUser,
		LOCAL_SERVICE_DB_USER: serviceUser,
		LOCAL_POSTGRES_ROOT_PASSWORD: generated.LOCAL_POSTGRES_ROOT_PASSWORD,
		LOCAL_APP_DB_PASSWORD: generated.LOCAL_APP_DB_PASSWORD,
		LOCAL_SERVICE_DB_PASSWORD: generated.LOCAL_SERVICE_DB_PASSWORD,
	};

	const appEnv = {
		...process.env,
		NODE_ENV: "development",
		APP_ENV: "production",
		APP_BASE_URL: baseUrl,
		NEXTAUTH_URL: baseUrl,
		DEPLOY_ENVIRONMENT: "local",
		APP_BUILD_SHA: buildSha,
		SERVICE_NAME: `poly-local-${id}`,
		PORT: String(appPort),
		PINO_LOG_LEVEL: process.env.PINO_LOG_LEVEL || "info",
		DATABASE_URL: databaseUrl.toString(),
		DATABASE_SERVICE_URL: serviceDatabaseUrl.toString(),
		AUTH_SECRET: generated.LOCAL_AUTH_SECRET,
		LITELLM_BASE_URL: "http://127.0.0.1:4000",
		LITELLM_MASTER_KEY: generated.LOCAL_LITELLM_MASTER_KEY,
		SCHEDULER_API_TOKEN: generated.LOCAL_SCHEDULER_API_TOKEN,
		BILLING_INGEST_TOKEN: generated.LOCAL_BILLING_INGEST_TOKEN,
		METRICS_TOKEN: generated.LOCAL_METRICS_TOKEN,
		TEMPORAL_ADDRESS: `127.0.0.1:${appPort + 2}`,
		TEMPORAL_NAMESPACE: `poly-local-${id}`,
		SCHEDULER_WORKER_HEALTH_URL: `http://127.0.0.1:${appPort + 3}`,
		COGNI_REPO_PATH: REPO_ROOT,
		// Baseline Cogni settlement reads are on Base, while live Polymarket
		// execution is on Polygon. Never point the Base client at the user's
		// Polygon endpoint merely to make readiness green.
		EVM_RPC_URL: PUBLIC_BASE_RPC_URL,
		POLYGON_RPC_URL: human.POLYGON_RPC_URL,
		POLYGON_RPC_WSS_URL: polygonWssUrl,
		PRIVY_USER_WALLETS_APP_ID: human.PRIVY_USER_WALLETS_APP_ID,
		PRIVY_USER_WALLETS_APP_SECRET: human.PRIVY_USER_WALLETS_APP_SECRET,
		PRIVY_USER_WALLETS_SIGNING_KEY: human.PRIVY_USER_WALLETS_SIGNING_KEY,
		POLY_WALLET_AEAD_KEY_HEX: generated.LOCAL_POLY_WALLET_AEAD_KEY_HEX,
		POLY_WALLET_AEAD_KEY_ID: `local-${id}`,
		CONNECTIONS_ENCRYPTION_KEY: generated.LOCAL_CONNECTIONS_ENCRYPTION_KEY_HEX,
		PAPER_ENFORCE_MODE: "live",
		GOVERNANCE_SCHEDULES_ENABLED: "false",
		JOB_LEADER_ELECTION_ENABLED: "false",
		POLY_PRICE_HISTORY_WRITER_ENABLED: "false",
		POLY_TRADER_OBSERVATION_WRITER_ENABLED: "false",
		POLY_TOP_WALLET_STATS_WRITER_ENABLED: "false",
		POLY_RESEARCH_PREWARM_ENABLED: "false",
		POLY_FILL_ROLLUP_BACKFILL_ENABLED: "false",
	};

	return {
		id,
		project,
		appPort,
		dbPort,
		dbName,
		appUser,
		serviceUser,
		buildSha,
		baseUrl,
		databaseUrl: databaseUrl.toString(),
		composeEnv,
		appEnv,
	};
}

function composeArgs(runtime, args) {
	return ["compose", "-p", runtime.project, "-f", COMPOSE_FILE, ...args];
}

function runChecked(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		fail(`${command} failed with exit ${String(result.status)}`);
	}
}

function ensureDocker() {
	const docker = spawnSync("docker", ["compose", "version"], {
		cwd: REPO_ROOT,
		stdio: "ignore",
	});
	if (docker.status !== 0) {
		fail("Docker Desktop with Docker Compose is required for pnpm dev:local");
	}
}

function ensureWorkspaceReady() {
	const nextBin = resolve(REPO_ROOT, "app/node_modules/.bin/next");
	const contractsBuild = resolve(
		REPO_ROOT,
		"packages/node-contracts/dist/index.js",
	);
	if (existsSync(nextBin) && existsSync(contractsBuild)) return;

	console.log(
		"LOCAL_RUNTIME_SETUP dependencies or package builds missing; bootstrapping workspace",
	);
	let install = spawnSync(
		"pnpm",
		["install", "--offline", "--frozen-lockfile"],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
	if (install.status !== 0) {
		install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
			cwd: REPO_ROOT,
			stdio: "inherit",
		});
	}
	if (install.error) throw install.error;
	if (install.status !== 0) {
		fail(`pnpm install failed with exit ${String(install.status)}`);
	}
	runChecked("pnpm", ["build:packages"]);
}

function startDatabase(runtime) {
	ensureDocker();
	console.log(
		`LOCAL_RUNTIME_DB starting project=${runtime.project} host=127.0.0.1 port=${runtime.dbPort}`,
	);
	runChecked(
		"docker",
		composeArgs(runtime, ["up", "-d", "--wait", "postgres"]),
		{ env: runtime.composeEnv },
	);
	runChecked(
		"docker",
		composeArgs(runtime, [
			"exec",
			"-T",
			"postgres",
			"bash",
			"/opt/cogni/provision.sh",
		]),
		{ env: runtime.composeEnv },
	);
	console.log(`LOCAL_RUNTIME_DB migrating database=${runtime.dbName}`);
	runChecked("pnpm", ["db:migrate:direct"], {
		env: { ...runtime.appEnv, DATABASE_URL: runtime.databaseUrl },
	});
}

function assertDatabaseHealth(runtime) {
	const sql =
		"select current_database(), current_user, to_regclass('public.users') is not null;";
	const args = composeArgs(runtime, [
		"exec",
		"-T",
		"postgres",
		"bash",
		"-ec",
		'PGPASSWORD="$LOCAL_APP_DB_PASSWORD" psql -h 127.0.0.1 -U "$LOCAL_APP_DB_USER" -d "$LOCAL_DB_NAME" -v ON_ERROR_STOP=1 -Atc "$1"',
		"local-db-health",
		sql,
	]);
	const result = spawnSync("docker", args, {
		cwd: REPO_ROOT,
		env: runtime.composeEnv,
		encoding: "utf8",
	});
	const expected = `${runtime.dbName}|${runtime.appUser}|t`;
	if (result.status !== 0 || result.stdout.trim() !== expected) {
		process.stderr.write(result.stderr || "");
		fail("Local Postgres app-role health query failed");
	}
	console.log(
		`LOCAL_RUNTIME_HEALTH db=healthy database=${runtime.dbName} role=${runtime.appUser} host=127.0.0.1 port=${runtime.dbPort}`,
	);
}

async function fetchHealth(url) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		const body = await response.text();
		return { ok: response.ok, status: response.status, body };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			body: error instanceof Error ? error.message : String(error),
		};
	}
}

export function readinessVerdict(result, signals = {}) {
	// Next dev compiles instrumentation and route handlers into separate module
	// graphs, so the route can temporarily miss the instrumentation latch even
	// after the same process emitted the exact fatal reason. The current-process
	// structured event is equivalent evidence and must keep trading disabled.
	if (signals.egressGeoBlocked === true) {
		return { readiness: "safety_blocked", liveTrading: "geo_blocked" };
	}
	if (result.ok) return { readiness: "healthy", liveTrading: "enabled" };
	try {
		const parsed = JSON.parse(result.body);
		if (result.status === 503 && parsed.reason === "EGRESS_GEOBLOCKED") {
			return { readiness: "safety_blocked", liveTrading: "geo_blocked" };
		}
		const reason = parsed.reason ? ` reason=${String(parsed.reason)}` : "";
		fail(`App /readyz failed (HTTP ${result.status}${reason})`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("App /readyz")) {
			throw error;
		}
		fail(`App /readyz failed (HTTP ${result.status})`);
	}
}

function currentAppLogSignals() {
	if (!existsSync(APP_LOG_FILE)) return { egressGeoBlocked: false };
	const log = readFileSync(APP_LOG_FILE, "utf8");
	const latestStart = log.lastIndexOf('"msg":"app started"');
	if (latestStart < 0) return { egressGeoBlocked: false };
	return {
		egressGeoBlocked: log
			.slice(latestStart)
			.includes('"reason":"EGRESS_GEOBLOCKED"'),
	};
}

async function waitForHttp(runtime, child, signals = {}) {
	const deadline = Date.now() + 120_000;
	let last = { ok: false, status: 0, body: "not attempted" };
	while (Date.now() < deadline) {
		if (child && child.exitCode !== null) {
			fail(`Poly app exited before health checks (exit ${child.exitCode})`);
		}
		last = await fetchHealth(`${runtime.baseUrl}/livez`);
		if (last.ok) break;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
	}
	if (!last.ok) {
		fail(`App /livez did not become healthy (last HTTP ${last.status})`);
	}
	console.log(
		`LOCAL_RUNTIME_HEALTH livez=healthy url=${runtime.baseUrl}/livez`,
	);

	const ready = await fetchHealth(`${runtime.baseUrl}/readyz`);
	let verdict = readinessVerdict(ready, signals);

	// A blocked egress path needs three boot probes spaced five seconds apart
	// before the app's sticky readiness latch closes. Re-check after that window
	// so a transient early 200 cannot green-light a geographically blocked trader.
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 12_000));
	const stableReady = await fetchHealth(`${runtime.baseUrl}/readyz`);
	const stableSignals = currentAppLogSignals();
	verdict = readinessVerdict(stableReady, {
		egressGeoBlocked:
			signals.egressGeoBlocked === true || stableSignals.egressGeoBlocked,
	});
	if (verdict.liveTrading === "geo_blocked") {
		console.log(
			`LOCAL_RUNTIME_HEALTH readyz=safety_blocked live_trading=geo_blocked url=${runtime.baseUrl}/readyz sha=${runtime.buildSha}`,
		);
		return verdict;
	}
	console.log(
		`LOCAL_RUNTIME_HEALTH readyz=healthy live_trading=enabled url=${runtime.baseUrl}/readyz sha=${runtime.buildSha}`,
	);
	return verdict;
}

async function startApp(runtime) {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const logFd = openSync(APP_LOG_FILE, "a", 0o600);
	chmodSync(APP_LOG_FILE, 0o600);
	const logStream = createWriteStream(APP_LOG_FILE, {
		fd: logFd,
		autoClose: true,
	});
	console.log(
		`LOCAL_RUNTIME_APP starting url=${runtime.baseUrl} sha=${runtime.buildSha} log=${APP_LOG_FILE}`,
	);
	const child = spawn(
		"pnpm",
		[
			"--filter",
			"@cogni/node-template-app",
			"exec",
			"next",
			"dev",
			"-p",
			String(runtime.appPort),
		],
		{
			cwd: REPO_ROOT,
			env: runtime.appEnv,
			stdio: ["inherit", "pipe", "pipe"],
		},
	);
	const signals = { egressGeoBlocked: false };
	const watchSignals = (chunk) => {
		if (chunk.toString().includes('"reason":"EGRESS_GEOBLOCKED"')) {
			signals.egressGeoBlocked = true;
		}
	};
	child.stdout.on("data", watchSignals);
	child.stderr.on("data", watchSignals);
	child.stdout.pipe(process.stdout, { end: false });
	child.stdout.pipe(logStream, { end: false });
	child.stderr.pipe(process.stderr, { end: false });
	child.stderr.pipe(logStream, { end: false });

	let stopping = false;
	const stop = (signal) => {
		if (stopping) return;
		stopping = true;
		child.kill(signal);
	};
	process.once("SIGINT", () => stop("SIGINT"));
	process.once("SIGTERM", () => stop("SIGTERM"));

	try {
		const health = await waitForHttp(runtime, child, signals);
		console.log(
			`LOCAL_RUNTIME_READY app=healthy db=healthy live_trading=${health.liveTrading} url=${runtime.baseUrl} state=${GENERATED_FILE} log=${APP_LOG_FILE}`,
		);
	} catch (error) {
		stop("SIGTERM");
		throw error;
	}

	const code = await new Promise((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("exit", (exitCode, signal) => {
			if (signal && stopping) resolvePromise(0);
			else resolvePromise(exitCode ?? 1);
		});
	});
	logStream.end();
	if (code !== 0) fail(`Poly app exited with code ${code}`);
}

function loadContext() {
	const human = loadHumanInput();
	const generated = ensureGeneratedSecrets();
	const runtime = runtimeContext(human, generated.values);
	console.log(
		`LOCAL_RUNTIME_SECRETS status=${generated.disposition} path=${GENERATED_FILE} mode=0600`,
	);
	console.log(
		`LOCAL_RUNTIME_SCOPE id=${runtime.id} project=${runtime.project} database=${runtime.dbName} appPort=${runtime.appPort} dbPort=${runtime.dbPort}`,
	);
	return runtime;
}

function loadDownContext() {
	const id = workspaceIdentity();
	const { appPort, dbPort } = allocatedPorts();
	const nodeName = `poly_${id}`;
	return {
		id,
		project: `poly-local-${id}`,
		appPort,
		dbPort,
		composeEnv: {
			...process.env,
			COMPOSE_PROGRESS: "plain",
			LOCAL_DB_PORT: String(dbPort),
			LOCAL_DB_NAME: `cogni_${nodeName}`,
			LOCAL_LITELLM_DB_NAME: `litellm_${nodeName}`,
			LOCAL_APP_DB_USER: `app_${nodeName}`,
			LOCAL_SERVICE_DB_USER: `service_${nodeName}`,
			// Compose validates required interpolation even for `down`; these
			// placeholders are never persisted or sent to a running container.
			LOCAL_POSTGRES_ROOT_PASSWORD: "unused-for-down",
			LOCAL_APP_DB_PASSWORD: "unused-for-down",
			LOCAL_SERVICE_DB_PASSWORD: "unused-for-down",
		},
	};
}

async function main() {
	const command = process.argv[2] ?? "start";
	if (!["start", "prepare", "health", "down"].includes(command)) {
		fail("Usage: node scripts/local-runtime.mjs [start|prepare|health|down]");
	}
	if (command === "down") {
		const runtime = loadDownContext();
		ensureDocker();
		runChecked("docker", composeArgs(runtime, ["down"]), {
			env: runtime.composeEnv,
		});
		console.log(
			`LOCAL_RUNTIME_DB stopped project=${runtime.project}; persistent volume retained`,
		);
		return;
	}

	const runtime = loadContext();
	if (command === "prepare") return;
	if (command === "health") {
		ensureDocker();
		assertDatabaseHealth(runtime);
		await waitForHttp(runtime, null);
		return;
	}
	ensureWorkspaceReady();
	startDatabase(runtime);
	assertDatabaseHealth(runtime);
	await startApp(runtime);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(
			`LOCAL_RUNTIME_ERROR ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
