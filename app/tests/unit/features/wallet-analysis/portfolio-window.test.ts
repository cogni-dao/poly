// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Canonical portfolio-window boundary coverage. */
import { describe, expect, it } from "vitest";
import { portfolioWindowStart } from "@/features/wallet-analysis/server/portfolio-window";

const CAPTURED_AT = "2026-10-07T20:30:00.000Z";

describe("portfolioWindowStart", () => {
  it.each([
    ["1D", "2026-10-06T20:30:00.000Z"],
    ["1W", "2026-09-30T20:30:00.000Z"],
    ["1M", "2026-09-07T20:30:00.000Z"],
    ["1Y", "2025-10-07T20:30:00.000Z"],
    ["YTD", "2026-01-01T00:00:00.000Z"],
  ] as const)("maps %s to the shared UTC cutoff", (interval, expected) => {
    expect(portfolioWindowStart(interval, CAPTURED_AT)?.toISOString()).toBe(
      expected
    );
  });

  it("leaves ALL unbounded", () => {
    expect(portfolioWindowStart("ALL", CAPTURED_AT)).toBeNull();
  });

  it("fails open for an invalid snapshot timestamp", () => {
    expect(portfolioWindowStart("1D", "not-a-date")).toBeNull();
  });
});
