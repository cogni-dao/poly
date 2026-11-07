// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metric-tools`
 * Purpose: Bind the published core__goal_progress and core__metric_* tools to this node's goal-progress reader.
 * Scope: Composition only; tool contracts and implementations come from @cogni-dao/ai-tools.
 * Invariants: The HTTP route and the tool share one goal-progress reader.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/work/items/story.0021
 * @public
 */
import type { GoalsProgress, MetricService } from "@cogni-dao/metrics";
import { createMetricTools } from "@cogni/shared-ai-tools";

export function createGoalMetricTools(deps: {
  metrics: () => MetricService | undefined;
  goalProgress: () => Promise<GoalsProgress>;
}) {
  return createMetricTools(deps.metrics, { goalProgress: deps.goalProgress });
}
