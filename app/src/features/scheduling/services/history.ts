// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Poly's authenticated identity binding; shared package owns metadata paging. */
import { toUserId } from "@cogni/ids";
import {
  createScheduleHistoryService,
  type ScheduleRunReader,
} from "@cogni/scheduling";
import type { ScheduleUserPort } from "@/ports/server";

export function createOwnedScheduleHistory(deps: {
  scheduleManager: Pick<ScheduleUserPort, "getSchedule">;
  scheduleRunReader: ScheduleRunReader;
}) {
  return createScheduleHistoryService({
    getSchedule: (caller, id) =>
      deps.scheduleManager.getSchedule(toUserId(caller), id),
    reader: deps.scheduleRunReader,
  });
}
