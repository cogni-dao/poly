// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Doltgres runtime authority for deployed work items. */

import { randomUUID } from "node:crypto";
import type {
	ActorKind,
	ExternalRef,
	SubjectRef,
	WorkItem,
	WorkItemId,
	WorkItemQueryPort,
	WorkItemStatus,
	WorkItemType,
	WorkQuery,
	WorkRelation,
} from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import type { Logger } from "pino";
import type { ReservedSql, Sql } from "postgres";

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
const AUTO_ID_RETRIES = 5;
const CLAIM_TTL_SECONDS = 300;
const COMMIT_TAG = "task.5001";
const GLOBAL_LOCK_KEY = 5_001_001;
const OP_BRANCH_PREFIX = "work-item-op/";
const MERGE_RETRIES = 3;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 50;
const QUERY_TIMEOUT_MS = 5_000;
const CANCEL_GRACE_MS = 1_000;
const RESERVE_TIMEOUT_MS = 5_000;

type WorkItemLogger = Pick<Logger, "info" | "warn" | "error">;

interface AdapterOptions {
	readonly lockWaitMs?: number;
	readonly lockRetryMs?: number;
	readonly queryTimeoutMs?: number;
	readonly cancelGraceMs?: number;
	readonly reserveTimeoutMs?: number;
}

interface OperationContext {
	readonly operationId: string;
	readonly operation: string;
	branch?: string;
}

