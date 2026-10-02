// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Doltgres-backed work-item adapter.
 *
 * This is the sole runtime read/write authority for deployed work items. Every
 * mutation is followed by a Dolt commit so state survives application pods and
 * remains attributable in Dolt history.
 */

import type {
	ActorKind,
	ExternalRef,
	Revision,
	SubjectRef,
	WorkItem,
	WorkItemCommandPort,
	WorkItemId,
	WorkItemQueryPort,
	WorkItemStatus,
	WorkItemType,
	WorkQuery,
	WorkRelation,
} from "@cogni/work-items";
import { isValidTransition, toWorkItemId } from "@cogni/work-items";
import type { Sql } from "postgres";

import type {
	WorkItemsCreateInput,
	WorkItemsDoltgresPort,
	WorkItemsPatchInput,
	WorkItemsPatchSet,
} from "@/ports/work-items-doltgres.port";

import {
	decodeCursor,
	encodeCursor,
	type WorkItemCursor,
} from "./work-items-cursor";

const ID_FLOOR = 5000;
const COMMIT_TAG = "task.5001";
const DEFAULT_AUTHOR = "actor:system";

export class WorkItemAlreadyExistsError extends Error {
	constructor(public readonly id: string) {
		super(`work item id '${id}' already exists`);
		this.name = "WorkItemAlreadyExistsError";
	}
}

export class WorkItemRevisionConflictError extends Error {
	constructor(public readonly id: string) {
		super(`work item '${id}' changed before this update`);
		this.name = "WorkItemRevisionConflictError";
	}
}

function escapeValue(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Non-finite number");
		return String(value);
	}
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (value instanceof Date) return `'${value.toISOString()}'`;
	if (Array.isArray(value) || typeof value === "object") {
		return `'${JSON.stringify(value).replace(/\0/g, "").replace(/'/g, "''")}'::jsonb`;
	}
	return `'${String(value).replace(/\0/g, "").replace(/'/g, "''")}'`;
}

function actorOf(value: unknown): ActorKind {
	return value === "human" || value === "ai" ? value : "either";
}

function jsonArrayOf<T>(value: unknown): readonly T[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value as T[];
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? (parsed as T[]) : [];
		} catch {
			return [];
		}
	}
	return [];
}

