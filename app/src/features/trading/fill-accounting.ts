// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure cumulative execution proof. Venue authentication belongs to the executor;
 * this module validates identities, conserved amounts, and observation cutoffs.
 * No intent amount, submission clock, or source tag establishes paper authority.
 */
import type { GetOrderResult, OrderReceipt } from "@cogni/poly-market-provider";

export const PAPER_RECEIPT_VERSION = 1;
export const PAPER_RECEIPT_SOURCE = "paper_order_receipt";
export const FILL_SHARE_TOLERANCE = 1e-9;
export const FILL_NOTIONAL_TOLERANCE = 1e-6;

export interface FillAccountingScope {
	mode: "live" | "paper";
	billing_account_id: string;
	connection_id: string;
	client_order_id: string;
	order_id: string;
	condition_id: string;
	token_id: string;
	side: "BUY" | "SELL";
}

/** Constructed at the authenticated factory response boundary, outside JSON attributes. */
export interface PaperReceiptContext {
	billing_account_id: string;
	connection_id: string;
	observed_at: string;
}

export type ContextualOrderReceipt = OrderReceipt & {
	readonly paper_context?: PaperReceiptContext;
};

export type ContextualGetOrderResult =
	| { found: ContextualOrderReceipt }
	| Exclude<GetOrderResult, { found: OrderReceipt }>;

export interface PaperReceiptProof extends FillAccountingScope {
	version: typeof PAPER_RECEIPT_VERSION;
	mode: "paper";
	source: typeof PAPER_RECEIPT_SOURCE;
	shares: number;
	notional_usdc: number;
	price: number | null;
	fee_known: boolean;
	fees_usdc: number | null;
	venue_status: OrderReceipt["status"];
	terminal: boolean;
	observed_at: string;
	proof_key: string;
}

export type FillAccountingResult =
	| { status: "pending"; reason: string }
	| { status: "mismatch"; reason: string }
	| { status: "verified_positive"; facts: PaperReceiptProof }
	| { status: "verified_zero"; finalProof: PaperReceiptProof };

/** The existing ledger's durable columns, independent of a DB driver. */
export interface FillAccountingRow {
	mode: string;
	billingAccountId: string;
	clientOrderId: string;
	orderId: string | null;
	marketId: string;
	status: string;
	shares: string | number | null;
	price: string | number | null;
	feesUsdc: string | number | null;
	attributes: Record<string, unknown> | null;
}

export function normalizeFillCondition(value: string): string {
	return value.replace(/^prediction-market:polymarket:/i, "").toLowerCase();
}

export function fillNotionalTolerance(value: number): number {
	return Math.max(
		FILL_NOTIONAL_TOLERANCE,
		Math.abs(value) * FILL_NOTIONAL_TOLERANCE,
	);
}

export function fillNumber(value: unknown): number | null {
	if (
		typeof value !== "number" &&
		!(
			typeof value === "string" &&
			/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
		)
	)
		return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Existing ledger columns have eight decimal places; the envelope keeps native precision. */
export function fillColumnText(value: number): string {
	if (!Number.isFinite(value) || value < 0)
		throw new Error("invalid cumulative column amount");
	// PostgreSQL numeric rounds the JSON decimal, rather than the underlying IEEE
	// approximation used by toFixed. Use that same decimal and half-away rule.
	const [coefficient = "0", exponent = "0"] = value
		.toString()
		.toLowerCase()
		.split("e");
	const [whole = "0", fraction = ""] = coefficient.split(".");
	const digits = BigInt(whole + fraction);
	const shift = 8 + Number(exponent) - fraction.length;
	const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
	const rounded =
		shift >= 0
			? digits * 10n ** BigInt(shift)
			: digits / divisor + ((digits % divisor) * 2n >= divisor ? 1n : 0n);
	const text = rounded.toString().padStart(9, "0");
	return `${text.slice(0, -8)}.${text.slice(-8)}`;
}

export function fillColumnNumber(value: number): number {
	return Number(fillColumnText(value));
}

function validClock(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	)
		return false;
	const clock = new Date(value);
	return Number.isFinite(clock.getTime()) && clock.toISOString() === value;
}

function scopeMatches(
	left: Record<string, unknown>,
	right: FillAccountingScope,
): boolean {
	return (
		left.mode === right.mode &&
		left.billing_account_id === right.billing_account_id &&
		left.connection_id === right.connection_id &&
		left.client_order_id === right.client_order_id &&
		left.order_id === right.order_id &&
		left.condition_id === right.condition_id &&
		left.token_id === right.token_id &&
		left.side === right.side
	);
}

function validScope(scope: FillAccountingScope): boolean {
	return (
		scope.mode === "paper" &&
		scope.billing_account_id.length > 0 &&
		scope.connection_id.length > 0 &&
		scope.client_order_id.length > 0 &&
		scope.order_id.length > 0 &&
		/^0x[0-9a-f]{64}$/.test(scope.condition_id) &&
		/^[0-9]+$/.test(scope.token_id) &&
		(scope.side === "BUY" || scope.side === "SELL")
	);
}

