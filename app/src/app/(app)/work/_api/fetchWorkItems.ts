// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for bounded work summary pages, the work board, and item detail.
 * Scope: Calls the summary, board and detail endpoints with type-safe contracts. Does not implement business logic.
 * Invariants:
 *   - Returns typed summary pages, board columns or details, or throws `WorkItemFetchError` carrying the HTTP status (the package hooks retry only 5xx and network failures)
 *   - BOUNDED_BOARD_READS: the only list reads are one `/work/summaries` page and one `/work/board` request; nothing here walks cursors (task.0056)
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type {
  WorkItemDto,
  WorkItemSummariesListOutput,
} from "@cogni/node-contracts";
import type { WorkBoardColumns } from "@cogni/work-items";

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

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    ...(signal && { signal }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok)
    throw new WorkItemFetchError(
      await responseErrorMessage(response, `HTTP ${response.status}`),
      response.status
    );
  return response.json() as Promise<T>;
}

/** Fetch one bounded server-filtered summary page (params from the shared codec). */
export function fetchWorkItems(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<WorkItemSummariesListOutput> {
  return getJson(`/api/v1/work/summaries?${params}`, signal);
}

/** Fetch the first page of every visible board column in one request. */
export function fetchWorkBoard(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<WorkBoardColumns> {
  return getJson(`/api/v1/work/board?${params}`, signal);
}

export async function fetchWorkItem(
  id: string,
  signal?: AbortSignal
): Promise<WorkItemDto> {
  const response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}`, {
    method: "GET",
    ...(signal && { signal }),
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
