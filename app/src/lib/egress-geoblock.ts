// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/lib/egress-geoblock`
 * Purpose: Prove from INSIDE the lease that Polymarket accepts this pod's outbound
 *   path, and latch a readiness failure when it provably does not — so a geoblocked
 *   lease fails the operator's boot SLO and never takes cutover.
 * Scope: Boot-time background assertion + a cached, IO-free latch read for `/readyz`.
 *   Holds NO bootstrap/container wiring (dep-cruiser forbids instrumentation → bootstrap,
 *   and `instrumentation.ts` is the caller), hence the self-contained pino logger — same
 *   precedent as `@/lib/governance-boot-sync`.
 * Invariants:
 *   - IN_WORKLOAD_EGRESS_IS_THE_ONLY_PROOF (story.5050): a provider's advertised /
 *     ingress country is NOT proof of the egress identity this workload presents to a
 *     third party. `required_placement_countries` narrows the bid pool; only Polymarket's
 *     own verdict, observed from inside this lease, proves the lease can trade.
 *   - UNREACHABLE_IS_NOT_BLOCKED: only a literal `blocked === true` counts. A timeout,
 *     non-2xx, rate-limit page or unexpected body shape is `unreachable`, which RESETS
 *     the streak and can never latch. One 429 must not latch a healthy pod dead.
 *   - REQUIRES_CONSECUTIVE: N=3 consecutive `blocked:true` verdicts, spaced seconds
 *     apart, before the latch closes. A single verdict is never enough.
 *   - LATCH_ONLY_IN_BOOT_WINDOW: the latch may only close inside the first
 *     `BOOT_WINDOW_MS` of process life. After that the latch freezes at whatever it is
 *     and probing stops — failing a live pod's probe on a transient upstream is exactly
 *     the shape of incident 2026-06-26 (a blip drained the fleet into a 502).
 *   - LATCH_IS_STICKY: once closed the latch never re-opens in this process. Cutover
 *     must fail; a flapping oracle must not flap readiness.
 *   - READYZ_DOES_ZERO_IO: `/readyz` reads the cached latch only. k8s calls it
 *     constantly; it must never touch polymarket.com.
 *   - BOOT_ONLY_PROBING: at most `MAX_PROBES` outbound GETs per process, and probing
 *     stops early on a conclusive `permitted` verdict.
 *   - FAIL_SOFT: never throws to the caller; every failure path is a log.
 * Side-effects: outbound HTTPS GETs to polymarket.com at boot only; structured logs;
 *   module-level latch state.
 * Notes: `POLY_EGRESS_ASSERTION_ENABLED=false` disables the assertion (probe + latch)
 *   for a node that does not depend on Polymarket egress, or as an incident escape
 *   hatch. Read from raw `process.env` because this runs before the env framework.
 * Links: work/items/story.5050, knowledge entry `node-choose-placement-region`,
 *   src/app/(infra)/readyz/route.ts, src/lib/governance-boot-sync.ts
 * @public
 */

import pino from "pino";

const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";
const PROBE_TIMEOUT_MS = 8_000;

/** A verdict may only kill readiness inside the first 10 minutes of process life. */
const BOOT_WINDOW_MS = 10 * 60_000;
/** Consecutive `blocked:true` verdicts required before the latch closes. */
const REQUIRED_CONSECUTIVE = 3;
/** Spacing between probes — seconds apart, so one bad instant cannot supply all N. */
const PROBE_INTERVAL_MS = 5_000;
/** Hard cap on outbound GETs per process. */
const MAX_PROBES = 6;

/** `blocked` and `permitted` are Polymarket's verdict; everything else is `unreachable`. */
export type EgressVerdict = "blocked" | "permitted" | "unreachable";

/** Cached, IO-free view of the egress assertion. Read by `/readyz`. */
export interface EgressGeoblockLatch {
  /** True only when N consecutive `blocked:true` verdicts landed inside the boot window. */
  readonly latched: boolean;
  /** Distinct readiness reason code when latched. */
  readonly reason: "EGRESS_GEOBLOCKED" | null;
  readonly lastVerdict: EgressVerdict | null;
  readonly consecutiveBlocked: number;
  readonly egressIp: string | null;
  readonly egressCountry: string | null;
  readonly egressRegion: string | null;
  readonly latchedAt: string | null;
}

export interface EgressAssertionConfig {
  /** False disables probing entirely (test env, or POLY_EGRESS_ASSERTION_ENABLED=false). */
  enabled: boolean;
}

