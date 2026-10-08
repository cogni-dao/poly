// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Strict Data-API fallback for PGv3 orders whose authenticated CLOB trade
 * history has already been pruned. Public activity supplies realized trades;
 * the current position corroborates that those trades belong to exactly one
 * opening order. Any incomplete or competing evidence fails closed.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CLOCK_SKEW_SECONDS = 5;
const TERMINAL_LAG_SECONDS = 30;
const MAX_EVIDENCE_WINDOW_SECONDS = 24 * 60 * 60;
const SHARE_EPSILON = 1e-6;
const COST_EPSILON = 1e-5;

export const POSITION_GAP_DATA_API_FILL_SOURCE =
	"data_api_activity_position" as const;

export interface PositionGapActivityEvidence {
	proxyWallet: string;
	type: string;
	timestamp: number;
	conditionId?: string | null;
	asset?: string | null;
	side?: string | null;
	size?: number;
	usdcSize?: number;
	price?: number;
	transactionHash?: string | null;
}

export interface PositionGapPositionEvidence {
	proxyWallet: string;
	conditionId: string;
	asset: string;
	size: number;
	totalBought?: number | undefined;
	grossInitialValue?: number | undefined;
	entryFeesUsdc?: number | undefined;
}

export interface PositionGapFillEvidencePort {
	getWalletAddress(): Promise<`0x${string}`>;
	listActivity(
		wallet: `0x${string}`,
		params: { start: number; end: number; limit: number; offset: number },
	): Promise<readonly PositionGapActivityEvidence[]>;
	listPositions(
		wallet: `0x${string}`,
		conditionId: string,
	): Promise<readonly PositionGapPositionEvidence[]>;
}

export type PositionGapFillEvidenceMismatchReason =
	| "activity_history_incomplete"
	| "ambiguous_activity"
	| "ambiguous_position"
	| "evidence_window_too_wide"
	| "invalid_time_bounds"
	| "missing_activity"
	| "missing_position"
	| "overlapping_position_gap_order"
	| "position_cost_mismatch"
	| "position_fee_missing"
	| "position_share_mismatch"
	| "position_total_bought_mismatch"
	| "trade_share_mismatch";

export type PositionGapFillEvidenceResult =
	| {
			status: "verified";
			source: typeof POSITION_GAP_DATA_API_FILL_SOURCE;
			wallet: `0x${string}`;
			shares: number;
			filledUsdc: number;
			grossCashUsdc: number;
			fillPrice: number;
			feesUsdc?: number;
			transactionHashes: readonly string[];
			evidenceStart: string;
			evidenceEnd: string;
	  }
	| {
			status: "mismatch";
			reason: PositionGapFillEvidenceMismatchReason;
			detail: string;
	  };

