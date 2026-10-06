// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin Poly wiring for the byte-identical shared Doltgres work-item adapter. */

import {
	DoltgresWorkItemAdapter,
	type DoltgresWorkItemAdapterOptions,
	WorkItemAuthorizationError,
	WorkItemLeaseConflictError,
	WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";
import type { Sql } from "postgres";

type PolyAdapterOptions = Omit<
	DoltgresWorkItemAdapterOptions,
	"idFloor" | "logger"
>;

export {
	WorkItemAuthorizationError,
	WorkItemLeaseConflictError,
	WorkItemsBusyError,
};

export class DoltgresPolyWorkItemAdapter extends DoltgresWorkItemAdapter {
	constructor(
		sql: Sql,
		logger?: DoltgresWorkItemAdapterOptions["logger"],
		options: PolyAdapterOptions = {},
	) {
		super(sql, {
			...options,
			idFloor: 5000,
			...(logger ? { logger } : {}),
		});
	}
}
