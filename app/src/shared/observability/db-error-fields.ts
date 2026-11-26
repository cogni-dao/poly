// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/observability/db-error-fields`
 * Purpose: The log fields of a failure that a route or the authority turns into a 503 `authz_unavailable`. A swallowed catch hides the cause (candidate-a, 11-13:
 *   every ask was a 503 and Loki showed nothing). One helper, so every such catch logs the same structured shape.
 * Scope: Pure. Reads `name`, a string `code` (a Postgres SQLSTATE such as `23514`, or a Node code such as `ERR_INVALID_ARG_TYPE`), and the driver's `constraint_name`,
 *   `table_name` and `column_name`; follows one `cause` (drizzle wraps driver errors).
 * Invariants:
 *   - NEVER_THE_MESSAGE_OR_DETAIL: a Postgres message or detail can carry row values (`Key (link_hash)=(...)`), so neither is ever returned. Only names, codes and schema
 *     identifiers, each length-capped. No token, hash, key or credential can reach a log through this helper.
 * Side-effects: none
 * @public
 */

const cap = (value: unknown, max = 80): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;

export interface FailureFields {
  readonly errorName: string;
  readonly errorCode?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly causeName?: string;
  readonly causeCode?: string;
}

const pick = (error: unknown) => {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  return {
    name: cap(e.name) ?? (error instanceof Error ? "Error" : "unknown"),
    code: cap(e.code, 40),
    constraint: cap(e.constraint_name),
    table: cap(e.table_name),
    column: cap(e.column_name),
    cause: e.cause,
  };
}

/** Structured, secret-free fields for a failure log line. */
export function failureFields(error: unknown): FailureFields {
  const top = pick(error);
  const cause = top.cause === undefined ? undefined : pick(top.cause);
  const constraint = top.constraint ?? cause?.constraint;
  const table = top.table ?? cause?.table;
  const column = top.column ?? cause?.column;
  const code = top.code ?? cause?.code;
  return {
    errorName: top.name,
    ...(code ? { errorCode: code } : {}),
    ...(constraint ? { constraint } : {}),
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(cause ? { causeName: cause.name, ...(cause.code ? { causeCode: cause.code } : {}) } : {}),
  };
}
