// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@/ports/work-items-doltgres.port`
 * Purpose: Poly-local port for the Doltgres-backed `work_items` API surface (task.5044).
 * Scope: Type-only port + input shapes derived from `@cogni/work-items` `WorkItemCommandPort`. Concrete adapter lives in `@/adapters/server/db/doltgres/work-items-adapter`.
 * Invariants: Routes/facades depend on this port, NEVER on the concrete adapter. Container wires either the real adapter or a `NotConfigured` impl when DOLTGRES_URL is unset.
 * Side-effects: none
 * Links: docs/spec/work-items-port.md
 * @public
 */

import type {
  CiteRef,
  HistoryEntry,
  WorkBoardColumnPages,
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkItemSummary,
  WorkItemWriterHealth,
  WorkQuery,
  WorkSummaryReadOptions,
} from "@cogni/work-items";

export type WorkItemsCreateInput = Parameters<WorkItemCommandPort["create"]>[0];

export type WorkItemsPatchSet = NonNullable<
  Parameters<WorkItemCommandPort["patch"]>[0]["set"]
> & {
  readonly deployVerified?: boolean;
  readonly projectId?: string | null;
  readonly parentId?: string | null;
  readonly blockedBy?: string | null;
};

export interface WorkItemsPatchInput {
  readonly id: WorkItemId;
  readonly expectedRevision?: number;
  readonly set: WorkItemsPatchSet;
  /** Required one-line change reason (at most 25 words); stored in the Dolt commit message, never in the item (task.0052, task.0086). */
  readonly reason: string;
  /** Hub atoms this change used (at most 8); the adapter pins each to a commit in history (task.0086). */
  readonly cites?: readonly CiteRef[];
}

export interface WorkItemsDoltgresPort {
  get(id: WorkItemId): Promise<WorkItem | null>;
  list(query?: WorkQuery): Promise<{
    items: WorkItem[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean };
  }>;
  /** One bounded summary page; `options` (signal, deadline, scan budget) only tightens the read (task.0056). */
  listSummaries(
    query?: WorkQuery,
    options?: WorkSummaryReadOptions,
  ): Promise<{
    items: WorkItemSummary[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean; rowsScanned?: number };
  }>;
  /** First page of every listed board column in ONE store read (no text); cursors equal `listSummaries`' (task.0056). */
  listBoardColumns?(
    query: WorkQuery,
    statuses: readonly string[],
    perColumn: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WorkBoardColumnPages>;
  create(input: WorkItemsCreateInput, principalId: string): Promise<WorkItem>;
  patch(input: WorkItemsPatchInput, principalId: string): Promise<WorkItem>;
  delete(id: WorkItemId, principalId: string): Promise<boolean>;
  /** Versions of one item, newest first, with their change reasons (task.0052). */
  history?(id: WorkItemId): Promise<HistoryEntry[]>;
  /** In-memory writer state for deep readiness; makes no database call (bug.0042). */
  writerHealth?(): WorkItemWriterHealth;
  claim(input: {
    id: WorkItemId;
    runId: string;
    command: string;
    principalId: string;
  }): Promise<WorkItem>;
  heartbeat(input: {
    id: WorkItemId;
    runId: string;
    command?: string;
    principalId: string;
  }): Promise<WorkItem>;
  release(input: {
    id: WorkItemId;
    runId: string;
    principalId: string;
  }): Promise<WorkItem>;
}
