// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/markets-table/DeltaDistribution`
 * Purpose: Generic |Δ| distribution chart. Receives an array of unsigned
 *   percentage values (already filtered + scaled by the caller), bins
 *   them, and renders a Recharts bar chart with summary stats. Three
 *   adapters in this directory (`MarketsDeltaDistribution`,
 *   `PositionsDeltaDistribution` for open + history) feed this with the
 *   per-tab join logic.
 * Scope: Pure client component. No fetch.
 *   Bounded by caller-supplied array length (≤ a few hundred), no V8 risk.
 * Invariants:
 *   - COVERAGE_IS_EXPLICIT: backend full-population eligible/comparable/dropped
 *     counts remain visible even when the chart is a bounded sample.
 *   - INCOMPLETE_FAILS_CLOSED: unavailable or ambiguous comparisons never
 *     render a trustworthy-looking histogram.
 *   - ABSOLUTE_VALUE: caller passes `Math.abs` values; component does not
 *     re-abs. Sign asymmetry is the caller's concern.
 *   - BIN_BOUNDARIES_FIXED: 0, 1, 5, 10, 25, 50, 100, ∞ (% units). Driven
 *     by the goal contract: ideal <1%, acceptable <10%, anything past 25%
 *     is mirror-loop pathology.
 * Side-effects: none
 * @public
 */

"use client";

import type {
  WalletDashboardComparisonCoverageLeaf,
  WalletDashboardComparisonCoverageReason,
} from "@cogni/poly-node-contracts";
import type { ReactElement } from "react";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

// eslint-disable-next-line no-restricted-imports -- pre-existing vendor import in app/, predates the kit-wrapper rule; tracked as follow-up
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/vendor/shadcn/chart";

// Green → amber → red gradient. Bin 0 is the "ideal" goal contract; bin 6 is
// pathology. Hard-coded hex (not theme tokens) so the gradient survives
// dark/light mode without duplicating the curve in CSS.
//
// `lo` is inclusive, `hi` is exclusive. The terminal bin's `hi` is +Infinity
// so the search loop matches everything not already binned.
const BINS = [
  { label: "<1%", lo: 0, hi: 1, color: "#22c55e" },
  { label: "1–5%", lo: 1, hi: 5, color: "#84cc16" },
  { label: "5–10%", lo: 5, hi: 10, color: "#eab308" },
  { label: "10–25%", lo: 10, hi: 25, color: "#f97316" },
  { label: "25–50%", lo: 25, hi: 50, color: "#ef4444" },
  { label: "50–100%", lo: 50, hi: 100, color: "#dc2626" },
  { label: "100%+", lo: 100, hi: Number.POSITIVE_INFINITY, color: "#991b1b" },
] as const;

export const BIN_LABELS = BINS.map((b) => b.label);

const CHART_CONFIG: ChartConfig = {
  count: {
    label: "Items",
    color: "var(--chart-1)",
  },
};

// Class strings extracted to consts so prettier-plugin-tailwindcss leaves
// them alone and biome's useSortedClasses can settle on a single ordering.
// Without the indirection the two formatters disagree on the sort order
// of `border` shorthand vs `border-<color>` and `text-<color>` vs typography
// modifiers, producing a fix-then-rerun loop.
const CONTAINER_CLASS =
  "space-y-2 rounded-md border border-border/60 bg-card/40 p-3";
const HEADER_ROW_CLASS =
  "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1";
const HEADER_LEFT_CLASS = "flex items-baseline gap-2";
const TITLE_CLASS =
  "font-semibold text-foreground text-xs uppercase tracking-wider";
const HEADER_META_CLASS = "text-muted-foreground text-xs";
const STATS_ROW_CLASS =
  "flex flex-wrap gap-x-3 font-mono text-muted-foreground text-xs tabular-nums";
const STAT_VALUE_CLASS = "text-foreground";
const CHART_WRAPPER_CLASS = "aspect-auto h-24 w-full";
const COVERAGE_ROW_CLASS =
  "flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs";
const COVERAGE_VALUE_CLASS = "font-mono text-foreground tabular-nums";
const WARNING_CLASS =
  "rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-300";
const UNAVAILABLE_CLASS =
  "rounded border border-border bg-muted/40 px-2 py-2 text-muted-foreground text-xs";

const REASON_COPY: Readonly<
  Record<WalletDashboardComparisonCoverageReason, string>
