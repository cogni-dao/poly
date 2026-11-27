// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations.
 * Scope: Maps Work item ports to contract DTOs. Does not contain business logic.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Write errors pass through unchanged; `workItemWriteErrorResponse` (@cogni/work-items) maps them to HTTP in the route (task.0097).
 * Moves (story.0033): create and patch resolve new metric links and pin baselines. Detail and bounded summary reads add authorized observations and directional verdicts.
 * Envelope (task.0118): `getWorkItem` is the one single-item read; each move also carries its metric, KPI and goal, and `includeLinks` adds the first page of citation links. List and summary reads stay summary-sized.
 * Side-effects: IO (Doltgres read/write via port)
 * Links: [work.items.list.v1.contract](../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemLease } from "@cogni/work-items";
import type {
	WorkItemsCreateInput as ContractCreateInput,
	WorkItemsPatchInput as ContractPatchInput,
	WorkItemDto,
	WorkItemsGetOutput,
	WorkItemsListInput,
	WorkItemsListOutput,
	WorkItemSummariesListInput,
	WorkItemSummariesListOutput,
} from "@cogni/node-contracts";
import type {
	WorkBoardColumnPages,
	WorkItem,
	WorkItemsBusyReason,
	WorkQuery,
	WorkSummaryReadOptions,
	WriteAttribution,
} from "@cogni/work-items";
import {
	backendUnavailableReason,
	composeItemEnvelope,
	createItemRefPorts,
	judgeMoveSummaries,
	toWorkItemDto,
	toWorkItemId,
	toWorkItemsCreateInput,
	toWorkItemsPatchInput,
} from "@cogni/work-items";
import { createCitationLinksPort } from "@/bootstrap/capabilities/citation-links";
import { createMoveMetricPorts } from "@/bootstrap/capabilities/work-item-moves";
import { getContainer } from "@/bootstrap/container";

export class InvalidCursorError extends Error {
	constructor(message = "invalid cursor") {
		super(message);
		this.name = "InvalidCursorError";
	}
}

export class WorkItemNotFoundError extends Error {
	constructor(id: string) {
		super(`Work item not found: ${id}`);
		this.name = "WorkItemNotFoundError";
	}
}

export class WorkItemForbiddenError extends Error {
	constructor(id: string) {
		super(`Not authorized to mutate work item: ${id}`);
		this.name = "WorkItemForbiddenError";
	}
}

export class WorkItemLeaseConflictError extends Error {
	constructor(id: string) {
		super(`Work item is claimed by another principal or lease: ${id}`);
		this.name = "WorkItemLeaseConflictError";
	}
}

