// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { POLY_CLOB_ERROR_CODES } from "@cogni/poly-market-provider/adapters/polymarket";

const CLOB_ERROR_CODES = new Set<string>(Object.values(POLY_CLOB_ERROR_CODES));

export type RecoverableHardClobRejectionCode =
	| "insufficient_allowance"
	| "insufficient_balance";

/**
 * Production bundles may load two copies of the provider package, so
 * `instanceof ClobRejectionError` is not a stable boundary. The error name and
 * complete structured details are the cross-bundle contract. A generic
 * transport error with adapter-classified details deliberately does not pass.
 */
export function isStructuredClobRejection(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as {
		name?: unknown;
		details?: {
			error_code?: unknown;
			response_keys?: unknown;
		};
	};
	return (
		candidate.name === "ClobRejectionError" &&
		candidate.details !== null &&
		typeof candidate.details === "object" &&
		typeof candidate.details.error_code === "string" &&
		CLOB_ERROR_CODES.has(candidate.details.error_code) &&
		Array.isArray(candidate.details.response_keys) &&
		candidate.details.response_keys.every((key) => typeof key === "string")
	);
}

/**
 * Only the adapter's stable explicit-rejection message is durable proof that
 * an old ambiguous submission created no order. Free-form balance/allowance
 * text and transport errors remain ambiguous and fail closed.
 */
export function recoverableHardClobRejectionCode(
	detail: string | null | undefined,
): RecoverableHardClobRejectionCode | null {
	if (!detail) return null;
	const match =
		/^PolymarketClobAdapter\.placeOrder: CLOB rejected order \(error_code=(insufficient_allowance|insufficient_balance), response_keys=\[[^\]]*\], reason="\1", clob_error="/.exec(
			detail,
		);
	return (match?.[1] as RecoverableHardClobRejectionCode | undefined) ?? null;
}
