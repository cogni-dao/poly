// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_components/TradingWalletBalanceBar`
 * Purpose: Preserve the legacy wallet balance bar while rendering nullable
 *   dashboard facts without coercing an unavailable leg to zero.
 * Scope: Presentational only. Complete facts delegate to the shared legacy
 *   `BalanceBar`; partial facts retain the same legend and a visibly
 *   indeterminate marker for each unknown leg.
 * Invariants:
 *   - UNKNOWN_IS_NOT_ZERO: nullable values render as an em dash.
 *   - COMPLETE_REUSES_LEGACY: complete facts always use `BalanceBar`.
 *   - PARTIAL_BAR_IS_NOT_A_TOTAL: known legs are proportional only to the
 *     known subtotal; fixed-width faded markers denote unknown legs.
 * Side-effects: none.
 * @internal
 */

"use client";

import type { ReactElement } from "react";
import { BalanceBar } from "@/features/wallet-analysis";

export type TradingWalletBalance = {
	readonly available: number | null;
	readonly locked: number | null;
	readonly positions: number | null;
	readonly total: number | null;
};

type BalanceLeg = {
	readonly key: "available" | "locked" | "positions";
	readonly label: "Available" | "Locked" | "Positions";
	readonly color: string;
	readonly value: number | null;
};

function fmtUsd(value: number | null): string {
	return value === null ? "—" : `$${value.toFixed(2)}`;
}

function hasCompleteBalance(balance: TradingWalletBalance): balance is {
	readonly available: number;
	readonly locked: number;
	readonly positions: number;
	readonly total: number;
} {
	return (
		balance.available !== null &&
		balance.locked !== null &&
		balance.positions !== null &&
		balance.total !== null
	);
}

export function TradingWalletBalanceBar({
	balance,
}: {
	readonly balance: TradingWalletBalance;
}): ReactElement {
	if (hasCompleteBalance(balance)) {
		return <BalanceBar balance={balance} />;
	}

	const legs: readonly BalanceLeg[] = [
		{
			key: "available",
			label: "Available",
			color: "bg-success/70",
			value: balance.available,
		},
		{
			key: "locked",
			label: "Locked",
			color: "bg-warning/70",
			value: balance.locked,
		},
		{
			key: "positions",
			label: "Positions",
			color: "bg-[hsl(var(--chart-1))]/70",
			value: balance.positions,
		},
	];
	const knownTotal = legs.reduce(
		(sum, leg) => sum + Math.max(0, leg.value ?? 0),
		0,
	);
	const accessibilityLabel = [
		"Balance composition",
		...legs.map(
			(leg) =>
				`${leg.label}: ${leg.value === null ? "unavailable" : fmtUsd(leg.value)}`,
		),
		`Total: ${balance.total === null ? "unavailable" : fmtUsd(balance.total)}`,
	].join("; ");

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
				<div className="flex items-baseline gap-2">
					<span className="text-muted-foreground text-xs uppercase tracking-wide">
						Total
					</span>
					<span className="font-semibold text-base tabular-nums">
						{fmtUsd(balance.total)}
					</span>
				</div>
				<div className="flex items-center gap-4 text-muted-foreground text-xs">
					{legs.map((leg) => (
						<span key={leg.key} className="inline-flex items-center gap-1.5">
							<span
								className={`inline-block size-2 rounded-sm ${leg.color}`}
								title={`${leg.label} balance`}
							/>
							{leg.label}{" "}
							<span className="text-foreground tabular-nums">
								{fmtUsd(leg.value)}
							</span>
						</span>
					))}
				</div>
			</div>

			<div
				className="flex h-2 overflow-hidden rounded-full bg-muted"
				role="img"
				aria-label={accessibilityLabel}
			>
				{knownTotal > 0 ? (
					legs.flatMap((leg) =>
						leg.value !== null && leg.value > 0
							? [
									<span
										key={leg.key}
										className={leg.color}
										style={{ flexBasis: 0, flexGrow: leg.value }}
										title={`${leg.label}: ${fmtUsd(leg.value)}`}
									/>,
								]
							: [],
					)
				) : (
					<span className="flex-1 bg-muted" />
				)}
				{legs.flatMap((leg) =>
					leg.value === null
						? [
								<span
									key={`unknown-${leg.key}`}
									className={`w-4 shrink-0 opacity-30 ${leg.color}`}
									title={`${leg.label} unavailable`}
								/>,
							]
						: [],
				)}
			</div>
		</div>
	);
}
