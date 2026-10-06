// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `research-you-wallet.spec`
 * Purpose: Prove the research benchmark board keys every comparison query on
 *   the connected per-tenant TRADING wallet (`funder_address` from
 *   `/api/v1/poly/wallet/status`) and never on the signin EOA — and that a
 *   disconnected wallet yields no "You" entry at all (no EOA fallback).
 * Scope: Research page client view with query hooks and visual children
 *   mocked. No HTTP, database, wallet, or chain IO.
 * Invariants: SELF_IS_TRADING_WALLET.
 * Side-effects: none
 * Links: app/src/app/(app)/research/view.tsx
 * @vitest-environment jsdom
 */

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factories below may reference them safely.
const { TRADING_WALLET, SIGNIN_EOA, RN1, TARGET_WALLET } = vi.hoisted(() => ({
  /** The app-owned per-tenant TRADING wallet (poly_wallet_connections row). */
  TRADING_WALLET: "0x88fA0742Fd24Bf2e72C1087fc49b6e089Da40Fb8",
  /** The user's signin EOA — never an observed trader wallet. */
  SIGNIN_EOA: "0x95e4070000000000000000000000000000000001",
  RN1: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
  TARGET_WALLET: "0x1234000000000000000000000000000000005678",
}));

const state = vi.hoisted(() => ({
  walletStatus: undefined as unknown,
  copyTargets: undefined as unknown,
  capturedQueryKeys: [] as readonly (readonly unknown[])[],
  seriesLabels: [] as readonly string[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    state.capturedQueryKeys = [...state.capturedQueryKeys, options.queryKey];
    if (options.queryKey[0] === "poly-wallet-status") {
      return { data: state.walletStatus, isLoading: false, isError: false };
    }
    if (options.queryKey[0] === "dashboard-copy-targets") {
      return { data: state.copyTargets, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueries: ({
    queries,
  }: {
    queries: readonly { queryKey: readonly unknown[] }[];
  }) => {
    for (const query of queries) {
      state.capturedQueryKeys = [...state.capturedQueryKeys, query.queryKey];
    }
    return queries.map(() => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }));
  },
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Tripwire: if the view is ever rewired to read the session wallet, this is
// the (wrong) address it would pick up — assertions below require it never
// reaches a query key.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "user-1", walletAddress: SIGNIN_EOA } },
  }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components", () => ({
  Input: (props: Record<string, unknown>) => (
    <input value={String(props.value ?? "")} readOnly />
  ),
  ToggleGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ToggleGroupItem: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock("@/app/(app)/_components/wallets-table", () => ({
  buildWalletRows: () => [],
  WalletsTable: () => <div>wallets table</div>,
}));

vi.mock("@/features/wallet-analysis", () => ({
  DistributionComparisonBlock: ({
    series,
  }: {
    series: readonly { label: string }[];
  }) => {
    state.seriesLabels = series.map((entry) => entry.label);
    return <div>comparison block</div>;
  },
  WalletDetailDrawer: () => null,
  WalletQuickJump: () => <div>quick jump</div>,
}));

vi.mock("@/app/(app)/dashboard/_api/fetchCopyTargets", () => ({
  createCopyTarget: vi.fn(),
  deleteCopyTarget: vi.fn(),
  fetchCopyTargets: vi.fn(),
}));

vi.mock("@/app/(app)/dashboard/_api/fetchTopWallets", () => ({
  fetchTopWallets: vi.fn(),
}));

import {
  buildComparisonWallets,
  ResearchView,
} from "@/app/(app)/research/view";

function connectedStatus(funderAddress: string | null) {
  return {
    configured: true,
    connected: true,
    connection_id: "11111111-1111-4111-8111-111111111111",
    funder_address: funderAddress,
    trading_ready: true,
    auto_wrap_consent_at: null,
    auto_wrap_floor_usdce_atomic: "1000000",
  };
}

const disconnectedStatus = {
  configured: true,
  connected: false,
  connection_id: null,
  funder_address: null,
  trading_ready: false,
  auto_wrap_consent_at: null,
  auto_wrap_floor_usdce_atomic: null,
};

function allCapturedAddresses(): string {
  return state.capturedQueryKeys
    .flat()
    .map((part) => String(part))
    .join("|")
    .toLowerCase();
}

describe("research 'You' wallet wiring (SELF_IS_TRADING_WALLET)", () => {
  beforeEach(() => {
    state.walletStatus = undefined;
    state.copyTargets = { targets: [{ target_wallet: TARGET_WALLET }] };
    state.capturedQueryKeys = [];
    state.seriesLabels = [];
  });

  it("keys comparison queries on the connected trading wallet, never the signin EOA", () => {
    state.walletStatus = connectedStatus(TRADING_WALLET);

    render(<ResearchView />);

    const captured = allCapturedAddresses();
    expect(captured).toContain(TRADING_WALLET.toLowerCase());
    expect(captured).not.toContain(SIGNIN_EOA.toLowerCase());

    // "You" leads the trader-comparison headline (slice of 3).
    const comparisonKey = state.capturedQueryKeys.find(
      (key) => key[0] === "research-trader-comparison"
    );
    expect(comparisonKey).toBeDefined();
    expect(
      String(comparisonKey?.[2]).startsWith(TRADING_WALLET.toLowerCase())
    ).toBe(true);

    // Distribution comparison probes the trading wallet too.
    expect(
      state.capturedQueryKeys.some(
        (key) =>
          key[0] === "research-distribution-comparison" &&
          key[1] === TRADING_WALLET.toLowerCase()
      )
    ).toBe(true);

    expect(state.seriesLabels).toContain("You");
  });

  it("omits 'You' entirely when no trading wallet is connected — no EOA fallback", () => {
    state.walletStatus = disconnectedStatus;

    render(<ResearchView />);

    const captured = allCapturedAddresses();
    expect(captured).not.toContain(SIGNIN_EOA.toLowerCase());
    expect(captured).not.toContain(TRADING_WALLET.toLowerCase());

    const comparisonKey = state.capturedQueryKeys.find(
      (key) => key[0] === "research-trader-comparison"
    );
    // Benchmarks still render for the primary research wallets…
    expect(String(comparisonKey?.[2])).toContain(RN1);
    // …but there is no "You" series.
    expect(state.seriesLabels).not.toContain("You");
  });

  it("ignores funder_address unless the connection is active", () => {
    // connected=false must win even if a stale funder_address is present.
    state.walletStatus = { ...disconnectedStatus, funder_address: SIGNIN_EOA };

    render(<ResearchView />);

    expect(allCapturedAddresses()).not.toContain(SIGNIN_EOA.toLowerCase());
    expect(state.seriesLabels).not.toContain("You");
  });

  describe("buildComparisonWallets", () => {
    it("labels the trading wallet 'You' and lowercases it", () => {
      const wallets = buildComparisonWallets(TRADING_WALLET, [
        { target_wallet: TARGET_WALLET },
      ]);
      expect(wallets[0]).toEqual({
        label: "You",
        address: TRADING_WALLET.toLowerCase(),
      });
      expect(wallets.map((wallet) => wallet.address)).toContain(TARGET_WALLET);
    });

    it("produces no 'You' entry for a null trading wallet", () => {
      const wallets = buildComparisonWallets(null, [
        { target_wallet: TARGET_WALLET },
      ]);
      expect(wallets.map((wallet) => wallet.label)).not.toContain("You");
    });

    it("dedupes a tracked target that is also the trading wallet, keeping the 'You' label", () => {
      const wallets = buildComparisonWallets(TRADING_WALLET, [
        { target_wallet: TRADING_WALLET.toLowerCase() },
      ]);
      const self = wallets.filter(
        (wallet) => wallet.address === TRADING_WALLET.toLowerCase()
      );
      expect(self).toHaveLength(1);
      expect(self[0]?.label).toBe("You");
    });
  });
});