export async function reconcilePositionGapFillEvidence(input: {
	port: PositionGapFillEvidencePort;
	conditionId: string;
	tokenId: string;
	expectedShares: number;
	submitStartedAt: Date | null;
	completedAt: Date | null;
	hasOverlappingOrder: boolean;
}): Promise<PositionGapFillEvidenceResult> {
	if (input.hasOverlappingOrder) {
		return mismatch(
			"overlapping_position_gap_order",
			"another PGv3 BUY for this account and token overlaps the evidence window",
		);
	}
	const startedMs = input.submitStartedAt?.getTime() ?? Number.NaN;
	const completedMs = input.completedAt?.getTime() ?? Number.NaN;
	if (
		!Number.isFinite(startedMs) ||
		!Number.isFinite(completedMs) ||
		completedMs < startedMs
	) {
		return mismatch(
			"invalid_time_bounds",
			"durable submit/completion timestamps are unavailable or inverted",
		);
	}
	const start = Math.max(0, Math.floor(startedMs / 1_000) - CLOCK_SKEW_SECONDS);
	const end = Math.ceil(completedMs / 1_000) + TERMINAL_LAG_SECONDS;
	if (end - start > MAX_EVIDENCE_WINDOW_SECONDS) {
		return mismatch(
			"evidence_window_too_wide",
			`order evidence window is ${end - start}s (max ${MAX_EVIDENCE_WINDOW_SECONDS}s)`,
		);
	}
	if (!finitePositive(input.expectedShares)) {
		return mismatch(
			"trade_share_mismatch",
			"CLOB did not persist a positive matched-share anchor",
		);
	}

	const wallet = await input.port.getWalletAddress();
	const activity: PositionGapActivityEvidence[] = [];
	let complete = false;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const rows = await input.port.listActivity(wallet, {
			start,
			end,
			limit: PAGE_SIZE,
			offset: page * PAGE_SIZE,
		});
		activity.push(...rows);
		if (rows.length < PAGE_SIZE) {
			complete = true;
			break;
		}
	}
	if (!complete) {
		return mismatch(
			"activity_history_incomplete",
			`Data API returned at least ${PAGE_SIZE * MAX_PAGES} events inside the order window`,
		);
	}

	const exactTokenActivity = activity.filter(
		(row) =>
			equalAddress(row.proxyWallet, wallet) &&
			Number.isFinite(row.timestamp) &&
			row.timestamp >= start &&
			row.timestamp <= end &&
			row.conditionId === input.conditionId &&
			row.asset === input.tokenId,
	);
	if (exactTokenActivity.length === 0) {
		return mismatch(
			"missing_activity",
			"no exact wallet/condition/token activity exists inside the order window",
		);
	}
	const trades = exactTokenActivity.filter(
		(row) =>
			row.type === "TRADE" &&
			row.side === "BUY" &&
			finitePositive(row.size) &&
			finitePositive(row.usdcSize) &&
			finitePositive(row.price) &&
			typeof row.transactionHash === "string" &&
			/^0x[a-fA-F0-9]{64}$/.test(row.transactionHash),
	);
	if (trades.length !== exactTokenActivity.length) {
		return mismatch(
			"ambiguous_activity",
			"same-token activity includes a non-BUY trade, lifecycle event, or invalid transaction",
		);
	}
	const shares = trades.reduce((sum, row) => sum + Number(row.size), 0);
	if (!sameNumber(shares, input.expectedShares, SHARE_EPSILON)) {
		return mismatch(
			"trade_share_mismatch",
			`Data API activity shares ${shares} differ from CLOB matched shares ${input.expectedShares}`,
		);
	}
	const grossCashUsdc = trades.reduce(
		(sum, row) => sum + Number(row.usdcSize),
		0,
	);
	const grossTradeNotional = trades.reduce(
		(sum, row) => sum + Number(row.size) * Number(row.price),
		0,
	);
	if (!finitePositive(grossCashUsdc) || !finitePositive(grossTradeNotional)) {
		return mismatch(
			"ambiguous_activity",
			"trade evidence did not contain positive realized economics",
		);
	}

	const positions = (
		await input.port.listPositions(wallet, input.conditionId)
	).filter(
		(position) =>
			equalAddress(position.proxyWallet, wallet) &&
			position.conditionId === input.conditionId &&
			position.asset === input.tokenId,
	);
	if (positions.length === 0) {
		return mismatch(
			"missing_position",
			"no exact wallet/condition/token position corroborates the trade",
		);
	}
	if (positions.length !== 1) {
		return mismatch(
			"ambiguous_position",
			`Data API returned ${positions.length} exact position rows`,
		);
	}
	const position = positions[0];
	if (!position || !sameNumber(position.size, shares, SHARE_EPSILON)) {
		return mismatch(
			"position_share_mismatch",
			`position shares ${position?.size ?? "missing"} differ from activity shares ${shares}`,
		);
	}
	if (!sameNumber(position.totalBought, shares, SHARE_EPSILON)) {
		return mismatch(
			"position_total_bought_mismatch",
			`position totalBought ${position.totalBought ?? "missing"} does not isolate this order`,
		);
	}
	if (
		!finitePositive(position.grossInitialValue) ||
		!sameNumber(position.grossInitialValue, grossCashUsdc, COST_EPSILON)
	) {
		return mismatch(
			"position_cost_mismatch",
			`position grossInitialValue ${position.grossInitialValue ?? "missing"} differs from activity USDC ${grossCashUsdc}`,
		);
	}

	if (!finiteNonnegative(position.entryFeesUsdc)) {
		return mismatch(
			"position_fee_missing",
			"position entryFeesUsdc is unavailable, so execution notional cannot be separated from gross cash",
		);
	}
	const feesUsdc = Number(position.entryFeesUsdc);
	const filledUsdc = Number(position.grossInitialValue) - feesUsdc;
	if (!finitePositive(filledUsdc)) {
		return mismatch(
			"position_cost_mismatch",
			`position gross cash ${position.grossInitialValue} does not exceed fees ${feesUsdc}`,
		);
	}
	if (!sameNumber(grossTradeNotional, filledUsdc, COST_EPSILON)) {
		return mismatch(
			"position_cost_mismatch",
			`fee-separated position notional ${filledUsdc} differs from activity size × price ${grossTradeNotional}`,
		);
	}
	return {
		status: "verified",
		source: POSITION_GAP_DATA_API_FILL_SOURCE,
		wallet,
		shares,
		filledUsdc,
		grossCashUsdc,
		fillPrice: filledUsdc / shares,
		feesUsdc,
		transactionHashes: [
			...new Set(
				trades.map((row) => String(row.transactionHash).toLowerCase()),
			),
		].sort(),
		evidenceStart: new Date(start * 1_000).toISOString(),
		evidenceEnd: new Date(end * 1_000).toISOString(),
	};
}

function mismatch(
	reason: PositionGapFillEvidenceMismatchReason,
	detail: string,
): PositionGapFillEvidenceResult {
	return { status: "mismatch", reason, detail };
}

function finitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameNumber(left: unknown, right: unknown, epsilon: number): boolean {
	return (
		typeof left === "number" &&
		Number.isFinite(left) &&
		typeof right === "number" &&
		Number.isFinite(right) &&
		Math.abs(left - right) <= epsilon
	);
}

function equalAddress(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}
