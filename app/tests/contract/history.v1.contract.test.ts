// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/history.v1.contract`
 * Purpose: Proves the PATCH `reason` field and the published history schemas reach Poly's node contracts (story.0023).
 * Scope: Pure Zod validation of re-exported package schemas. Does not test HTTP transport or Doltgres.
 * Invariants: reason is optional, 1-512 chars after CR/LF become spaces; both history operations share one item schema.
 * Side-effects: none
 * Links: packages/node-contracts/src/history.v1.contract.ts
 * @internal
 */

import {
  knowledgeHistoryOperation,
  workItemsHistoryOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const base = { id: "task.0001", reason: "test change", set: { title: "t" } };

describe("work.items.patch.v1 reason", () => {
  it("accepts a patch with a reason", () => {
    expect(workItemsPatchOperation.input.safeParse(base).success).toBe(true);
  });

  it("rejects a patch without a reason", () => {
    const { reason: _reason, ...withoutReason } = base;
    expect(workItemsPatchOperation.input.safeParse(withoutReason).success).toBe(
      false
    );
  });

  it("accepts cites and rejects more than eight", () => {
    expect(
      workItemsPatchOperation.input.safeParse({
        ...base,
        cites: [{ id: "change-history-design" }],
      }).success
    ).toBe(true);
    expect(
      workItemsPatchOperation.input.safeParse({
        ...base,
        cites: Array.from({ length: 9 }, (_, i) => ({ id: `atom-${i}` })),
      }).success
    ).toBe(false);
  });

  it("accepts a one-line reason beside expectedRevision", () => {
    const parsed = workItemsPatchOperation.input.safeParse({
      ...base,
      expectedRevision: 3,
      reason: "Pivot per decision-x",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty or over-240-character reason", () => {
    expect(
      workItemsPatchOperation.input.safeParse({ ...base, reason: "" }).success
    ).toBe(false);
    expect(
      workItemsPatchOperation.input.safeParse({
        ...base,
        reason: "x".repeat(241),
      }).success
    ).toBe(false);
  });
});

describe("history operations", () => {
  it("work items and knowledge declare one history item shape", () => {
    expect(z.toJSONSchema(workItemsHistoryOperation.output)).toEqual(
      z.toJSONSchema(knowledgeHistoryOperation.output)
    );
  });
});