export class WorkItemsBackendNotReadyError extends Error {
	constructor(
		message: string,
		readonly reason: WorkItemsBusyReason,
	) {
		super(message);
		this.name = "WorkItemsBackendNotReadyError";
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
		case "needs_design_review":
			return "/review-design";
		case "needs_implement":
			return "/implement";
		case "needs_implementation_review":
			return "/review-implementation";
		case "needs_validation":
			return "/validate-candidate";
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

const toDto = toWorkItemDto;

/**
 * MOVES_READ_AT_READ_TIME: add each move's baseline, current reading and verdict to a
 * single item. Never throws: a lookup that fails reads `unknown`. A list read does not call this.
 */
async function withMoveReadings(
	dto: WorkItemDto,
	options?: WorkSummaryReadOptions,
): Promise<WorkItemDto> {
	if (!dto.moves?.length) return dto;
	const container = getContainer();
	// No metrics service on this node: every move reads `unknown` (metrics_unavailable).
	const readings = container.goalMetrics
		? createMoveMetricPorts(() => container.goalMetrics).readings
		: undefined;
	return (await judgeMoveSummaries([dto], readings, options))[0] ?? dto;
}

async function withSummaryReadings<T extends { moves?: WorkItemDto["moves"] }>(
	items: readonly T[],
	options?: WorkSummaryReadOptions,
): Promise<T[]> {
	const container = getContainer();
	const readings = container.goalMetrics
		? createMoveMetricPorts(() => container.goalMetrics).readings
		: undefined;
	return judgeMoveSummaries(items, readings, options);
}

/**
 * Single-item read options; `includeLinks` adds the first page of citation links, `includeArtifacts` and `includeHistory`
 * the first page of artifact and history refs, `artifactId` one artifact in full (story.0058).
 */
export interface WorkItemReadOptions extends WorkSummaryReadOptions {
	readonly includeLinks?: boolean;
	readonly includeArtifacts?: boolean;
	readonly includeHistory?: boolean;
	readonly artifactId?: string;
	/** Set false for a caller that needs only the item (the EDO expectations read). Default: read the latest artifacts. */
	readonly artifacts?: boolean;
	/** Set false for a caller that needs only the stored move ids (the EDO expectations read). Default: resolve the chain. */
	readonly chain?: boolean;
}

/**
 * THE single-item envelope (task.0118): the stored item plus, for each move, its readings, verdict
 * and the metric → KPI → goal chain, and optionally the first page of citation links. Never throws
 * for either: an unresolved chain reads `context: "unavailable"` and unreadable links read `unavailable`.
 */
async function withItemEnvelope(
	dto: WorkItemDto,
	options?: WorkItemReadOptions,
): Promise<WorkItemsGetOutput> {
	const container = getContainer();
	const artifactStore = container.workItemArtifacts?.artifacts;
	const readings = container.goalMetrics
		? createMoveMetricPorts(
				() => container.goalMetrics,
				() => container.knowledgeStorePort,
			).readings
		: undefined;
	// ONE_COMPOSITION: the same `composeItemEnvelope` the agent tool's capability calls.
	return composeItemEnvelope(
		dto,
		{
			readings,
			links: createCitationLinksPort(() => container.knowledgeStorePort),
			// task.0028: the latest artifact of each kind, without body, one bounded read.
			artifacts: artifactStore
				? { latest: (id) => artifactStore.latest(id) }
				: undefined,
			// story.0058: refs first, then one read; the same ports the agent tool's capability wires.
			...createItemRefPorts({
				artifacts: artifactStore,
				history: container.doltgresWorkItems,
			}),
			log: (event) => container.log.warn(event, "work.items.envelope_degraded"),
		},
		options,
	);
}

function rethrowBackendError(error: unknown): never {
	const message = (error as Error)?.message ?? "";
	// Errors the package owns (revision conflict, scores, reason, cites, moves, resolver and
	// baseline failures, write-outcome-unknown) pass through: the route maps them with
	// `workItemWriteErrorResponse`, which matches by name across bundled copies (task.0097).
	const notFound = /^Work item not found: (.+)$/.exec(message);
	if (notFound?.[1]) throw new WorkItemNotFoundError(notFound[1]);
	if (
		(error as Error)?.name === "DoltgresNotConfiguredError" ||
		(error as Error)?.name === "WorkItemsBusyError" ||
		(error as Error)?.name === "WorkItemsCapacityError" ||
		(error as Error)?.name === "UnprovableTransitionError" ||
		(error as Error)?.name === "DoltMergeOutcomeUnknownError"
	) {
		// The 503 names its reason (task.0162); a busy-named error that carries none is the base "store busy" case.
		throw new WorkItemsBackendNotReadyError(
			(error as Error).message,
			backendUnavailableReason(error) ?? "capacity_held",
		);
	}
	if ((error as Error)?.name === "WorkItemAuthorizationError") {
		const id = (error as { id?: string }).id ?? "unknown";
		throw new WorkItemForbiddenError(id);
	}
	if ((error as Error)?.name === "WorkItemLeaseConflictError") {
		const id = (error as { id?: string }).id ?? "unknown";
		throw new WorkItemLeaseConflictError(id);
	}
	throw error;
}

export async function listWorkItems(
	input: WorkItemsListInput,
): Promise<WorkItemsListOutput> {
	const container = getContainer();
	try {
		const result = await container.doltgresWorkItems.list({
			...(input.types && { types: input.types as WorkItem["type"][] }),
			...(input.statuses && {
				statuses: input.statuses as WorkItem["status"][],
			}),
			...(input.text && { text: input.text }),
			...(input.actor && { actor: input.actor as WorkItem["actor"] }),
			...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
			...(input.node && { node: input.node }),
			...(input.limit && { limit: input.limit }),
			...(input.cursor && { cursor: input.cursor }),
		});
		return {
			items: result.items.map(toDto),
			pageInfo: result.pageInfo,
			...(result.nextCursor && { nextCursor: result.nextCursor }),
		};
	} catch (error) {
		if ((error as Error)?.name === "InvalidCursorError") {
			throw new InvalidCursorError((error as Error).message);
		}
		rethrowBackendError(error);
	}
}

/** The store query for one decoded summary request (the published codec already bounded it). */
function summaryQuery(input: WorkItemSummariesListInput): WorkQuery {
	return {
		...(input.sortBy !== undefined && { sortBy: input.sortBy }),
		...(input.sortDirection !== undefined && {
			sortDirection: input.sortDirection,
		}),
		...(input.types && { types: input.types as WorkItem["type"][] }),
		...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
		...(input.text && { text: input.text }),
		...(input.actor && { actor: input.actor as WorkItem["actor"] }),
		...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
		...(input.projectIds && { projectIds: input.projectIds.map(toWorkItemId) }),
		...(input.rankMin !== undefined && { rankMin: input.rankMin }),
		...(input.rankMax !== undefined && { rankMax: input.rankMax }),
		...(input.node && { node: input.node }),
		...(input.labels && { labels: input.labels }),
		...(input.labelPrefix !== undefined && { labelPrefix: input.labelPrefix }),
		...(input.scored !== undefined && { scored: input.scored }),
		limit: input.limit ?? 25,
		...(input.cursor && { cursor: input.cursor }),
	};
}

function rethrowReadError(error: unknown): never {
	if ((error as Error)?.name === "InvalidCursorError") {
		throw new InvalidCursorError((error as Error).message);
	}
	rethrowBackendError(error);
}

/**
 * One bounded summary page (task.0056). `options` (signal, shared deadline,
 * scan budget) only tightens the read. Poly's Doltgres hub is the only backend;
 * an unconfigured hub surfaces as `WorkItemsBackendNotReadyError` (503).
 */
export async function listWorkSummaries(
	input: WorkItemSummariesListInput,
	options?: WorkSummaryReadOptions,
): Promise<WorkItemSummariesListOutput> {
	try {
		const page = await getContainer().doltgresWorkItems.listSummaries(
			summaryQuery(input),
			options,
		);
		return { ...page, items: await withSummaryReadings(page.items, options) };
	} catch (error) {
		rethrowReadError(error);
	}
}

/**
 * First page of every listed board column in ONE store read when the port
 * composes it (task.0056); otherwise one bounded summary read per column.
 * Text queries never reach here (the package keeps them per-column).
 */
export async function listWorkBoardColumns(
	input: WorkItemSummariesListInput,
	statuses: readonly string[],
	perColumn: number,
	options?: WorkSummaryReadOptions,
): Promise<WorkBoardColumnPages> {
	const port = getContainer().doltgresWorkItems;
	if (port.listBoardColumns) {
		try {
			const page = await port.listBoardColumns(
				summaryQuery(input),
				statuses,
				perColumn,
				options,
			);
			const items = await withSummaryReadings(
				page.columns.flatMap((column) => column.items),
				options,
			);
			let offset = 0;
			return {
				...page,
				columns: page.columns.map((column) => {
					const start = offset;
					offset += column.items.length;
					return { ...column, items: items.slice(start, offset) };
				}),
			};
		} catch (error) {
			rethrowReadError(error);
		}
	}
	const columns = [];
	for (const status of statuses) {
		const page = await listWorkSummaries(
			{ ...input, statuses: [status], limit: perColumn },
			options,
		);
		columns.push({ status, items: page.items, pageInfo: page.pageInfo });
	}
	return { columns, queryCount: columns.length };
}

export async function getWorkItem(
	id: string,
	options?: WorkItemReadOptions,
): Promise<WorkItemsGetOutput | null> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.get(toWorkItemId(id));
		return item ? await withItemEnvelope(toDto(item), options) : null;
	} catch (error) {
		rethrowBackendError(error);
	}
}

