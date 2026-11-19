// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `slice-failure-logging.test`
 * Purpose: A wallet-analysis slice that fails with Postgres 53300 is served as a
 *   warning AND logged once with event + slice + cause_code (bug.5064) — it used to
 *   vanish into `warnings[]` with no Loki trace.
 * Scope: Unit; the PnL read and the logger are mocked, no Postgres.
 * Invariants: SLICE_FAILURE_LOGGED_ONCE, NO_PAYLOAD.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/slice-failure.ts
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  pnlRead: vi.fn(),
}));

vi.mock("@/shared/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/observability")>();
  return { ...actual, makeLogger: () => ({ warn: mocks.warn }) };
});
vi.mock("@/features/wallet-analysis/server/trading-wallet-overview-service", () => ({
  getTradingWalletPnlHistoryRead: mocks.pnlRead,
}));

import {
  isDbCapacityError,
  sliceFailureFields,
} from "@/features/wallet-analysis/server/slice-failure";
import { getPnlSlice } from "@/features/wallet-analysis/server/wallet-analysis-service";

const ADDRESS = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";

/** postgres-js shape: PostgresError with the SQLSTATE on `.code`. */
function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PostgresError", code });
}

describe("wallet-analysis slice failure logging (bug.5064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs one structured warn with event, slice and cause_code 53300, and still serves the warning", async () => {
    mocks.pnlRead.mockRejectedValue(
      postgresError("53300", 'too many connections for role "service_poly"')
    );

    const result = await getPnlSlice({} as never, ADDRESS, "1M");

    expect(result).toEqual({
      kind: "warn",
      warning: {
        slice: "pnl",
        code: "upstream_failed",
        message: 'too many connections for role "service_poly"',
      },
    });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = mocks.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({
      event: "poly.wallet_analysis.slice_failed",
      slice: "pnl",
      cause_code: "53300",
      err_class: "PostgresError",
    });
    expect(message).toMatch(/slice failed/);
  });

  it("does not log when the slice succeeds", async () => {
    mocks.pnlRead.mockResolvedValue({
      status: "ok",
      points: [],
      observedAt: new Date().toISOString(),
    });
    const result = await getPnlSlice({} as never, ADDRESS, "1M");
    expect(result.kind).toBe("ok");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("reads the SQLSTATE from a drizzle-wrapped cause", () => {
    const wrapped = new Error("Failed query: select ...", {
      cause: postgresError("53300", "too many connections"),
    });
    expect(sliceFailureFields("pnl", wrapped).cause_code).toBe("53300");
    expect(isDbCapacityError(wrapped)).toBe(true);
  });

  it("classifies connection-capacity failures only", () => {
    expect(isDbCapacityError(postgresError("53300", "x"))).toBe(true);
    expect(
      isDbCapacityError(new Error('too many connections for role "service_poly"'))
    ).toBe(true);
    expect(isDbCapacityError(postgresError("42P01", "relation missing"))).toBe(
      false
    );
    expect(isDbCapacityError(new Error("boom"))).toBe(false);
    expect(isDbCapacityError(undefined)).toBe(false);
  });
});