export function paperProofKey(
	proof: Omit<PaperReceiptProof, "proof_key" | "observed_at">,
): string {
	// A semantic comparison key, not a signature. Authentication precedes persistence.
	const hex = (bytes: Uint8Array) =>
		Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const numberKey = (value: number | null) => {
		if (value === null) return "null";
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value);
		return hex(bytes);
	};
	const textKey = [
		proof.version.toString(),
		proof.mode,
		proof.billing_account_id,
		proof.connection_id,
		proof.client_order_id,
		proof.order_id,
		proof.condition_id,
		proof.token_id,
		proof.side,
		proof.venue_status,
		proof.fee_known ? "1" : "0",
		proof.terminal ? "1" : "0",
	]
		.map((value) => hex(new TextEncoder().encode(value)))
		.join(":");
	return `${textKey}|${[proof.shares, proof.notional_usdc, proof.price, proof.fees_usdc].map(numberKey).join(":")}`;
}

/** Validate native identity before the ledger may bind trusted account context. */
export function provePaperReceipt(
	receipt: OrderReceipt,
	scope: FillAccountingScope,
	context: PaperReceiptContext,
): FillAccountingResult {
	if (
		!validScope(scope) ||
		context.billing_account_id !== scope.billing_account_id ||
		context.connection_id !== scope.connection_id ||
		!validClock(context.observed_at)
	) {
		return { status: "mismatch", reason: "paper_account_binding_mismatch" };
	}
	const native = receipt.attributes ?? {};
	if (
		receipt.client_order_id !== scope.client_order_id ||
		receipt.order_id !== scope.order_id ||
		typeof native.market !== "string" ||
		normalizeFillCondition(native.market) !== scope.condition_id ||
		native.tokenId !== scope.token_id ||
		native.side !== scope.side
	) {
		return { status: "mismatch", reason: "paper_receipt_identity_mismatch" };
	}
	const shares = fillNumber(receipt.total_shares);
	const price = fillNumber(receipt.fill_price);
	const cost = fillNumber(receipt.filled_size_usdc);
	const matched = fillNumber(native.sizeMatched);
	const feeKnown =
		receipt.fees_usdc !== undefined && receipt.fees_usdc !== null;
	const fee = feeKnown ? fillNumber(receipt.fees_usdc) : null;
	if ((feeKnown && (fee === null || fee < 0)) || cost === null || cost < 0) {
		return { status: "mismatch", reason: "paper_receipt_amount_invalid" };
	}
	const terminal = receipt.status === "filled" || receipt.status === "canceled";
	const zero =
		receipt.status === "canceled" &&
		cost === 0 &&
		matched === 0 &&
		(shares === null || shares === 0) &&
		(price === null || price >= 0);
	if (
		!zero &&
		(shares === null ||
			shares <= 0 ||
			price === null ||
			price <= 0 ||
			cost <= 0 ||
			Math.abs(shares * price - cost) > fillNotionalTolerance(cost) ||
			(native.sizeMatched !== undefined &&
				(matched === null ||
					Math.abs(matched - shares) > FILL_SHARE_TOLERANCE)))
	) {
		return {
			status: "pending",
			reason: "paper_cumulative_execution_unavailable",
		};
	}
	const proof: PaperReceiptProof = {
		...scope,
		mode: "paper",
		version: PAPER_RECEIPT_VERSION,
		source: PAPER_RECEIPT_SOURCE,
		shares: zero ? 0 : (shares ?? 0),
		notional_usdc: cost,
		price: zero ? null : price,
		fee_known: feeKnown,
		fees_usdc: fee,
		venue_status: receipt.status,
		terminal,
		observed_at: context.observed_at,
		proof_key: "",
	};
	proof.proof_key = paperProofKey(proof);
	return zero
		? { status: "verified_zero", finalProof: proof }
		: { status: "verified_positive", facts: proof };
}

