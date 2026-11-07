// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Node composition of goal metrics. Calculators, budgets and the source allow-list are published in @cogni-dao/metrics/knowledge; this node binds its own id.
 * Scope: Composition only; no measurement logic lives here.
 * Invariants: Observations are scoped to this node's id and deploy environment.
 * Side-effects: none (factories only)
 * Links: https://node-template.cognidao.org/work/items/story.0021
 * @public
 */
import {
  createGoalMetrics as createPublishedGoalMetrics,
  createGoalProgressReader,
  createGoalSource,
} from "@cogni-dao/metrics/knowledge";
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
