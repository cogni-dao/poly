// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Durable algorithm-origin projection contract and bounded SQL guards. */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  readAlgorithmOriginProjection,
  unavailableOriginCoverage,
} from "@/features/wallet-analysis/server/algorithm-origin-read-model";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "0x1234123412341234123412341234123412341234";
const HASH = `sha256:${"a".repeat(64)}`;
const completeRow = {
  origin_position_count: 1,
  origin_event_count: 2,
  complete_event_count: 2,
  legacy_partial_event_count: 0,
  incomplete_event_count: 0,
  identity_ambiguous_event_count: 0,
  origin_layer_count: 1,
  comparable_layer_count: 1,
  preview_layer_count: 1,
  preview_truncated: false,
  condition_id: "condition-a",
  token_id: "token-a",
  algorithm_id: "poly.copy-mirror.target-percentile-scaled",
  algorithm_version_id: HASH,
  config_hash: HASH,
  input_snapshot_id: HASH,
  assignment_id: "assignment-a",
  correlation_id: "correlation-newest",
  evidence: "complete",
  target_wallet: TARGET,
  first_executed_at: "2026-10-12T10:00:00.000Z",
  last_executed_at: "2026-10-12T11:00:00.000Z",
  executed_fill_count: 2,
  decision_shares: "25",
  decision_cost_usdc: "10",
  decision_average_price: "0.4",
  decision_observed_at: "2026-10-12T10:59:59.000Z",
  now_shares: "4",
  now_cost_usdc: "1.8",
  now_current_value_usdc: "2.1",
  now_average_price: "0.45",
  now_observed_at: "2026-10-12T12:00:00.000Z",
  now_identity_count: 1,
  position_layer_count: 1,
} as const;

describe("algorithm origin read model", () => {
  it("emits all six lineage ids and keeps copied-at-decision separate from target-now", async () => {
    const captured: string[] = [];
    const db = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
        return [completeRow];
      },
    };
    const result = await readAlgorithmOriginProjection({
      db,
      billingAccountId: ACCOUNT,
      connectionKind: "privy_live",
      capturedAt: new Date("2026-10-12T12:00:00.000Z"),
      previewPositionKeys: [{ conditionId: "CONDITION-A", tokenId: "token-a" }],
    });

    expect(result.coverage).toMatchObject({
      status: "available",
      originEventCount: 2,
      originLayerCount: 1,
      comparableLayerCount: 1,
      previewTruncated: false,
    });
    expect(
      result.byPositionKey.get("condition-a\u0000token-a")?.[0]
    ).toMatchObject({
      algorithmId: "poly.copy-mirror.target-percentile-scaled",
      algorithmVersionId: HASH,
      configHash: HASH,
      inputSnapshotId: HASH,
      assignmentId: "assignment-a",
      correlationId: "correlation-newest",
      evidence: "complete",
      targetAtDecision: { costBasisUsdc: 10, shares: 25 },
      targetNow: { costBasisUsdc: 1.8, shares: 4, currentValueUsdc: 2.1 },
      comparisonStatus: "comparable",
    });
    expect(
      result.layerCountByPositionKey.get("condition-a\u0000token-a")
    ).toBe(1);
    const rendered = captured[0] ?? "";
    expect(rendered).toContain("FROM poly_copy_trade_fills f");
    expect(rendered).not.toContain("poly_copy_trade_decisions");
    expect(rendered).toContain("lower(p.condition_id) = l.condition_id");
    expect(rendered).toContain("p.token_id = l.token_id");
    expect(rendered).toMatch(/preview_rank <= \$\d+/);
    expect(rendered).toContain(
      "CASE WHEN p.evidence = 'complete' THEN 0 ELSE 1 END"
    );
  });

  it("keeps proven origin when the target has no current position", async () => {
    const result = await readAlgorithmOriginProjection({
      db: {
        execute: async () => [
          {
            ...completeRow,
            comparable_layer_count: 0,
            now_shares: null,
            now_cost_usdc: null,
            now_current_value_usdc: null,
            now_average_price: null,
            now_observed_at: null,
            now_identity_count: 0,
          },
        ],
      },
      billingAccountId: ACCOUNT,
      connectionKind: "privy_live",
      capturedAt: new Date("2026-10-12T12:00:00.000Z"),
      previewPositionKeys: [{ conditionId: "condition-a", tokenId: "token-a" }],
    });

    expect(
      result.byPositionKey.get("condition-a\u0000token-a")?.[0]
    ).toMatchObject({
      evidence: "complete",
      targetAtDecision: { costBasisUsdc: 10 },
      targetNow: null,
      comparisonStatus: "target_now_unavailable",
    });
  });

  it("represents an unavailable reader with nulls rather than false zeroes", () => {
    expect(unavailableOriginCoverage()).toEqual({
      status: "unavailable",
      originPositionCount: null,
      originEventCount: null,
      completeEventCount: null,
      legacyPartialEventCount: null,
      incompleteEventCount: null,
      identityAmbiguousEventCount: null,
      originLayerCount: null,
      comparableLayerCount: null,
      previewLayerCount: null,
      previewTruncated: null,
    });
  });
});
