// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/CumulativeClaimPanel`
 * Purpose: Guards the ownership metric separation and terminal claim confirmation UX.
 * Scope: Component behavior with wallet and claim reads mocked; no network or chain access.
 * Invariants: Balance survives a missing leaf; confirmation hides mutation controls before refetch.
 * Side-effects: none
 * @internal
 * @vitest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWaitForTransactionReceipt } from "wagmi";

import { CumulativeClaimPanel } from "@/features/governance/components/CumulativeClaimPanel";
import { useCumulativeClaim } from "@/features/governance/hooks/useCumulativeClaim";

const refetchAfterClaim = vi.fn<() => Promise<void>>();

vi.mock("@cogni/node-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/node-shared")>();
  return {
    ...actual,
    getTransactionExplorerUrl: () => "https://explorer.test/tx/0xabc",
  };
});

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x0000000000000000000000000000000000000001", isConnected: true }),
  useChainId: () => 8453,
  useSwitchChain: () => ({ switchChain: vi.fn() }),
  useWriteContract: () => ({
    writeContract: vi.fn(),
    isPending: false,
    error: null,
    data: "0xabc",
  }),
  useWaitForTransactionReceipt: vi.fn(),
}));

vi.mock("@/features/governance/hooks/useCumulativeClaim", () => ({
  useCumulativeClaim: vi.fn(),
}));

const CLAIM = {
  settlementRevisionId: "revision-1",
  settlementSequence: 1,
  epochId: null,
  root: `0x${"1".repeat(64)}`,
  distributor: "0x0000000000000000000000000000000000000002",
  chainId: 8453,
  tokenAddress: "0x0000000000000000000000000000000000000003",
  account: "0x0000000000000000000000000000000000000001",
  amount: (10n * 10n ** 18n).toString(),
  proof: [],
} as const;

function mockClaimState(overrides: Record<string, unknown> = {}) {
  vi.mocked(useCumulativeClaim).mockReturnValue({
    claim: CLAIM,
    cumulativeClaimed: 4n * 10n ** 18n,
    claimable: 6n * 10n ** 18n,
    tokenBalance: 14n * 10n ** 18n,
    tokenDecimals: 18,
    isTokenBalanceLoading: false,
    tokenBalanceError: null,
    isLoading: false,
    isClaimedLoading: false,
    error: null,
    refetchAfterClaim,
    ...overrides,
  });
}

describe("CumulativeClaimPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refetchAfterClaim.mockResolvedValue();
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({
      isLoading: false,
      isSuccess: false,
    } as ReturnType<typeof useWaitForTransactionReceipt>);
  });

  it("keeps token balance visible when the wallet has no allocation leaf", () => {
    mockClaimState({
      claim: null,
      cumulativeClaimed: undefined,
      claimable: undefined,
      tokenBalance: 5n * 10n ** 18n,
    });

    render(
      <CumulativeClaimPanel
        bare
        tokenAddress="0x0000000000000000000000000000000000000003"
        chainId={8453}
      />
    );

    expect(screen.getByText("Token balance")).toBeInTheDocument();
    expect(screen.getByText("5 tokens")).toBeInTheDocument();
    expect(screen.getByText("Cumulative entitlement")).toBeInTheDocument();
    expect(screen.getByText("No allocation")).toBeInTheDocument();
    expect(screen.getAllByText("Not available")).toHaveLength(2);
  });

  it("shows confirmation exclusively and awaits both refreshed reads", async () => {
    mockClaimState();
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({
      isLoading: false,
      isSuccess: true,
    } as ReturnType<typeof useWaitForTransactionReceipt>);

    render(
      <CumulativeClaimPanel
        bare
        tokenAddress={CLAIM.tokenAddress}
        chainId={8453}
      />
    );

    expect(screen.getByText("Tokens claimed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /claim 6 tokens/i })).toBeNull();
    expect(screen.getByRole("link", { name: "View transaction" })).toHaveAttribute(
      "href",
      "https://explorer.test/tx/0xabc"
    );
    await waitFor(() => expect(refetchAfterClaim).toHaveBeenCalledOnce());
  });
});
