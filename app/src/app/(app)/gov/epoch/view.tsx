// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/epoch/view`
 * Purpose: Unified epoch overview with one lifecycle rail for current and historical epochs.
 * Scope: Renders epoch data, settlement evidence, and the existing contribution sync trigger.
 * Invariants: NO_ADMIN_SETTLEMENT_ACTIONS, SAME_RAIL_EVERY_EPOCH, UNKNOWN_NEVER_COMPLETE.
 * Side-effects: IO (via epoch query and contribution sync hooks)
 * Links: docs/spec/epoch-ledger.md, src/features/governance/types.ts
 * @public
 */

"use client";

import { CheckCircle, Clock, Eye, Loader2, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo } from "react";
import {
  Badge,
  Button,
  ExpandableTableRow,
  PieChart,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { EpochCountdown } from "@/features/governance/components/EpochCountdown";
import { EpochDetail } from "@/features/governance/components/EpochDetail";
import { EpochLifecycleProgress } from "@/features/governance/components/EpochLifecycleProgress";
import { useCollectEpoch } from "@/features/governance/hooks/useCollectEpoch";
import { useEpochsPage } from "@/features/governance/hooks/useEpochsPage";
import { buildPieChartData } from "@/features/governance/lib/build-pie-data";
import type { SettlementLifecycleEvidence } from "@/features/governance/lib/epoch-lifecycle-state";
import type { EpochView } from "@/features/governance/types";

function compareUnitsDescending(
  left: EpochView["contributors"][number],
  right: EpochView["contributors"][number]
): number {
  const leftUnits = BigInt(left.units);
  const rightUnits = BigInt(right.units);
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? -1 : 1;
}

function formatCredits(value: string | null): string {
  if (value === null) return "—";
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return value;
  }
}

function StatusBadge({
  status,
}: {
  status: EpochView["status"];
}): ReactElement {
  switch (status) {
    case "finalized":
      return (
        <Badge
          intent="outline"
          size="sm"
          className="gap-1 border-success/40 text-success"
        >
          <CheckCircle className="h-3 w-3" />
          Finalized
        </Badge>
      );
    case "review":
      return (
        <Badge
          intent="outline"
          size="sm"
          className="gap-1 border-warning/40 text-warning"
        >
          <Eye className="h-3 w-3" />
          Review
        </Badge>
      );
    default:
      return (
        <Badge intent="default" size="sm" className="animate-pulse gap-1">
          <Clock className="h-3 w-3" />
          Active
        </Badge>
      );
  }
}

