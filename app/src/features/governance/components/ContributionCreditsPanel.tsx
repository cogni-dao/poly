// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/ContributionCreditsPanel`
 * Purpose: Visual and tabular view of finalized non-token attribution credits by canonical owner.
 * Scope: Presentational only; consumes the holdings read model.
 * Invariants: canonicalOwnerKey is the list, chart, table, and React identity; labels never aggregate owners.
 * Side-effects: none
 * @public
 */

import { Info, Users } from "lucide-react";
import type { ReactElement } from "react";

import {
  Alert,
  AlertDescription,
  Progress,
  SectionCard,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { HoldingRow } from "@/features/governance/components/HoldingCard";
import type { HoldingsData } from "@/features/governance/types";

export function ContributionCreditsPanel({
  data,
}: {
  readonly data: HoldingsData;
}): ReactElement {
  return (
    <SectionCard title="Contribution credits">
      <Alert>
        <Info className="size-4" aria-hidden="true" />
        <AlertDescription>
          Credits measure contribution inside finalized epochs. They are not
          tokens, wallet balances, or an independently transferable asset.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-2 gap-3">
        <CreditMetric
          label="Credits issued"
          value={formatCredits(data.totalCreditsIssued)}
        />
        <CreditMetric
          label="Contributors"
          value={data.totalContributors.toLocaleString()}
          icon={<Users className="size-4" aria-hidden="true" />}
        />
      </div>

      {data.holdings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground text-sm">
          No finalized contribution credits yet.
        </p>
      ) : (
        <>
          <div className="space-y-4" aria-label="Contribution credit shares">
            {data.holdings.map((holding) => (
              <div key={holding.canonicalOwnerKey} className="space-y-2">
                <div className="flex items-end justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {holding.displayName ?? holding.claimantLabel}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {holding.ownershipPercent}%
                  </span>
                </div>
                <Progress
                  value={holding.ownershipPercent}
                  aria-label={`${holding.displayName ?? holding.claimantLabel}: ${holding.ownershipPercent}% of finalized contribution credits`}
                />
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8 text-center">#</TableHead>
                  <TableHead>Contributor</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">
                    Share
                  </TableHead>
                  <TableHead className="hidden text-right sm:table-cell">
                    Epochs
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.holdings.map((holding, index) => (
                  <HoldingRow
                    key={holding.canonicalOwnerKey}
                    holding={holding}
                    rank={index + 1}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

function CreditMetric({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: ReactElement;
}): ReactElement {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 break-words font-semibold text-foreground text-lg tabular-nums">
        {value}
      </p>
    </div>
  );
}

function formatCredits(value: string): string {
  return BigInt(value).toLocaleString();
}
