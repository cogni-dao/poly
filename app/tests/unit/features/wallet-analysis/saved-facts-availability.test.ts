// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `saved-facts-availability.test`
 * Purpose: Prove missing/unready observer state cannot become a valid empty
 *   wallet, while a successful source cursor authorizes observed-empty output.
 * Scope: Pure availability classification; no mocked DB and no upstream IO.
 * Invariants: MISSING_IS_NOT_EMPTY, OBSERVED_EMPTY_IS_ZERO, PAGE_LOAD_DB_ONLY.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/wallet-analysis-service.ts
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";
import { classifySavedFactsAvailability } from "@/features/wallet-analysis/server/wallet-analysis-service";

describe("classifySavedFactsAvailability", () => {
  const now = new Date("2026-10-02T12:05:00.000Z");
  it("distinguishes a missing observer wallet from observed-empty", () => {
    expect(
      classifySavedFactsAvailability(undefined, "data-api-positions")
    ).toEqual({ kind: "wallet_missing" });
  });

  it.each(["pending", "partial", "stale", "error"])(
    "does not authorize zero for a %s source cursor",
    (cursorStatus) => {
      expect(
        classifySavedFactsAvailability(
          {
            walletId: "wallet-1",
            cursorStatus,
            lastSuccessAt: new Date("2026-10-02T12:00:00.000Z"),
          },
          "data-api-positions",
          now
        )
      ).toEqual({
        kind: "source_not_ready",
        source: "data-api-positions",
        cursorStatus,
        lastSuccessAt: new Date("2026-10-02T12:00:00.000Z"),
        reason: "status",
      });
    }
  );

  it("requires a recorded successful observation time", () => {
    expect(
      classifySavedFactsAvailability(
        { walletId: "wallet-1", cursorStatus: "ok", lastSuccessAt: null },
        "data-api-trades"
      )
    ).toEqual({
      kind: "source_not_ready",
      source: "data-api-trades",
      cursorStatus: "ok",
      lastSuccessAt: null,
      reason: "missing_timestamp",
    });
  });

  it("expires a formerly successful cursor after the freshness window", () => {
    const lastSuccessAt = new Date("2026-10-02T11:54:59.000Z");
    expect(
      classifySavedFactsAvailability(
        { walletId: "wallet-1", cursorStatus: "ok", lastSuccessAt },
        "data-api-positions",
        now
      )
    ).toEqual({
      kind: "source_not_ready",
      source: "data-api-positions",
      cursorStatus: "ok",
      lastSuccessAt,
      reason: "expired",
    });
  });

  it("authorizes empty output only after an ok successful source cursor", () => {
    expect(
      classifySavedFactsAvailability(
        {
          walletId: "wallet-1",
          cursorStatus: "ok",
          lastSuccessAt: new Date("2026-10-02T12:00:00.000Z"),
        },
        "data-api-positions",
        now
      )
    ).toEqual({
      kind: "ready",
      walletId: "wallet-1",
      lastSuccessAt: new Date("2026-10-02T12:00:00.000Z"),
    });
  });
});
