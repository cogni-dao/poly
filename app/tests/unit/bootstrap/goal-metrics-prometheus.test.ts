// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/goal-metrics-prometheus`
 * Purpose: The node's MetricsQueryPort reaches the published goal-metric engine, so `http.requests@1` reads this node's series (task.0171).
 * Scope: The `createGoalMetrics` composition only; the published engine is mocked.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/goal-metrics.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const published = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@cogni-dao/metrics/knowledge", () => ({
  createGoalMetrics: published,
  createGoalProgressReader: vi.fn(),
  createGoalSource: vi.fn(),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "node-1" }));

import { createGoalMetrics } from "@/bootstrap/capabilities/goal-metrics";

const deps = {
  knowledgeSql: {} as never,
  observationsSql: {} as never,
  environment: "test",
  log: () => undefined,
};

describe("createGoalMetrics prometheus wiring", () => {
  beforeEach(() => published.mockClear());

  // Defect guarded: the node never passed its MetricsQueryPort, so http.requests@1 always read prometheus:not_configured.
  it("passes the node's metricsQuery to the published engine as the prometheus reader", () => {
    const metricsQuery = { queryInstant: vi.fn() } as never;
    createGoalMetrics({ ...deps, metricsQuery });
    const arg = published.mock.calls[0]?.[0] as unknown as {
      prometheus?: { query: unknown };
    };
    expect(arg.prometheus?.query).toBe(metricsQuery);
  });

  it("leaves prometheus unset without a metricsQuery, so the reading is unknown, never zero", () => {
    createGoalMetrics(deps);
    const arg = published.mock.calls[0]?.[0] as unknown as { prometheus?: unknown };
    expect(arg.prometheus).toBeUndefined();
  });
});
