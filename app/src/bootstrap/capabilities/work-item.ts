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
import { WorkItemPatchConflictError } from "@cogni/shared-ai-tools";
import type {
  ActorKind,
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
} from "@cogni/work-items";
import { toWorkItemDto, toWorkItemId } from "@cogni/work-items";
import type { WorkItemsDoltgresPort } from "@/ports/work-items-doltgres.port";

/**
 * Dependencies for creating the work item capability.
 */
export interface WorkItemCapabilityDeps {
  readonly workItemQuery: WorkItemQueryPort;
  readonly workItemCommand: WorkItemCommandPort;
  readonly backlogWriter?: {
    readonly store: Pick<WorkItemsDoltgresPort, "patch">;
    readonly principalId: () => string;
  };
}

function toWorkItemInfo(item: WorkItem): WorkItemInfo {
  return toWorkItemDto(item);
}

/**
 * Create a WorkItemCapability backed by hexagonal ports.
 */
export function createWorkItemCapability(
  deps: WorkItemCapabilityDeps,
): WorkItemCapability {
  const { workItemQuery, workItemCommand } = deps;

  return {
    async query(params): Promise<readonly WorkItemInfo[]> {
      const result = await workItemQuery.list({
        ...(params.sortBy !== undefined && { sortBy: params.sortBy }),
        ...(params.sortDirection !== undefined && {
          sortDirection: params.sortDirection,
        }),
        ...(params.labels !== undefined && { labels: params.labels }),
        ...(params.labelPrefix !== undefined && {
          labelPrefix: params.labelPrefix,
        }),
        ...(params.scored !== undefined && { scored: params.scored }),
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
        ...(params.sortBy !== undefined && { sortBy: params.sortBy }),
        ...(params.sortDirection !== undefined && {
          sortDirection: params.sortDirection,
        }),
        ...(params.labels !== undefined && { labels: params.labels }),
        ...(params.labelPrefix !== undefined && {
          labelPrefix: params.labelPrefix,
        }),
        ...(params.scored !== undefined && { scored: params.scored }),
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
      return {
        items: result.items.map(toWorkItemInfo),
        ...(result.nextCursor !== undefined && {
          nextCursor: result.nextCursor,
        }),
      };
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
          const updated = await writer.store.patch(
            {
              id: toWorkItemId(input.id),
              set: input.set,
              ...(input.expectedRevision !== undefined && {
                expectedRevision: input.expectedRevision,
              }),
            },
            writer.principalId(),
          );
          return toWorkItemInfo(updated);
        } catch (error) {
          if ((error as Error)?.name === "WorkItemRevisionConflictError") {
            const conflict = error as {
              id: string;
              expectedRevision: number;
              currentRevision: number;
            };
            throw new WorkItemPatchConflictError(
              conflict.id,
              conflict.expectedRevision,
              conflict.currentRevision,
            );
          }
          throw error;
        }
      }
      if (input.expectedRevision !== undefined)
        throw new Error("Doltgres backlog writer unavailable");
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
