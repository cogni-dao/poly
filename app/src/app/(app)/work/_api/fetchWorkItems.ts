// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrapper for work items list.
 * Scope: Calls /api/v1/work/items with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed WorkItemsListOutput or throws
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";

export class WorkItemFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkItemFetchError";
    this.status = status;
  }
}

export function isWorkItemNotFoundError(
  error: unknown
): error is WorkItemFetchError {
  return error instanceof WorkItemFetchError && error.status === 404;
}

async function responseErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

export async function fetchWorkItems(): Promise<WorkItemsListOutput> {
  const items: WorkItemDto[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "500" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/v1/work/items?${params}`, {
      method: "GET", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", cache: "no-store",
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, `HTTP ${response.status}`));
    const page: WorkItemsListOutput = await response.json();
    items.push(...page.items);
    cursor = page.pageInfo?.hasMore === false ? undefined : page.nextCursor ?? page.pageInfo?.endCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Work-items cursor did not advance");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { items, pageInfo: { endCursor: null, hasMore: false } };
}

export async function fetchWorkItem(id: string): Promise<WorkItemDto> {
  const response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const message = await responseErrorMessage(
      response,
      `Failed to fetch work item (HTTP ${response.status})`
    );
    throw new WorkItemFetchError(message, response.status);
  }
  return response.json() as Promise<WorkItemDto>;
}
