// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations.
 * Scope: Maps Work item ports to contract DTOs. Does not contain business logic.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Side-effects: IO (filesystem read/write via port)
 * Links: [work.items.list.v1.contract](../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type {
  WorkItemDto,
  WorkItemsCreateInput,
  WorkItemsCreateOutput,
  WorkItemsListInput,
  WorkItemsListOutput,
  WorkItemsPatchInput,
  WorkItemsPatchOutput,
} from "@cogni/node-contracts";
import type { WorkItem, WorkItemId } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { getContainer } from "@/bootstrap/container";

const PATCH_UNSUPPORTED_BY_COMMAND_PORT = [
  "blockedBy",
  "deployVerified",
  "parentId",
  "projectId",
] as const satisfies readonly (keyof WorkItemsPatchInput["set"])[];

export class WorkItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Work item not found: ${id}`);
    this.name = "WorkItemNotFoundError";
  }
}

export class UnsupportedWorkItemPatchFieldsError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Unsupported work item patch fields: ${fields.join(", ")}`);
    this.name = "UnsupportedWorkItemPatchFieldsError";
    this.fields = fields;
  }
}

type WorkItemCoordinationDto = {
  nextAction: string | null;
  session: {
    status: "active" | "none";
    claimedByRun: string | null;
    claimedByDisplayName: string | null;
    claimedAt: string | null;
    lastCommand: string | null;
  };
};

function nextActionForWorkItem(item: WorkItem): string | null {
  if (item.blockedBy) return "blocked";
  switch (item.status) {
    case "needs_triage":
      return "/triage";
    case "needs_research":
      return "/research";
    case "needs_design":
      return "/design";
    case "needs_implement":
      return "/implement";
    case "needs_closeout":
      return "/closeout";
    case "needs_merge":
      return item.deployVerified ? "/merge" : "/validate-candidate";
    case "blocked":
      return "blocked";
    case "done":
    case "cancelled":
      return null;
  }
}

function toDto(item: WorkItem): WorkItemDto {
  return {
    id: item.id as string,
    type: item.type,
    title: item.title,
    status: item.status,
    ...(item.actor !== "either" && { actor: item.actor }),
    priority: item.priority,
    rank: item.rank,
    estimate: item.estimate,
    summary: item.summary,
    outcome: item.outcome,
    projectId: item.projectId as string | undefined,
    parentId: item.parentId as string | undefined,
    node: item.node,
    assignees: item.assignees as WorkItemDto["assignees"],
    externalRefs: item.externalRefs as WorkItemDto["externalRefs"],
    labels: item.labels as string[],
    specRefs: item.specRefs as string[],
    branch: item.branch,
    pr: item.pr,
    reviewer: item.reviewer,
    revision: item.revision,
    blockedBy: item.blockedBy as string | undefined,
    deployVerified: item.deployVerified,
    claimedByRun: item.claimedByRun,
    claimedAt: item.claimedAt,
    lastCommand: item.lastCommand,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function listWorkItems(
  input: WorkItemsListInput
): Promise<WorkItemsListOutput> {
  const container = getContainer();
  const result = await container.workItemQuery.list({
    ...(input.types && {
      types: input.types as WorkItem["type"][],
    }),
    ...(input.statuses && {
      statuses: input.statuses as WorkItem["status"][],
    }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor as WorkItem["actor"] }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.limit && { limit: input.limit }),
  });

  return {
    items: result.items.map(toDto),
    nextCursor: result.nextCursor,
  };
}

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
  const container = getContainer();
  const item = await container.workItemQuery.get(id as WorkItemId);
  return item ? toDto(item) : null;
}

export async function createWorkItem(
  input: WorkItemsCreateInput
): Promise<WorkItemsCreateOutput> {
  const container = getContainer();
  const item = await container.workItemCommand.create({
    ...(input.id && { id: toWorkItemId(input.id) }),
    type: input.type,
    title: input.title,
    ...(input.summary !== undefined && { summary: input.summary }),
    ...(input.outcome !== undefined && { outcome: input.outcome }),
    ...(input.specRefs !== undefined && { specRefs: input.specRefs }),
    ...(input.projectId !== undefined && {
      projectId: toWorkItemId(input.projectId),
    }),
    ...(input.parentId !== undefined && {
      parentId: toWorkItemId(input.parentId),
    }),
    ...(input.labels !== undefined && { labels: input.labels }),
    ...(input.assignees !== undefined && { assignees: input.assignees }),
    ...(input.node !== undefined && { node: input.node }),
    ...(input.status !== undefined && { status: input.status }),
    ...(input.priority !== undefined && { priority: input.priority }),
    ...(input.rank !== undefined && { rank: input.rank }),
    ...(input.estimate !== undefined && { estimate: input.estimate }),
  });

  return toDto(item);
}

