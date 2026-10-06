// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/copy-trade-attempts-cursor`
 * Purpose: Pin the attempt tape's frozen keyset cursor and its hard bounds.
 * Scope: Pure functions and schema validation. No DB.
 * Invariants:
 *   - CURSOR_IS_OPAQUE_AND_ROUND_TRIPS — base64url of the `(decided_at, id)`
 *     tuple; anything else raises `InvalidAttemptCursorError`, which the
 *     capability plane renders as a 400 rather than a 500.
 *   - BOUNDS_ARE_NOT_NEGOTIABLE — max 200 per page, enforced by the contract.
 * Side-effects: none
 * Links: task.1791070959
 * @internal
 */

import {
  POLY_COPY_ATTEMPTS_DEFAULT_LIMIT,
  POLY_COPY_ATTEMPTS_MAX_LIMIT,
  PolyAccountRecentAttemptsQuerySchema,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import {
  decodeAttemptCursor,
  encodeAttemptCursor,
  InvalidAttemptCursorError,
} from "@/features/wallet-analysis/server/copy-trade-attempts-read";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

describe("attempt tape cursor", () => {
  it("round-trips the keyset tuple", () => {
    const cursor = {
      decidedAt: "2026-10-05T00:00:00.000Z",
      attemptId: ATTEMPT,
    };
    expect(decodeAttemptCursor(encodeAttemptCursor(cursor))).toEqual(cursor);
  });

  it("is opaque — it does not leak the tuple in plain text", () => {
    const encoded = encodeAttemptCursor({
      decidedAt: "2026-10-05T00:00:00.000Z",
      attemptId: ATTEMPT,
    });
    expect(encoded).not.toContain(ATTEMPT);
    expect(encoded).not.toContain("2026-10-05");
    // base64url only: no padding and no +/ characters, so it is URL-safe.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["not base64", "!!!not-a-cursor!!!"],
    ["not JSON", Buffer.from("plain text", "utf8").toString("base64url")],
    [
      "missing attemptId",
      Buffer.from(
        JSON.stringify({ decidedAt: "2026-10-05T00:00:00.000Z" }),
        "utf8"
      ).toString("base64url"),
    ],
    [
      "empty attemptId",
      Buffer.from(
        JSON.stringify({
          decidedAt: "2026-10-05T00:00:00.000Z",
          attemptId: "",
        }),
        "utf8"
      ).toString("base64url"),
    ],
    [
      "unparseable timestamp",
      Buffer.from(
        JSON.stringify({ decidedAt: "never", attemptId: ATTEMPT }),
        "utf8"
      ).toString("base64url"),
    ],
  ])("rejects a cursor that is %s", (_label, value) => {
    // Must be this specific error: the handler classifier maps it to a 400.
    // Any other throw would surface as a 500 and read as an outage.
    expect(() => decodeAttemptCursor(value)).toThrow(InvalidAttemptCursorError);
  });
});

describe("attempt tape bounds", () => {
  const parse = (input: Record<string, unknown>) =>
    PolyAccountRecentAttemptsQuerySchema.parse({
      billing_account_id: ACCOUNT,
      ...input,
    });

  it("defaults to a bounded page with both filters wide open", () => {
    const query = parse({});
    expect(query.limit).toBe(POLY_COPY_ATTEMPTS_DEFAULT_LIMIT);
    expect(query.mode).toBe("all");
    expect(query.outcome).toBe("all");
    // Page 1 omits the cutoff; the server freezes it.
    expect(query.captured_at).toBeUndefined();
  });

  it("coerces a query-string limit, because every GET param is a string", () => {
    expect(parse({ limit: "25" }).limit).toBe(25);
  });

  it(`refuses a page larger than ${POLY_COPY_ATTEMPTS_MAX_LIMIT}`, () => {
    expect(() => parse({ limit: String(POLY_COPY_ATTEMPTS_MAX_LIMIT + 1) })).toThrow();
    expect(parse({ limit: String(POLY_COPY_ATTEMPTS_MAX_LIMIT) }).limit).toBe(
      POLY_COPY_ATTEMPTS_MAX_LIMIT
    );
  });

  it.each([["0"], ["-1"]])("refuses a non-positive limit (%s)", (value) => {
    expect(() => parse({ limit: value })).toThrow();
  });

  it("refuses an inverted since/until window", () => {
    expect(() =>
      parse({
        since: "2026-10-05T00:00:00.000Z",
        until: "2026-10-04T00:00:00.000Z",
      })
    ).toThrow();
  });

  it("requires a billing account — the tape is never account-blind", () => {
    expect(() =>
      PolyAccountRecentAttemptsQuerySchema.parse({ limit: "10" })
    ).toThrow();
  });
});