export async function createWorkItem(
	input: ContractCreateInput,
	_sessionUser: { id: string },
	attribution: WriteAttribution,
): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.create(
			// A null `scores` never reaches the store: it reads as absent.
			toWorkItemsCreateInput({ ...input, scores: input.scores ?? undefined }),
			attribution,
		);
		return await withMoveReadings(toDto(item));
	} catch (error) {
		rethrowBackendError(error);
	}
}

export async function patchWorkItem(
	input: ContractPatchInput,
	_sessionUser: { id: string },
	attribution: WriteAttribution,
): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.patch(
			toWorkItemsPatchInput(input),
			attribution,
		);
		return await withMoveReadings(toDto(item));
	} catch (error) {
		if ((error as Error)?.message === `Work item not found: ${input.id}`) {
			throw new WorkItemNotFoundError(input.id);
		}
		rethrowBackendError(error);
	}
}

export async function claimWorkItem(input: {
	id: string;
	runId: string;
	command: string;
	principalId: string;
}): Promise<WorkItemLease> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.claim({
			id: toWorkItemId(input.id),
			runId: input.runId,
			command: input.command,
			principalId: input.principalId,
		});
		return item;
	} catch (error) {
		if ((error as Error)?.message === `Work item not found: ${input.id}`) {
			throw new WorkItemNotFoundError(input.id);
		}
		rethrowBackendError(error);
	}
}

export async function releaseWorkItem(input: {
	leaseToken: string;
	id: string;
	runId: string;
	principalId: string;
}): Promise<WorkItemLease> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.release({
			leaseToken: input.leaseToken,
			id: toWorkItemId(input.id),
			runId: input.runId,
			principalId: input.principalId,
		});
		return item;
	} catch (error) {
		if ((error as Error)?.message === `Work item not found: ${input.id}`) {
			throw new WorkItemNotFoundError(input.id);
		}
		rethrowBackendError(error);
	}
}

export async function heartbeatWorkItem(input: {
	leaseToken: string;
	id: string;
	runId: string;
	command?: string;
	principalId: string;
}): Promise<WorkItemLease> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.heartbeat({
			leaseToken: input.leaseToken,
			id: toWorkItemId(input.id),
			runId: input.runId,
			...(input.command !== undefined && { command: input.command }),
			principalId: input.principalId,
		});
		return item;
	} catch (error) {
		if (error instanceof WorkItemNotFoundError) throw error;
		rethrowBackendError(error);
	}
}

export async function getWorkItemCoordination(
	id: string,
): Promise<WorkItemCoordinationDto> {
	const container = getContainer();
	try {
		const current = await container.doltgresWorkItems.get(toWorkItemId(id));
		if (!current) throw new WorkItemNotFoundError(id);
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
	} catch (error) {
		if (error instanceof WorkItemNotFoundError) throw error;
		rethrowBackendError(error);
	}
}
