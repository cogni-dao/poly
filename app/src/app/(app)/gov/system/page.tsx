// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/system/page`
 * Purpose: Server entrypoint for the system activity page within governance.
 * Scope: Server component; delegates client behavior to GovernanceView. No data fetching.
 * Invariants: Auth enforced by (app) layout guard. One-time node and distribution setup belongs to
 *   the Cogni Operator node page; this child-node route is activity-only.
 * Side-effects: none (server render only)
 * Links: docs/spec/governance-status-api.md
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { PageSkeleton } from "@/components";

import { GovernanceView } from "./view";

export default function SystemActivityPage(): ReactElement {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <GovernanceView />
    </Suspense>
  );
}
