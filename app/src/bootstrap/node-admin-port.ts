// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-port`
 * Purpose: This node's `NodeAdminPort`: node-wide AI access, delegating to the existing agent authority.
 * Scope: Composition only. No authority logic, no schema. The `AdminSession` argument is proof the Admin area's mint ran; its user id is the approver.
 * Invariants: NO_NEW_AUTHORITY (grant, revoke and deny are `AgentToolAuthority` calls, unchanged).
 * Side-effects: IO (through the agent authority)
 * Links: src/ports/node-admin.port.ts, src/bootstrap/agent-authority.ts
 * @internal
 */

import type { AgentToolAuthority } from "@/bootstrap/agent-authority";
import type { NodeAdminPort } from "@/ports";

export function createNodeAdminPort(authority: AgentToolAuthority): NodeAdminPort {
  return {
    listNodeAi: () => authority.listNodeAi(),
    async turnAiPermissionOn(session, { ref, scope }) {
      const { principalUserId, created } = await authority.grantRole({ ...ref, scope, approvedBy: session.userId });
      return { principalUserId, changed: created };
    },
    async turnAiPermissionOff(session, { ref, scope }) {
      const { principalUserId, revoked } = await authority.revokeRole({ ...ref, scope, revokedBy: session.userId });
      return { principalUserId, changed: revoked };
    },
    async dismissAiRequest(session, { ref, scope }) {
      const { principalUserId, denied } = await authority.denyRequest({ ...ref, scope, deniedBy: session.userId });
      return { principalUserId, changed: denied };
    },
  };
}
