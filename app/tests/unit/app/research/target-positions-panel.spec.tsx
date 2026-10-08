// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Human parity proof for position-gap runtime truth on the existing Research
 * target-position surface.
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { HTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const wallet = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const targetId = "11111111-1111-4111-8111-111111111111";

vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: readonly string[] }) =>
		queryKey[0] === "research-target-positions"
			? {
					data: {
						billing_account_id: "4212528f-6b2c-41de-a1cd-8558c871c088",
						captured_at: "2026-10-07T03:16:00.000Z",
						target_wallet: null,
						sort: "portfolio_weight",
						limit: 25,
						targets: [
							{
								target_id: targetId,
								target_wallet: wallet,
								label: "RN1",
								live_position_count: 1,
								live_portfolio_value_usdc: 200_000,
								observation: {
									cursor_status: "ok",
									last_success_at: "2026-10-07T03:15:55.000Z",
									last_position_observed_at: "2026-10-07T03:15:55.000Z",
									staleness_seconds: 5,
									freshness: "fresh",
									completeness: "complete",
									reason: "complete_saved_snapshot",
								},
							},
						],
						positions: [
							{
								target_id: targetId,
								target_wallet: wallet,
								target_label: "RN1",
								condition_id: "condition-a",
								token_id: "token-a",
								market_title: "Will truth win?",
								event_title: null,
								outcome: "Yes",
								market_slug: null,
								event_slug: null,
								market_url: null,
								shares: 10,
								cost_basis_usdc: 7.5,
								current_value_usdc: 8,
								portfolio_weight: 1,
								entry_price: 0.75,
								current_price: 0.8,
								cash_pnl_usdc: 0.5,
								last_observed_at: "2026-10-07T03:15:55.000Z",
							},
						],
						next_cursor: null,
						truncated: false,
						live_position_rule: {
							active: true,
							shares_greater_than: 0,
							max_age_seconds: 21_600,
						},
						freshness: {
							oldest_target_success_at: "2026-10-07T03:15:55.000Z",
							newest_position_observed_at: "2026-10-07T03:15:55.000Z",
						},
						completeness: {
							complete: true,
							active_target_count: 1,
							targets_returned: 1,
							targets_truncated: false,
							complete_targets: 1,
							partial_targets: 0,
							unavailable_targets: 0,
						},
						sources: {
							targets: "poly_copy_trade_targets",
							positions: "poly_trader_current_positions",
							metadata: "poly_market_metadata",
							observation: "poly_trader_ingestion_cursors",
						},
					},
					isLoading: false,
					isError: false,
					isFetching: false,
				}
			: {
					data: {
						targets: [
							{
								target_id: targetId,
								target_wallet: wallet,
								policy: { effective_kind: "position_gap" },
								position_gap_runtime: {
									status: "observed",
									snapshot: {
										completeness: "complete",
										freshness: "fresh",
									},
									plan: {
										status: "no_feasible_position",
										sleeve_budget_usdc: 24,
										eligible_net_nav_usdc: 500_000,
										scale: 0.000048,
										free_wallet_cash_after_guards_usdc: 23,
										reserved_budget_usdc: 1,
										minimum_feasible_sleeve_usdc: 53.31,
									},
									execution: {
										submitted_order_count: 0,
										filled_order_count: 0,
									},
									positions: [
										{
											condition_id: "condition-a",
											token_id: "token-a",
											desired_shares: 2,
											held_shares: 1,
											open_shares: 0.5,
											gap_shares: 0.5,
											locked_overweight_shares: 0,
											price_cap: 0.79,
											market_floor_usdc: 3.95,
											decision_reason: "below_market_floor",
										},
									],
								},
							},
						],
					},
					isLoading: false,
					isError: false,
					isFetching: false,
				},
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock("@/components", () => {
	const Div = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	);
	const TablePart = ({ children }: { children: ReactNode }) => <>{children}</>;
	return {
		Badge: Div,
		Button: ({ children, ...props }: HTMLAttributes<HTMLButtonElement>) => (
			<button {...props}>{children}</button>
		),
		Card: Div,
		CardContent: Div,
		CardHeader: Div,
		CardTitle: Div,
		Select: TablePart,
		SelectContent: TablePart,
		SelectItem: TablePart,
		SelectTrigger: Div,
		SelectValue: () => null,
		Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
		TableBody: ({ children }: { children: ReactNode }) => (
			<tbody>{children}</tbody>
		),
		TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
		TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
		TableHeader: ({ children }: { children: ReactNode }) => (
			<thead>{children}</thead>
		),
		TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
	};
});

import { TargetPositionsPanel } from "@/app/(app)/research/_components/TargetPositionsPanel";

describe("TargetPositionsPanel position-gap truth", () => {
	it("renders the saved plan, gap, floor, cap, and no-feasible state", () => {
		render(<TargetPositionsPanel />);

		expect(
			screen.getByText(/no feasible position · sleeve \$24\.00/),
		).toBeInTheDocument();
		expect(screen.getByText(/min \$53\.31/)).toBeInTheDocument();
		expect(screen.getByText("1/2 · open 0.5 · gap 0.5")).toBeInTheDocument();
		expect(
			screen.getByText("≤0.790 · $3.95 floor · below_market_floor"),
		).toBeInTheDocument();
	});
});
