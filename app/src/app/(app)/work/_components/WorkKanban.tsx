// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkKanban`
 * Purpose: Binds the shared `WorkBoard` from `@cogni/knowledge-base-ui` to this node's work summary and router links (task.0044, task.0056).
 * Scope: Adapter only. Board markup and behavior live in the package; this node keeps data loading, URL state and routing.
 * Side-effects: none
 * Links: task.0044, story.0018
 * @internal
 */

"use client";

import {
  WorkBoard,
  type WorkBoardGoalLink,
  type WorkBoardProps,
} from "@cogni/knowledge-base-ui";
import type { WorkItemSummary } from "@cogni/node-contracts";
import Link from "next/link";

type WorkKanbanProps = Omit<WorkBoardProps<WorkItemSummary>, "renderGoalLink">;

/** Renders a board goal pointer with this node's router link. */
export function WorkGoalLink({ href, className, label }: WorkBoardGoalLink) {
  return (
    <Link href={href} prefetch={false} className={className}>
      {label}
    </Link>
  );
}

export function WorkKanban(props: WorkKanbanProps) {
  return <WorkBoard {...props} renderGoalLink={WorkGoalLink} />;
}
