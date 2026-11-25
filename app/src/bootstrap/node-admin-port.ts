// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Red's bounded internal-AI host composition. Published functions own grant policy.
 * One server-owned slug and one declared permission; no account or outside rows.
 * Every read is an indexed lookup. Slug writes avoid the package's ID-list lookup.
 */
import {
  AgentRolesError,
  grantRole,
  resolveInternalPrincipal,
  revokeRole,
  type WithStore,
} from "@cogni/agent-grants";
import { sandboxShellContract } from "@cogni/shared-ai-tools";
import type { Logger } from "pino";

import type { NodeAdminPort } from "@/ports/node-admin.port";
import { EVENT_NAMES } from "@/shared/observability";

const PRINCIPAL_SLUG = "node-ai";

export function createNodeAdminPort(
  withStore: WithStore,
  log: Logger,
): NodeAdminPort {
  const permission = sandboxShellContract.requires;
  if (
    permission?.scope !== "sandbox:exec" ||
    permission.kind !== "node" ||
    !permission.label ||
    !permission.description
  ) {
    throw new Error("internal_permission_unavailable");
  }
  const declaredScopes = [permission.scope];
  const scopeKinds = { [permission.scope]: permission.kind };
  const change =
    (on: boolean): NodeAdminPort["turnAiPermissionOn"] =>
    async (session, target) => {
      // Refuse unknown scopes before opening the store; the client cannot choose authority.
      if (target.scope !== permission.scope)
        throw new AgentRolesError("invalid_scope", "unsupported permission");
      const result = await withStore(async (store) => {
        const principalUserId = await resolveInternalPrincipal(
          store,
          PRINCIPAL_SLUG,
        );
        if (!principalUserId)
          throw new AgentRolesError(
            "principal_not_found",
            "internal AI unavailable",
          );
        if (target.principalUserId !== principalUserId)
          throw new AgentRolesError("not_allowed", "unsupported principal");
        const input = {
          principalSlug: PRINCIPAL_SLUG,
          scope: permission.scope,
          me: { userId: session.userId, admin: session },
          scopeKinds,
        };
        const changed = on
          ? (await grantRole(store, { ...input, declaredScopes })).created
          : (await revokeRole(store, input)).revoked;
        return { principalUserId, changed };
      });
      log.info(
        {
          event: on
            ? EVENT_NAMES.AGENT_ROLE_GRANTED
            : EVENT_NAMES.AGENT_ROLE_REVOKED,
          principalUserId: result.principalUserId,
          scope: permission.scope,
          resource: "node",
          ...(on
            ? { approvedBy: session.userId }
            : { revokedBy: session.userId }),
          changed: result.changed,
        },
        "internal AI permission decision",
      );
      return { changed: result.changed };
    };
  return {
    async listNodeAi() {
      return withStore(async (store) => {
        const principalUserId = await resolveInternalPrincipal(
          store,
          PRINCIPAL_SLUG,
        );
        if (!principalUserId) throw new Error("internal_principal_unavailable");
        const on = await store.hasLiveRole(principalUserId, permission.scope);
        return {
          permissions: [
            {
              section: "node",
              principalUserId,
              who: PRINCIPAL_SLUG,
              outside: false,
              hint: null,
              scope: permission.scope,
              label: permission.label,
              description: permission.description,
              on,
              until: null,
              resource: "node",
              rowId: null,
            },
          ],
          more: 0,
        };
      });
    },
    turnAiPermissionOn: change(true),
    turnAiPermissionOff: change(false),
  };
}
