// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/DistributionModelFlow`
 * Purpose: Human-readable visual of how contribution activity becomes claimable tokens.
 * Scope: Presentational only; it does not infer protocol state.
 * Invariants: Credits are non-token attribution; publication is cumulative.
 * Side-effects: none
 * @public
 */

import { ArrowDown, CircleDot, Coins, Send } from "lucide-react";
import type { ComponentType, ReactElement } from "react";

interface FlowStep {
  readonly title: string;
  readonly description: string;
  readonly Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

const STEPS: readonly FlowStep[] = [
  {
    title: "Contribute",
    description: "Activity earns attribution credits. Credits are not tokens.",
    Icon: CircleDot,
  },
  {
    title: "Finalize an epoch",
    description: "Credits determine each contributor’s share of that epoch.",
    Icon: Coins,
  },
  {
    title: "Publish and claim",
    description: "The latest global total makes all newly earned tokens claimable.",
    Icon: Send,
  },
] as const;

export function DistributionModelFlow(): ReactElement {
  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="Token issuance model">
      {STEPS.map(({ title, description, Icon }, index) => (
        <li key={title} className="min-w-0">
          <div className="h-full rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-3 sm:items-start">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary text-sm">
                <Icon className="size-4" aria-hidden={true} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-foreground text-sm">
                  {index + 1}. {title}
                </p>
                <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
                  {description}
                </p>
              </div>
            </div>
          </div>
          {index < STEPS.length - 1 && (
            <div className="flex h-5 items-center justify-center text-muted-foreground sm:hidden">
              <ArrowDown className="size-4" aria-hidden="true" />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
