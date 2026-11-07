// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/_fixtures/goals/progress`
 * Purpose: Schema-valid GoalsProgress fixtures for Goals tab tests and visual harnesses.
 * Scope: Illustrative data only. Every builder output parses with GoalsProgressSchema.
 * Invariants: Fixed clock (AS_OF); gaps are explicit `missing` buckets, never filled.
 * Side-effects: none
 * Links: packages/metrics/src/contracts.ts
 * @internal
 */

import {
  type GoalProgress,
  type GoalsProgress,
  GoalsProgressSchema,
  type KpiAssessment,
  type KpiReason,
  type KpiStatus,
  type MetricHistory,
} from "@cogni-dao/metrics/contracts";

export const AS_OF = "2026-11-02T10:05:00.000Z";
const DAY = 86_400_000;
const TODAY = Date.parse("2026-11-02T00:00:00.000Z");
const DEADLINE = "2027-01-31T00:00:00.000Z";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** 30 daily buckets ending at today; `gaps` are day offsets with no reading. */
export function trend(
  metricId: string,
  unit: string,
  values: (number | null)[]
): MetricHistory {
  const start = TODAY - 29 * DAY;
  return {
    metricId,
    unit,
    step: "1d",
    from: new Date(start).toISOString(),
    to: new Date(TODAY + DAY).toISOString(),
    buckets: values.map((v, i) => ({
      start: new Date(start + i * DAY).toISOString(),
      end: new Date(start + (i + 1) * DAY).toISOString(),
      status: v === null ? "missing" : "ok",
      value: v,
      observationId: v === null ? null : uuid(1000 + i),
    })),
  };
}

export function convergenceValues(): (number | null)[] {
  return Array.from({ length: 30 }, (_, i) =>
    i === 16 || i === 17 ? null : Math.round((0.76 + i * 0.002) * 100) / 100
  );
}

function assessment(
  status: KpiStatus,
  over: Partial<KpiAssessment> = {}
): KpiAssessment {
  return {
    status,
    reason: null,
    value: 0.82,
    unit: "ratio",
    observationId: uuid(1),
    observedAt: "2026-11-02T10:00:00.000Z",
    comparator: "gte",
    target: { value: 1, unit: "ratio" },
    deadline: DEADLINE,
    pace: { observed: 0.01, needed: 0.014 },
    ...over,
  };
}

function kpi(
  metricId: string,
  title: string,
  a: KpiAssessment,
  t: MetricHistory | null
): GoalProgress["kpis"][number] {
  return {
    binding: {
      metricId,
      comparator: a.comparator,
      target: a.target,
    },
    metric: {
      id: metricId,
      title,
      calculatorId: "work.convergence@1",
      cadenceSeconds: 3600,
      maxAgeSeconds: 7200,
    },
    assessment: a,
    trend: t,
  };
}

function goal(
  id: string,
  title: string,
  kpis: GoalProgress["kpis"],
  over: Partial<GoalProgress> = {}
): GoalProgress {
  return {
    id,
    title,
    evaluateAt: DEADLINE,
    configurationError: false,
    kpis,
    hypotheses: [],
    moreHypotheses: false,
    hypothesesUnavailable: false,
    ...over,
  };
}