/** Decode a saved proof only against an independently selected canonical scope. */
export function decodeFillAccounting(
	row: FillAccountingRow,
	scope: FillAccountingScope,
	capturedAt: Date,
): FillAccountingResult {
	if (
		!validScope(scope) ||
		row.mode !== scope.mode ||
		row.billingAccountId !== scope.billing_account_id ||
		row.clientOrderId !== scope.client_order_id ||
		row.orderId !== scope.order_id ||
		normalizeFillCondition(row.marketId) !== scope.condition_id ||
		normalizeFillCondition(
			String(row.attributes?.condition_id ?? row.marketId),
		) !== scope.condition_id ||
		row.attributes?.token_id !== scope.token_id ||
		row.attributes?.side !== scope.side
	) {
		return { status: "mismatch", reason: "paper_ledger_identity_mismatch" };
	}
	const saved = record(row.attributes?.paper_receipt_v1);
	if (
		!saved ||
		saved.version !== PAPER_RECEIPT_VERSION ||
		saved.source !== PAPER_RECEIPT_SOURCE ||
		!scopeMatches(saved, scope)
	)
		return { status: "pending", reason: "paper_bound_receipt_missing" };
	if (
		!validClock(saved.observed_at) ||
		!Number.isFinite(capturedAt.getTime()) ||
		saved.observed_at > capturedAt.toISOString()
	)
		return { status: "pending", reason: "paper_receipt_after_cutoff" };
	if (saved.fee_known !== true && saved.fee_known !== false)
		return { status: "pending", reason: "paper_fee_state_missing" };
	if (saved.fee_known === false && saved.fees_usdc !== null)
		return { status: "mismatch", reason: "paper_fee_state_conflict" };
	const status = saved.venue_status;
	if (
		!["pending", "open", "partial", "filled", "canceled", "error"].includes(
			String(status),
		) ||
		saved.terminal !== (status === "filled" || status === "canceled") ||
		row.status !== status ||
		row.attributes?.realized_fill_source !== PAPER_RECEIPT_SOURCE
	) {
		return { status: "mismatch", reason: "paper_finality_mismatch" };
	}
	const shares = fillNumber(saved.shares);
	const cost = fillNumber(saved.notional_usdc);
	const price = fillNumber(saved.price);
	const fee = fillNumber(saved.fees_usdc);
	if (
		typeof saved.shares !== "number" ||
		typeof saved.notional_usdc !== "number" ||
		(saved.price !== null && typeof saved.price !== "number") ||
		(saved.fee_known && typeof saved.fees_usdc !== "number") ||
		shares === null ||
		cost === null ||
		(saved.fee_known && (fee === null || fee < 0)) ||
		(saved.fee_known &&
			(fee === null || fillColumnNumber(fee) !== fillNumber(row.feesUsdc)))
	)
		return { status: "mismatch", reason: "paper_saved_amount_invalid" };
	const receipt: OrderReceipt = {
		client_order_id: scope.client_order_id,
		order_id: scope.order_id,
		status: status as OrderReceipt["status"],
		filled_size_usdc: cost,
		...(shares > 0 ? { total_shares: shares } : {}),
		...(price !== null && price > 0 ? { fill_price: price } : {}),
		...(saved.fee_known && fee !== null ? { fees_usdc: fee } : {}),
		submitted_at: saved.observed_at,
		attributes: {
			market: scope.condition_id,
			tokenId: scope.token_id,
			side: scope.side,
			sizeMatched: shares,
		},
	};
	const decoded = provePaperReceipt(receipt, scope, {
		billing_account_id: scope.billing_account_id,
		connection_id: scope.connection_id,
		observed_at: saved.observed_at,
	});
	const proof = acceptedPaperProof(decoded);
	const durableShares = fillNumber(row.shares);
	const durableCost = fillNumber(row.attributes?.filled_size_usdc);
	if (
		!proof ||
		proof.proof_key !== saved.proof_key ||
		Math.abs((durableShares ?? 0) - fillColumnNumber(shares)) >
			FILL_SHARE_TOLERANCE ||
		durableCost === null ||
		Math.abs(durableCost - cost) > fillNotionalTolerance(cost) ||
		(shares > 0 &&
			(price === null ||
				fillNumber(row.price) === null ||
				Math.abs(Number(row.price) - fillColumnNumber(price)) >
					FILL_SHARE_TOLERANCE))
	) {
		return { status: "mismatch", reason: "paper_saved_tuple_conflict" };
	}
	return decoded;
}

export function acceptedPaperProof(
	result: FillAccountingResult,
): PaperReceiptProof | null {
	return result.status === "verified_positive"
		? result.facts
		: result.status === "verified_zero"
			? result.finalProof
			: null;
}

/** Public economics only after the independent SQL gate validates the durable row. */
export function paperFillAccountingPresentation(input: {
	positive: boolean | null | undefined;
	zero: boolean | null | undefined;
	shares: number | null;
	notional: number | null;
}) {
	if (input.zero === true)
		return {
			status: "verified_zero" as const,
			source: "paper_order_receipt" as const,
			matched_order_count: 1 as const,
			realized_shares: 0 as const,
			realized_entry_notional_usdc: 0 as const,
		};
	if (
		input.positive === true &&
		input.shares !== null &&
		input.shares > 0 &&
		input.notional !== null &&
		input.notional > 0
	)
		return {
			status: "verified" as const,
			source: "paper_order_receipt" as const,
			matched_order_count: 1,
			realized_shares: input.shares,
			realized_entry_notional_usdc: input.notional,
		};
	return { status: "pending" as const, source: "clob_order_receipt" as const };
}
