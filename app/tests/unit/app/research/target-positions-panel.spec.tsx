// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Human parity proof for the existing Target Positions Research table. @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { HTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const wallet = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const targetId = "11111111-1111-4111-8111-111111111111";
const runtime = {
	status: "observed",
	run: { status: "completed" },
	snapshot: { completeness: "complete", freshness: "fresh" },
	plan: {
		status: "no_feasible_position",
		sleeve_budget_usdc: 24,
		eligible_net_nav_usdc: 500_000,
		target_complete_set_value_usdc: 25_000,
		target_pusd_balance_usdc: 1_800_000,
		target_usdce_balance_usdc: 0,
		target_total_wealth_usdc: 2_325_000,
		target_balance_source_block: 95_213_861,
		scale: 0.000048,
		free_wallet_cash_after_guards_usdc: 23,
		reserved_budget_usdc: 1,
		minimum_feasible_sleeve_usdc: 53.31,
		locked_overweight_count: 0,
	},
	execution: {
		scope: "target_lifetime",
		submitted_order_count: 1,
		fill_accounting: { status: "pending", source: "clob_order_receipt" },
	},
	positions_truncated: false,
	positions: [],
} as const;
const runtimeRow = {
	decision_reasons: ["below_market_floor"],
	target_weight: 0.18,
	desired_shares: 2,
	held_shares: 1,
	open_shares: 0.5,
	gap_shares: 0.5,
	locked_overweight_shares: 0,
	price_cap: 0.79,
	market_floor_usdc: 3.95,
	minimum_sleeve_usdc: 53.31,
	cohort_count: 1,
} as const;

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
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
					position_gap_runtime: runtime,
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
					row_source: "saved_and_runtime",
					shares: 10,
					cost_basis_usdc: 7.5,
					current_value_usdc: 8,
					portfolio_weight: 0.9,
					entry_price: 0.75,
					current_price: 0.8,
					cash_pnl_usdc: 0.5,
					last_observed_at: "2026-10-07T03:15:55.000Z",
					runtime: runtimeRow,
				},
				{
					target_id: targetId,
					target_wallet: wallet,
					target_label: "RN1",
					condition_id: "condition-runtime",
					token_id: "token-runtime",
					market_title: "Runtime-only market",
					event_title: null,
					outcome: null,
					market_slug: null,
					event_slug: null,
					market_url: null,
					row_source: "runtime_only",
					shares: null,
					cost_basis_usdc: null,
					current_value_usdc: null,
					portfolio_weight: 0.1,
					entry_price: null,
					current_price: null,
					cash_pnl_usdc: null,
					last_observed_at: "2026-10-07T03:15:58.000Z",
					runtime: {
						...runtimeRow,
						decision_reasons: ["missing_cohort"],
						target_weight: 0.1,
						desired_shares: 1,
						held_shares: 0,
						open_shares: 0,
						gap_shares: 1,
						price_cap: null,
						market_floor_usdc: null,
						minimum_sleeve_usdc: null,
					},
				},
			],
			next_cursor: null,
			truncated: false,
		},
		isLoading: false,
		isError: false,
		isFetching: false,
	}),
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
	it("renders runtime-only rows and decision facts from the one account read", () => {
		render(<TargetPositionsPanel />);

		expect(
			screen.getByText(/no order · usable budget \$24\.00/),
		).toBeInTheDocument();
		expect(screen.getByText(/\$53\.31 needed/)).toBeInTheDocument();
		expect(
			screen.getByText(
				/Target wealth \$2,325,000\.00 · pUSD balance \$1,800,000\.00 · directional positions \$500,000\.00 · paired sets \$25,000\.00 · block 95,213,861/,
			),
		).toBeInTheDocument();
		expect(screen.getByText("1/2 · open 0.5 · gap 0.5")).toBeInTheDocument();
		expect(screen.getByText(/1 submitted · fills pending/)).toBeInTheDocument();
		expect(screen.queryByText(/filled/)).not.toBeInTheDocument();
		expect(
			screen.getByText("≤0.790 · $3.95 floor · below_market_floor"),
		).toBeInTheDocument();
		expect(screen.getByText("RN1 · runtime")).toBeInTheDocument();
		expect(screen.getByText("Runtime-only market")).toBeInTheDocument();
		expect(screen.getByText("0/1 · open 0 · gap 1")).toBeInTheDocument();
	});
});
