// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** App-local binding for the target-positions account-read capability. */

import type {
	PolyAccountTargetPositionsQuery,
	PolyAccountTargetPositionsResponse,
} from "@cogni/poly-node-contracts";

import {
	getTargetPositionsForAccount,
	InvalidTargetPositionCursorError,
	type TargetPositionsReadBinding,
} from "@/features/wallet-analysis/server/target-positions-read";

import type {
	AccountReadHandler,
	AccountReadStatus,
} from "./execute-account-read";

type TargetPositionsInput = Omit<
	PolyAccountTargetPositionsQuery,
	"billing_account_id"
> & { billing_account_id?: string };

/** One factory serves owner and delegate transports with identical policy truth. */
export function targetPositionsAccountReadHandler(
	binding: TargetPositionsReadBinding,
): AccountReadHandler<
	TargetPositionsInput,
	PolyAccountTargetPositionsResponse
> {
	return (tx, input, accountId) =>
		getTargetPositionsForAccount(tx, accountId, input, binding);
}

export function classifyTargetPositionsError(
	error: unknown,
): "invalid_input" | undefined {
	return error instanceof InvalidTargetPositionCursorError
		? "invalid_input"
		: undefined;
}

export function targetPositionsExtra(context: {
	status: AccountReadStatus;
	data: PolyAccountTargetPositionsResponse | null;
}): Record<string, unknown> {
	return {
		positionsCount: context.data?.positions.length ?? 0,
		targetsCount: context.data?.targets.length ?? 0,
		truncated: context.data?.truncated ?? false,
		...(context.status === "ok"
			? { complete: context.data?.completeness.complete ?? false }
			: {}),
	};
}
