// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/columns`
 * Purpose: Binds the published work column set from `@cogni/knowledge-base-ui` to this node's `WorkItemSummary` (task.0044, task.0056).
 * Scope: Adapter only. Column definitions, header sort/filter controls and cells live in the package.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER — inherited from the package columns.
 * Side-effects: none
 * Links: task.0044
 * @internal
 */

"use client";

import { createWorkItemColumns } from "@cogni/knowledge-base-ui";
import type { WorkItemSummary } from "@cogni/node-contracts";

export const columns = createWorkItemColumns<WorkItemSummary>();