export async function patchWorkItem(
  input: WorkItemsPatchInput
): Promise<WorkItemsPatchOutput> {
  const unsupportedFields = PATCH_UNSUPPORTED_BY_COMMAND_PORT.filter(
    (field) => field in input.set
  );
  if (unsupportedFields.length > 0) {
    throw new UnsupportedWorkItemPatchFieldsError([...unsupportedFields]);
  }

  const container = getContainer();
  const current = await container.workItemQuery.get(toWorkItemId(input.id));
  if (!current) {
    throw new WorkItemNotFoundError(input.id);
  }

  const item = await container.workItemCommand.patch({
    id: toWorkItemId(input.id),
    expectedRevision: String(current.revision),
    set: {
      ...(input.set.title !== undefined && { title: input.set.title }),
      ...(input.set.summary !== undefined && { summary: input.set.summary }),
      ...(input.set.outcome !== undefined && { outcome: input.set.outcome }),
      ...(input.set.estimate !== undefined && { estimate: input.set.estimate }),
      ...(input.set.priority !== undefined && { priority: input.set.priority }),
      ...(input.set.rank !== undefined && { rank: input.set.rank }),
      ...(input.set.status !== undefined && { status: input.set.status }),
      ...(input.set.specRefs !== undefined && { specRefs: input.set.specRefs }),
      ...(input.set.labels !== undefined && { labels: input.set.labels }),
      ...(input.set.branch !== undefined && { branch: input.set.branch }),
      ...(input.set.pr !== undefined && { pr: input.set.pr }),
      ...(input.set.reviewer !== undefined && { reviewer: input.set.reviewer }),
      ...(input.set.node !== undefined && { node: input.set.node }),
    },
  });

  return toDto(item);
}

export async function claimWorkItem(input: {
  id: string;
  runId: string;
  command: string;
}): Promise<WorkItemDto> {
  const container = getContainer();
  const current = await container.workItemQuery.get(toWorkItemId(input.id));
  if (!current) {
    throw new WorkItemNotFoundError(input.id);
  }

  const item = await container.workItemCommand.claim({
    id: toWorkItemId(input.id),
    runId: input.runId,
    command: input.command,
  });

  return toDto(item);
}

export async function releaseWorkItem(input: {
  id: string;
  runId: string;
}): Promise<WorkItemDto> {
  const container = getContainer();
  const current = await container.workItemQuery.get(toWorkItemId(input.id));
  if (!current) {
    throw new WorkItemNotFoundError(input.id);
  }

  const item = await container.workItemCommand.release({
    id: toWorkItemId(input.id),
    runId: input.runId,
  });

  return toDto(item);
}

export async function heartbeatWorkItem(input: {
  id: string;
  runId: string;
  command?: string;
}): Promise<WorkItemDto> {
  const container = getContainer();
  const current = await container.workItemQuery.get(toWorkItemId(input.id));
  if (!current) {
    throw new WorkItemNotFoundError(input.id);
  }

  const item = await container.workItemCommand.claim({
    id: toWorkItemId(input.id),
    runId: input.runId,
    command: input.command ?? current.lastCommand ?? "heartbeat",
  });

  return toDto(item);
}

export async function getWorkItemCoordination(
  id: string
): Promise<WorkItemCoordinationDto> {
  const container = getContainer();
  const current = await container.workItemQuery.get(toWorkItemId(id));
  if (!current) {
    throw new WorkItemNotFoundError(id);
  }

  return {
    nextAction: nextActionForWorkItem(current),
    session: {
      status: current.claimedByRun ? "active" : "none",
      claimedByRun: current.claimedByRun ?? null,
      claimedByDisplayName: current.claimedByRun ?? null,
      claimedAt: current.claimedAt ?? null,
      lastCommand: current.lastCommand ?? null,
    },
  };
}
