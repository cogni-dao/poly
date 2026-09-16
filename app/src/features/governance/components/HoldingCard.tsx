// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/HoldingCard`
 * Purpose: Table row for a single holder in the holdings view — rank, avatar, credits, ownership%.
 * Scope: Governance feature component. Renders as TableRow for use inside shadcn Table. Does not perform data fetching or server-side logic.
 * Invariants: Credit strings format through BigInt; display names never identify rows.
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import type { ReactElement } from "react";

import { Badge, TableCell, TableRow } from "@/components";
import type { HoldingView } from "@/features/governance/types";

interface HoldingRowProps {
  readonly holding: HoldingView;
  readonly rank: number;
}

export function HoldingRow({ holding, rank }: HoldingRowProps): ReactElement {
  const credits = BigInt(holding.totalCredits).toLocaleString();

  return (
    <TableRow>
      <TableCell className="w-8 px-2 text-center text-muted-foreground text-xs sm:px-4">
        {rank}
      </TableCell>
      <TableCell className="max-w-32 px-2 sm:max-w-none sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-sm">
            {holding.displayName ?? "Contributor"}
          </span>
          {!holding.isLinked && (
            <Badge
              intent="outline"
              size="sm"
              className="hidden h-5 px-1.5 sm:inline-flex"
            >
              Unlinked
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="px-2 text-right font-mono text-xs tabular-nums sm:px-4">
        {credits}
      </TableCell>
      <TableCell className="hidden text-right font-medium text-sm sm:table-cell">
        {holding.ownershipPercent}%
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground text-xs sm:table-cell">
        {holding.epochsContributed}
      </TableCell>
    </TableRow>
  );
}
