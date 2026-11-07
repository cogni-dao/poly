# goals

Node-owned Goals + KPIs view. The measurement engine and the wire contract (`GoalsProgressSchema`, `KpiAssessmentSchema`, `MetricHistorySchema`, `MetricDisplaySchema`) come from the published `@cogni-dao/metrics/contracts`. Never redefine them here. Ported from node-template (story.0021).

## UI invariants

- Status comes from `assessKpi` only. The UI never re-derives it. Every status shows a symbol and a word (`STATUS_META`), so color is never the only signal.
- Display type comes from the read model (`kpi.metric.display`), never from units: progress shows a bar toward the target, volume a sparkline plus change, slo availability bars plus error budget. One formatter (`formatValue`) prints every reading.
- Unknown is not zero. A missing reading renders "—" (`aria-label="No reading"`). Gaps stay gaps (`connectNulls={false}`). Never bridge history, invent expected values, or present stale readings as current.
- Cards hold a label, a number, at most one short hint, a pill and one mark. The plain-words reason lives in the accessible description and on the entry page.
- Refreshes are quiet. A failed poll keeps the data. Only `STALE_AFTER_FAILURES` consecutive failures mark it "Stale"; a 401 shows "Signed out".
- `GoalsBoard` is reusable and imports nothing from Knowledge routes. Knowledge mounts it only on `?mode=goals`, and its 30s poll runs only while that tab is selected. Entry pages mount it with `goalId`.
- With Recharts 2, pass arrays as direct chart children, never Fragments or wrapper components. Use `useChartId` ids and no animation.
- This feature only reads; the refresh worker computes. It must not import bootstrap, app or adapter code.
