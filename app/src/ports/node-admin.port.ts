// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** AI-permission acts only. The sole mint is (admin)/_lib/admin-session.ts. */
import type { NodeAiPermissionView } from "@cogni/agent-grants";

declare const adminSessionBrand: unique symbol;
export type AdminSession = {
  readonly [adminSessionBrand]: true;
  readonly userId: string;
};

export interface AiPermissionTarget {
  readonly principalUserId: string;
  readonly scope: string;
}

export interface NodeAdminPort {
  listNodeAi(session: AdminSession): Promise<{
    permissions: NodeAiPermissionView[];
    more: number;
  }>;
  turnAiPermissionOn(
    session: AdminSession,
    target: AiPermissionTarget,
  ): Promise<{ changed: boolean }>;
  turnAiPermissionOff(
    session: AdminSession,
    target: AiPermissionTarget,
  ): Promise<{ changed: boolean }>;
}
