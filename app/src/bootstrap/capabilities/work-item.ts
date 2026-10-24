// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item`
 * Purpose: Factory for WorkItemCapability — bridges ai-tools interface to WorkItemQueryPort + WorkItemCommandPort.
 * Scope: Creates WorkItemCapability that delegates to hexagonal ports. Does not implement transport.
 * Invariants:
 *   - PORTS_ARE_AUTHORITY: All operations delegate to WorkItemQueryPort/WorkItemCommandPort
 *   - TRANSITION_TABLE_ENFORCED: CommandPort validates transitions
 * Side-effects: none (factory only)
 * Links: docs/spec/development-lifecycle.md
 * @internal
 */

import type {
  WorkItemCapability,
  WorkItemInfo,
  WorkItemTransitionResult,
} from "@cogni/shared-ai-tools";
import type {
  ActorKind,
  SubjectRef,
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
} from "@cogni/work-items";
import { rankScore, toWorkItemId } from "@cogni/work-items";
import { WorkItemPatchConflictError } from "@cogni/shared-ai-tools";
import type { WorkItemsDoltgresPort } from "@/ports/work-items-doltgres.port";

/**
 * Dependencies for creating the work item capability.
 */
export interface WorkItemCapabilityDeps {
  readonly workItemQuery: WorkItemQueryPort;
  readonly workItemCommand: WorkItemCommandPort;
  readonly backlogWriter?: { readonly store: Pick<WorkItemsDoltgresPort, "patch">; readonly principalId: () => string };
}

function assigneeId(a: SubjectRef): string {
  switch (a.kind) {
    case "user":
      return a.userId;
    case "agent":
      return a.agentId;
    case "system":
      return a.serviceId;
  }
}

function toWorkItemInfo(item: WorkItem): WorkItemInfo {
  const evaluationRank = rankScore(item.scores);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    status: item.status,
    labels: [...item.labels],
    assignees: item.assignees.map((a) => ({ kind: a.kind, id: assigneeId(a) })),
    updatedAt: item.updatedAt,
    revision: item.revision,
    ...(item.scores !== undefined && { scores: item.scores }),
    ...(evaluationRank !== undefined && { rankScore: evaluationRank }),
    ...(item.outcome !== undefined && { outcome: item.outcome }),
    ...(item.estimate !== undefined && { estimate: item.estimate }),
    ...(item.parentId !== undefined && { parentId: item.parentId }),
    ...(item.specRefs !== undefined && { specRefs: [...item.specRefs] }),
    ...(item.actor !== "either" && { actor: item.actor }),
    ...(item.priority !== undefined && { priority: item.priority }),
    ...(item.rank !== undefined && { rank: item.rank }),
    ...(item.summary !== undefined && { summary: item.summary }),
    ...(item.projectId !== undefined && { projectId: item.projectId }),
    ...(item.branch !== undefined && { branch: item.branch }),
    ...(item.pr !== undefined && { pr: item.pr }),
    ...(item.blockedBy !== undefined && { blockedBy: item.blockedBy }),
  };
}

/**
 * Create a WorkItemCapability backed by hexagonal ports.
 */
export function createWorkItemCapability(
  deps: WorkItemCapabilityDeps
): WorkItemCapability {
  const { workItemQuery, workItemCommand } = deps;

  return {
    async query(params): Promise<readonly WorkItemInfo[]> {
      const result = await workItemQuery.list({
        ...(params.ids && { ids: params.ids.map(toWorkItemId) }),
        ...(params.cursor && { cursor: params.cursor }),
        ...(params.statuses && {
          statuses: params.statuses as readonly WorkItemStatus[],
        }),
        ...(params.types && {
          types: params.types as readonly WorkItemType[],
        }),
        ...(params.text && { text: params.text }),
        ...(params.actor && { actor: params.actor as ActorKind }),
        ...(params.projectId && {
          projectId: toWorkItemId(params.projectId),
        }),
        ...(params.limit && { limit: params.limit }),
      });
      return result.items.map(toWorkItemInfo);
    },

    async queryPage(params) {
      const result = await workItemQuery.list({
        ...(params.ids && { ids: params.ids.map(toWorkItemId) }),
        ...(params.cursor && { cursor: params.cursor }),
        ...(params.statuses && {
          statuses: params.statuses as readonly WorkItemStatus[],
        }),
        ...(params.types && {
          types: params.types as readonly WorkItemType[],
        }),
        ...(params.text && { text: params.text }),
        ...(params.actor && { actor: params.actor as ActorKind }),
        ...(params.projectId && {
          projectId: toWorkItemId(params.projectId),
        }),
        ...(params.limit && { limit: params.limit }),
      });
      return { items: result.items.map(toWorkItemInfo), ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }) };
    },

    async transitionStatus(input): Promise<WorkItemTransitionResult> {
      const current = await workItemQuery.get(toWorkItemId(input.id));
      if (!current) {
        throw new Error(`Work item not found: ${input.id}`);
      }

      const updated = await workItemCommand.transitionStatus({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        toStatus: input.toStatus as WorkItemStatus,
        ...(input.reason && { reason: input.reason }),
      });

      return {
        id: updated.id,
        previousStatus: current.status,
        newStatus: updated.status,
        revision: updated.revision as number,
      };
    },

    async patch(input): Promise<WorkItemInfo> {
      const writer = deps.backlogWriter;
      if (writer) {
        try {
          const updated = await writer.store.patch({
            id: toWorkItemId(input.id), set: input.set,
            ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }),
          }, writer.principalId());
          return toWorkItemInfo(updated);
        } catch (error) {
          if ((error as Error)?.name === "WorkItemRevisionConflictError") {
            const conflict = error as { id: string; expectedRevision: number; currentRevision: number };
            throw new WorkItemPatchConflictError(conflict.id, conflict.expectedRevision, conflict.currentRevision);
          }
          throw error;
        }
      }
      if (input.expectedRevision !== undefined) throw new Error("Doltgres backlog writer unavailable");
      const current = await workItemQuery.get(toWorkItemId(input.id));
      if (!current) {
        throw new Error(`Work item not found: ${input.id}`);
      }

      const updated = await workItemCommand.patch({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        set: input.set,
      });

      return toWorkItemInfo(updated);
    },
  };
}
