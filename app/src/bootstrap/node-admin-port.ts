// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-port`
 * Purpose: This node's `NodeAdminPort`: node-wide AI access, delegating to the existing agent authority.
 * Scope: Composition only. No authority logic, no schema. The `AdminSession` argument is proof the Admin area's mint ran; its user id is the approver,
 *   and the session itself is the `admin` proof the package's one gate (`canApprove`) asks for on a node row.
 * Invariants: NO_NEW_AUTHORITY (grant, revoke and deny are `AgentToolAuthority` calls; the decision is the package's `canApprove`).
 * Side-effects: IO (through the agent authority)
 * Links: src/ports/node-admin.port.ts, src/bootstrap/agent-authority.ts
 * @internal
 */

import type { ApprovalCaller } from "@cogni/agent-grants";

import type { AgentToolAuthority } from "@/bootstrap/agent-authority";
import type { AdminSession, NodeAdminPort } from "@/ports";

/** The admin session is the proof of node-admin: it rides in `admin`, and only `requireAdminSession()` can make one. */
const adminCaller = (session: AdminSession): ApprovalCaller => ({ userId: session.userId, admin: session });

export function createNodeAdminPort(authority: AgentToolAuthority): NodeAdminPort {
  return {
    listNodeAi: () => authority.listNodeAi(),
    async turnAiPermissionOn(session, { ref, scope }) {
      const { principalUserId, created } = await authority.grantRole({ ...ref, scope, me: adminCaller(session) });
      return { principalUserId, changed: created };
    },
    async turnAiPermissionOff(session, { ref, scope }) {
      const { principalUserId, revoked } = await authority.revokeRole({ ...ref, scope, me: adminCaller(session) });
      return { principalUserId, changed: revoked };
    },
    async dismissAiRequest(session, { ref, scope }) {
      const { principalUserId, denied } = await authority.denyRequest({ ...ref, scope, me: adminCaller(session) });
      return { principalUserId, changed: denied };
    },
    async previewAiRequest(_session, token) {
      return authority.previewAsk({ token, resource: "node" });
    },
  };
}
