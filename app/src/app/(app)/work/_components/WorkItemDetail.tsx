// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import { Sheet, SheetContent } from "@/components";
import type { WorkItemDetailBodyProps } from "./WorkItemDetailBody";
import { WorkItemDetailBody } from "./WorkItemDetailBody";

/** The eager detail sheet both hosts (the /work page and the dashboard) render; its body is the one shared item view. */
export function WorkItemDetail({
  open,
  onOpenChange,
  ...body
}: WorkItemDetailBodyProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <WorkItemDetailBody {...body} />
      </SheetContent>
    </Sheet>
  );
}
