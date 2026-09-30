// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/lib/egress-geoblock`
 * Purpose: Prove the boot-time Polymarket egress assertion latches `/readyz` dead ONLY
 *   on N consecutive literal `blocked:true` verdicts inside the boot window.
 * Scope: Pure unit test — `fetch`, clock and sleep are injected; no network, no timers.
 * Invariants exercised: UNREACHABLE_IS_NOT_BLOCKED, REQUIRES_CONSECUTIVE,
 *   LATCH_ONLY_IN_BOOT_WINDOW, LATCH_IS_STICKY, READYZ_DOES_ZERO_IO (cached read).
 * Side-effects: module-level latch reset between tests
 * Links: src/lib/egress-geoblock.ts, work/items/story.5050, knowledge entry `node-choose-placement-region`
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetEgressGeoblockLatchForTest,
  getEgressGeoblockLatch,
  resolveEgressAssertionConfig,
  runEgressGeoblockAssertion,
} from "@/lib/egress-geoblock";

const ENABLED = { enabled: true };

/** Oracle response bodies. */
const BLOCKED = {
  blocked: true,
  ip: "203.0.113.7",
  country: "US",
  region: "NY",
};
const PERMITTED = {
  blocked: false,
  ip: "198.51.100.4",
  country: "PT",
  region: "13",
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * fetch stub that replays a scripted sequence of outcomes, then repeats the last.
 * Entries are either a Response-ish object or an Error to throw.
 */
function scriptedFetch(steps: Array<unknown>) {
  let i = 0;
  return vi.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return step as Response;
  });
}

/** Deterministic clock that advances a fixed amount on every read. */
function clock(startMs: number, stepMs: number) {
  let t = startMs;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noSleep = () => Promise.resolve();

function baseDeps(fetchImpl: ReturnType<typeof scriptedFetch>) {
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: noSleep,
    logger: silentLogger,
    maxProbes: 6,
    requiredConsecutive: 3,
    probeIntervalMs: 1,
    bootWindowMs: 600_000,
  };
}

afterEach(() => {
  _resetEgressGeoblockLatchForTest();
  vi.clearAllMocks();
});

describe("resolveEgressAssertionConfig", () => {
  it("is enabled by default and disabled in test or by the kill switch", () => {
    expect(resolveEgressAssertionConfig({}).enabled).toBe(true);
    expect(resolveEgressAssertionConfig({ APP_ENV: "test" }).enabled).toBe(
      false
    );
    expect(
      resolveEgressAssertionConfig({ POLY_EGRESS_ASSERTION_ENABLED: "false" })
        .enabled
    ).toBe(false);
    expect(
      resolveEgressAssertionConfig({ POLY_EGRESS_ASSERTION_ENABLED: "true" })
        .enabled
    ).toBe(true);
  });
});

describe("runEgressGeoblockAssertion — UNREACHABLE_IS_NOT_BLOCKED", () => {
  it("never latches when the oracle times out", async () => {
    const timeout = Object.assign(new Error("timed out"), {
      name: "TimeoutError",
    });
    const fetchImpl = scriptedFetch([timeout]);

    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(fetchImpl)
    );

    expect(latch.latched).toBe(false);
    expect(latch.lastVerdict).toBe("unreachable");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("never latches on a rate-limit page (non-2xx)", async () => {
    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(scriptedFetch([jsonResponse("<html>429</html>", 429)]))
    );

    expect(latch.latched).toBe(false);
    expect(latch.lastVerdict).toBe("unreachable");
  });

  it("never latches on an unparseable / unexpected body shape", async () => {
    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(scriptedFetch([jsonResponse({ nope: 1 })]))
    );

    expect(latch.latched).toBe(false);
    expect(latch.lastVerdict).toBe("unreachable");
  });

  it("resets the streak: blocked, blocked, unreachable, blocked does not latch", async () => {
    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(
        scriptedFetch([
          jsonResponse(BLOCKED),
          jsonResponse(BLOCKED),
          jsonResponse(null, 503),
          jsonResponse(BLOCKED),
          jsonResponse(null, 503),
          jsonResponse(BLOCKED),
        ])
      )
    );

    expect(latch.latched).toBe(false);
    expect(latch.consecutiveBlocked).toBe(1);
  });
});