function optionalString(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalWorkItemId(value: unknown): WorkItemId | undefined {
	return value ? toWorkItemId(String(value)) : undefined;
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
	const item: Record<string, unknown> = {
		id: toWorkItemId(String(row.id)),
		type: String(row.type) as WorkItemType,
		title: String(row.title),
		status: String(row.status) as WorkItemStatus,
		node: String(row.node ?? "shared"),
		actor: actorOf(row.actor),
		assignees: jsonArrayOf<SubjectRef>(row.assignees),
		externalRefs: jsonArrayOf<ExternalRef>(row.external_refs),
		labels: jsonArrayOf<string>(row.labels),
		specRefs: jsonArrayOf<string>(row.spec_refs),
		revision: Number(row.revision ?? 0),
		deployVerified: Boolean(row.deploy_verified ?? false),
		createdAt: row.created_at ? String(row.created_at) : "",
		updatedAt: row.updated_at ? String(row.updated_at) : "",
	};

	const optional = {
		priority: optionalNumber(row.priority),
		rank: optionalNumber(row.rank),
		estimate: optionalNumber(row.estimate),
		summary: optionalString(row.summary),
		outcome: optionalString(row.outcome),
		projectId: optionalWorkItemId(row.project_id),
		parentId: optionalWorkItemId(row.parent_id),
		branch: optionalString(row.branch),
		pr: optionalString(row.pr),
		reviewer: optionalString(row.reviewer),
		blockedBy: optionalWorkItemId(row.blocked_by),
		claimedByRun: optionalString(row.claimed_by_run),
		claimedAt: optionalString(row.claimed_at),
		lastCommand: optionalString(row.last_command),
	};
	for (const [key, value] of Object.entries(optional)) {
		if (value !== undefined) item[key] = value;
	}
	return item as WorkItem;
}

function parseSuffix(id: string, type: WorkItemType): number | null {
	const prefix = `${type}.`;
	if (!id.startsWith(prefix)) return null;
	const tail = id.slice(prefix.length);
	return /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
}

const PATCH_COLUMNS: Record<keyof WorkItemsPatchSet, string> = {
	title: "title",
	summary: "summary",
	outcome: "outcome",
	status: "status",
	priority: "priority",
	rank: "rank",
	estimate: "estimate",
	labels: "labels",
	specRefs: "spec_refs",
	branch: "branch",
	pr: "pr",
	reviewer: "reviewer",
	node: "node",
	deployVerified: "deploy_verified",
	projectId: "project_id",
	parentId: "parent_id",
	blockedBy: "blocked_by",
};

type CommandPatchInput = Parameters<WorkItemCommandPort["patch"]>[0];

export class DoltgresPolyWorkItemAdapter
	implements WorkItemsDoltgresPort, WorkItemQueryPort, WorkItemCommandPort
{
	constructor(private readonly sql: Sql) {}

	private async commit(message: string, authorTag: string): Promise<void> {
		await this.sql.unsafe(
			`SELECT dolt_commit('-Am', ${escapeValue(`${COMMIT_TAG}: ${message} by ${authorTag}`)})`,
		);
	}

	async get(id: WorkItemId): Promise<WorkItem | null> {
		const rows = await this.sql.unsafe(
			`SELECT * FROM work_items WHERE id = ${escapeValue(id as string)} LIMIT 1`,
		);
		return rows.length > 0
			? rowToWorkItem(rows[0] as Record<string, unknown>)
			: null;
	}

	async list(query: WorkQuery = {}): Promise<{
		items: WorkItem[];
		nextCursor?: string;
		pageInfo: { endCursor: string | null; hasMore: boolean };
	}> {
		const conditions: string[] = [];
		if (query.ids?.length) {
			conditions.push(
				`id IN (${query.ids.map((id) => escapeValue(id as string)).join(", ")})`,
			);
		}
		if (query.types?.length) {
			conditions.push(`type IN (${query.types.map(escapeValue).join(", ")})`);
		}
		if (query.statuses?.length) {
			conditions.push(
				`status IN (${query.statuses.map(escapeValue).join(", ")})`,
			);
		}
		// The shared work_items schema has no actor column yet; every persisted
		// item therefore has the domain default `either`.
		if (query.actor && query.actor !== "either") conditions.push("FALSE");
		if (query.projectId) {
			conditions.push(`project_id = ${escapeValue(query.projectId as string)}`);
		}
		if (query.node) {
			const nodes = Array.isArray(query.node) ? query.node : [query.node];
			conditions.push(`node IN (${nodes.map(escapeValue).join(", ")})`);
		}
		if (query.text) {
			const escaped = query.text.toLowerCase().replace(/[%_\\]/g, "\\$&");
			const pattern = escapeValue(`%${escaped}%`);
			conditions.push(
				`(LOWER(title) LIKE ${pattern} OR LOWER(COALESCE(summary,'')) LIKE ${pattern})`,
			);
		}
		if (query.cursor) {
			const cursor = decodeCursor(query.cursor);
			const priority = cursor.p ?? 999;
			const rank = cursor.r ?? 999;
			const timestamp = escapeValue(cursor.ts);
			const id = escapeValue(cursor.id);
			conditions.push(
				`(` +
					`COALESCE(priority,999) > ${priority}` +
					` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) > ${rank})` +
					` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) = ${rank} AND created_at < ${timestamp})` +
					` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) = ${rank} AND created_at = ${timestamp} AND id > ${id})` +
					`)`,
			);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
		const rows = (await this.sql.unsafe(
			`SELECT * FROM work_items ${where} ORDER BY COALESCE(priority, 999) ASC, COALESCE(rank, 999) ASC, created_at DESC, id ASC LIMIT ${limit + 1}`,
		)) as ReadonlyArray<Record<string, unknown>>;
		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		const items = pageRows.map(rowToWorkItem);

		let endCursor: string | null = null;
		if (hasMore && pageRows.length > 0) {
			const last = pageRows[pageRows.length - 1] as Record<string, unknown>;
			const cursor: WorkItemCursor = {
				p: optionalNumber(last.priority) ?? null,
				r: optionalNumber(last.rank) ?? null,
				ts:
					last.created_at instanceof Date
						? last.created_at.toISOString()
						: String(last.created_at ?? ""),
				id: String(last.id),
			};
			endCursor = encodeCursor(cursor);
		}

		return {
			items,
			pageInfo: { endCursor, hasMore },
			...(endCursor && { nextCursor: endCursor }),
		};
	}

	async create(
		input: WorkItemsCreateInput,
		authorTag = DEFAULT_AUTHOR,
	): Promise<WorkItem> {
		let allocatedId: string;
		if (input.id) {
			const requested = String(input.id);
			if (!requested.startsWith(`${input.type}.`)) {
				throw new Error(
					`Provided id '${requested}' does not match type '${input.type}'`,
				);
			}
			if (await this.get(toWorkItemId(requested))) {
				throw new WorkItemAlreadyExistsError(requested);
			}
			allocatedId = requested;
		} else {
			const idRows = await this.sql.unsafe(
				`SELECT id FROM work_items WHERE type = ${escapeValue(input.type)}`,
			);
			let maxSuffix = ID_FLOOR - 1;
			for (const row of idRows as ReadonlyArray<Record<string, unknown>>) {
				const suffix = parseSuffix(String(row.id), input.type);
				if (suffix !== null && suffix > maxSuffix) maxSuffix = suffix;
			}
			allocatedId = `${input.type}.${String(maxSuffix + 1).padStart(4, "0")}`;
		}

		const columns = ["id", "type", "title", "status", "node"];
		const values = [
			escapeValue(allocatedId),
			escapeValue(input.type),
			escapeValue(input.title),
			escapeValue(input.status ?? "needs_triage"),
			escapeValue(input.node ?? "shared"),
		];
		const add = (column: string, value: unknown) => {
			if (value === undefined) return;
			columns.push(column);
			values.push(escapeValue(value));
		};
		add("summary", input.summary);
		add("outcome", input.outcome);
		add("project_id", input.projectId);
		add("parent_id", input.parentId);
		add("priority", input.priority);
		add("rank", input.rank);
		add("estimate", input.estimate);
		add("assignees", input.assignees);
		add("labels", input.labels);
		add("spec_refs", input.specRefs);

		const rows = await this.sql.unsafe(
			`INSERT INTO work_items (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING *`,
		);
		const row = rows[0] as Record<string, unknown> | undefined;
		if (!row) throw new Error("INSERT returned no row");
		await this.commit(`create ${allocatedId}`, authorTag);
		return rowToWorkItem(row);
	}

	async patch(
		input: WorkItemsPatchInput | CommandPatchInput,
		authorTag = DEFAULT_AUTHOR,
	): Promise<WorkItem> {
		const set = input.set ?? {};
		const clauses: string[] = [];
		for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
			keyof WorkItemsPatchSet,
			string,
		][]) {
			const value = (set as WorkItemsPatchSet)[key];
			if (value !== undefined)
				clauses.push(`${column} = ${escapeValue(value)}`);
		}
		if (clauses.length === 0) {
			const current = await this.get(input.id);
			if (!current)
				throw new Error(`Work item not found: ${input.id as string}`);
			return current;
		}

		clauses.push("revision = revision + 1", "updated_at = NOW()");
		const expectedRevision =
			"expectedRevision" in input
				? ` AND revision = ${escapeValue(Number(input.expectedRevision))}`
				: "";
		const rows = await this.sql.unsafe(
			`UPDATE work_items SET ${clauses.join(", ")} WHERE id = ${escapeValue(input.id as string)}${expectedRevision} RETURNING *`,
		);
		const row = rows[0] as Record<string, unknown> | undefined;
		if (!row) {
			const exists = await this.get(input.id);
			if (exists && expectedRevision) {
				throw new WorkItemRevisionConflictError(input.id as string);
			}
			throw new Error(`Work item not found: ${input.id as string}`);
		}
		await this.commit(`patch ${input.id as string}`, authorTag);
		return rowToWorkItem(row);
	}

	async delete(id: WorkItemId, authorTag: string): Promise<boolean> {
		const rows = await this.sql.unsafe(
			`DELETE FROM work_items WHERE id = ${escapeValue(id as string)} RETURNING id`,
		);
		if (rows.length === 0) return false;
		await this.commit(`delete ${id as string}`, authorTag);
		return true;
	}

	async transitionStatus(input: {
		id: WorkItemId;
		expectedRevision: Revision;
		toStatus: WorkItemStatus;
		reason?: string;
		blockedBy?: WorkItemId;
	}): Promise<WorkItem> {
		const current = await this.get(input.id);
		if (!current) throw new Error(`Work item not found: ${input.id as string}`);
		if (!isValidTransition(current.status, input.toStatus)) {
			throw new Error(
				`Invalid work item status transition: ${current.status} -> ${input.toStatus}`,
			);
		}
		return this.patch({
			id: input.id,
			expectedRevision: input.expectedRevision,
			set: {
				status: input.toStatus,
				...(input.blockedBy && { blockedBy: input.blockedBy }),
			},
		} as WorkItemsPatchInput & { expectedRevision: Revision });
	}

	async setAssignees(input: {
		id: WorkItemId;
		expectedRevision: Revision;
		assignees: SubjectRef[];
	}): Promise<WorkItem> {
		return this.updateJsonField(
			input.id,
			"assignees",
			input.assignees,
			input.expectedRevision,
			"set assignees",
		);
	}

	async upsertExternalRef(input: {
		id: WorkItemId;
		expectedRevision: Revision;
		ref: ExternalRef;
	}): Promise<WorkItem> {
		const current = await this.get(input.id);
		if (!current) throw new Error(`Work item not found: ${input.id as string}`);
		const refs = [...current.externalRefs];
		const index = refs.findIndex(
			(ref) => ref.system === input.ref.system && ref.kind === input.ref.kind,
		);
		if (index >= 0) refs[index] = input.ref;
		else refs.push(input.ref);
		return this.updateJsonField(
			input.id,
			"external_refs",
			refs,
			input.expectedRevision,
			"upsert external ref",
		);
	}

	private async updateJsonField(
		id: WorkItemId,
		column: "assignees" | "external_refs",
		value: unknown,
		expectedRevision: Revision,
		action: string,
	): Promise<WorkItem> {
		const rows = await this.sql.unsafe(
			`UPDATE work_items SET ${column} = ${escapeValue(value)}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(id as string)} AND revision = ${escapeValue(Number(expectedRevision))} RETURNING *`,
		);
		const row = rows[0] as Record<string, unknown> | undefined;
		if (!row) {
			if (await this.get(id))
				throw new WorkItemRevisionConflictError(id as string);
			throw new Error(`Work item not found: ${id as string}`);
		}
		await this.commit(`${action} ${id as string}`, DEFAULT_AUTHOR);
		return rowToWorkItem(row);
	}

	async claim(input: {
		id: WorkItemId;
		runId: string;
		command: string;
	}): Promise<WorkItem> {
		const rows = await this.sql.unsafe(
			`UPDATE work_items SET claimed_by_run = ${escapeValue(input.runId)}, claimed_at = NOW(), last_command = ${escapeValue(input.command)}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} RETURNING *`,
		);
		const row = rows[0] as Record<string, unknown> | undefined;
		if (!row) throw new Error(`Work item not found: ${input.id as string}`);
		await this.commit(`claim ${input.id as string}`, `run:${input.runId}`);
		return rowToWorkItem(row);
	}

	async release(input: { id: WorkItemId; runId: string }): Promise<WorkItem> {
		const rows = await this.sql.unsafe(
			`UPDATE work_items SET claimed_by_run = NULL, claimed_at = NULL, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND claimed_by_run = ${escapeValue(input.runId)} RETURNING *`,
		);
		const row = rows[0] as Record<string, unknown> | undefined;
		if (row) {
			await this.commit(`release ${input.id as string}`, `run:${input.runId}`);
			return rowToWorkItem(row);
		}
		const current = await this.get(input.id);
		if (!current) throw new Error(`Work item not found: ${input.id as string}`);
		return current;
	}

	async listRelations(id: WorkItemId): Promise<WorkRelation[]> {
		const rows = (await this.sql.unsafe(
			`SELECT id, parent_id, blocked_by FROM work_items WHERE id = ${escapeValue(id as string)} OR parent_id = ${escapeValue(id as string)} OR blocked_by = ${escapeValue(id as string)}`,
		)) as ReadonlyArray<Record<string, unknown>>;
		const relations: WorkRelation[] = [];
		for (const row of rows) {
			const rowId = toWorkItemId(String(row.id));
			if (row.parent_id) {
				relations.push({
					fromId: toWorkItemId(String(row.parent_id)),
					toId: rowId,
					type: "parent_of",
				});
			}
			if (row.blocked_by) {
				relations.push({
					fromId: toWorkItemId(String(row.blocked_by)),
					toId: rowId,
					type: "blocks",
				});
			}
		}
		return relations;
	}

	async upsertRelation(relation: WorkRelation): Promise<void> {
		const column =
			relation.type === "parent_of"
				? "parent_id"
				: relation.type === "blocks"
					? "blocked_by"
					: null;
		if (!column) {
			throw new Error(`Doltgres work_items cannot persist ${relation.type}`);
		}
		const rows = await this.sql.unsafe(
			`UPDATE work_items SET ${column} = ${escapeValue(relation.fromId as string)}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(relation.toId as string)} RETURNING id`,
		);
		if (rows.length === 0) {
			throw new Error(`Work item not found: ${relation.toId as string}`);
		}
		await this.commit(
			`upsert ${relation.type} ${relation.fromId as string}->${relation.toId as string}`,
			DEFAULT_AUTHOR,
		);
	}

	async removeRelation(relation: WorkRelation): Promise<void> {
		const column =
			relation.type === "parent_of"
				? "parent_id"
				: relation.type === "blocks"
					? "blocked_by"
					: null;
		if (!column) return;
		const rows = await this.sql.unsafe(
			`UPDATE work_items SET ${column} = NULL, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(relation.toId as string)} AND ${column} = ${escapeValue(relation.fromId as string)} RETURNING id`,
		);
		if (rows.length > 0) {
			await this.commit(
				`remove ${relation.type} ${relation.fromId as string}->${relation.toId as string}`,
				DEFAULT_AUTHOR,
			);
		}
	}
}
