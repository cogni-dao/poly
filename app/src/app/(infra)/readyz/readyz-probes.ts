// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/readyz/readyz-probes`
 * Purpose: Poly's consumer of `@cogni-dao/substrate-health` — the declared-dependency registry and the node
 *   closures that `/readyz?deep=1` consumes. The deep runner, failure type, reach-probe factories and
 *   drift-guard helper live in the package; this adapter wires them to this node's logger, error type, ports,
 *   env and declaration map.
 * Scope: Owns the node declaration map (`SUBSTRATE_DEPENDENCIES`, including the Polygon-RPC / paper-sidecar N/A entries), the EVM-RPC deep closure, the three node
 *   probe wrappers over the package factories, and the node-local drift-guard allowlist. Does not own the HTTP
 *   handler or the default (k8s) probe path, which stays inline in `route.ts`.
 * Invariants:
 *   - Imports are one-way: `route.ts` → this module → `@cogni/substrate-health` (never the reverse).
 *   - `?deep=1` probes exactly the dependencies this node DECLARES (`isDeclared`), each reach-only, fatal.
 *   - Deep registry order fixes first-failure `reason`/`message` and `unreachable[]`: evm-rpc, temporal,
 *     scheduler-worker, postgres, redis, litellm-gateway, doltgres.
 *   - Every substrate env key (`/_(URL|ADDRESS)$/`) is owned by a map entry or allowlisted; the drift guard
 *     fails CI otherwise.
 * Side-effects: IO (network reads to RPC/Temporal/LiteLLM/Redis, DB reads) only when a probe runs.
 * Links: src/app/(infra)/readyz/route.ts, @cogni-dao/substrate-health, deep-readyz-design
 * @public
 */

import {
  type DeepChecks,
  DeepProbeFailure,
  findUnclassifiedSubstrateKeys as pkgFindUnclassifiedSubstrateKeys,
  type ProbeDependency as PkgProbeDependency,
  probeKnowledgePlane,
  probeLiteLlmGateway,
  probeRedisStream,
  runDeepChecks as pkgRunDeepChecks,
  type SubstrateDependency as PkgSubstrateDependency,
  SUBSTRATE_ENV_KEY_PATTERN,
} from "@cogni/substrate-health";
import type { getContainer } from "@/bootstrap/container";
import { verifySystemTenant } from "@/bootstrap/healthchecks";
import type { serverEnv } from "@/shared/env";
import {
  assertSchedulerWorkerConnectivity,
  assertTemporalConnectivity,
  checkEvmRpcConnectivity,
  InfraConnectivityError,
} from "@/shared/env/invariants";
import type { RequestContext } from "@/shared/observability";

// Re-exported from the package so `route.ts` keeps one import site and the
// parity meta-test can assert the node uses the package's class by identity.
export { type DeepChecks, DeepProbeFailure, SUBSTRATE_ENV_KEY_PATTERN };

type Container = ReturnType<typeof getContainer>;
type Env = ReturnType<typeof serverEnv>;

/**
 * Deep-path budget for each dependency check. The checks run concurrently, so the
 * whole probe stays under this plus the response; it must stay below the 5 s deadline
 * of the fleet prober that reads `unreachable`.
 */
export const DEEP_CHECK_BUDGET_MS = 3000;

/** A fixed, never-present id: a healthy knowledge plane returns null, a dead one throws. */
const DOLTGRES_READYZ_PROBE_ID = "readyz-probe-knowledge-reach";
/** A fixed run id for the Redis XLEN reach probe; missing key returns 0. */
const REDIS_READYZ_PROBE_KEY = "readyz:probe";

/** This node's connectivity error, injected into the package's runner and probe factories. */
const wrapInfra = (message: string): Error => new InfraConnectivityError(message);

/** Dependencies a deep 503 can name in `unreachable` (this node's probe-name union). */
export type DeepDependency =
  | "postgres"
  | "temporal"
  | "scheduler-worker"
  | "evm-rpc"
  | "redis"
  | "litellm-gateway"
  | "doltgres";

/**
 * Deep path: run every declared dependency check concurrently and report every
 * failure, with per-dependency observability. Thin wrapper that injects this
 * node's logger, connectivity error and deep budget into the package runner; the
 * package throws the shared `DeepProbeFailure` and emits `substrate.deep.complete`.
 */
export async function runDeepChecks(
  ctx: RequestContext,
  checks: ReadonlyArray<readonly [DeepDependency, () => Promise<unknown>]>
): Promise<DeepChecks> {
  return pkgRunDeepChecks(checks, {
    log: (fields, message) => ctx.log.info(fields, message),
    timeoutError: (dependency, budgetMs) =>
      new InfraConnectivityError(
        `${dependency} check exceeded ${budgetMs}ms budget`
      ),
    budgetMs: DEEP_CHECK_BUDGET_MS,
  });
}

