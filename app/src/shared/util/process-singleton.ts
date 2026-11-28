// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/util/process-singleton`
 * Purpose: One instance per OS process for resources that own native handles
 *   (the DI container and its job elector, the Postgres pools).
 * Scope: A `globalThis`-keyed registry. No resource knowledge, no IO.
 * Invariants:
 *   - ONE_PER_PROCESS (bug.5066): Next.js 16 / Turbopack evaluates a module once
 *     per bundle graph — the instrumentation hook, each app-route handler and each
 *     server-rendered page get SEPARATE copies, so a module-level `let _x` is a
 *     per-graph singleton, not a per-process one (reproduced on next@16.2.3:
 *     instrumentation + page + route = 3 copies, 1 pid). Every copy then built its
 *     own container: 2 job electors + 2 service pools per pod, so one pod held 4
 *     `service_poly` backends against a role capped far lower. State that must
 *     exist once per process lives here, keyed on `Symbol.for(...)` on `globalThis`
 *     (the same pattern as `shared/observability/server/metrics.ts` and the
 *     resting-sweep slot in `bootstrap/jobs/poly-mirror-resting-sweep.job.ts`).
 *   - FACTORY_RUNS_ONCE: `create` is synchronous, so two graphs can never both
 *     observe an empty slot.
 * Side-effects: global (one registry on globalThis)
 * Links: work/items/bug.5066, packages/db-client/src/build-client.ts (backend math)
 * @public
 */

const REGISTRY_KEY = Symbol.for("cogni.poly.process-singletons");

function registry(): Map<string, unknown> {
  const g = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
  let map = g[REGISTRY_KEY];
  if (!map) {
    map = new Map();
    g[REGISTRY_KEY] = map;
  }
  return map;
}

/** Return the process-wide instance for `key`, creating it with `create` on first use. */
export function processSingleton<T>(key: string, create: () => T): T {
  const map = registry();
  if (map.has(key)) return map.get(key) as T;
  const value = create();
  map.set(key, value);
  return value;
}

/** Forget one instance (the owner is responsible for disposing it). */
export function clearProcessSingleton(key: string): void {
  registry().delete(key);
}

/** Forget every instance. Tests only: `vi.resetModules()` does not reset `globalThis`. */
export function resetProcessSingletons(): void {
  registry().clear();
}
