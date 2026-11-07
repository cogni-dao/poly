// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Node composition of goal metrics and their agent tools. Calculators, budgets, the source allow-list and tool contracts are published (@cogni-dao/metrics/knowledge, @cogni-dao/ai-tools); this node binds its own id.
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
import type { GoalsProgress, MetricService } from "@cogni-dao/metrics";
import { createMetricTools } from "@cogni/shared-ai-tools";
import type { Sql } from "postgres";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
  knowledgeSql: Sql;
  observationsSql: Sql;
  environment: string;
  log(event: object): void;
}) {
  return createPublishedGoalMetrics({ ...deps, node: getNodeId() });
}

/** Bind the published core__goal_progress and core__metric_* tools to this node's reader. */
export function createGoalMetricTools(deps: {
  metrics: () => MetricService | undefined;
  goalProgress: () => Promise<GoalsProgress>;
}) {
  return createMetricTools(deps.metrics, { goalProgress: deps.goalProgress });
}
