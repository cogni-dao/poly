// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WalletAnalysisView } from "@/features/wallet-analysis/components/WalletAnalysisView";

describe("WalletAnalysisView saved-fact warnings", () => {
  it("renders missing balance as unavailable rather than zero or a skeleton", () => {
    render(
      <WalletAnalysisView
        data={{
          address: "0x1111111111111111111111111111111111111111",
          identity: { name: "Wallet", isPrimaryTarget: false },
        }}
        warnings={[
          {
            slice: "balance",
            code: "saved_facts_not_ready",
            message: "Position observation is stale.",
          },
        ]}
      />
    );

    expect(screen.getByText("Balance unavailable")).toBeInTheDocument();
    expect(screen.getByText("Position observation is stale.")).toBeInTheDocument();
  });
});