/**
 * EVM RPC deep check: forced live read, fatal on failure. The default probe path
 * keeps its own non-fatal EVM check inline in `route.ts`.
 */
export async function checkEvmRpc(
  ctx: RequestContext,
  container: Container,
  env: Env
): Promise<void> {
  const evmRpcResult = await checkEvmRpcConnectivity(
    container.evmOnchainClient,
    env,
    { forceLive: true }
  );
  if (!evmRpcResult.ok) {
    const message = `EVM RPC connectivity check failed: ${evmRpcResult.errorMessage ?? "unknown"}`;
    ctx.log.error(
      {
        event: "substrate.evm_rpc.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "evm-rpc",
        source: evmRpcResult.source,
        message,
      },
      "deep readiness: EVM RPC unreachable"
    );
    throw new InfraConnectivityError(message);
  }
  ctx.log.info(
    {
      event: "substrate.evm_rpc.reachable",
      dependency: "evm-rpc",
      source: evmRpcResult.source,
    },
    "deep readiness: EVM RPC reachable"
  );
}

/**
 * Doltgres knowledge-plane reach via the package factory. Only meaningful when
 * the node declares Doltgres (`DOLTGRES_URL`). A bounded point read; a healthy
 * empty hit returns null.
 */
export function checkDoltgres(container: Container, env: Env): Promise<void> {
  if (!env.DOLTGRES_URL) return Promise.resolve(); // undeclared; the registry filter also guards this
  const port = container.knowledgeStorePort;
  if (!port) {
    return Promise.reject(
      new InfraConnectivityError(
        "Doltgres is declared (DOLTGRES_URL set) but the knowledge store is not wired"
      )
    );
  }
  return probeKnowledgePlane(port, DOLTGRES_READYZ_PROBE_ID, {
    wrapError: wrapInfra,
  })();
}

/** LiteLLM gateway reach via the package factory (uncached alias-catalog read). */
export function checkLiteLlm(env: Env): Promise<void> {
  return probeLiteLlmGateway(
    {
      baseUrl: env.LITELLM_BASE_URL,
      apiKey: env.LITELLM_MASTER_KEY,
      budgetMs: DEEP_CHECK_BUDGET_MS,
    },
    { wrapError: wrapInfra }
  )();
}

/** Redis run-stream reach via the package factory (`XLEN` on a fixed key). */
export function checkRedis(container: Container): Promise<void> {
  return probeRedisStream(container.runStream, REDIS_READYZ_PROBE_KEY, {
    wrapError: wrapInfra,
  })();
}

/** Every substrate dependency this node can declare, probe or justified non-probe. */
type SubstrateName =
  | DeepDependency
  | "polygon-rpc"
  | "paper-sidecar"
  | "tigerbeetle"
  | "langfuse"
  | "openbao-eso"
  | "openfga";

type ProbeRun = (
  ctx: RequestContext,
  container: Container,
  env: Env
) => Promise<unknown>;

/** This node's declaration-map entry: the package type specialized to node names/closures. */
type SubstrateDependency = PkgSubstrateDependency<
  Env,
  DeepDependency,
  SubstrateName,
  ProbeRun
>;

/** Narrow a registry entry to a probe entry (and thus `dependency: DeepDependency`). */
function isProbe(
  dep: SubstrateDependency
): dep is PkgProbeDependency<Env, DeepDependency, ProbeRun> {
  return dep.readyz.kind === "probe";
}

const always = (): boolean => true;

/**
 * The single source of truth for what deep readiness proves. Probe entries are in
 * deep-registry order; new probes are appended so existing first-failure/order
 * assertions hold. `na` entries record why a declared dependency is not probed.
 */
