// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/dashboard/copy-target-control-panel`
 * Purpose: Prove the human selector names the active implementation without
 *          redundant prose, links directly to durable guidance, and gives one
 *          no obsolete allocation controls.
 * Scope: Component rendering with query hooks mocked; no HTTP or DB.
 * Invariants: HUMAN_READABLE_POLICY, LEARN_MORE_IS_ALGORITHM_SPECIFIC,
 *             NO_LEGACY_GAP_KNOBS, NO_RECOMMENDATION_COPY.
 * Side-effects: none
 * Links: task.1791070971, src/app/(app)/dashboard/_components/CopyTargetControlPanel.tsx
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const targetResponse = {
  billing_account_id: "4212528f-6b2c-41de-a1cd-8558c871c088",
  captured_at: "2026-10-07T03:16:00.000Z",
  targets: [
    {
      target_id: "11111111-1111-4111-8111-111111111111",
      target_wallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
      active: true,
      created_at: "2026-10-01T00:00:00.000Z",
      mirror_activated_at: "2026-10-07T03:15:40.799Z",
      disabled_at: null,
      policy: {
        declared_kind: "position_gap",
        effective_kind: "position_gap",
        resolution: "explicit",
        implementation_revision: {
          status: "available",
          build_sha: "f3e49318b1a9075bc6a6f70a92403c7edbaddf6e",
        },
        mirror_filter_percentile: 98,
        mirror_max_usdc_per_trade: 5,
        target_range_max_usdc: 20,
        mirror_max_alloc_per_condition_usdc: 50,
        range_knobs_incomplete: false,
        portfolio_budget: {
          configured_budget_usdc: 20,
          effective_budget_usdc: 18.5,
          allocation_status: "prorated",
          effective_budget_observed_at: "2026-10-07T03:15:55.000Z",
          observation_status: "observed",
        },
      },
      activation: { status: "eligible", explanation: "Active grant" },
    },
  ],
  active_target_count: 1,
  targets_truncated: false,
  wallet_safety: { status: "absent", reason: "no_wallet_grant_on_file" },
  budget_allocation: {
    position_gap_target_count: 1,
    automatic_target_count: 0,
    explicit_budget_total_usdc: 20,
    unbudgeted_active_target_count: 1,
    shared_wallet_risk: true,
    mirror_nav_usdc: 18.5,
    effective_budget_total_usdc: 18.5,
    overallocated: true,
    observed_at: "2026-10-07T03:15:55.000Z",
    observation_status: "observed",
  },
  sources: {
    targets: "poly_copy_trade_targets",
    caps: "poly_wallet_grants",
    config_table: "dropped_in_migration_0036",
  },
  completeness: {
    complete: true,
    targets_truncated: false,
    caps_available: true,
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) =>
    queryKey[0] === "dashboard-copy-targets"
      ? { data: targetResponse, isLoading: false }
      : {
          data: {
            configured: true,
            connected: true,
            grant: {
              id: "22222222-2222-4222-8222-222222222222",
              per_order_usdc_cap: 10,
              daily_usdc_cap: 500,
              hourly_fills_cap: 20,
            },
          },
          isLoading: false,
        },
  useMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => undefined),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components", () => ({
  AddressChip: ({ address }: { address: string }) => <span>{address}</span>,
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
  Card: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  formatShortWallet: (wallet: string) => wallet.slice(0, 8),
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  SelectValue: () => <span>Selected algorithm</span>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/kit/policy/PolicyControls", () => ({
  PolicyControls: () => <div>Global policy controls</div>,
}));

vi.mock("@/features/wallet-analysis", () => ({
  WalletQuickJump: () => <div>Wallet quick jump</div>,
}));

import { CopyTargetControlPanel } from "@/app/(app)/dashboard/_components/CopyTargetControlPanel";

describe("CopyTargetControlPanel algorithm selector", () => {
  it("renders a terse position-gap decision surface", () => {
    render(<CopyTargetControlPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Expand copy controls" }),
    );

    expect(screen.getByText("Active: Position gap")).toBeInTheDocument();
    expect(screen.getByText("build f3e49318")).toBeInTheDocument();
    expect(screen.queryByText(/recommended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Most promising/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Changes here are drafts/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Draft only/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/first post-save baseline/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Algorithm guide")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Full portfolio")).toHaveValue("20.00");
    expect(
      screen.getByText("Adjusted $18.50 · Shared wallet"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Learn how Position gap works" }),
    ).toHaveAttribute(
      "href",
      "https://poly.cognidao.org/knowledge/mirror-position-gap",
    );
    expect(
      screen.getByRole("link", { name: "Learn how Auto works" }),
    ).toHaveAttribute(
      "href",
      "https://poly.cognidao.org/knowledge/mirror-algorithm-rankings",
    );
  });
});
