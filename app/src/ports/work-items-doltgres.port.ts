// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Published contracts; the host supplies auth and runtime composition. */
import type { WorkItemsPort } from "@cogni/work-items";
export type WorkItemsDoltgresPort = WorkItemsPort;
export type WorkItemsCreateInput = Parameters<WorkItemsPort["create"]>[0];
export type WorkItemsPatchInput = Parameters<WorkItemsPort["patch"]>[0];
export type WorkItemsPatchSet = WorkItemsPatchInput["set"];