function CurrentEpochSection({
  epoch,
  lifecycle,
}: {
  readonly epoch: EpochView;
  readonly lifecycle: SettlementLifecycleEvidence;
}): ReactElement {
  const collectEpoch = useCollectEpoch();
  const sorted = useMemo(
    () => [...epoch.contributors].sort(compareUnitsDescending),
    [epoch.contributors]
  );

  const totalPoints = useMemo(
    () =>
      sorted
        .reduce((sum, contributor) => {
          const roundedPoints = (BigInt(contributor.units) + 500n) / 1000n;
          return sum + roundedPoints;
        }, 0n)
        .toLocaleString(),
    [sorted]
  );

  const { chartData, chartConfig, legendEntries } = useMemo(
    () =>
      buildPieChartData(
        sorted.map((c) => ({
          key: c.displayName ?? c.claimantLabel,
          value: c.creditShare,
        }))
      ),
    [sorted]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="mb-1 font-bold text-3xl tracking-tight">
            Epoch <span className="text-primary">#{epoch.id}</span>
          </h1>
          <p className="text-muted-foreground">
            {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
            {new Date(epoch.periodEnd).toLocaleDateString()}
          </p>
        </div>

        {epoch.status === "open" ? (
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              disabled={
                collectEpoch.loading || collectEpoch.cooldownSeconds !== null
              }
              aria-busy={collectEpoch.loading}
              aria-describedby={
                collectEpoch.error ||
                collectEpoch.successMessage ||
                collectEpoch.cooldownSeconds !== null
                  ? "epoch-sync-feedback"
                  : undefined
              }
              onClick={() => void collectEpoch.trigger()}
            >
              {collectEpoch.loading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {collectEpoch.loading ? "Syncing…" : "Sync contributions"}
            </Button>
            {collectEpoch.error ? (
              <p
                id="epoch-sync-feedback"
                role="alert"
                className="max-w-sm text-destructive text-xs sm:text-right"
              >
                Couldn’t sync contributions: {collectEpoch.error}
              </p>
            ) : collectEpoch.successMessage ? (
              <p
                id="epoch-sync-feedback"
                role="status"
                className="max-w-sm text-success text-xs sm:text-right"
              >
                {collectEpoch.successMessage}
              </p>
            ) : collectEpoch.cooldownSeconds !== null ? (
              <p
                id="epoch-sync-feedback"
                role="status"
                className="max-w-sm text-muted-foreground text-xs sm:text-right"
              >
                Recently synced. Try again in about{" "}
                {Math.ceil(collectEpoch.cooldownSeconds / 60)} min.
              </p>
            ) : (
              <p className="max-w-sm text-muted-foreground text-xs sm:text-right">
                Pull the latest contributions into this open epoch.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border bg-card px-3 py-4">
        <EpochLifecycleProgress epoch={epoch} lifecycle={lifecycle} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="hidden items-center gap-3 sm:flex">
          <PieChart
            data={chartData}
            config={chartConfig}
            innerRadius={45}
            innerLabel={`#${epoch.id}`}
            className="aspect-square h-44 shrink-0"
          />
          <div className="flex flex-col gap-1.5">
            {legendEntries.map((e) => (
              <div key={e.label} className="flex items-center gap-2 text-xs">
                <div
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: e.color }}
                />
                <span className="text-muted-foreground">{e.label}</span>
              </div>
            ))}
          </div>
        </div>
        <EpochCountdown
          periodStart={epoch.periodStart}
          periodEnd={epoch.periodEnd}
          status={epoch.status}
          contributorCount={sorted.length}
          totalPoints={totalPoints}
        />
      </div>

      <EpochDetail epoch={epoch} hideHeader />
    </div>
  );
}

function PastEpochsSection({
  epochs,
  lifecycle,
}: {
  readonly epochs: readonly EpochView[];
  readonly lifecycle: SettlementLifecycleEvidence;
}): ReactElement {
  if (epochs.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center">
        <p className="text-muted-foreground">No past epochs</p>
        <p className="mt-2 text-muted-foreground text-sm">
          Completed epochs will appear here after they are finalized.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-16">#</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Contributors</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {epochs.map((epoch) => {
            return (
              <ExpandableTableRow
                key={epoch.id}
                colSpan={7}
                cellClassNames={[
                  undefined,
                  undefined,
                  "text-right",
                  "text-right",
                  "text-right",
                ]}
                expandedContent={
                  <div className="space-y-4">
                    <div className="rounded-lg border bg-card px-3 py-4">
                      <EpochLifecycleProgress
                        epoch={epoch}
                        lifecycle={lifecycle}
                      />
                    </div>
                    <EpochDetail epoch={epoch} />
                  </div>
                }
                cells={[
                  <span key="id" className="font-bold text-foreground/60">
                    {epoch.id}
                  </span>,
                  <span key="period" className="text-sm">
                    {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
                    {new Date(epoch.periodEnd).toLocaleDateString()}
                  </span>,
                  <span key="contributors" className="text-right text-sm">
                    {epoch.contributors.length}
                  </span>,
                  <span key="credits" className="text-right font-mono text-xs">
                    {formatCredits(epoch.poolTotalCredits)}
                  </span>,
                  <div key="status" className="flex justify-end">
                    <StatusBadge status={epoch.status} />
                  </div>,
                ]}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function CurrentEpochView(): ReactElement {
  const { data, isLoading, error } = useEpochsPage();

  if (error) {
    return (
      <div className="flex flex-col gap-8">
        <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive text-lg">
            Error loading epoch data
          </h2>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-8">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-48 rounded-md bg-muted" />
          <div className="h-28 rounded-lg bg-muted" />
          <div className="h-64 rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {data.current ? (
        <CurrentEpochSection
          key={data.current.id}
          epoch={data.current}
          lifecycle={data.settlementLifecycle}
        />
      ) : (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">No active epoch</p>
          <p className="mt-2 text-muted-foreground text-sm">
            A new epoch will appear here when one is opened.
          </p>
        </div>
      )}

      {data.pastEpochs.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="font-semibold text-xl tracking-tight">
              Past Epochs
            </h2>
            <p className="text-muted-foreground text-sm">
              Review and finalized epochs with their full distribution state
            </p>
          </div>
          <PastEpochsSection
            epochs={data.pastEpochs}
            lifecycle={data.settlementLifecycle}
          />
        </div>
      )}
    </div>
  );
}
