// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-admin`
 * Purpose: The one door for node-admin writes (ADMIN_ACTS_IN_ADMIN). Every method takes an `AdminSession` first, so a caller that
 *   never passed the Admin area's `requireAdminSession()` cannot call it: the type checker refuses.
 * Scope: Interface and the branded session type only. First slice: node-wide AI access. Epoch review, goal-layer merge and priority 0/1 join in task.0115.
 * Invariants:
 *   - ONE_MINT: the brand below is not exported. Only `src/app/(admin)/_lib/admin-session.ts` casts to `AdminSession` (an import-lock test fails on any other `as AdminSession`).
 *   - NO_NEW_AUTHORITY: an implementation delegates to the existing authority; it decides nothing itself.
 * Side-effects: none (interface definition only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, tests/unit/app/admin-acts-in-admin.test.ts
 * @public
 */

import type { NodeAiPermissionView, PrincipalRef } from "@cogni/agent-grants";

declare const adminSessionBrand: unique symbol;

/** A browser session the node-admin check approved. Made only by `requireAdminSession()`. */
export type AdminSession = {
  readonly [adminSessionBrand]: true;
  readonly userId: string;
};

export interface AiPermissionTarget {
  readonly ref: PrincipalRef;
  readonly scope: string;
}

export interface AiPermissionChange {
  readonly principalUserId: string;
  readonly changed: boolean;
}

export interface NodeAdminPort {
  /** The admin table of this node's AI permissions. */
  listNodeAi(session: AdminSession): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** Turn a node-wide permission On: approve a pending ask, or grant one of this node's AI directly. */
  turnAiPermissionOn(session: AdminSession, target: AiPermissionTarget): Promise<AiPermissionChange>;
  /** Turn a live node-wide permission Off. */
  turnAiPermissionOff(session: AdminSession, target: AiPermissionTarget): Promise<AiPermissionChange>;
  /** Dismiss a pending ask (the agent then sees `denied`). */
  dismissAiRequest(session: AdminSession, target: AiPermissionTarget): Promise<AiPermissionChange>;
}
