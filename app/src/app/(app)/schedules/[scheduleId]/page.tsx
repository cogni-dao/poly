// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated Red schedule history shell; API independently checks ownership. */
import { redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth/server";
import { ScheduleHistoryView } from "./view";

export default async function ScheduleHistoryPage({
  params,
}: {
  params: Promise<{ scheduleId: string }>;
}) {
  if (!(await getServerSessionUser())) redirect("/");
  return <ScheduleHistoryView scheduleId={(await params).scheduleId} />;
}
