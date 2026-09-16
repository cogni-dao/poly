// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/loading`
 * Purpose: Section-level Suspense fallback covering `/gov`,
 *   `/gov/epoch`, `/gov/holdings`, and `/gov/review`. One shared section
 *   skeleton avoids near-identical route files.
 * Scope: Server component, layout-preserving inside `(app)/gov/layout.tsx`.
 * Invariants: Outer matches gov page renders. Table dominant.
 * Side-effects: none
 * Links: ./layout.tsx, src/components/kit/layout/TableSkeleton.tsx
 * @public
 */

import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";
import { TableSkeleton } from "@/components/kit/layout/TableSkeleton";

export default function GovLoading() {
  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <PageHeaderSkeleton titleWidth="w-40" />
      <TableSkeleton rows={8} />
    </div>
  );
}
