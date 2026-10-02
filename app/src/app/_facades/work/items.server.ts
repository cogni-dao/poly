// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations.
 * Scope: Maps Work item ports to contract DTOs. Does not contain business logic.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Side-effects: IO (Doltgres read/write via port)
 * Links: [work.items.list.v1.contract](../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type {
	WorkItemsCreateInput as ContractCreateInput,
	WorkItemsPatchInput as ContractPatchInput,
	WorkItemDto,
	WorkItemsListInput,
	WorkItemsListOutput,
} from "@cogni/node-contracts";
import type { WorkItem } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
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
	constructor(message: string) {
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

type StripUndefined<T> = {
	[K in keyof T]?: Exclude<T[K], undefined>;
};

function dropUndefined<T extends Record<string, unknown>>(
	value: T,
): StripUndefined<T> {
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = item;
	}
	return result as StripUndefined<T>;
}

function rethrowBackendError(error: unknown): never {
	const message = (error as Error)?.message ?? "";
	const notFound = /^Work item not found: (.+)$/.exec(message);
	if (notFound?.[1]) throw new WorkItemNotFoundError(notFound[1]);
	if ((error as Error)?.name === "DoltgresNotConfiguredError") {
		throw new WorkItemsBackendNotReadyError((error as Error).message);
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

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.get(toWorkItemId(id));
		return item ? toDto(item) : null;
	} catch (error) {
		rethrowBackendError(error);
	}
}

export async function createWorkItem(
	input: ContractCreateInput,
	sessionUser: { id: string },
): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.create(
			{
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
			},
			sessionUser.id,
		);
		return toDto(item);
	} catch (error) {
		rethrowBackendError(error);
	}
}

export async function patchWorkItem(
	input: ContractPatchInput,
	sessionUser: { id: string },
): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.patch(
			{ id: toWorkItemId(input.id), set: dropUndefined(input.set) },
			sessionUser.id,
		);
		return toDto(item);
	} catch (error) {
		if ((error as Error)?.message === `Work item not found: ${input.id}`) {
			throw new WorkItemNotFoundError(input.id);
		}
		rethrowBackendError(error);
	}
}

export async function deleteWorkItem(
	id: string,
	sessionUser: { id: string },
): Promise<boolean> {
	const container = getContainer();
	try {
		return await container.doltgresWorkItems.delete(
			toWorkItemId(id),
			sessionUser.id,
		);
	} catch (error) {
		rethrowBackendError(error);
	}
}

export async function claimWorkItem(input: {
	id: string;
	runId: string;
	command: string;
	principalId: string;
}): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.claim({
			id: toWorkItemId(input.id),
			runId: input.runId,
			command: input.command,
			principalId: input.principalId,
		});
		return toDto(item);
	} catch (error) {
		if ((error as Error)?.message === `Work item not found: ${input.id}`) {
			throw new WorkItemNotFoundError(input.id);
		}
		rethrowBackendError(error);
	}
}

export async function releaseWorkItem(input: {
	id: string;
	runId: string;
	principalId: string;
}): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.release({
			id: toWorkItemId(input.id),
			runId: input.runId,
			principalId: input.principalId,
		});
		return toDto(item);
	} catch (error) {
		if ((error as Error)?.message === `Work item not found: ${input.id}`) {
			throw new WorkItemNotFoundError(input.id);
		}
		rethrowBackendError(error);
	}
}

export async function heartbeatWorkItem(input: {
	id: string;
	runId: string;
	command?: string;
	principalId: string;
}): Promise<WorkItemDto> {
	const container = getContainer();
	try {
		const item = await container.doltgresWorkItems.heartbeat({
			id: toWorkItemId(input.id),
			runId: input.runId,
			...(input.command !== undefined && { command: input.command }),
			principalId: input.principalId,
		});
		return toDto(item);
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
