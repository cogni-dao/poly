// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/governance/components/EpochLifecycleProgress`
 * Purpose: Adapt epoch settlement evidence to the shared read-only lifecycle rail.
 * Scope: Presentation and hydration-safe period-boundary state only; contains no actions or IO.
 * Invariants: SAME_RAIL_EVERY_EPOCH, STATUS_IS_TEXT, UNKNOWN_NEVER_COMPLETE.
 * Side-effects: hydration-safe period-boundary timer only
 * Links: src/features/governance/lib/epoch-lifecycle-state.ts, task.5039
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { LifecycleProgress, type LifecycleProgressStep } from "@/components";
import {
  deriveEpochLifecycle,
  type SettlementLifecycleEvidence,
} from "@/features/governance/lib/epoch-lifecycle-state";
import type { EpochView } from "@/features/governance/types";

function usePeriodEnded(
  status: EpochView["status"],
  periodEnd: string
): boolean {
  const [boundaryReached, setBoundaryReached] = useState(false);

  useEffect(() => {
    if (status !== "open") return;
    const periodEndMs = Date.parse(periodEnd);
    if (!Number.isFinite(periodEndMs)) return;

    const remainingMs = Math.max(0, periodEndMs - Date.now());
    const timer = window.setTimeout(
      () => setBoundaryReached(true),
      remainingMs
    );
    return () => window.clearTimeout(timer);
  }, [periodEnd, status]);

  return status === "open" && boundaryReached;
}

export function EpochLifecycleProgress({
  epoch,
  lifecycle,
}: {
  readonly epoch: EpochView;
  readonly lifecycle: SettlementLifecycleEvidence;
}): ReactElement {
  const periodEnded = usePeriodEnded(epoch.status, epoch.periodEnd);
  const derived = deriveEpochLifecycle(epoch, lifecycle, periodEnded);
  const steps: readonly LifecycleProgressStep[] = derived.steps.map((step) => ({
    label: step.label,
    state: step.state,
    description: step.description,
  }));

  return (
    <div className="space-y-3">
      <LifecycleProgress
        ariaLabel={`Epoch ${epoch.id} lifecycle`}
        steps={steps}
      />
      <p className="text-center text-muted-foreground text-xs">
        <span className="font-medium text-foreground">Publish:</span>{" "}
        {derived.publishDetail}
      </p>
    </div>
  );
}
