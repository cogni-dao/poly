// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded durable scheduling hints; never quantity or valuation authority. */
export type TerminalKey = readonly [string, string];
export type TerminalRecovery = {
  reason: "authority_unavailable" | "authority_malformed" | "authority_budget";
  anchor: TerminalKey | null;
};
const PREFIX = "terminal_recovery_v1:";
const RESERVED = "terminal_recovery_";

export function terminalKey(value: unknown): TerminalKey | null {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (part) =>
        typeof part === "string" &&
        part.length > 0 &&
        part.length <= 256 &&
        /^[A-Za-z0-9_-]+$/.test(part)
    )
    ? (value as unknown as TerminalKey)
    : null;
}

export function parseTerminalResume(value: string | null): TerminalKey | null {
  if (!value || value.length > 1_100) return null;
  try {
    return terminalKey(JSON.parse(value));
  } catch {
    return null;
  }
}

export function readTerminalRecovery(message: string | null | undefined): {
  recovery: TerminalRecovery | null;
  malformed: boolean;
} {
  const lines = message?.split("\n") ?? [];
  const line = lines.at(-1);
  const ordinaryPrefix =
    /^(data_api_error|data_api_incomplete|data_api_malformed|omission_over_cap|authority_unavailable|authority_malformed|authority_nonzero|superseded_exhausted): /;
  if (
    lines.length > 2 ||
    (lines.length === 2 && !ordinaryPrefix.test(lines[0] ?? "")) ||
    !line?.startsWith(RESERVED)
  ) {
    return { recovery: null, malformed: false };
  }
  if (line.startsWith(PREFIX) && line.length <= 1_200) {
    try {
      const data: unknown = JSON.parse(line.slice(PREFIX.length));
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        const anchor = obj.anchor === null ? null : terminalKey(obj.anchor);
        if (
          Object.keys(obj).length === 2 &&
          "anchor" in obj &&
          (obj.anchor === null || anchor !== null) &&
          (obj.reason === "authority_unavailable" ||
            obj.reason === "authority_malformed" ||
            obj.reason === "authority_budget")
        ) {
          return { recovery: { reason: obj.reason, anchor }, malformed: false };
        }
      }
    } catch {
      /* Invalid reserved state conservatively requests a new sweep. */
    }
  }
  return {
    recovery: { reason: "authority_unavailable", anchor: null },
    malformed: true,
  };
}

export function positionErrorMessage(
  recovery: TerminalRecovery | null,
  failure?: { reason: string; detail: string }
): string | null {
  const ordinary = failure
    ? `${failure.reason}: ${failure.detail.replace(/[\r\n]/g, " ").slice(0, 2_048)}`
    : null;
  const control = recovery ? PREFIX + JSON.stringify(recovery) : null;
  return ordinary && control
    ? `${ordinary}\n${control}`
    : (ordinary ?? control);
}

function compare(a: TerminalKey, b: TerminalKey): number {
  return a[0] < b[0]
    ? -1
    : a[0] > b[0]
      ? 1
      : a[1] < b[1]
        ? -1
        : a[1] > b[1]
          ? 1
          : 0;
}

/** Only successfully classified keys advance recovery; attempted keys are fairness only. */
export function terminalSweepComplete(input: {
  anchor: TerminalKey | null;
  previous: TerminalKey | null;
  classified: readonly TerminalKey[];
  completePass: boolean;
}): boolean {
  if (input.completePass) return true;
  const rankCompare = (a: TerminalKey, b: TerminalKey): number => {
    if (!input.anchor) return compare(a, b);
    const aRank = compare(a, input.anchor) > 0 ? 0 : 1;
    const bRank = compare(b, input.anchor) > 0 ? 0 : 1;
    return aRank - bRank || compare(a, b);
  };
  let previous = input.previous;
  for (const key of input.classified) {
    if (input.anchor && compare(key, input.anchor) === 0) return true;
    if (
      previous &&
      (!input.anchor || compare(previous, input.anchor) !== 0) &&
      rankCompare(key, previous) < 0
    )
      return true;
    previous = key;
  }
  return false;
}
