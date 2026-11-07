# goals

Node-owned Goals + KPIs presentation. The reusable measurement engine and the wire contract (`GoalsProgressSchema`, `KpiAssessmentSchema`, `MetricHistorySchema`, `MetricDisplaySchema`) live in `@cogni-dao/metrics/contracts`; this feature owns the Goals view (`components/GoalsBoard`), the open KPI chart (`components/KpiChart`) and per-type card numbers (`lib/display`).

## UI rules

- Read at a glance. The board is a count strip (goals and KPIs counted once each; every status count is a count of KPIs), then one collapsible row per goal (its title is the header, with KPI count, most urgent status and due date). Inside a row, one card per KPI: label, number, at most one short hint, a status pill and one mark. No sentences on the board; the plain-words reason (`REASON_TEXT`, exhaustive by type) is part of the card toggle's accessible description and hover title, and lives on the entry page.
- Display type comes from the read model (`kpi.metric.display`): the calculator declares a default and a metric definition may override it (see packages/metrics/AGENTS.md). The UI never guesses from units. progress = bar toward target; volume = gradient sparkline + change since the bucket of its first reading; slo = availability bars + error budget against a ≥ objective (axis to 100) or ≤ objective (axis from 0), values truncated (never rounded up to 100%). Adding, refining or removing a metric or binding changes the board with no UI change. One formatter (`formatValue`) prints a reading everywhere.
- `GoalsBoard` is reusable: no Knowledge-route imports. Knowledge mounts it only on `?mode=goals`; its 30s poll (`refetchIntervalInBackground: false`) runs only while that tab is selected. The entry page mounts it with `goalId` (first KPI open).
- Status comes from `assessKpi` only; the UI never re-derives it. Cards are keyed by binding position plus metric id (a goal may bind one metric twice; a shifted binding closes the open chart). The whole card is one toggle button whose accessible description carries value, status, hint and reason. Every status shows a symbol and a word (`STATUS_META`); color is redundant.
- Unknown is not zero: no reading is "—" (`aria-label="No reading"`), never 0; delayed and failing values are muted.
- Quiet refresh: a failed poll keeps the data silently; only `STALE_AFTER_FAILURES` consecutive failures mark it "Stale", and a `GoalsReadError` with status 401 says "Signed out".
- Gaps stay gaps (`connectNulls={false}`); the newest reading after the last closed bucket is its own point. The read model carries a 30-day daily `trend` and, for hourly metrics, `recent` (last 24 hours). A card draws the daily trend once it has `MIN_DAILY_SHAPE` readings, else `recent`; the open chart starts on 1D until then.
- Recharts 2 renders only its own element types as direct chart children: pass arrays, never Fragments or wrapper components. Every chart and series takes a `useChartId` id (SSR-stable). No animation.
- The open chart is a `figure` named by the metric title; a collapsed "Readings" list is the keyboard path to each observation. Operational IDs stay behind those links.

Read the canonical complete active-goal list. Never bridge missing history, invent expected values, or present stale readings as current. The UI only reads; the existing worker computes. This feature must not import bootstrap, app or adapter code.
