// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(),
  resolveAppDb: vi.fn(),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_config: unknown, handler: unknown) => handler,
}));

import { executionCompletionDiagnostics } from "@/app/api/v1/poly/wallet/execution/route";
import { overviewCompletionDiagnostics } from "@/app/api/v1/poly/wallet/overview/route";

describe.each([
  ["overview", overviewCompletionDiagnostics],
  ["execution", executionCompletionDiagnostics],
])("%s route completion diagnostics", (_route, diagnostics) => {
  it("keeps a warning-free completion ok", () => {
    expect(diagnostics("ok", [])).toEqual({
      status: "ok",
      warnings: 0,
      warning_codes: [],
    });
  });

  it("sorts and deduplicates warning codes and degrades an ok status", () => {
    expect(
      diagnostics("ok", [
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
    expect(diagnostics("positions_read_model_unavailable", ["z", "a"]))
      .toMatchObject({
        status: "positions_read_model_unavailable",
        warning_codes: ["a", "z"],
      });
  });
});