describe("runEgressGeoblockAssertion — REQUIRES_CONSECUTIVE", () => {
  it("does not latch on a single blocked verdict", async () => {
    const latch = await runEgressGeoblockAssertion(ENABLED, {
      ...baseDeps(
        scriptedFetch([jsonResponse(BLOCKED), jsonResponse(PERMITTED)])
      ),
    });

    expect(latch.latched).toBe(false);
    expect(latch.lastVerdict).toBe("permitted");
  });

  it("latches on 3 consecutive blocked verdicts inside the boot window", async () => {
    const fetchImpl = scriptedFetch([jsonResponse(BLOCKED)]);

    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(fetchImpl)
    );

    expect(latch.latched).toBe(true);
    expect(latch.reason).toBe("EGRESS_GEOBLOCKED");
    expect(latch.egressIp).toBe(BLOCKED.ip);
    expect(latch.egressCountry).toBe(BLOCKED.country);
    // Stops probing the instant it latches — exactly N probes, no more.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Cached read, available to /readyz with zero IO.
    expect(getEgressGeoblockLatch().latched).toBe(true);
  });

  it("one permitted verdict clears the streak and stops probing", async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse(BLOCKED),
      jsonResponse(BLOCKED),
      jsonResponse(PERMITTED),
      jsonResponse(BLOCKED),
      jsonResponse(BLOCKED),
      jsonResponse(BLOCKED),
    ]);

    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(fetchImpl)
    );

    expect(latch.latched).toBe(false);
    expect(latch.consecutiveBlocked).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("runEgressGeoblockAssertion — LATCH_ONLY_IN_BOOT_WINDOW", () => {
  it("does not latch when blocked verdicts arrive after the boot window", async () => {
    const fetchImpl = scriptedFetch([jsonResponse(BLOCKED)]);

    // Clock jumps 5 minutes per read against a 1-minute window: the first loop
    // head already sits outside the window (incident 2026-06-26 guard).
    const latch = await runEgressGeoblockAssertion(ENABLED, {
      ...baseDeps(fetchImpl),
      bootWindowMs: 60_000,
      now: clock(0, 300_000),
    });

    expect(latch.latched).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to latch when the window closes mid-streak", async () => {
    // Window closes between probe 2 and the latch check after probe 3.
    const nowValues = [
      0, // startedAt
      0, // loop head, attempt 1
      0, // loop head, attempt 2
      0, // loop head, attempt 3
      120_000, // latch-site check: window has closed
    ];
    let i = 0;
    const now = () => nowValues[Math.min(i++, nowValues.length - 1)];

    const latch = await runEgressGeoblockAssertion(ENABLED, {
      ...baseDeps(scriptedFetch([jsonResponse(BLOCKED)])),
      bootWindowMs: 60_000,
      now,
    });

    expect(latch.latched).toBe(false);
    expect(latch.consecutiveBlocked).toBe(3);
  });
});

describe("runEgressGeoblockAssertion — lifecycle", () => {
  it("is a no-op when disabled", async () => {
    const fetchImpl = scriptedFetch([jsonResponse(BLOCKED)]);

    const latch = await runEgressGeoblockAssertion(
      { enabled: false },
      baseDeps(fetchImpl)
    );

    expect(latch.latched).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("latch is sticky: a later permitted run cannot re-open it", async () => {
    await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(scriptedFetch([jsonResponse(BLOCKED)]))
    );
    expect(getEgressGeoblockLatch().latched).toBe(true);

    const fetchImpl = scriptedFetch([jsonResponse(PERMITTED)]);
    const latch = await runEgressGeoblockAssertion(
      ENABLED,
      baseDeps(fetchImpl)
    );

    expect(latch.latched).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults to an unlatched, IO-free latch before any probe runs", () => {
    expect(getEgressGeoblockLatch()).toMatchObject({
      latched: false,
      reason: null,
      lastVerdict: null,
      consecutiveBlocked: 0,
    });
  });
});
