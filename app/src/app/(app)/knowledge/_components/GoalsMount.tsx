// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GoalsMount`
 * Purpose: This node's mount of the Goals capability published by `@cogni/knowledge-base-ui/goals` (task.0062): the board, the measurement evidence, the hypothesis KPI evidence and the Goals tab badge read.
 * Scope: Composition only. The package owns the board, chart, range control, evidence views, read client and poll contract. The node supplies one host (`NODE_GOALS_HOST` in `(app)/_components/goals-host.ts`, shared with the Metrics page: the package-default cookie-session client at `/api/v1/metrics`, Next's `Link` for client navigation) and the `?observation=` URL value. A fork that needs another client, `init`, `queryKeyPrefix` or `hrefs` changes only `NODE_GOALS_HOST`.
 * Invariants: ONE_CACHE_ENTRY (every component here, and the Knowledge dashboard that calls the badge hook, sits under `KnowledgeGoalsProvider`, so the board and the badge share one client and one key prefix with the Metrics page); no Goals markup, formatting or fetching lives in the app.
 * Side-effects: none beyond the package's GET reads
 * Links: task.0062, packages/knowledge-base-ui/AGENTS.md
 * @internal
 */

"use client";

import {
  GoalsBoard,
  type GoalsBoardProps,
  GoalsProvider,
  KpiEvidence,
  type KpiEvidenceProps,
  MetricEvidence,
  type UseGoalsProgressOptions,
  useGoalsProgress,
} from "@cogni/knowledge-base-ui/goals";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { NODE_GOALS_HOST } from "../../_components/goals-host";

export function KnowledgeGoalsProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <GoalsProvider {...NODE_GOALS_HOST}>{children}</GoalsProvider>;
}

export function KnowledgeGoalsBoard(props: GoalsBoardProps) {
  return (
    <KnowledgeGoalsProvider>
      <GoalsBoard {...props} />
    </KnowledgeGoalsProvider>
  );
}

/** Evidence for a metric entry; the linked reading comes from `?observation=`. */
export function KnowledgeMetricEvidence({ id }: { readonly id: string }) {
  return (
    <KnowledgeGoalsProvider>
      <MetricEvidence
        id={id}
        observationId={useSearchParams().get("observation")}
      />
    </KnowledgeGoalsProvider>
  );
}

/** A hypothesis' KPI evidence, from its stored bindings and the subject projection. */
export function KnowledgeKpiEvidence(props: KpiEvidenceProps) {
  return (
    <KnowledgeGoalsProvider>
      <KpiEvidence {...props} />
    </KnowledgeGoalsProvider>
  );
}

/**
 * One cached goal-progress read shared with the board; the tab badge never polls.
 * Call it under `KnowledgeGoalsProvider` (the dashboard view does).
 */
export function useKnowledgeGoalsBadge(
  options: Omit<UseGoalsProgressOptions, "poll">
) {
  return useGoalsProgress({ ...options, poll: false });
}
