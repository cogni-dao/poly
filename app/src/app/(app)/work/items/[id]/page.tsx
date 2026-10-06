// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated canonical human permalink for one node-local work item. */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { WorkDashboardView } from "../../view";

export default async function WorkItemPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const { id } = await params;
  return <WorkDashboardView selectedItemId={id} />;
}
