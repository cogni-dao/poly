// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item`
 * Purpose: Factory for WorkItemCapability — bridges ai-tools interface to WorkItemQueryPort + WorkItemCommandPort.
 * Scope: Creates WorkItemCapability that delegates to hexagonal ports. Does not implement transport.
 * Invariants:
 *   - PATCH_REASON_AND_CITES (task.0086): the required `reason` and the optional `cites` are forwarded to the Doltgres store, the one enforcer;
 *     the command-port fallback is Poly's unavailable stub (mutations use the HTTP command plane), so it never receives them.
 *   - MOVES_READ_AT_READ_TIME (story.0033): a read that returns exactly one item (core__work_item_read) adds each move's baseline,
 *     current reading and verdict from `moveReadings`; a list read returns the stored moves only, so a page costs no metric lookup.
 *   - ONE_ITEM_ENVELOPE (task.0118): `read` is the single-item envelope: it also adds each move's metric, KPI and goal (`moveReadings.context`) and, on request, the first page of citation links (`links`); both through the package's `composeItemEnvelope`; `query` and `queryPage` never do.
 *   - PORTS_ARE_AUTHORITY: All operations delegate to WorkItemQueryPort/WorkItemCommandPort
 *   - TRANSITION_TABLE_ENFORCED: CommandPort validates transitions
 * Side-effects: none (factory only)
 * Links: docs/spec/development-lifecycle.md
 * @internal
 */

import type {
  WorkItemCapability,
  WorkItemInfo,
  WorkItemQueryParams,
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
import type {
  EnvelopeDegradedEvent,
  ItemLinksPort,
  MoveReadingPort,
} from "@cogni/work-items";
import {
  composeItemEnvelope,
  judgeMoveSummaries,
  toWorkItemDto,
  toWorkItemId,
  WORK_ITEM_SORT_FIELDS,
  type WorkItemSortBy,
} from "@cogni/work-items";
import type { WorkItemsDoltgresPort } from "@/ports/work-items-doltgres.port";

/**
 * Dependencies for creating the work item capability.
 */
export interface WorkItemCapabilityDeps {
  readonly workItemQuery: WorkItemQueryPort;
  readonly workItemCommand: WorkItemCommandPort;
  /** Reads the metrics a single item moves; absent means no metrics service (every move reads `unknown`). */
  readonly moveReadings?: MoveReadingPort | undefined;
  /** First page of an item's citation links (`read` with `includeLinks`); absent reads `unavailable`. */
  readonly links?: ItemLinksPort | undefined;
  /** One event per degraded envelope part (chain or links). */
  readonly log?: ((event: EnvelopeDegradedEvent) => void) | undefined;
  readonly backlogWriter?: {
    readonly store: Pick<WorkItemsDoltgresPort, "patch">;
    readonly principalId: () => string;
  };
}

/**
 * The published tool schema (ai-tools 0.4.2) offers sort fields this node's
 * pinned work-items store does not order by yet; reject them explicitly instead
 * of letting the store fail on an unknown order.
 */
function supportedSortBy(sortBy: string): WorkItemSortBy {
  if ((WORK_ITEM_SORT_FIELDS as readonly string[]).includes(sortBy))
    return sortBy as WorkItemSortBy;
  throw new Error(
    `unsupported sortBy "${sortBy}"; use one of ${WORK_ITEM_SORT_FIELDS.join(", ")}`,
  );
}

function toWorkItemInfo(item: WorkItem): WorkItemInfo {
  return toWorkItemDto(item);
}

/** The patch `set` without explicit-undefined keys (the route facade drops them the same way). */
const definedOnly = (set: object): object =>
  Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));

/**
 * Create a WorkItemCapability backed by hexagonal ports.
 */
export function createWorkItemCapability(
  deps: WorkItemCapabilityDeps,
): WorkItemCapability {
  const { workItemQuery, workItemCommand } = deps;

  function list(params: WorkItemQueryParams) {
    return workItemQuery.list({
      ...(params.sortBy !== undefined && {
        sortBy: supportedSortBy(params.sortBy),
      }),
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
  }

  /** A one-item read gets each move judged from its observations (bounded: at most 3 moves). */
  async function withMoveReadings(
    items: readonly WorkItemInfo[],
  ): Promise<readonly WorkItemInfo[]> {
    const only = items.length === 1 ? items[0] : undefined;
    if (!only?.moves?.length) return items;
    return judgeMoveSummaries([only], deps.moveReadings);
  }

  return {
    /**
     * THE single-item envelope (task.0118), the same shape `GET /api/v1/work/items/{id}` serves: the
     * item with each move's readings, verdict and metric → KPI → goal chain, and with `includeLinks`
     * the first page of citation links.
     */
    async read(id, options): Promise<WorkItemInfo | null> {
      const result = await list({ ids: [id], limit: 1 });
      const item = result.items
        .map(toWorkItemInfo)
        .find((entry) => entry.id === id);
      if (!item) return null;
      // ONE_COMPOSITION: the same `composeItemEnvelope` the HTTP facade calls.
      return composeItemEnvelope(
        item,
        { readings: deps.moveReadings, links: deps.links, log: deps.log },
        { includeLinks: options?.includeLinks === true },
      );
    },

    async query(params): Promise<readonly WorkItemInfo[]> {
      const result = await list(params);
      return withMoveReadings(result.items.map(toWorkItemInfo));
    },

    async queryPage(params) {
      const result = await list(params);
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
              set: definedOnly(input.set) as Parameters<
                typeof writer.store.patch
              >[0]["set"],
              ...(input.expectedRevision !== undefined && {
                expectedRevision: input.expectedRevision,
              }),
              reason: input.reason,
              ...(input.cites !== undefined && { cites: input.cites }),
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
        set: definedOnly(input.set) as NonNullable<
          Parameters<typeof workItemCommand.patch>[0]["set"]
        >,
      });

      return toWorkItemInfo(updated);
    },
  };
}
