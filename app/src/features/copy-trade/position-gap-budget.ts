// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure allocation math for sharing one mirror wallet across position-gap targets.
 * Configured budgets reserve dollars; null budgets split the unreserved NAV.
 */

export type PositionGapBudgetAllocationStatus =
	| "full"
	| "reserved"
	| "prorated"
	| "shared_remainder";

export interface PositionGapBudgetGroup {
	explicitBudgetTotalUsdc: number;
	automaticTargetCount: number;
	unbudgetedTargetCount: number;
}

export interface EffectivePositionGapBudget {
	effectiveBudgetUsdc: number;
	allocationStatus: PositionGapBudgetAllocationStatus;
	overallocated: boolean;
}

/** Summarize only runtime-eligible position-gap targets in one account. */
export function summarizePositionGapBudgetGroup(
	configuredBudgets: readonly (number | null)[],
	unbudgetedTargetCount: number,
): PositionGapBudgetGroup {
	return {
		explicitBudgetTotalUsdc: configuredBudgets.reduce<number>(
			(sum, budget) => sum + (budget ?? 0),
			0,
		),
		automaticTargetCount: configuredBudgets.filter((budget) => budget === null)
			.length,
		unbudgetedTargetCount,
	};
}

/**
 * Allocate one target's effective budget without allowing the account-wide
 * position-gap allocation to exceed live mirror NAV.
 */
export function effectivePositionGapBudget(params: {
	configuredBudgetUsdc: number | null;
	mirrorNavUsdc: number;
	group: PositionGapBudgetGroup;
}): EffectivePositionGapBudget | undefined {
	const { configuredBudgetUsdc, mirrorNavUsdc, group } = params;
	if (
		!Number.isFinite(mirrorNavUsdc) ||
		mirrorNavUsdc < 0 ||
		!Number.isFinite(group.explicitBudgetTotalUsdc) ||
		group.explicitBudgetTotalUsdc < 0 ||
		!Number.isInteger(group.automaticTargetCount) ||
		group.automaticTargetCount < 0 ||
		!Number.isInteger(group.unbudgetedTargetCount) ||
		group.unbudgetedTargetCount < 0 ||
		(configuredBudgetUsdc !== null &&
			(!Number.isFinite(configuredBudgetUsdc) || configuredBudgetUsdc <= 0))
	) {
		return undefined;
	}

	const overallocated = group.explicitBudgetTotalUsdc > mirrorNavUsdc;
	if (configuredBudgetUsdc !== null) {
		if (overallocated && group.explicitBudgetTotalUsdc > 0) {
			return {
				effectiveBudgetUsdc:
					(mirrorNavUsdc * configuredBudgetUsdc) /
					group.explicitBudgetTotalUsdc,
				allocationStatus: "prorated",
				overallocated,
			};
		}
		return {
			effectiveBudgetUsdc: configuredBudgetUsdc,
			allocationStatus: "reserved",
			overallocated,
		};
	}

	if (group.automaticTargetCount <= 0) return undefined;
	const effectiveBudgetUsdc =
		Math.max(mirrorNavUsdc - group.explicitBudgetTotalUsdc, 0) /
		group.automaticTargetCount;
	return {
		effectiveBudgetUsdc,
		allocationStatus:
			group.automaticTargetCount === 1 && group.explicitBudgetTotalUsdc === 0
				? "full"
				: "shared_remainder",
		overallocated,
	};
}
