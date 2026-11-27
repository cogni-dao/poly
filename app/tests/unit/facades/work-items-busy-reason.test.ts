// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-items-busy-reason`
 * Purpose: A busy store error reaches the routes as `WorkItemsBackendNotReadyError` carrying its closed reason (task.0162).
 * Scope: The facade's busy classification through `getWorkItem`, with a mocked container.
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import {
  getWorkItem,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getContainer } from "@/bootstrap/container";

async function failWith(error: Error) {
  vi.mocked(getContainer).mockReturnValue({
    doltgresWorkItems: { get: vi.fn().mockRejectedValue(error) },
  } as never);
  return getWorkItem("task.0001").catch((e: unknown) => e);
}

describe("work items facade busy classification", () => {
  // Defect guarded: the facade dropped the busy reason, so every busy 503 answered with no closed `code`.
  it("keeps the reason a busy error carries", async () => {
    const busy = Object.assign(new Error("store detail"), {
      name: "WorkItemsBusyError",
      reason: "queue_timeout",
    });
    const result = await failWith(busy);
    expect(result).toBeInstanceOf(WorkItemsBackendNotReadyError);
    expect((result as WorkItemsBackendNotReadyError).reason).toBe("queue_timeout");
  });

  it("names a busy error with no reason as capacity_held", async () => {
    const busy = Object.assign(new Error("store detail"), {
      name: "WorkItemsBusyError",
    });
    const result = await failWith(busy);
    expect(result).toBeInstanceOf(WorkItemsBackendNotReadyError);
    expect((result as WorkItemsBackendNotReadyError).reason).toBe("capacity_held");
  });
});
