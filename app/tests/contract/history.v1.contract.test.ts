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

const base = { id: "task.0001", set: { title: "t" } };

describe("work.items.patch.v1 reason", () => {
  it("accepts a patch without a reason", () => {
    expect(workItemsPatchOperation.input.safeParse(base).success).toBe(true);
  });

  it("accepts a one-line reason beside expectedRevision", () => {
    const parsed = workItemsPatchOperation.input.safeParse({
      ...base,
      expectedRevision: 3,
      reason: "Pivot per decision-x",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty or over-512-character reason", () => {
    expect(
      workItemsPatchOperation.input.safeParse({ ...base, reason: "" }).success
    ).toBe(false);
    expect(
      workItemsPatchOperation.input.safeParse({
        ...base,
        reason: "x".repeat(513),
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
