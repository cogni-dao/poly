// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/observability/db-capacity-error`
 * Purpose: Classify Postgres connection-capacity failures (role/db/server limit) so callers can
 *   treat them as transient capacity, not as a broken schema or a server bug (bug.5064).
 * Scope: Pure classification over the bounded `safeErrorDimensions` fields. No IO.
 * Invariants: Only SQLSTATE 53300/53000/53400 or a "too many connections" message match.
 * Side-effects: none
 * @public
 */

import { safeErrorDimensions } from "./safe-error-dimensions";

/** SQLSTATE 53300 too_many_connections; 53000/53400 are the sibling resource limits. */
const DB_CAPACITY_SQLSTATES: ReadonlySet<string> = new Set([
	"53300",
	"53000",
	"53400",
]);

/** True when the failure is Postgres refusing a connection (role/db/server limit). */
export function isDbCapacityError(err: unknown): boolean {
	const dims = safeErrorDimensions(err);
	const code = dims.cause_code ?? dims.err_code;
	if (code !== undefined && DB_CAPACITY_SQLSTATES.has(code)) return true;
	return /too many connections/i.test(
		`${dims.err ?? ""} ${dims.cause_message ?? ""}`,
	);
}