export interface EgressAssertionDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock so boot-window behaviour is testable without real time. */
  now?: () => number;
  logger?: Pick<pino.Logger, "info" | "warn" | "error">;
  bootWindowMs?: number;
  requiredConsecutive?: number;
  probeIntervalMs?: number;
  maxProbes?: number;
}

interface MutableLatch {
  latched: boolean;
  reason: "EGRESS_GEOBLOCKED" | null;
  lastVerdict: EgressVerdict | null;
  consecutiveBlocked: number;
  egressIp: string | null;
  egressCountry: string | null;
  egressRegion: string | null;
  latchedAt: string | null;
}

function emptyLatch(): MutableLatch {
  return {
    latched: false,
    reason: null,
    lastVerdict: null,
    consecutiveBlocked: 0,
    egressIp: null,
    egressCountry: null,
    egressRegion: null,
    latchedAt: null,
  };
}

let latchState: MutableLatch = emptyLatch();

/**
 * Cached latch read for `/readyz`. Performs ZERO IO — the probe runs in the
 * background at boot and this only reports what it concluded.
 */
export function getEgressGeoblockLatch(): EgressGeoblockLatch {
  return { ...latchState };
}

/** Reset module state between tests. */
export function _resetEgressGeoblockLatchForTest(): void {
  latchState = emptyLatch();
}

/** Resolve config straight from process.env (this runs before the env framework). */
export function resolveEgressAssertionConfig(
  env: Partial<NodeJS.ProcessEnv>
): EgressAssertionConfig {
  return {
    enabled:
      env.APP_ENV !== "test" && env.POLY_EGRESS_ASSERTION_ENABLED !== "false",
  };
}