> = {
  comparison_missing:
    "Some eligible rows are missing a comparable target-versus-us delta.",
  preview_truncated: "The chart uses a bounded preview.",
  source_unavailable: "The comparison source is unavailable.",
  source_incomplete: "The comparison source is stale or incomplete.",
  identity_ambiguous:
    "Duplicate wallet or market identities made this comparison ambiguous.",
};

export function binIndex(absDeltaPct: number): number {
  for (let i = 0; i < BINS.length; i += 1) {
    const b = BINS[i];
    if (b && absDeltaPct >= b.lo && absDeltaPct < b.hi) return i;
  }
  return BINS.length - 1;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

export type DeltaDistributionProps = {
  /** Already absolute-valued, already × 100, already filtered. */
  absDeltaPcts: readonly number[];
  /** Right-side caption — e.g. "live · n=24" or "open positions · n=12". */
  subtitle: string;
  /** Backend-owned, full-population comparison coverage. */
  coverage?: WalletDashboardComparisonCoverageLeaf | undefined;
  /** Human-readable plural, e.g. "markets" or "positions". */
  entityLabel: string;
  /** Client-side integrity failures that must fail the chart closed. */
  integrityReasons?: readonly WalletDashboardComparisonCoverageReason[];
};

type CoverageState =
  | {
      kind: "unavailable";
      counts: null | {
        eligible: number;
        comparable: number;
        dropped: number;
        sampled: number;
      };
      reasons: readonly WalletDashboardComparisonCoverageReason[];
    }
  | {
      kind: "empty" | "complete" | "partial";
      counts: {
        eligible: number;
        comparable: number;
        dropped: number;
        sampled: number;
      };
      reasons: readonly WalletDashboardComparisonCoverageReason[];
    };

export function resolveDeltaCoverageState({
  absDeltaPcts,
  coverage,
  integrityReasons = [],
}: Pick<
  DeltaDistributionProps,
  "absDeltaPcts" | "coverage" | "integrityReasons"
>): CoverageState {
  if (!coverage) {
    return {
      kind: "unavailable",
      counts: null,
      reasons: ["source_unavailable"],
    };
  }

  const reasons = [...new Set([...coverage.reasons, ...integrityReasons])];
  const rawCounts = [
    coverage.eligible,
    coverage.comparable,
    coverage.dropped,
    coverage.sampled,
  ];
  const allNull = rawCounts.every((value) => value === null);
  const allNumbers = rawCounts.every(
    (value) => typeof value === "number" && Number.isSafeInteger(value)
  );

  if (allNull) return { kind: "unavailable", counts: null, reasons };
  if (!allNumbers) return { kind: "unavailable", counts: null, reasons };

  const eligible = coverage.eligible as number;
  const comparable = coverage.comparable as number;
  const dropped = coverage.dropped as number;
  const sampled = coverage.sampled as number;
  const counts = { eligible, comparable, dropped, sampled };
  const malformed =
    rawCounts.some((value) => (value as number) < 0) ||
    eligible !== comparable + dropped ||
    sampled > comparable ||
    sampled !== absDeltaPcts.length ||
    absDeltaPcts.some((value) => !Number.isFinite(value));
  const identityAmbiguous = reasons.includes("identity_ambiguous");
  const sourceUnavailable = reasons.includes("source_unavailable");

  if (malformed || identityAmbiguous || sourceUnavailable) {
    return { kind: "unavailable", counts, reasons };
  }
  if (eligible === 0 && coverage.complete && reasons.length === 0) {
    return { kind: "empty", counts, reasons };
  }

  const fullyComparable =
    coverage.complete &&
    dropped === 0 &&
    sampled === comparable &&
    reasons.length === 0;
  return {
    kind: fullyComparable ? "complete" : "partial",
    counts,
    reasons,
  };
}

export function DeltaDistribution({
  absDeltaPcts,
  subtitle,
  coverage,
  entityLabel,
  integrityReasons,
}: DeltaDistributionProps): ReactElement | null {
  const mergedReasons = [
    ...(coverage?.reasons ?? []),
    ...(integrityReasons ?? []),
  ];
  const chartMustBeSuppressed = mergedReasons.some((reason) =>
    ["source_unavailable", "source_incomplete", "identity_ambiguous"].includes(
      reason
    )
  );
  const chartValues = chartMustBeSuppressed ? [] : absDeltaPcts;
  const coverageState = resolveDeltaCoverageState({
    absDeltaPcts: chartValues,
    coverage,
    ...(integrityReasons ? { integrityReasons } : {}),
  });
  const { bars, stats } = useMemo(() => {
    const counts = new Array(BINS.length).fill(0) as number[];
    for (const v of chartValues) {
      const idx = binIndex(v);
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    const total = chartValues.length;
    const meanAbs =
      total > 0 ? chartValues.reduce((s, v) => s + v, 0) / total : 0;
    const medAbs = median(chartValues);
    const under1 = chartValues.filter((v) => v < 1).length;
    const under10 = chartValues.filter((v) => v < 10).length;
    return {
      bars: BINS.map((b, i) => ({
        bin: b.label,
        count: counts[i] ?? 0,
        fill: b.color,
      })),
      stats: { meanAbs, medAbs, under1, under10, total },
    };
  }, [chartValues]);

  if (coverageState.kind === "empty") {
    return (
      <div className={CONTAINER_CLASS}>
        <p className={UNAVAILABLE_CLASS}>
          No eligible {subtitle} {entityLabel}.
        </p>
      </div>
    );
  }

  const coverageText = coverageState.counts
    ? `Compared ${coverageState.counts.comparable} of ${coverageState.counts.eligible} ${entityLabel} · ${coverageState.counts.dropped} excluded`
    : "Comparison coverage unavailable";
  const reasonText = coverageState.reasons
    .map((reason) => REASON_COPY[reason])
    .join(" ");

  if (coverageState.kind === "unavailable") {
    return (
      <div className={CONTAINER_CLASS} role="status">
        <p className={UNAVAILABLE_CLASS}>
          Delta comparison unavailable. {coverageText}.
          {reasonText ? ` ${reasonText}` : ""}
        </p>
      </div>
    );
  }

  const isPartial = coverageState.kind === "partial";
  const showSample =
    isPartial || coverageState.counts.sampled !== coverageState.counts.comparable;
  const sourceIncomplete = coverageState.reasons.includes("source_incomplete");

  if (sourceIncomplete) {
    return (
      <div className={CONTAINER_CLASS} role="status">
        <p className={WARNING_CLASS}>
          Partial comparison. {coverageText}. Chart sample{" "}
          {coverageState.counts.sampled} of {coverageState.counts.comparable}.
          The histogram is withheld. {reasonText}
        </p>
      </div>
    );
  }

  if (stats.total === 0) {
    return (
      <div className={CONTAINER_CLASS} role="status">
        <p className={WARNING_CLASS}>
          Partial comparison. {coverageText}. No comparable rows are available
          in the chart sample.{reasonText ? ` ${reasonText}` : ""}
        </p>
      </div>
    );
  }

  const pctUnder1 = Math.round((stats.under1 / stats.total) * 100);
  const pctUnder10 = Math.round((stats.under10 / stats.total) * 100);

  return (
    <div className={CONTAINER_CLASS}>
      <div className={HEADER_ROW_CLASS}>
        <div className={HEADER_LEFT_CLASS}>
          <h4 className={TITLE_CLASS}>|Δ| distribution</h4>
          <span className={HEADER_META_CLASS}>{subtitle}</span>
        </div>
        <div className={STATS_ROW_CLASS}>
          <span>
            mean{" "}
            <span className={STAT_VALUE_CLASS}>
              {stats.meanAbs.toFixed(1)}%
            </span>
          </span>
          <span>
            median{" "}
            <span className={STAT_VALUE_CLASS}>{stats.medAbs.toFixed(1)}%</span>
          </span>
          <span>
            &lt;1% <span className={STAT_VALUE_CLASS}>{pctUnder1}%</span>
          </span>
          <span>
            &lt;10% <span className={STAT_VALUE_CLASS}>{pctUnder10}%</span>
          </span>
        </div>
      </div>
      <div className={COVERAGE_ROW_CLASS}>
        <span>{coverageText}</span>
        {showSample ? (
          <span>
            Chart sample{" "}
            <span className={COVERAGE_VALUE_CLASS}>
              {coverageState.counts.sampled} of{" "}
              {coverageState.counts.comparable}
            </span>
          </span>
        ) : null}
      </div>
      {isPartial ? (
        <p className={WARNING_CLASS} role="status">
          Partial comparison.{reasonText ? ` ${reasonText}` : ""}
        </p>
      ) : null}
      <ChartContainer config={CHART_CONFIG} className={CHART_WRAPPER_CLASS}>
        <BarChart
          data={bars}
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          barCategoryGap="14%"
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bin"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={28}
            allowDecimals={false}
            fontSize={11}
          />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent indicator="dot" />}
          />
          <Bar dataKey="count" radius={[2, 2, 0, 0]}>
            {bars.map((b) => (
              <Cell key={b.bin} fill={b.fill} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}
