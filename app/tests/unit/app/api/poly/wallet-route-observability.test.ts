// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { walletCompletionDiagnostics } from "@/app/api/v1/poly/wallet/_lib/wallet-completion-diagnostics";

describe("wallet route completion diagnostics", () => {
  it("keeps a warning-free completion ok", () => {
    expect(walletCompletionDiagnostics("ok", [])).toEqual({
      status: "ok",
      warnings: 0,
      warning_codes: [],
    });
  });

  it("sorts and deduplicates warning codes and degrades an ok status", () => {
    expect(
      walletCompletionDiagnostics("ok", [
        "positions_stale",
        "balances_partial",
        "positions_stale",
      ])
    ).toEqual({
      status: "degraded",
      warnings: 3,
      warning_codes: ["balances_partial", "positions_stale"],
    });
  });

  it("preserves a specific non-ok status", () => {
    expect(
      walletCompletionDiagnostics("positions_read_model_unavailable", [
        "z",
        "a",
      ])
    ).toMatchObject({
      status: "positions_read_model_unavailable",
      warning_codes: ["a", "z"],
    });
  });
});