function defaultLogger(): Pick<pino.Logger, "info" | "warn" | "error"> {
  return pino({
    base: {
      app: "cogni-template",
      // biome-ignore lint/style/noProcessEnv: boot log emitted before the config framework
      service: process.env.SERVICE_NAME ?? "app",
      component: "egress-geoblock",
    },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

interface ProbeOutcome {
  verdict: EgressVerdict;
  ip: string | null;
  country: string | null;
  region: string | null;
  errorClass: string | null;
}

function unreachable(errorClass: string): ProbeOutcome {
  return {
    verdict: "unreachable",
    ip: null,
    country: null,
    region: null,
    errorClass,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * One probe of Polymarket's own geoblock oracle.
 *
 * UNREACHABLE_IS_NOT_BLOCKED: every failure mode — timeout, non-2xx, HTML
 * rate-limit page, missing/none-boolean `blocked` — returns `unreachable`. An
 * oracle we could not read is never evidence that the egress is blocked, and it
 * is never evidence that the egress is permitted either.
 */
async function probeOnce(fetchImpl: typeof fetch): Promise<ProbeOutcome> {
  try {
    const res = await fetchImpl(GEOBLOCK_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return unreachable(`oracle_http_${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown> | null;
    const blocked = body ? body.blocked : undefined;
    if (typeof blocked !== "boolean") {
      return unreachable("oracle_shape_unexpected");
    }
    return {
      verdict: blocked ? "blocked" : "permitted",
      ip: asString(body?.ip),
      country: asString(body?.country),
      region: asString(body?.region),
      errorClass: null,
    };
  } catch (error) {
    return unreachable(
      error instanceof Error && error.name === "TimeoutError"
        ? "oracle_timeout"
        : "oracle_unreachable"
    );
  }
}

/**
 * Boot-time egress assertion. Probes Polymarket's geoblock oracle up to
 * `maxProbes` times, spaced `probeIntervalMs` apart, and latches readiness dead
 * only when `requiredConsecutive` literal `blocked:true` verdicts land inside
 * the boot window. Never throws.
 *
 * Returns the resulting latch so callers/tests can assert on it; production
 * callers fire-and-forget and read it later via `getEgressGeoblockLatch()`.
 */
export async function runEgressGeoblockAssertion(
  config: EgressAssertionConfig,
  deps: EgressAssertionDeps = {}
): Promise<EgressGeoblockLatch> {
  const log = deps.logger ?? defaultLogger();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const bootWindowMs = deps.bootWindowMs ?? BOOT_WINDOW_MS;
  const requiredConsecutive = deps.requiredConsecutive ?? REQUIRED_CONSECUTIVE;
  const probeIntervalMs = deps.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const maxProbes = deps.maxProbes ?? MAX_PROBES;

  if (!config.enabled) {
    log.info(
      { event: "poly.egress.geoblock.skipped" },
      "egress geoblock assertion disabled — /readyz will NOT gate on Polymarket egress"
    );
    return getEgressGeoblockLatch();
  }

  if (latchState.latched) {
    // LATCH_IS_STICKY: nothing re-opens a closed latch in this process.
    return getEgressGeoblockLatch();
  }

  const startedAt = now();

  for (let attempt = 1; attempt <= maxProbes; attempt++) {
    // LATCH_ONLY_IN_BOOT_WINDOW: boot-only probing. Once the window closes we
    // stop entirely rather than keep a live pod one bad page away from death.
    if (now() - startedAt > bootWindowMs) {
      log.warn(
        { event: "poly.egress.geoblock.window_closed", attempt },
        "egress geoblock boot window closed — latch frozen, no further probes"
      );
      return getEgressGeoblockLatch();
    }

    const outcome = await probeOnce(fetchImpl);
    latchState.lastVerdict = outcome.verdict;
    if (outcome.verdict === "blocked") {
      latchState.consecutiveBlocked += 1;
      latchState.egressIp = outcome.ip;
      latchState.egressCountry = outcome.country;
      latchState.egressRegion = outcome.region;
    } else {
      // A permitted OR an unreachable verdict breaks the streak.
      latchState.consecutiveBlocked = 0;
    }

    log.info(
      {
        event: "poly.egress.geoblock",
        verdict: outcome.verdict,
        blocked:
          outcome.verdict === "unreachable" ? null : outcome.verdict === "blocked",
        egress_ip: outcome.ip,
        egress_country: outcome.country,
        egress_region: outcome.region,
        attempt,
        consecutive_blocked: latchState.consecutiveBlocked,
        ...(outcome.errorClass ? { error_class: outcome.errorClass } : {}),
      },
      outcome.verdict === "permitted"
        ? "egress permitted by Polymarket"
        : outcome.verdict === "blocked"
          ? "egress BLOCKED by Polymarket — this lease cannot open orders"
          : "egress geoblock probe inconclusive (unreachable, NOT blocked)"
    );

    if (outcome.verdict === "permitted") {
      // Conclusive affirmative: this lease's outbound path is accepted. Stop
      // probing; BOOT_ONLY_PROBING keeps us off polymarket.com for the rest of
      // the process lifetime.
      return getEgressGeoblockLatch();
    }

    if (latchState.consecutiveBlocked >= requiredConsecutive) {
      // Re-check the window at the latch site, not only at the loop head: the
      // latch is the destructive act and must be guarded where it happens.
      if (now() - startedAt > bootWindowMs) {
        log.error(
          {
            event: "poly.egress.geoblock.not_latched",
            severity: "degraded",
            reason: "OUTSIDE_BOOT_WINDOW",
            consecutive_blocked: latchState.consecutiveBlocked,
          },
          "egress BLOCKED but the boot window has closed — refusing to latch a running pod dead (incident 2026-06-26)"
        );
        return getEgressGeoblockLatch();
      }
      latchState.latched = true;
      latchState.reason = "EGRESS_GEOBLOCKED";
      latchState.latchedAt = new Date(now()).toISOString();
      log.error(
        {
          event: "poly.egress.geoblock.latched",
          severity: "critical",
          reason: "EGRESS_GEOBLOCKED",
          dependency: "polymarket-egress",
          consecutive_blocked: latchState.consecutiveBlocked,
          egress_ip: latchState.egressIp,
          egress_country: latchState.egressCountry,
          egress_region: latchState.egressRegion,
        },
        "readiness LATCHED FAILED: Polymarket geoblocks this lease's egress — /readyz now 503s so the operator's boot SLO refuses this lease and re-mints elsewhere"
      );
      return getEgressGeoblockLatch();
    }

    if (attempt < maxProbes) {
      await sleep(probeIntervalMs);
    }
  }

  log.warn(
    {
      event: "poly.egress.geoblock.inconclusive",
      attempts: maxProbes,
      last_verdict: latchState.lastVerdict,
      consecutive_blocked: latchState.consecutiveBlocked,
    },
    "egress geoblock assertion inconclusive after all probes — not latching (unreachable is not blocked)"
  );
  return getEgressGeoblockLatch();
}
