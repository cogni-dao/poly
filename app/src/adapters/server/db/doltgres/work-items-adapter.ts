// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Poly's content upgrade preserves its existing v1 Dolt lease authority.
 * Both immutable adapters serialize through legacy advisory key 5001001.
 * The legacy reconciler treats scores as opaque; the new writer validates them.
 * No PostgreSQL lease migration, token conversion or database-only lock cutover.
 */
import type { WorkItem, WorkItemId, WorkQuery } from "@cogni/work-items";
import {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemAdapterOptions,
  WorkItemAuthorizationError,
  WorkItemLeaseConflictError,
  WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";
import { DoltgresWorkItemAdapter as LegacyLeaseAdapter } from "@cogni/legacy-work-items/adapters/doltgres";
import type { Sql } from "postgres";
import type { WorkItemsDoltgresPort } from "@/ports/work-items-doltgres.port";

export { WorkItemAuthorizationError, WorkItemLeaseConflictError, WorkItemsBusyError };

type Options = Omit<DoltgresWorkItemAdapterOptions, "idFloor" | "logger"> & {
  readonly legacyClient?: Sql;
};

type Claim = Pick<WorkItem, "claimedByRun" | "claimedAt" | "lastCommand">;
function project(item: WorkItem, claim: Claim | null): WorkItem {
  const { claimedByRun: _run, claimedAt: _at, lastCommand: _command, ...content } = item;
  return {
    ...content,
    ...(claim?.claimedByRun !== undefined && { claimedByRun: claim.claimedByRun }),
    ...(claim?.claimedAt !== undefined && { claimedAt: claim.claimedAt }),
    ...(claim?.lastCommand !== undefined && { lastCommand: claim.lastCommand }),
  };
}

export class DoltgresPolyWorkItemAdapter implements WorkItemsDoltgresPort {
  private readonly content: DoltgresWorkItemAdapter;
  private readonly legacy: LegacyLeaseAdapter;

  constructor(sql: Sql, logger?: DoltgresWorkItemAdapterOptions["logger"], options: Options = {}) {
    const { legacyClient, ...contentOptions } = options;
    this.content = new DoltgresWorkItemAdapter(sql, {
      ...contentOptions, idFloor: 5000, writerLockProtocol: "bridge",
      ...(logger ? { logger } : {}),
    });
    this.legacy = new LegacyLeaseAdapter(legacyClient ?? sql, {
      idFloor: 5000,
      ...(options.recreateClient ? { recreateClient: options.recreateClient } : {}),
      ...(logger ? { logger } : {}),
    });
  }

  async get(id: WorkItemId): Promise<WorkItem | null> {
    const item = await this.content.get(id);
    return item ? project(item, await this.legacy.get(id)) : null;
  }
  async list(query?: WorkQuery) {
    const result = await this.content.list(query);
    if (!result.items.length) return result;
    const claims = await this.legacy.list({ ids: result.items.map((item) => item.id), limit: 500 });
    const byId = new Map(claims.items.map((item) => [item.id, item]));
    return { ...result, items: result.items.map((item) => project(item, byId.get(item.id) ?? null)) };
  }
  async create(...args: Parameters<WorkItemsDoltgresPort["create"]>) {
    const item = await this.content.create(...args);
    return project(item, await this.legacy.get(item.id));
  }
  async patch(...args: Parameters<WorkItemsDoltgresPort["patch"]>) {
    const item = await this.content.patch(...args);
    return project(item, await this.legacy.get(item.id));
  }
  // Keep Poly's existing authenticated DELETE endpoint compatible during adoption.
  delete(...args: Parameters<WorkItemsDoltgresPort["delete"]>) { return this.legacy.delete(...args); }
  async claim(input: Parameters<WorkItemsDoltgresPort["claim"]>[0]) {
    const claim = await this.legacy.claim(input);
    return project((await this.content.get(input.id)) ?? claim, claim);
  }
  async heartbeat(input: Parameters<WorkItemsDoltgresPort["heartbeat"]>[0]) {
    const claim = await this.legacy.heartbeat(input);
    return project((await this.content.get(input.id)) ?? claim, claim);
  }
  async release(input: Parameters<WorkItemsDoltgresPort["release"]>[0]) {
    const claim = await this.legacy.release(input);
    return project((await this.content.get(input.id)) ?? claim, claim);
  }
  listRelations(id: WorkItemId) { return this.content.listRelations(id); }
}
