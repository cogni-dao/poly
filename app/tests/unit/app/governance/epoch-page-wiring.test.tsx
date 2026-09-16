// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `epoch-page-wiring.test`
 * Purpose: Prove the Epoch overview keeps contribution sync while admin settlement actions stay in Review.
 * Scope: App-view composition with visual children and the page query mocked.
 * Invariants: CONTRIBUTION_SYNC_REMAINS, SAME_RAIL_EVERY_EPOCH, ADMIN_ACTIONS_LIVE_IN_REVIEW.
 * Side-effects: none
 * Links: src/app/(app)/gov/epoch/view.tsx, task.5039
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { EpochView } from "@/features/governance/types";

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  collect: {
    loading: false,
    error: null as string | null,
    successMessage: null as string | null,
    cooldownSeconds: null as number | null,
    trigger: vi.fn(),
  },
}));

vi.mock("@/features/governance/hooks/useEpochsPage", () => ({
  useEpochsPage: () => ({ data: state.data, isLoading: false, error: null }),
}));
vi.mock("@/features/governance/hooks/useCollectEpoch", () => ({
  useCollectEpoch: () => state.collect,
}));
vi.mock("@/features/governance/components/EpochCountdown", () => ({
  EpochCountdown: () => <div>Epoch countdown</div>,
}));
vi.mock("@/features/governance/components/EpochDetail", () => ({
  EpochDetail: ({ epoch }: { epoch: EpochView }) => (
    <div data-testid={`detail-${epoch.id}`}>Epoch detail</div>
  ),
}));
vi.mock("@/features/governance/components/EpochLifecycleProgress", () => ({
  EpochLifecycleProgress: ({ epoch }: { epoch: EpochView }) => (
    <div data-testid={`rail-${epoch.id}`}>Lifecycle rail</div>
  ),
}));
vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    className,
    disabled,
    onClick,
    type,
    "aria-busy": ariaBusy,
    "aria-describedby": ariaDescribedBy,
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => (
    <button
      type={type}
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-busy={ariaBusy}
      aria-describedby={ariaDescribedBy}
    >
      {children}
    </button>
  ),
  ExpandableTableRow: ({
    cells,
    expandedContent,
  }: {
    cells: ReactNode[];
    expandedContent: ReactNode;
  }) => (
    <div>
      {cells}
      {expandedContent}
    </div>
  ),
  PieChart: () => null,
  Table: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHead: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { CurrentEpochView } from "@/app/(app)/gov/epoch/view";

function epoch(id: string, status: EpochView["status"]): EpochView {
  return {
    id,
    status,
    periodStart: "2026-08-10T00:00:00.000Z",
    periodEnd: "2026-08-17T00:00:00.000Z",
    poolTotalCredits: status === "finalized" ? "100" : null,
    approvers: status === "open" ? null : ["0xapprover"],
    contributors: [],
    unresolvedCount: 0,
    unresolvedActivities: [],
  };
}

describe("Epoch page wiring", () => {
  it("shows lifecycle rails and contribution sync without admin settlement controls", () => {
    const current = epoch("8", "open");
    const past = epoch("7", "finalized");
    state.data = {
      current,
      pastEpochs: [past],
      settlementLifecycle: {
        publicationEvidence: "matched",
        liveRevision: null,
        latestRevision: null,
        epochs: [],
      },
    };

    render(<CurrentEpochView />);

    expect(screen.getByTestId("rail-8")).toBeInTheDocument();
    expect(screen.getByTestId("rail-7")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sync contributions" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/publish distribution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open for review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign and finalize/i)).not.toBeInTheDocument();
  });

  it("shows cooldown feedback and disables repeat sync", () => {
    state.collect.cooldownSeconds = 125;
    state.data = {
      current: epoch("8", "open"),
      pastEpochs: [],
      settlementLifecycle: {
        publicationEvidence: "unknown",
        liveRevision: null,
        latestRevision: null,
        epochs: [],
      },
    };

    render(<CurrentEpochView />);

    expect(
      screen.getByRole("button", { name: "Sync contributions" })
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recently synced. Try again in about 3 min."
    );
    state.collect.cooldownSeconds = null;
  });

  it("does not show contribution sync after the epoch enters review", () => {
    state.data = {
      current: epoch("8", "review"),
      pastEpochs: [],
      settlementLifecycle: {
        publicationEvidence: "unknown",
        liveRevision: null,
        latestRevision: null,
        epochs: [],
      },
    };

    render(<CurrentEpochView />);

    expect(
      screen.queryByRole("button", { name: "Sync contributions" })
    ).not.toBeInTheDocument();
  });
});