export const SUBSTRATE_DEPENDENCIES: readonly SubstrateDependency[] = [
  {
    dependency: "evm-rpc",
    envKeys: ["EVM_RPC_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (ctx, container, env) => checkEvmRpc(ctx, container, env),
    },
  },
  {
    dependency: "temporal",
    envKeys: ["TEMPORAL_ADDRESS"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, container, env) =>
        assertTemporalConnectivity(container.scheduleControl, env),
    },
  },
  {
    dependency: "scheduler-worker",
    envKeys: ["SCHEDULER_WORKER_HEALTH_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, _container, env) => assertSchedulerWorkerConnectivity(env),
    },
  },
  {
    // System tenant billing account (SYSTEM_TENANT_STARTUP_CHECK) is the Postgres verdict.
    dependency: "postgres",
    envKeys: ["DATABASE_URL", "DATABASE_SERVICE_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, container) =>
        verifySystemTenant(container.serviceAccountService),
    },
  },
  {
    dependency: "redis",
    envKeys: ["REDIS_URL"],
    isDeclared: always,
    readyz: { kind: "probe", run: (_ctx, container) => checkRedis(container) },
  },
  {
    dependency: "litellm-gateway",
    envKeys: ["LITELLM_BASE_URL"],
    isDeclared: always,
    readyz: { kind: "probe", run: (_ctx, _container, env) => checkLiteLlm(env) },
  },
  {
    dependency: "doltgres",
    envKeys: ["DOLTGRES_URL"],
    isDeclared: (env) => Boolean(env.DOLTGRES_URL),
    readyz: {
      kind: "probe",
      run: (_ctx, container, env) => checkDoltgres(container, env),
    },
  },
  {
    dependency: "polygon-rpc",
    envKeys: ["POLYGON_RPC_URL", "POLYGON_RPC_WSS_URL"],
    isDeclared: (env) => Boolean(env.POLYGON_RPC_URL || env.POLYGON_RPC_WSS_URL),
    readyz: {
      kind: "na",
      reason:
        "Optional Polymarket trade-execution RPC (Polygon, not the Base EVM_RPC_URL); trading routes and jobs fail closed per request when it is absent or down, so it is not a serving dependency of the pod.",
    },
  },
  {
    dependency: "paper-sidecar",
    envKeys: ["PAPER_SIDECAR_URL"],
    isDeclared: (env) => Boolean(env.PAPER_SIDECAR_URL),
    readyz: {
      kind: "na",
      reason:
        "Optional sibling paper-trading sidecar (loopback in the pod); consumed only by the paper-only executor and fails closed per trade request, never a serving dependency.",
    },
  },
  {
    dependency: "tigerbeetle",
    envKeys: ["TIGERBEETLE_ADDRESS"],
    isDeclared: (env) => Boolean(env.TIGERBEETLE_ADDRESS),
    readyz: {
      kind: "na",
      reason:
        "Account/ledger class; proven out-of-band, never from the serving path.",
    },
  },
  {
    dependency: "langfuse",
    envKeys: ["LANGFUSE_BASE_URL"],
    isDeclared: (env) => Boolean(env.LANGFUSE_BASE_URL),
    readyz: {
      kind: "na",
      reason:
        "Observe class; probing telemetry from the serving path makes it a serving dependency.",
    },
  },
  {
    dependency: "openbao-eso",
    envKeys: [],
    isDeclared: always,
    readyz: {
      kind: "na",
      reason: "Secret delivery is already proven by assertRuntimeSecrets.",
    },
  },
  {
    dependency: "openfga",
    envKeys: [],
    isDeclared: () => false,
    readyz: { kind: "na", reason: "Not wired on Poly." },
  },
];

/**
 * Build the deep-path checks for the dependencies this node declares, in registry
 * order. Probe entries use a `DeepDependency` name by construction.
 */
export function buildDeepChecks(
  ctx: RequestContext,
  container: Container,
  env: Env
): ReadonlyArray<readonly [DeepDependency, () => Promise<unknown>]> {
  const checks: Array<readonly [DeepDependency, () => Promise<unknown>]> = [];
  for (const dep of SUBSTRATE_DEPENDENCIES) {
    if (!isProbe(dep) || !dep.isDeclared(env)) continue;
    const run = dep.readyz.run;
    checks.push([dep.dependency, () => run(ctx, container, env)]);
  }
  return checks;
}

/** Schema keys that match the substrate pattern but are not substrate dependencies. */
export const NON_SUBSTRATE_ALLOWLIST: readonly string[] = [
  "APP_BASE_URL",
  "LANGGRAPH_DEV_URL",
  "DOLTHUB_REMOTE_URL",
  "PROMETHEUS_REMOTE_WRITE_URL",
  "PROMETHEUS_QUERY_URL",
];

/**
 * Drift guard: given the server-env schema keys, return every substrate-looking
 * key that is neither owned by a `SUBSTRATE_DEPENDENCIES` entry nor allowlisted.
 * Thin wrapper over the package helper with this node's classified keys.
 */
export function findUnclassifiedSubstrateKeys(
  schemaKeys: readonly string[]
): string[] {
  const classifiedKeys = SUBSTRATE_DEPENDENCIES.flatMap((dep) => [
    ...dep.envKeys,
  ]);
  return pkgFindUnclassifiedSubstrateKeys(schemaKeys, {
    classifiedKeys,
    allowlist: NON_SUBSTRATE_ALLOWLIST,
  });
}