interface WorkItemConnection {
	readonly context: OperationContext;
	unsafe(query: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

const noopLogger: WorkItemLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

export class WorkItemAlreadyExistsError extends Error {
	constructor(public readonly id: string) {
		super(`work item id '${id}' already exists`);
		this.name = "WorkItemAlreadyExistsError";
	}
}

export class WorkItemAuthorizationError extends Error {
	constructor(public readonly id: string) {
		super(`Not authorized to mutate work item: ${id}`);
		this.name = "WorkItemAuthorizationError";
	}
}

export class WorkItemLeaseConflictError extends Error {
	constructor(public readonly id: string) {
		super(`Work item is claimed by another principal or lease: ${id}`);
		this.name = "WorkItemLeaseConflictError";
	}
}

export class DoltCommitFailedError extends Error {
	constructor() {
		super("Dolt work-item commit did not return a commit hash");
		this.name = "DoltCommitFailedError";
	}
}

export class DoltOperationFailedError extends Error {
	constructor(operation: string) {
		super(`${operation} did not report success`);
		this.name = "DoltOperationFailedError";
	}
}

export class DirtyWorkItemsMainError extends Error {
	constructor() {
		super("main has uncommitted work_items changes; refusing access");
		this.name = "DirtyWorkItemsMainError";
	}
}

export class ForeignMergeInProgressError extends Error {
	constructor() {
		super("main has a merge in progress not owned by the work-item adapter");
		this.name = "ForeignMergeInProgressError";
	}
}

export class WorkItemMergeConflictError extends Error {
	constructor() {
		super("work_items operation branch conflicted while merging to main");
		this.name = "WorkItemMergeConflictError";
	}
}

export class WorkItemsBusyError extends Error {
	constructor(message = "Work-item store is busy; retry shortly") {
		super(message);
		this.name = "WorkItemsBusyError";
	}
}

class DoltMergeOutcomeUnknownError extends WorkItemsBusyError {
	constructor() {
		super(
			"Work-item merge outcome is unknown; adapter requires reconciliation",
		);
		this.name = "DoltMergeOutcomeUnknownError";
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

function requirePrincipal(principalId: string): string {
	const value = principalId.trim();
	if (!value) throw new WorkItemAuthorizationError("unknown");
	return value;
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
	const claimIsActive = row.claim_active !== false;
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
		claimedByRun: claimIsActive
			? optionalString(row.claimed_by_run)
			: undefined,
		claimedAt: claimIsActive ? optionalString(row.claimed_at) : undefined,
		lastCommand: claimIsActive ? optionalString(row.last_command) : undefined,
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

function isDuplicateError(error: unknown): boolean {
	const candidate = error as { code?: string; message?: string };
	return (
		candidate.code === "23505" ||
		/duplicate|unique|already exists/i.test(candidate.message ?? "")
	);
}

function doltCommitHash(rows: unknown): string {
	if (!Array.isArray(rows) || rows.length === 0)
		throw new DoltCommitFailedError();
	const value = (rows[0] as Record<string, unknown>).dolt_commit;
	const raw = Array.isArray(value) ? value[0] : value;
	const normalized = String(raw ?? "")
		.replace(/^\{/, "")
		.replace(/\}$/, "")
		.trim();
	if (!normalized || normalized === "undefined" || normalized === "null") {
		throw new DoltCommitFailedError();
	}
	return normalized;
}

function assertDoltStatus(
	rows: unknown,
	field: "dolt_add" | "dolt_checkout" | "dolt_branch",
): void {
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new DoltOperationFailedError(field);
	}
	const value = (rows[0] as Record<string, unknown>)[field];
	const raw = Array.isArray(value) ? value[0] : value;
	const statusMatch = String(raw ?? "").match(/^[({]?\s*(-?\d+)/);
	if (!statusMatch || Number(statusMatch[1]) !== 0) {
		throw new DoltOperationFailedError(field);
	}
}

function parseDoltMerge(rows: unknown): { hash: string; conflicts: number } {
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new WorkItemMergeConflictError();
	}
	const value = (rows[0] as Record<string, unknown>).dolt_merge;
	const parts = Array.isArray(value)
		? value
		: String(value ?? "")
				.replace(/^[({]/, "")
				.replace(/[})]$/, "")
				.split(",");
	// Doltgres 0.56 returns exactly [hash, fast_forward, conflicts, message].
	// A partial acknowledgement is ambiguous: reject it so the caller proves
	// branch-commit reachability before it can report success or retry.
	if (parts.length !== 4) {
		throw new WorkItemMergeConflictError();
	}
	const hash = String(parts[0] ?? "").trim();
	const conflicts = Number(parts[2]);
	if (!hash || !Number.isFinite(conflicts) || conflicts > 0) {
		throw new WorkItemMergeConflictError();
	}
	return { hash, conflicts };
}

function doltScalar(rows: unknown, field: string): string {
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new DoltOperationFailedError(field);
	}
	const value = (rows[0] as Record<string, unknown>)[field];
	const raw = Array.isArray(value) ? value[0] : value;
	const normalized = String(raw ?? "")
		.replace(/^\{/, "")
		.replace(/\}$/, "")
		.trim();
	if (!normalized || normalized === "undefined" || normalized === "null") {
		throw new DoltOperationFailedError(field);
	}
	return normalized;
}

function isMergeConflict(error: unknown): boolean {
	return (
		error instanceof WorkItemMergeConflictError ||
		/conflict|constraint violation/i.test(
			error instanceof Error ? error.message : String(error),
		)
	);
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

function queryStage(query: string): string {
	if (query.startsWith("SELECT pg_try_advisory_lock")) return "lock.try";
	if (query.startsWith("SELECT pg_advisory_unlock")) return "lock.release";
	if (query.includes("dolt_checkout('-b'")) return "branch.create";
	if (query === "SELECT dolt_checkout('main')") return "main.checkout";
	if (query.startsWith("SELECT dolt_commit")) return "branch.commit";
	if (query.startsWith("SELECT dolt_merge_base")) return "merge.reachability";
	if (query === "SELECT dolt_merge('--abort')") return "merge.abort";
	if (query.startsWith("SELECT dolt_merge")) return "merge.apply";
	if (query.startsWith("SELECT dolt_branch")) return "branch.delete";
	if (query.includes("FROM dolt.merge_status")) return "merge.status";
	if (query === "SELECT table_name FROM dolt.status") return "main.status";
	if (query === "SELECT name FROM dolt.branches") return "branches.list";
	if (query.startsWith("INSERT INTO work_items")) return "dml.create";
	if (query.startsWith("UPDATE work_items")) return "dml.update";
	if (query.startsWith("DELETE FROM work_items")) return "dml.delete";
	if (query.includes("FROM work_items")) return "dml.read";
	return "sql.other";
}

function doltBoolean(rows: unknown, field: string): boolean {
	if (!Array.isArray(rows) || rows.length === 0) return false;
	const value = (rows[0] as Record<string, unknown>)[field];
	const raw = Array.isArray(value) ? value[0] : value;
	return raw === true || raw === 1 || String(raw).toLowerCase() === "true";
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorFields(error: unknown): Record<string, unknown> {
	return error instanceof Error
		? { errorName: error.name, errorMessage: error.message }
		: { errorMessage: String(error) };
}

export class DoltgresPolyWorkItemAdapter
	implements WorkItemsDoltgresPort, WorkItemQueryPort
{
	private operationActive = false;
	private poisoned = false;
	private readonly logger: WorkItemLogger;
	private readonly lockWaitMs: number;
	private readonly lockRetryMs: number;
	private readonly queryTimeoutMs: number;
	private readonly cancelGraceMs: number;
	private readonly reserveTimeoutMs: number;

	constructor(
		private readonly sql: Sql,
		logger: WorkItemLogger = noopLogger,
		options: AdapterOptions = {},
	) {
		this.logger = logger;
		this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
		this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
		this.queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
		this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
		this.reserveTimeoutMs = options.reserveTimeoutMs ?? RESERVE_TIMEOUT_MS;
	}

	private logStage(
		level: "info" | "warn" | "error",
		context: OperationContext,
		stage: string,
		state: "start" | "complete" | "error",
		fields: Record<string, unknown> = {},
	): void {
		this.logger[level](
			{
				event: `adapter.work_items.stage_${state}`,
				component: "doltgres-work-items",
				operationId: context.operationId,
				operation: context.operation,
				stage,
				...fields,
			},
			`work_items ${stage} ${state}`,
		);
	}

	private async terminateClient(
		context: OperationContext,
		stage: string,
		reason: string,
	): Promise<void> {
		this.poisoned = true;
		this.logStage("error", context, "connection.terminate", "error", {
			failedStage: stage,
			reason,
		});
		await this.sql.end({ timeout: 0 }).catch((error) => {
			this.logStage("error", context, "connection.terminate", "error", {
				failedStage: stage,
				reason: "terminate_failed",
				...errorFields(error),
			});
		});
	}

	private async executeQuery(
		conn: ReservedSql,
		context: OperationContext,
		query: string,
	): Promise<ReadonlyArray<Record<string, unknown>>> {
		const stage = queryStage(query);
		const startedAt = Date.now();
		let timedOut = false;
		const branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1] ?? context.branch;
		const queryFields = branch ? { branch } : {};
		this.logStage("info", context, stage, "start", queryFields);
		const pending = conn.unsafe(query);
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const cancelTimer = setTimeout(() => {
			timedOut = true;
			try {
				pending.cancel();
			} catch (cancelError) {
				this.logStage("error", context, stage, "error", {
					...queryFields,
					timedOut: true,
					cancelFailed: true,
					...errorFields(cancelError),
				});
				void this.terminateClient(context, stage, "cancel_threw");
				return;
			}
			forceTimer = setTimeout(() => {
				void this.terminateClient(context, stage, "cancel_drain_timeout");
			}, this.cancelGraceMs);
		}, this.queryTimeoutMs);
		try {
			const rows = (await pending) as ReadonlyArray<Record<string, unknown>>;
			if (timedOut) {
				throw new WorkItemsBusyError(
					`Work-item store timed out during ${stage}; retry shortly`,
				);
			}
			this.logStage("info", context, stage, "complete", {
				...queryFields,
				durationMs: Date.now() - startedAt,
			});
			return rows;
		} catch (error) {
			this.logStage("error", context, stage, "error", {
				...queryFields,
				durationMs: Date.now() - startedAt,
				timedOut,
				...errorFields(error),
			});
			if (timedOut) {
				throw new WorkItemsBusyError(
					`Work-item store timed out during ${stage}; retry shortly`,
				);
			}
			throw error;
		} finally {
			clearTimeout(cancelTimer);
			if (forceTimer) clearTimeout(forceTimer);
		}
	}

	private instrumentConnection(
		conn: ReservedSql,
		context: OperationContext,
	): WorkItemConnection {
		return {
			context,
			unsafe: (query) => this.executeQuery(conn, context, query),
		};
	}

	private async withGlobalLock<T>(
		operation: string,
		fn: (conn: WorkItemConnection) => Promise<T>,
	): Promise<T> {
		if (this.poisoned) {
			throw new WorkItemsBusyError(
				"Work-item store requires restart reconciliation",
			);
		}
		if (this.operationActive) throw new WorkItemsBusyError();
		this.operationActive = true;
		const context = { operationId: randomUUID(), operation };
		const reserveStartedAt = Date.now();
		this.logStage("info", context, "connection.reserve", "start");
		let rawConn: ReservedSql | undefined;
		let locked = false;
		let reserveTimedOut = false;
		const reserveTimer = setTimeout(() => {
			reserveTimedOut = true;
			void this.terminateClient(
				context,
				"connection.reserve",
				"reserve_timeout",
			);
		}, this.reserveTimeoutMs);
		try {
			try {
				rawConn = await this.sql.reserve();
			} catch (error) {
				if (reserveTimedOut) {
					throw new WorkItemsBusyError(
						"Work-item store timed out reserving a connection; retry shortly",
					);
				}
				throw error;
			}
			if (reserveTimedOut) {
				await this.terminateClient(
					context,
					"connection.reserve",
					"reserve_completed_after_timeout",
				);
				throw new WorkItemsBusyError(
					"Work-item store timed out reserving a connection; retry shortly",
				);
			}
			clearTimeout(reserveTimer);
			this.logStage("info", context, "connection.reserve", "complete", {
				durationMs: Date.now() - reserveStartedAt,
			});
			const conn = this.instrumentConnection(rawConn, context);
			locked = await this.acquireGlobalLock(conn, context);
			await this.reconcileUnderLock(conn);
			return await fn(conn);
		} catch (error) {
			this.logStage("error", context, "operation", "error", {
				durationMs: Date.now() - reserveStartedAt,
				...errorFields(error),
			});
			throw error;
		} finally {
			clearTimeout(reserveTimer);
			if (locked && rawConn) {
				try {
					await this.executeQuery(
						rawConn,
						context,
						`SELECT pg_advisory_unlock(${GLOBAL_LOCK_KEY})`,
					);
				} catch {
					// Never return a session that may still own the global lock to the
					// pool. This client is dedicated to work items, so terminating it is
					// the fail-closed recovery; restart constructs a fresh client.
					await this.terminateClient(context, "lock.release", "unlock_failed");
					rawConn = undefined;
				}
			}
			rawConn?.release();
			this.operationActive = false;
		}
	}

	private async acquireGlobalLock(
		conn: WorkItemConnection,
		context: OperationContext,
	): Promise<boolean> {
		const deadline = Date.now() + this.lockWaitMs;
		do {
			const rows = await conn.unsafe(
				`SELECT pg_try_advisory_lock(${GLOBAL_LOCK_KEY})`,
			);
			if (doltBoolean(rows, "pg_try_advisory_lock")) return true;
			if (Date.now() >= deadline) {
				this.logStage("warn", context, "lock.acquire", "error", {
					durationMs: this.lockWaitMs,
					reason: "contended",
				});
				throw new WorkItemsBusyError();
			}
			await sleep(
				Math.min(this.lockRetryMs, Math.max(0, deadline - Date.now())),
			);
		} while (Date.now() <= deadline);
		throw new WorkItemsBusyError();
	}

	private async reconcileUnderLock(conn: WorkItemConnection): Promise<void> {
		const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
		assertDoltStatus(checkoutRows, "dolt_checkout");
		await this.abortOwnedMergeIfPresent(conn);
		await this.assertMainClean(conn);

		const branchRows = (await conn.unsafe(
			"SELECT name FROM dolt.branches",
		)) as ReadonlyArray<Record<string, unknown>>;
		for (const row of branchRows) {
			const branch = String(row.name ?? "");
			if (!branch.startsWith(OP_BRANCH_PREFIX)) continue;
			const deleteRows = await conn.unsafe(
				`SELECT dolt_branch('-D', ${escapeValue(branch)})`,
			);
			assertDoltStatus(deleteRows, "dolt_branch");
		}
	}

	private async mergeState(
		conn: WorkItemConnection,
	): Promise<Record<string, unknown> | undefined> {
		const rows = (await conn.unsafe(
			"SELECT is_merging, source, source_commit, target, unmerged_tables FROM dolt.merge_status",
		)) as ReadonlyArray<Record<string, unknown>>;
		return rows.find((row) => row.is_merging === true);
	}

	private async abortOwnedMergeIfPresent(
		conn: WorkItemConnection,
		expectedBranch?: string,
	): Promise<boolean> {
		const state = await this.mergeState(conn);
		if (!state) return false;
		const source = String(state.source ?? "");
		const target = String(state.target ?? "");
		const owned =
			source.startsWith(OP_BRANCH_PREFIX) &&
			(expectedBranch === undefined || source === expectedBranch) &&
			(target === "main" || target === "refs/heads/main");
		if (!owned) throw new ForeignMergeInProgressError();

		await conn.unsafe("SELECT dolt_merge('--abort')");
		if (await this.mergeState(conn)) {
			throw new DoltOperationFailedError("dolt_merge --abort");
		}
		return true;
	}

	private async branchCommitIsOnMain(
		conn: WorkItemConnection,
		branchCommit: string,
	): Promise<boolean> {
		const rows = await conn.unsafe(
			`SELECT dolt_merge_base('main', ${escapeValue(branchCommit)}) AS dolt_merge_base`,
		);
		return doltScalar(rows, "dolt_merge_base") === branchCommit;
	}

	private async assertMainClean(conn: WorkItemConnection): Promise<void> {
		const rows = (await conn.unsafe(
			"SELECT table_name FROM dolt.status",
		)) as ReadonlyArray<Record<string, unknown>>;
		if (
			rows.some((row) =>
				String(row.table_name ?? "")
					.toLowerCase()
					.endsWith("work_items"),
			)
		) {
			throw new DirtyWorkItemsMainError();
		}
	}

	private async mutate<T>(
		message: string,
		principalId: string,
		fn: (conn: WorkItemConnection) => Promise<T>,
		shouldCommit: (result: T) => boolean = () => true,
	): Promise<T> {
		let lastConflict: unknown;
		for (let attempt = 0; attempt < MERGE_RETRIES; attempt += 1) {
			try {
				return await this.withGlobalLock(message, (conn) =>
					this.mutateOnBranch(
						conn,
						message,
						requirePrincipal(principalId),
						fn,
						shouldCommit,
					),
				);
			} catch (error) {
				if (!(error instanceof WorkItemMergeConflictError)) throw error;
				lastConflict = error;
			}
		}
		throw lastConflict;
	}

	private async mutateOnBranch<T>(
		conn: WorkItemConnection,
		message: string,
		principalId: string,
		fn: (conn: WorkItemConnection) => Promise<T>,
		shouldCommit: (result: T) => boolean,
	): Promise<T> {
		const branch = `${OP_BRANCH_PREFIX}${randomUUID()}`;
		conn.context.branch = branch;
		const createRows = await conn.unsafe(
			`SELECT dolt_checkout('-b', ${escapeValue(branch)}, 'main')`,
		);
		assertDoltStatus(createRows, "dolt_checkout");

		try {
			const result = await fn(conn);
			if (!shouldCommit(result)) {
				await this.returnToMainAndDeleteBranch(conn, branch);
				return result;
			}
			const commitRows = await conn.unsafe(
				`SELECT dolt_commit('-Am', ${escapeValue(`${COMMIT_TAG}: ${message} by actor:${principalId}`)})`,
			);
			const branchCommit = doltCommitHash(commitRows);

			const mainRows = await conn.unsafe("SELECT dolt_checkout('main')");
			assertDoltStatus(mainRows, "dolt_checkout");
			let mergeRows: unknown;
			try {
				mergeRows = await conn.unsafe(
					`SELECT dolt_merge(${escapeValue(branch)})`,
				);
				const merge = parseDoltMerge(mergeRows);
				if (merge.conflicts > 0) throw new WorkItemMergeConflictError();
			} catch (mergeError) {
				// DOLT_MERGE implicitly commits. A transport error can therefore arrive
				// after main moved. Reachability is the authority: never replay a
				// create/update/delete whose branch commit is already on main.
				let reachable: boolean;
				try {
					reachable = await this.branchCommitIsOnMain(conn, branchCommit);
				} catch (proofError) {
					this.poisoned = true;
					this.logger.error(
						{
							event: "adapter.work_items.merge_outcome_unknown",
							component: "doltgres-work-items",
							branch,
							...errorFields(proofError),
						},
						"work_items merge reachability could not be proven",
					);
					throw new DoltMergeOutcomeUnknownError();
				}
				if (reachable) {
					await this.postMergeHousekeeping(conn, branch).catch(() => undefined);
					return result;
				}
				const aborted = await this.abortOwnedMergeIfPresent(conn, branch);
				if (aborted || isMergeConflict(mergeError)) {
					throw new WorkItemMergeConflictError();
				}
				throw mergeError;
			}
			// The merge is now durable. Cleanup is repairable housekeeping and must
			// not turn a committed mutation into an API failure that callers replay.
			await this.postMergeHousekeeping(conn, branch).catch(() => undefined);
			return result;
		} catch (error) {
			if (error instanceof DoltMergeOutcomeUnknownError) {
				throw error;
			}
			await this.returnToMainAndDeleteBranch(conn, branch).catch(
				() => undefined,
			);
			throw error;
		}
	}

	private async postMergeHousekeeping(
		conn: WorkItemConnection,
		branch: string,
	): Promise<void> {
		await this.assertMainClean(conn);
		await this.deleteOperationBranch(conn, branch);
	}

	private async returnToMainAndDeleteBranch(
		conn: WorkItemConnection,
		branch: string,
	): Promise<void> {
		const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
		assertDoltStatus(checkoutRows, "dolt_checkout");
		await this.assertMainClean(conn);
		await this.deleteOperationBranch(conn, branch);
	}

	private async deleteOperationBranch(
		conn: WorkItemConnection,
		branch: string,
	): Promise<void> {
		const rows = await conn.unsafe(
			`SELECT dolt_branch('-D', ${escapeValue(branch)})`,
		);
		assertDoltStatus(rows, "dolt_branch");
	}

	private async readOnCleanMain<T>(
		fn: (conn: WorkItemConnection) => Promise<T>,
	): Promise<T> {
		return this.withGlobalLock("read work items", fn);
	}

	private async getWith(conn: WorkItemConnection, id: WorkItemId) {
		const rows = await conn.unsafe(
			`SELECT *, (claim_expires_at IS NOT NULL AND claim_expires_at > NOW()) AS claim_active FROM work_items WHERE id = ${escapeValue(id as string)} LIMIT 1`,
		);
		return rows.length > 0 ? (rows[0] as Record<string, unknown>) : undefined;
	}

	async get(id: WorkItemId): Promise<WorkItem | null> {
		return this.readOnCleanMain(async (conn) => {
			const row = await this.getWith(conn, id);
			return row ? rowToWorkItem(row) : null;
		});
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
			conditions.push(
				`(COALESCE(priority,999) > ${priority}` +
					` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) > ${rank})` +
					` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) = ${rank} AND created_at < ${escapeValue(cursor.ts)})` +
					` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) = ${rank} AND created_at = ${escapeValue(cursor.ts)} AND id > ${escapeValue(cursor.id)}))`,
			);
		}

		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
		const rows = await this.readOnCleanMain(
			async (conn) =>
				(await conn.unsafe(
					`SELECT *, (claim_expires_at IS NOT NULL AND claim_expires_at > NOW()) AS claim_active FROM work_items ${where} ORDER BY COALESCE(priority, 999) ASC, COALESCE(rank, 999) ASC, created_at DESC, id ASC LIMIT ${limit + 1}`,
				)) as ReadonlyArray<Record<string, unknown>>,
		);
		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		const items = pageRows.map(rowToWorkItem);
		let endCursor: string | null = null;
		if (hasMore && pageRows.length) {
			const last = pageRows[pageRows.length - 1];
			if (!last) throw new Error("cursor row missing");
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
		principalId: string,
	): Promise<WorkItem> {
		const principal = requirePrincipal(principalId);
		const createOnce = (allocatedId?: string) =>
			this.mutate("create work item", principal, async (conn) => {
				const insert = async (allocatedId: string) => {
					const columns = [
						"id",
						"type",
						"title",
						"status",
						"node",
						"created_by_principal_id",
					];
					const values = [
						escapeValue(allocatedId),
						escapeValue(input.type),
						escapeValue(input.title),
						escapeValue(input.status ?? "needs_triage"),
						escapeValue(input.node ?? "shared"),
						escapeValue(principal),
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
					const rows = await conn.unsafe(
						`INSERT INTO work_items (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING *, FALSE AS claim_active`,
					);
					const row = rows[0] as Record<string, unknown> | undefined;
					if (!row) throw new Error("INSERT returned no row");
					return rowToWorkItem(row);
				};

				if (allocatedId) return insert(allocatedId);

				const idRows = await conn.unsafe(
					`SELECT id FROM work_items WHERE type = ${escapeValue(input.type)}`,
				);
				let maxSuffix = ID_FLOOR - 1;
				for (const row of idRows as ReadonlyArray<Record<string, unknown>>) {
					const suffix = parseSuffix(String(row.id), input.type);
					if (suffix !== null && suffix > maxSuffix) maxSuffix = suffix;
				}
				const nextId = `${input.type}.${String(maxSuffix + 1).padStart(4, "0")}`;
				try {
					return await insert(nextId);
				} catch (error) {
					if (isDuplicateError(error)) {
						throw new WorkItemAlreadyExistsError(nextId);
					}
					throw error;
				}
			});

		if (input.id) {
			const requested = String(input.id);
			if (!requested.startsWith(`${input.type}.`)) {
				throw new Error(
					`Provided id '${requested}' does not match type '${input.type}'`,
				);
			}
			try {
				return await createOnce(requested);
			} catch (error) {
				if (isDuplicateError(error)) {
					throw new WorkItemAlreadyExistsError(requested);
				}
				throw error;
			}
		}

		let lastCollisionId = `${input.type}.${ID_FLOOR}`;
		for (let attempt = 0; attempt < AUTO_ID_RETRIES; attempt += 1) {
			try {
				return await createOnce();
			} catch (error) {
				if (!isDuplicateError(error)) throw error;
				const match = /work item id '([^']+)'/.exec(
					error instanceof Error ? error.message : "",
				);
				if (match?.[1]) lastCollisionId = match[1];
			}
		}
		throw new WorkItemAlreadyExistsError(lastCollisionId);
	}

	async patch(
		input: WorkItemsPatchInput,
		principalId: string,
	): Promise<WorkItem> {
		const principal = requirePrincipal(principalId);
		const clauses: string[] = [];
		for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
			keyof WorkItemsPatchSet,
			string,
		][]) {
			const value = input.set[key];
			if (value !== undefined)
				clauses.push(`${column} = ${escapeValue(value)}`);
		}
		if (!clauses.length) {
			return this.readOnCleanMain(async (conn) => {
				const current = await this.getWith(conn, input.id);
				if (!current)
					throw new Error(`Work item not found: ${input.id as string}`);
				if (String(current.created_by_principal_id) !== principal) {
					throw new WorkItemAuthorizationError(input.id as string);
				}
				return rowToWorkItem(current);
			});
		}

		return this.mutate(
			`patch ${input.id as string}`,
			principal,
			async (conn) => {
				clauses.push("revision = revision + 1", "updated_at = NOW()");
				const rows = await conn.unsafe(
					`UPDATE work_items SET ${clauses.join(", ")} WHERE id = ${escapeValue(input.id as string)} AND created_by_principal_id = ${escapeValue(principal)} RETURNING *, (claim_expires_at IS NOT NULL AND claim_expires_at > NOW()) AS claim_active`,
				);
				const row = rows[0] as Record<string, unknown> | undefined;
				if (!row) await this.throwMissingOrUnauthorized(conn, input.id);
				return rowToWorkItem(row as Record<string, unknown>);
			},
		);
	}

	async delete(id: WorkItemId, principalId: string): Promise<boolean> {
		const principal = requirePrincipal(principalId);
		return this.mutate(
			`delete ${id as string}`,
			principal,
			async (conn) => {
				const rows = await conn.unsafe(
					`DELETE FROM work_items WHERE id = ${escapeValue(id as string)} AND created_by_principal_id = ${escapeValue(principal)} RETURNING id`,
				);
				if (rows.length) return true;
				const current = await this.getWith(conn, id);
				if (current) throw new WorkItemAuthorizationError(id as string);
				return false;
			},
			Boolean,
		);
	}

	private async throwMissingOrUnauthorized(
		conn: WorkItemConnection,
		id: WorkItemId,
	): Promise<never> {
		if (await this.getWith(conn, id)) {
			throw new WorkItemAuthorizationError(id as string);
		}
		throw new Error(`Work item not found: ${id as string}`);
	}

	async claim(input: {
		id: WorkItemId;
		runId: string;
		command: string;
		principalId: string;
	}): Promise<WorkItem> {
		const principal = requirePrincipal(input.principalId);
		return this.mutate(
			`claim ${input.id as string}`,
			principal,
			async (conn) => {
				const rows = await conn.unsafe(
					`UPDATE work_items SET claimed_by_run = ${escapeValue(input.runId)}, claim_owner_principal_id = ${escapeValue(principal)}, claimed_at = NOW(), claim_expires_at = NOW() + INTERVAL '${CLAIM_TTL_SECONDS} seconds', last_command = ${escapeValue(input.command)}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND (claim_expires_at IS NULL OR claim_expires_at <= NOW() OR (claim_owner_principal_id = ${escapeValue(principal)} AND claimed_by_run = ${escapeValue(input.runId)})) RETURNING *, TRUE AS claim_active`,
				);
				const row = rows[0] as Record<string, unknown> | undefined;
				if (!row) await this.throwLeaseConflictOrMissing(conn, input.id);
				return rowToWorkItem(row as Record<string, unknown>);
			},
		);
	}

	async heartbeat(input: {
		id: WorkItemId;
		runId: string;
		command?: string;
		principalId: string;
	}): Promise<WorkItem> {
		const principal = requirePrincipal(input.principalId);
		return this.mutate(
			`heartbeat ${input.id as string}`,
			principal,
			async (conn) => {
				const command =
					input.command === undefined
						? ""
						: `, last_command = ${escapeValue(input.command)}`;
				const rows = await conn.unsafe(
					`UPDATE work_items SET claim_expires_at = NOW() + INTERVAL '${CLAIM_TTL_SECONDS} seconds'${command}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND claim_owner_principal_id = ${escapeValue(principal)} AND claimed_by_run = ${escapeValue(input.runId)} AND claim_expires_at > NOW() RETURNING *, TRUE AS claim_active`,
				);
				const row = rows[0] as Record<string, unknown> | undefined;
				if (!row) await this.throwLeaseConflictOrMissing(conn, input.id);
				return rowToWorkItem(row as Record<string, unknown>);
			},
		);
	}

	async release(input: {
		id: WorkItemId;
		runId: string;
		principalId: string;
	}): Promise<WorkItem> {
		const principal = requirePrincipal(input.principalId);
		return this.mutate(
			`release ${input.id as string}`,
			principal,
			async (conn) => {
				const rows = await conn.unsafe(
					`UPDATE work_items SET claimed_by_run = NULL, claim_owner_principal_id = NULL, claimed_at = NULL, claim_expires_at = NULL, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND claim_owner_principal_id = ${escapeValue(principal)} AND claimed_by_run = ${escapeValue(input.runId)} RETURNING *, FALSE AS claim_active`,
				);
				const row = rows[0] as Record<string, unknown> | undefined;
				if (!row) await this.throwLeaseConflictOrMissing(conn, input.id);
				return rowToWorkItem(row as Record<string, unknown>);
			},
		);
	}

	private async throwLeaseConflictOrMissing(
		conn: WorkItemConnection,
		id: WorkItemId,
	): Promise<never> {
		if (await this.getWith(conn, id)) {
			throw new WorkItemLeaseConflictError(id as string);
		}
		throw new Error(`Work item not found: ${id as string}`);
	}

	async listRelations(id: WorkItemId): Promise<WorkRelation[]> {
		const rows = await this.readOnCleanMain(
			async (conn) =>
				(await conn.unsafe(
					`SELECT id, parent_id, blocked_by FROM work_items WHERE id = ${escapeValue(id as string)} OR parent_id = ${escapeValue(id as string)} OR blocked_by = ${escapeValue(id as string)}`,
				)) as ReadonlyArray<Record<string, unknown>>,
		);
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
}
