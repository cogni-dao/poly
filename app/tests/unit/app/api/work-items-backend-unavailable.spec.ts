// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/work-items-backend-unavailable`
 * Purpose: A busy work-item store answers 503 with its closed reason, never the store's error text (task.0162).
 * Scope: The one `backendUnavailable` helper and the facade's busy classification. No routes, no store.
 * Side-effects: none
 * Links: src/app/api/v1/work/items/_backend-unavailable.ts
 * @public
 */

import { describe, expect, it, vi } from "vitest";

import { backendUnavailable } from "@/app/api/v1/work/items/_backend-unavailable";

describe("work items busy 503", () => {
  // Defect guarded: a busy 503 once logged no reason and carried no closed `code`.
  it("names the closed reason in the body and the log line", async () => {
    const info = vi.fn();
    const response = backendUnavailable(
      { log: { info } as never, reqId: "req-1", routeId: "work.items.claims" },
      "queue_timeout"
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: "queue_timeout" });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: "work.items.backend_unavailable",
      status: 503,
      errorCode: "backend_unavailable",
      reason: "queue_timeout",
    });
  });
});
