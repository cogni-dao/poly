// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Poly composition: published content + one published operational lease authority.
 * Bridge content locking remains until all old global-lock writers have drained.
 * Activation requires the generated Postgres migration and bounded producer handoff.
 */
import { withWorkItemLeases, type WorkItemLeasePort } from "@cogni/work-items";
import {
	DoltgresWorkItemAdapter,
	type DoltgresWorkItemAdapterOptions,
} from "@cogni/work-items/adapters/doltgres";
import type { Sql } from "postgres";

type Options = Omit<DoltgresWorkItemAdapterOptions, "idFloor" | "logger">;

export function createPolyWorkItemAdapter(
	sql: Sql,
	leases: WorkItemLeasePort,
	logger?: DoltgresWorkItemAdapterOptions["logger"],
	options: Options = {},
) {
	const content = new DoltgresWorkItemAdapter(sql, {
		...options,
		idFloor: 5000,
		writerLockProtocol: "bridge",
		...(logger ? { logger } : {}),
	});
	return Object.assign(withWorkItemLeases(content, leases), {
		listRelations: content.listRelations.bind(content),
	});
}
