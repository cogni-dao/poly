// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PolyDataApiRateLimitedError,
  PolyDataApiRequestError,
} from "@cogni/poly-market-provider/adapters/polymarket";
import {
  PositionObservationBudget,
  PositionObservationController,
} from "@/features/wallet-analysis/server/position-observation-control";

import {
  parseTerminalResume,
  positionErrorMessage,
  readTerminalRecovery,
  terminalSweepComplete,
  type TerminalKey,
} from "@/features/wallet-analysis/server/terminal-position-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("position observation process admission", () => {
  it("coalesces a canonical wallet across DB IDs/clients and gives joiners independent cancellation", async () => {
    const control = new PositionObservationController();
    const gate = deferred<number>();
    const work = vi.fn(() => gate.promise);
    const owner = control.run("0xABC", undefined, work);
    const abort = new AbortController();
    const joined = control.run("0xabc", abort.signal, work);
    const rejection = expect(joined).rejects.toThrow("joiner stopped");
    abort.abort(new Error("joiner stopped"));
    await rejection;
    expect(control.activeCount).toBe(1);
    gate.resolve(7);
    expect(await owner).toEqual({ value: 7, joined: false });
    expect(work).toHaveBeenCalledTimes(1);
    expect(control.activeCount).toBe(0);
  });

  it("admits three distinct wallets, defers a fourth without queueing and retains a cancelled owner's unsettled IO", async () => {
    const control = new PositionObservationController();
    const gate = deferred<number>();
    const signal = new AbortController();
    const owner = control.run("a", signal.signal, () => gate.promise);
    const b = control.run("b", undefined, () => gate.promise);
    const c = control.run("c", undefined, () => gate.promise);
    signal.abort();
    const extra = vi.fn(async () => 4);
    expect(await control.run("d", undefined, extra)).toEqual({
      deferred: "capacity",
    });
    expect(extra).not.toHaveBeenCalled();
    expect(control.activeCount).toBe(3);
    gate.resolve(1);
    await Promise.all([owner, b, c]);
    expect(control.activeCount).toBe(0);
  });
});

describe("finite shared invocation allowances", () => {
  const transient = () => new PolyDataApiRequestError("503", true, 503);
  it("uses one retry across components/CAS rather than restarting the invocation", async () => {
    const wait = vi.fn(async () => {});
    const budget = new PositionObservationBudget(
      new PositionObservationController({ wait, random: () => 0 })
    );
    const page = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce("ok");
    expect(await budget.call("data_api", page)).toBe("ok");
    const laterPreparation = vi.fn().mockRejectedValue(transient());
    await expect(budget.call("data_api", laterPreparation)).rejects.toThrow(
      "503"
    );
    expect(page).toHaveBeenCalledTimes(2);
    expect(laterPreparation).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(budget.dataApiCalls).toBe(3);
  });

  it.each([
    new SyntaxError("bad JSON"),
    new PolyDataApiRateLimitedError("/positions", 30_000),
    new PolyDataApiRequestError("400", false, 400),
  ])("never retries semantic/cooldown errors %#", async (error) => {
    const wait = vi.fn(async () => {});
    const budget = new PositionObservationBudget(
      new PositionObservationController({ wait })
    );
    const read = vi.fn().mockRejectedValue(error);
    await expect(budget.call("data_api", read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("charges all twenty page calls across two preparations and only one extra retry", async () => {
    const budget = new PositionObservationBudget(
      new PositionObservationController({ wait: async () => {} })
    );
    const read = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(1);
    for (let n = 0; n < 20; n += 1) await budget.call("data_api", read);
    expect(read).toHaveBeenCalledTimes(21);
    await expect(budget.call("data_api", read)).rejects.toThrow(
      "allowance exhausted"
    );
    expect(read).toHaveBeenCalledTimes(21);
  });
});


describe("durable terminal recovery control", () => {
  const hint = {
    reason: "authority_unavailable" as const,
    anchor: ["c", "100"] as const,
  };
  it("preserves the anchor across ordinary errors while preventing provider control-line injection", () => {
    const message = positionErrorMessage(hint, {
      reason: "data_api_error",
      detail: "503\nterminal_recovery_v1:evil",
    });
    expect(
      message?.startsWith("data_api_error: 503 terminal_recovery_v1:evil\n")
    ).toBe(true);
    expect(readTerminalRecovery(message)).toEqual({
      recovery: hint,
      malformed: false,
    });
    expect(
      readTerminalRecovery("provider said terminal_recovery_v1:evil").recovery
    ).toBeNull();
    expect(
      readTerminalRecovery("data_api_error: terminal_recovery_v1:evil").recovery
    ).toBeNull();
    expect(
      positionErrorMessage(null, {
        reason: "data_api_error",
        detail: "x".repeat(4_000),
      })?.length
    ).toBeLessThan(2_100);
  });
  it.each([
    'terminal_recovery_v1:{"reason":"authority_unavailable","anchor":[],"extra":1}',
    "terminal_recovery_v2:{}",
    "data_api_error: 503\nterminal_recovery_v1:bad",
    `terminal_recovery_v1:${JSON.stringify({ ...hint, anchor: ["x".repeat(257), "1"] })}`,
    `terminal_recovery_v1:${JSON.stringify({ ...hint, anchor: ["c\n", "1"] })}`,
  ])("keeps malformed reserved state conservatively pending: %s", (message) => {
    expect(readTerminalRecovery(message)).toEqual({
      recovery: { reason: "authority_unavailable", anchor: null },
      malformed: true,
    });
  });
  it("strictly bounds and validates fairness keys", () => {
    expect(parseTerminalResume('["c","1"]')).toEqual(["c", "1"]);
    for (const value of [
      '["","1"]',
      '["c",1]',
      '["c","1","2"]',
      " ".repeat(1_101),
    ])
      expect(parseTerminalResume(value)).toBeNull();
  });
  const key = (token: string): TerminalKey => ["c", token];
  const sweep = (
    anchor: TerminalKey | null,
    previous: TerminalKey | null,
    tokens: string[],
    completePass = false
  ) =>
    terminalSweepComplete({
      anchor,
      previous,
      classified: tokens.map(key),
      completePass,
    });
  it("does not mistake departure or a different prefix for recovery", () => {
    expect(sweep(key("100"), key("100"), ["101", "200", "001", "099"])).toBe(
      false
    );
    expect(sweep(key("100"), key("100"), [])).toBe(false);
    expect(sweep(key("100"), key("100"), ["101", "100"])).toBe(true);
  });
  it("detects absent-anchor crossing and split wraps without attempted-key evidence", () => {
    expect(sweep(key("100"), key("099"), ["101"])).toBe(true);
    expect(sweep(key("100"), key("200"), ["001"])).toBe(false);
    expect(sweep(key("100"), key("099"), [])).toBe(false);
    expect(sweep(null, key("200"), ["001"])).toBe(true);
    expect(sweep(null, null, ["001", "200"])).toBe(false);
    expect(sweep(key("100"), null, [], true)).toBe(true);
  });
});
