// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers open, close, and browser-back semantics for work-item permalinks. */

import { describe, expect, it, vi } from "vitest";

import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  workItemHref,
  workListHref,
  workViewHref,
} from "@/app/(app)/work/_lib/workItemNavigation";

const searchParams = new URLSearchParams(
  "status=needs_implement&sort=priority&q=permalink"
);

describe("work-item permalink navigation", () => {
  it("builds exact human routes while preserving useful list state", () => {
    expect(workItemHref("subtask.5001", searchParams)).toBe(
      "/work/items/subtask.5001?status=needs_implement&sort=priority&q=permalink"
    );
    expect(workListHref(searchParams)).toBe(
      "/work?status=needs_implement&sort=priority&q=permalink"
    );
  });

  it("pushes selection so browser Back returns to the list", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    openWorkItemPermalink(router, "story.5000", searchParams);

    expect(router.push).toHaveBeenCalledWith(
      "/work/items/story.5000?status=needs_implement&sort=priority&q=permalink",
      { scroll: false }
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("encodes the logical id exactly once at the human URL boundary", () => {
    expect(workItemHref("bug.%2F", new URLSearchParams())).toBe(
      "/work/items/bug.%252F"
    );
  });

  it("updates owned controls without losing unrelated list state", () => {
    expect(
      workViewHref(
        "task.5174",
        new URLSearchParams("cursor=opaque&type=bug&status=needs_design"),
        {
          type: ["task"],
          status: ["needs_implement"],
          project: ["proj.work"],
          sort: "-priority",
          query: "permalink",
        }
      )
    ).toBe(
      "/work/items/task.5174?cursor=opaque&type=task&status=needs_implement&project=proj.work&sort=-priority&q=permalink"
    );
  });

  it("replaces a closed sheet with its preserved list URL", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    closeWorkItemPermalink(router, searchParams);

    expect(router.replace).toHaveBeenCalledWith(
      "/work?status=needs_implement&sort=priority&q=permalink",
      { scroll: false }
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});
