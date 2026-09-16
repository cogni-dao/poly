// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/compose-holdings`
 * Purpose: Verifies holdings composition uses claimant display names rather than raw user IDs.
 * Scope: Unit tests for finalized holdings UI composition only. Does not test HTTP routes or database queries.
 * Invariants:
 * - DISPLAY_NAMES_FROM_CLAIMANTS: holdings render claimant display names from finalized read models
 * - NO_GUID_DISPLAY: holdings must not fall back to raw user ID prefixes
 * Side-effects: none
 * Links: src/features/governance/lib/compose-holdings.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { composeHoldings } from "@/features/governance/lib/compose-holdings";

describe("composeHoldings", () => {
  it("derives user-facing names from activity receipts instead of user ids", () => {
    const data = composeHoldings(
      [
        {
          id: "21",
          status: "finalized",
          periodStart: "2026-02-17T00:00:00.000Z",
          periodEnd: "2026-02-24T00:00:00.000Z",
          weightConfig: {
            "github:pr_merged": 8000,
          },
          poolTotalCredits: "10000",
        },
      ],
      [
        {
          epochId: "21",
          poolTotalCredits: "10000",
          items: [
            {
              canonicalOwnerKey:
                "user:d0000000-0000-4000-a000-000058641509",
              claimantKey: "user:d0000000-0000-4000-a000-000058641509",
              claimant: {
                kind: "user",
                userId: "d0000000-0000-4000-a000-000058641509",
              },
              displayName: "derekg1729",
              isLinked: true,
              totalUnits: "8000",
              share: "0.800000",
              amountCredits: "8000",
              receiptIds: ["r1"],
            },
            {
              canonicalOwnerKey: "identity:github:207977700",
              claimantKey: "identity:github:207977700",
              claimant: {
                kind: "identity",
                provider: "github",
                externalId: "207977700",
                providerLogin: "Cogni-1729",
              },
              displayName: "Cogni-1729",
              isLinked: false,
              totalUnits: "2000",
              share: "0.200000",
              amountCredits: "2000",
              receiptIds: ["r2"],
            },
          ],
        },
      ]
    );

    expect(data.holdings.map((holding) => holding.displayName)).toEqual([
      "derekg1729",
      "Cogni-1729",
    ]);
    expect(
      data.holdings.some((holding) => holding.displayName?.includes("d0000000"))
    ).toBe(false);
  });

  it("combines a historical linked identity and direct user into one owner", () => {
    const ownerKey = "user:a5ee0c8f-d07c-42cb-821d-df67b2dd0367";
    const data = composeHoldings(
      [
        {
          id: "2",
          status: "finalized",
          periodStart: "2026-08-17T00:00:00.000Z",
          periodEnd: "2026-08-24T00:00:00.000Z",
          weightConfig: {},
          poolTotalCredits: "10000",
        },
        {
          id: "3",
          status: "finalized",
          periodStart: "2026-08-24T00:00:00.000Z",
          periodEnd: "2026-08-31T00:00:00.000Z",
          weightConfig: {},
          poolTotalCredits: "10000",
        },
      ],
      [
        {
          epochId: "2",
          poolTotalCredits: "10000",
          items: [
            {
              canonicalOwnerKey: ownerKey,
              claimantKey: "identity:github:295942454",
              claimant: {
                kind: "identity",
                provider: "github",
                externalId: "295942454",
                providerLogin: "flock-leader",
              },
              displayName: "flock-leader",
              isLinked: true,
              totalUnits: "1000",
              share: "1.000000",
              amountCredits: "10000",
              receiptIds: ["epoch-2-receipt"],
            },
          ],
        },
        {
          epochId: "3",
          poolTotalCredits: "10000",
          items: [
            {
              canonicalOwnerKey: ownerKey,
              claimantKey: ownerKey,
              claimant: {
                kind: "user",
                userId: "a5ee0c8f-d07c-42cb-821d-df67b2dd0367",
              },
              displayName: "flock-leader",
              isLinked: true,
              totalUnits: "1000",
              share: "1.000000",
              amountCredits: "10000",
              receiptIds: ["epoch-3-receipt"],
            },
          ],
        },
      ]
    );

    expect(data).toMatchObject({
      totalCreditsIssued: "20000",
      totalContributors: 1,
      epochsCompleted: 2,
      holdings: [
        {
          canonicalOwnerKey: ownerKey,
          claimantKind: "user",
          displayName: "flock-leader",
          totalCredits: "20000",
          ownershipPercent: 100,
          epochsContributed: 2,
        },
      ],
    });
  });

  it("keeps equal display names separate when canonical owners differ", () => {
    const data = composeHoldings(
      [
        {
          id: "3",
          status: "finalized",
          periodStart: "2026-08-24T00:00:00.000Z",
          periodEnd: "2026-08-31T00:00:00.000Z",
          weightConfig: {},
          poolTotalCredits: "10000",
        },
      ],
      [
        {
          epochId: "3",
          poolTotalCredits: "10000",
          items: [
            {
              canonicalOwnerKey: "user:owner-1",
              claimantKey: "user:owner-1",
              claimant: { kind: "user", userId: "owner-1" },
              displayName: "same-name",
              isLinked: true,
              totalUnits: "500",
              share: "0.500000",
              amountCredits: "5000",
              receiptIds: ["r1"],
            },
            {
              canonicalOwnerKey: "user:owner-2",
              claimantKey: "user:owner-2",
              claimant: { kind: "user", userId: "owner-2" },
              displayName: "same-name",
              isLinked: true,
              totalUnits: "500",
              share: "0.500000",
              amountCredits: "5000",
              receiptIds: ["r2"],
            },
          ],
        },
      ]
    );

    expect(data.totalContributors).toBe(2);
    expect(data.holdings.map((holding) => holding.canonicalOwnerKey)).toEqual([
      "user:owner-1",
      "user:owner-2",
    ]);
  });

  it("keeps credit totals exact above Number.MAX_SAFE_INTEGER", () => {
    const large = "90071992547409930000";
    const data = composeHoldings(
      [
        {
          id: "large",
          status: "finalized",
          periodStart: "2026-08-24T00:00:00.000Z",
          periodEnd: "2026-08-31T00:00:00.000Z",
          weightConfig: {},
          poolTotalCredits: large,
        },
      ],
      [
        {
          epochId: "large",
          poolTotalCredits: large,
          items: [
            {
              canonicalOwnerKey: "user:large-owner",
              claimantKey: "user:large-owner",
              claimant: { kind: "user", userId: "large-owner" },
              displayName: "large-owner",
              isLinked: true,
              totalUnits: large,
              share: "1.000000",
              amountCredits: large,
              receiptIds: ["r-large"],
            },
          ],
        },
      ]
    );

    expect(data.totalCreditsIssued).toBe(large);
    expect(data.holdings[0]).toMatchObject({
      canonicalOwnerKey: "user:large-owner",
      totalCredits: large,
      ownershipPercent: 100,
    });
  });
});
