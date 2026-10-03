// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `trading-wallet-states.spec`
 * Purpose: Prove wallet status failures and unknown collateral never collapse
 *   into deployment-disabled or known-zero funding states.
 * Scope: Money-page client components with React Query and visual children mocked.
 * Invariants: UNKNOWN_IS_NOT_ZERO, APPROVALS_REMAIN_AVAILABLE.
 * Side-effects: none
 * @vitest-environment jsdom
 */

import type { PolyWalletBalancesOutput } from "@cogni/poly-node-contracts";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	statusQuery: {
		data: undefined as unknown,
		isLoading: false,
		isError: false,
	},
	balancesQuery: {
		data: undefined as unknown,
		isLoading: false,
		isError: false,
	},
	mutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({
		data: undefined,
		error: null,
		isError: false,
		isPending: false,
		mutate: state.mutate,
	}),
	useQuery: ({ queryKey }: { queryKey: readonly string[] }) =>
		queryKey[0] === "poly-wallet-status"
			? state.statusQuery
			: state.balancesQuery,
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("next-auth/react", () => ({
	useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock("@/components", () => ({
	AddressChip: ({ address }: { address: string }) => <span>{address}</span>,
	Card: ({ children }: { children: ReactNode }) => (
		<section>{children}</section>
	),
	HintText: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

vi.mock("@/app/(app)/credits/AutoWrapToggle", () => ({
	AutoWrapToggle: () => <div>auto wrap</div>,
}));

vi.mock("@/app/(app)/credits/TradingWalletConnectFlow", () => ({
	TradingWalletConnectFlow: () => <div>connect flow</div>,
}));

vi.mock("@/app/(app)/credits/TradingWalletWithdrawDialog", () => ({
	TradingWalletWithdrawDialog: () => <button type="button">Withdraw</button>,
}));

import {
	classifyFundingState,
	TradingWalletPanel,
} from "@/app/(app)/credits/TradingWalletPanel";

function walletBalances(
	usdcE: number | null,
	pusd: number | null,
): PolyWalletBalancesOutput {
	return {
		configured: true,
		connected: true,
		address: "0x1111111111111111111111111111111111111111",
		usdc_e: usdcE,
		pusd,
		pol: 0,
		errors: [],
	};
}

function connectedStatus(tradingReady: boolean) {
	return {
		configured: true,
		connected: true,
		connection_id: "11111111-1111-4111-8111-111111111111",
		funder_address: "0x1111111111111111111111111111111111111111",
		trading_ready: tradingReady,
		auto_wrap_consent_at: null,
		auto_wrap_floor_usdce_atomic: "1000000",
	};
}

describe("trading-wallet missing states", () => {
	beforeEach(() => {
		state.statusQuery = {
			data: connectedStatus(false),
			isLoading: false,
			isError: false,
		};
		state.balancesQuery = {
			data: undefined,
			isLoading: false,
			isError: false,
		};
		state.mutate.mockReset();
	});

	it("classifies positive, known-zero, and partial collateral distinctly", () => {
		expect(classifyFundingState(walletBalances(0, 2))).toBe("funded");
		expect(classifyFundingState(walletBalances(0, 0))).toBe("unfunded");
		expect(classifyFundingState(walletBalances(null, 0))).toBe("unknown");
		expect(classifyFundingState(undefined)).toBe("unknown");
	});

	it("does not call a failed status read deployment-disabled", () => {
		state.statusQuery = {
			data: undefined,
			isLoading: false,
			isError: true,
		};

		render(<TradingWalletPanel />);

		expect(
			screen.getByText(/status is temporarily unavailable/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/not enabled on this deployment/i),
		).not.toBeInTheDocument();
	});

	it("keeps approvals available when the balance read is unknown", () => {
		state.balancesQuery = {
			data: undefined,
			isLoading: false,
			isError: true,
		};

		render(<TradingWalletPanel />);

		expect(
			screen.getByRole("button", { name: "Enable trading" }),
		).toBeEnabled();
		expect(screen.getByText(/funding status is unknown/i)).toBeInTheDocument();
	});

	it("labels ready-but-unknown collateral without telling the user to fund", () => {
		state.statusQuery = {
			data: connectedStatus(true),
			isLoading: false,
			isError: false,
		};

		render(<TradingWalletPanel />);

		expect(screen.getByText(/balance unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText(/add pUSD or USDC.e/i)).not.toBeInTheDocument();
	});
});
