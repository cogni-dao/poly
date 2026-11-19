// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/trader-pnl-overlay-partial`
 * Purpose: Prove the overlay names every missing/stale series (PARTIAL_IS_RENDERED, bug.5065)
 *   instead of collapsing to "unavailable" or omitting a trader silently.
 * Scope: Unit — pure `partialNotes` over a hand-built response.
 * Side-effects: none
 * Links: src/features/wallet-analysis/components/TraderPnlOverlayChart.tsx, work/items/bug.5065
 * @internal
 */

import type { PolyResearchTraderPnlResponse } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import { partialNotes } from "@/features/wallet-analysis/components/TraderPnlOverlayChart";

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const CEO = "0x41a7ec25dc776bc364452c5c5cc936ffc6d5f296";

function response(
  over: Partial<PolyResearchTraderPnlResponse>
): PolyResearchTraderPnlResponse {
  return {
    interval: "1M",
    capturedAt: "2026-11-19T00:00:00.000Z",
    traders: [],
    warnings: [],
    ...over,
  };
}

describe("partialNotes", () => {
  it("is empty for a complete response and for no data", () => {
    expect(partialNotes(undefined)).toEqual([]);
    expect(
      partialNotes(
        response({
          traders: [
            {
              address: RN1,
              label: "RN1",
              interval: "1M",
              pnl: {
                usdc: 5,
                history: [{ ts: "2026-11-18T00:00:00.000Z", pnl: 1 }],
              },
            },
          ],
        })
      )
    ).toEqual([]);
  });

  it("names a warned trader and an unwarned empty trader", () => {
    const notes = partialNotes(
      response({
        traders: [
          {
            address: RN1,
            label: "RN1",
            interval: "1M",
            pnl: { usdc: null, history: [] },
          },
          {
            address: CEO,
            label: "You",
            interval: "1M",
            pnl: { usdc: null, history: [] },
          },
        ],
        warnings: [
          { wallet: CEO, code: "pnl_history_stale", message: "stale" },
        ],
      })
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("You");
    expect(notes[0]).toContain("stale");
    expect(notes[1]).toContain("RN1");
  });
});