/** The three illustrative node-template goals from the approved visual. */
export function visualFixture(): GoalsProgress {
  const ratio = kpi(
    "convergence-ratio-7d",
    "7-day convergence ratio",
    assessment("behind"),
    trend("convergence-ratio-7d", "ratio", convergenceValues())
  );
  const validated = kpi(
    "validated-7d",
    "Validated units, 7 days",
    assessment("on_track", {
      value: 14,
      unit: "items",
      target: { value: 1, unit: "items" },
      observationId: uuid(2),
      pace: { observed: 1.5, needed: null },
    }),
    trend(
      "validated-7d",
      "items",
      Array.from({ length: 30 }, (_, i) =>
        i === 16 || i === 17 ? null : 8 + Math.round(i / 5)
      )
    )
  );
  const notMeasured = (reason: KpiReason, target: number, unit: string) =>
    assessment("not_measured", {
      reason,
      value: null,
      unit,
      observationId: null,
      observedAt: null,
      target: { value: target, unit },
      pace: { observed: null, needed: null },
    });
  return GoalsProgressSchema.parse({
    asOf: AS_OF,
    environment: "local",
    goals: [
      goal(
        "goal-ai-work-converges",
        "AI work converges faster than it sprawls",
        [ratio, validated],
        {
          hypotheses: [
            {
              id: "hypothesis-close-one",
              title: "Close one item without adding one",
              evaluateAt: "2026-11-09T00:00:00.000Z",
              predictions: [
                {
                  binding: {
                    metricId: "convergence-ratio-7d",
                    comparator: "gte",
                    target: { value: 0.85, unit: "ratio" },
                    evaluationAt: "2026-11-09T00:00:00.000Z",
                  },
                  baselineValue: 0.8,
                  baselineAt: "2026-10-27T00:00:00.000Z",
                  assessment: assessment("evaluating", {
                    reason: "evaluation_not_due",
                    target: { value: 0.85, unit: "ratio" },
                    deadline: "2026-11-09T00:00:00.000Z",
                  }),
                },
              ],
              outcome: null,
            },
          ],
        }
      ),
      goal("goal-first-principles", "Every agent reasons from first principles", [
        {
          binding: {
            metricId: "first-principles-adherence",
            comparator: "gte",
            target: { value: 0.85, unit: "ratio" },
          },
          metric: null,
          assessment: notMeasured("calculator_unavailable", 0.85, "ratio"),
          trend: null,
        },
      ]),
      goal(
        "goal-knowledge-syntropy",
        "Knowledge grows node expertise over time",
        []
      ),
    ],
  });
}

const STATUS_OVERRIDES: Record<KpiStatus, Partial<KpiAssessment>> = {
  on_track: { value: 1.04 },
  behind: {},
  met: { value: 1.1, deadline: "2026-10-31T00:00:00.000Z" },
  missed: { value: 0.7, deadline: "2026-10-31T00:00:00.000Z" },
  delayed: { observedAt: "2026-11-02T07:00:00.000Z" },
  failing: { reason: "source_timeout" },
  building: {
    reason: "insufficient_history",
    value: null,
    observationId: null,
    observedAt: null,
  },
  not_measured: {
    reason: "calculator_unavailable",
    value: null,
    observationId: null,
    observedAt: null,
  },
  evaluating: { deadline: "2026-11-02T00:00:00.000Z" },
  unresolved: {
    reason: "no_reading_at_evaluation",
    value: null,
    observationId: null,
    observedAt: null,
    deadline: "2026-10-31T00:00:00.000Z",
  },
};

/** One goal per status, each with a schema-valid assessment. */
export function everyStatusFixture(): GoalsProgress {
  const statuses = Object.keys(STATUS_OVERRIDES) as KpiStatus[];
  return GoalsProgressSchema.parse({
    asOf: AS_OF,
    environment: "local",
    goals: statuses.map((s, i) =>
      goal(`goal-${s}`, `Goal in status ${s}`, [
        kpi(
          `metric-${i}`,
          `Metric ${i}`,
          assessment(s, STATUS_OVERRIDES[s]),
          trend(`metric-${i}`, "ratio", convergenceValues())
        ),
      ])
    ),
  });
}

// ------------------------------------------------- ranged history (task.0040)

export type BucketSpec = number | null | "error" | "unavailable";

/** `specs.length` buckets of `step` ending at `to`; null = missing, never filled. */
export function history(
  metricId: string,
  unit: string,
  step: MetricHistory["step"],
  to: string,
  specs: readonly BucketSpec[],
  idBase = 5000
): MetricHistory {
  const size = { "1h": 3_600_000, "1d": DAY, "1w": 7 * DAY }[step];
  const end = Date.parse(to);
  const start = end - specs.length * size;
  return {
    metricId,
    unit,
    step,
    from: new Date(start).toISOString(),
    to,
    buckets: specs.map((s, i) => ({
      start: new Date(start + i * size).toISOString(),
      end: new Date(start + (i + 1) * size).toISOString(),
      status:
        s === null
          ? "missing"
          : s === "error" || s === "unavailable"
            ? s
            : "ok",
      value: typeof s === "number" ? s : null,
      observationId: s === null ? null : uuid(idBase + i),
    })),
  };
}

export { assessment as assessmentFixture, goal as goalFixture, kpi as kpiFixture };
