// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/goals/display`
 * Purpose: Prove what a KPI card and chart show by display type: the type comes
 *   from the read model only; SLOs read as truncated % against ≥ or ≤
 *   objectives with an error budget; a volume change names the real time since
 *   its first reading; a young hourly metric draws its last day; unknown is
 *   never 0; a stored display must be valid and fit the unit.
 * Scope: Pure functions in lib/display.ts and the metrics stored-spec contract.
 * Invariants: UNKNOWN_IS_NOT_ZERO; HINT_LE_3_WORDS; ONE_FORMATTER_PER_DISPLAY.
 * Side-effects: none
 * Links: app/src/features/goals/lib/display.ts, packages/metrics/src/contracts.ts
 * @internal
 */

import { displayFits, parseStoredMetricSpec } from "@cogni-dao/metrics/contracts";
import { assessmentFixture, history, kpiFixture } from "@tests/_fixtures/goals/progress";
import { describe, expect, it } from "vitest";

import {
  cardHint,
  cardSeries,
  displayOf,
  formatPercent,
  formatValue,
  meetsTarget,
  progressFraction,
  sloBudget,
  targetInView,
  yDomain,
} from "@/features/goals/lib/display";

const OBSERVED = "2026-11-02T10:00:00.000Z";

function k(
  unit: string,
  value: number | null,
  target: number,
  comparator: "gte" | "lte" = "gte",
  daily: (number | null)[] = [1, 2]
) {
  return kpiFixture(
    "m",
    "M",
    assessmentFixture("on_track", { unit, value, comparator, target: { value: target, unit }, observedAt: OBSERVED }),
    history("m", unit, "1d", "2026-11-03T00:00:00.000Z", daily)
  );
}

describe("display type", () => {
  it("comes from the read model and never from the unit", () => {
    const kpi = k("%", 99.9, 99.5);
    expect(displayOf(kpi)).toBe("progress");
    expect(displayOf({ ...kpi, metric: kpi.metric && { ...kpi.metric, display: "slo" } })).toBe("slo");
    expect(displayOf({ ...kpi, metric: null })).toBe("progress");
  });

  it("is stored beside the spec, strictly, and must fit the unit", () => {
    const stored = { calculatorId: "x@1", params: {}, maxAgeSeconds: 60, display: "volume" };
    expect(parseStoredMetricSpec(stored)).toEqual({
      spec: { calculatorId: "x@1", params: {}, maxAgeSeconds: 60 },
      display: "volume",
    });
    expect(() => parseStoredMetricSpec({ ...stored, display: "bogus" })).toThrow();
    expect(displayFits("slo", "%")).toBe(true);
    expect(displayFits("slo", "ratio")).toBe(false);
    expect(displayFits("volume", "stars")).toBe(true);
  });
});

describe("slo", () => {
  it("truncates, never rounds up to 100%", () => {
    expect(formatPercent(99.9996)).toBe("99.999");
    expect(formatPercent(99.95)).toBe("99.95");
    expect(formatPercent(87.56)).toBe("87.5");
    expect(formatValue(99.95, "slo", "%")).toBe("99.95%");
  });

  it("reads ≥ and ≤ objectives with their own budget", () => {
    const floor = { comparator: "gte" as const, target: { value: 99.9, unit: "%" } };
    const ceiling = { comparator: "lte" as const, target: { value: 1, unit: "%" } };
    expect(sloBudget(99.95, floor)).toBeCloseTo(0.5);
    expect(sloBudget(0.25, ceiling)).toBeCloseTo(0.75);
    expect(meetsTarget(0.25, ceiling)).toBe(true);
    expect(meetsTarget(2, ceiling)).toBe(false);
    expect(cardHint(k("%", 99.95, 99.9), "slo", null)).toBe("budget 50%");
  });

  it("scales the axis toward 100 for ≥ and up from 0 for ≤", () => {
    const [lo, hi] = yDomain("slo", [99.95, 99.8], 99.9, "gte");
    expect(hi).toBe(100);
    expect(lo).toBeLessThan(99.8);
    expect(yDomain("slo", [0.25, 0.6], 1, "lte")).toEqual([0, 1.5]);
  });
});

describe("volume", () => {
  it("names the real time since the first reading, skipping leading gaps", () => {
    const kpi = k("stars", 130, 200, "gte", [null, null, 100, 120]);
    // The first reading sits in the Nov 1 bucket: the change is labelled by it, never a guessed duration.
    expect(cardHint(kpi, "volume", kpi.trend)).toBe("+30 since Nov 1");
    const hourly = history("m", "stars", "1h", OBSERVED, [null, 120, 125]);
    expect(cardHint(kpi, "volume", hourly)).toBe("+10 since 08:00");
    const overnight = history("m", "stars", "1h", OBSERVED, [...Array(12).fill(null), 110, ...Array(10).fill(null), 125]);
    expect(cardHint(kpi, "volume", overnight)).toBe("+20 since Nov 1");
    expect(cardHint(k("stars", 120, 200, "gte", [120, 120]), "volume", null)).toBe("≥ 200");
    expect(cardHint(k("stars", 130, 200, "gte", [null, 120]), "volume", null)).toBe("≥ 200");
    expect(formatValue(12_400, "volume", "stars")).toBe("12.4K");
  });

  it("draws the last day hourly until the daily trend has a shape", () => {
    const young = { ...k("items", 5, 9, "gte", [null, 4]), recent: history("m", "items", "1h", OBSERVED, [3, 4, 5]) };
    expect(cardSeries(young)?.step).toBe("1h");
    const mature = { ...k("items", 5, 9, "gte", [3, 4, 5]), recent: young.recent };
    expect(cardSeries(mature)?.step).toBe("1d");
  });

  it("shows a target while it is ahead, and once met only near the data", () => {
    const atLeast = (value: number) => ({ comparator: "gte" as const, target: { value, unit: "stars" } });
    expect(targetInView("volume", [40, 60], atLeast(100))).toBe(true);
    expect(targetInView("volume", [15, 18], atLeast(1))).toBe(false);
    expect(targetInView("volume", [15, 18], atLeast(14))).toBe(true);
    expect(targetInView("progress", [0.2], atLeast(1))).toBe(true);
  });
});

describe("unknown", () => {
  it("is never zero", () => {
    expect(progressFraction(k("ratio", null, 1))).toBeNull();
    expect(cardHint(k("ratio", null, 1), "progress", null)).toBe("≥ 1.00");
    expect(progressFraction(k("items", 50, 40, "lte"))).toBeCloseTo(0.8);
    expect(progressFraction(k("items", 30, 40, "lte"))).toBe(1);
  });
});
