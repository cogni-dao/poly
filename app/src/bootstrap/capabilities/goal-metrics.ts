// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Node composition of goal metrics and their agent tools. Calculators, budgets, the source allow-list and tool contracts are published (@cogni-dao/metrics/knowledge, @cogni-dao/ai-tools); this node binds its own id and registers its own calculators (`poly.wallet-pnl@1`).
 * Scope: Composition only; no measurement logic lives here.
 * Invariants: Observations are scoped to this node's id and deploy environment; the HTTP route and core__goal_progress share one goal-progress reader.
 * Side-effects: none (factories only)
 * Links: https://node-template.cognidao.org/work/items/story.0021
 * @public
 */
import {
  createGoalMetrics as createPublishedGoalMetrics,
  createGoalProgressReader,
  createGoalSource,
} from "@cogni-dao/metrics/knowledge";
import { createKnowledgeUsageCalculator } from "@cogni-dao/metrics/usage";
import type { GoalsProgress, MetricService } from "@cogni-dao/metrics";
import { createMetricTools } from "@cogni/shared-ai-tools";
import type { Sql } from "postgres";
import type { MetricsQueryPort } from "@/ports";
import { getNodeId } from "@/shared/config";
import { createWalletPnlCalculator } from "./wallet-pnl-calculator";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
  knowledgeSql: Sql;
  observationsSql: Sql;
  environment: string;
  log(event: object): void;
  /** Read by `http.requests@1`; absent reads unknown (`prometheus:not_configured`). */
  metricsQuery?: MetricsQueryPort;
}) {
  const { metricsQuery, ...rest } = deps;
  return createPublishedGoalMetrics({
    ...rest,
    node: getNodeId(),
    ...(metricsQuery
      ? {
          // The operator lane scrape labels every series with node and env (bug.5641), and the
          // node-scoped read proxy confines each query to them (story.5169); no `app` matcher.
          prometheus: { query: metricsQuery },
        }
      : {}),
    // Node-owned families only (never a reserved package family). Each reads a
    // source this node owns or public data; none reads private connection data.
    nodeCalculators: [
      createWalletPnlCalculator(),
      createKnowledgeUsageCalculator(deps.observationsSql),
    ],
  });
}

/** Bind the published core__goal_progress and core__metric_* tools to this node's reader. */
export function createGoalMetricTools(deps: {
  metrics: () => MetricService | undefined;
  goalProgress: () => Promise<GoalsProgress>;
}) {
  return createMetricTools(deps.metrics, { goalProgress: deps.goalProgress });
}
