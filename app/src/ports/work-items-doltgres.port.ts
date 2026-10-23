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
  WorkItemCommandPort,
  WorkItemId,
  WorkItemsPort,
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
  readonly set: WorkItemsPatchSet;
}

/** Published content + the sole PostgreSQL lease authority; no local lease protocol. */
export type WorkItemsDoltgresPort = WorkItemsPort;
