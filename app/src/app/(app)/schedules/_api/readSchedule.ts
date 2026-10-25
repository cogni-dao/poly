// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node-owned fetch bindings validate the published schedule wire contracts. */
import {
  schedulesGetOperation,
  schedulesHistoryOperation,
} from "@cogni/scheduling";

async function read(url: string): Promise<unknown> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
export async function readSchedule(id: string) {
  return schedulesGetOperation.output.parse(
    await read(`/api/v1/schedules/${encodeURIComponent(id)}`)
  );
}
export async function readScheduleRuns(id: string, cursor?: string) {
  const query = new URLSearchParams({
    limit: "20",
    ...(cursor ? { cursor } : {}),
  });
  return schedulesHistoryOperation.output.parse(
    await read(`/api/v1/schedules/${encodeURIComponent(id)}/runs?${query}`)
  );
}
