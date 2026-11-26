// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.write-events.contract`
 * Purpose: The node's event registry and the package's route cores name the same work-item write (bug.0063) and read (story.0085)
 *   events, so a Loki query written against the registry finds what the package emits.
 * Scope: Constant parity only.
 * Invariants: EVENT_NAMES_HERE (package owns the names; the registry repeats them).
 * Side-effects: none
 * @internal
 */

import { WORK_ITEM_READ_EVENTS, WORK_ITEM_WRITE_EVENTS } from "@cogni/work-items";
import { describe, expect, it } from "vitest";

import { EVENT_NAMES } from "@/shared/observability";

describe("work-item write events", () => {
  it("the registry names equal the package's", () => {
    expect({
      createSuccess: EVENT_NAMES.WORK_ITEMS_CREATE_SUCCESS,
      createRefused: EVENT_NAMES.WORK_ITEMS_CREATE_REFUSED,
      patchSuccess: EVENT_NAMES.WORK_ITEMS_PATCH_SUCCESS,
      patchRefused: EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED,
    }).toEqual(WORK_ITEM_WRITE_EVENTS);
  });

  it("the registry names equal the package's read events", () => {
    expect({
      getSuccess: EVENT_NAMES.WORK_ITEMS_GET_SUCCESS,
      getRefused: EVENT_NAMES.WORK_ITEMS_GET_REFUSED,
    }).toEqual(WORK_ITEM_READ_EVENTS);
  });
});
