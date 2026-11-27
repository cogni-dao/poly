// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's authority object: `createAgentToolAuthority` from `@cogni/agent-grants/host` (the guard store, decision log, admin check,
 *   and the role, ask and mine calls) over this node's tool contracts and graph catalog.
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and `agent_principals` are
 *   deny-all for the app role. Decides nothing itself (ONE_AUTHORIZE_FN lives in the package). No org, service-auth or payer methods: those
 *   join the package after task.0181's release.
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS, DECLARED_SCOPES_FROM_CONTRACTS, NO_SECRETS_IN_LOGS: owned by the package host; see `@cogni/agent-grants/host`.
 *   - ONE_GRANT_PLANE: Poly's own account-grant plane is gone (migration 0093). Its `account:read` grant is an `agent_roles` row, declared once through
 *     `app/src/node-extensions.ts` (the node composition root) and passed here as `routes`.
 * Side-effects: IO (service-role database reads and writes)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AgentAuthoritySql,
  type AgentToolAuthority,
  createAgentToolAuthority as createHostAuthority,
} from "@cogni/agent-grants/host";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import type { Logger } from "pino";

import { nodeExtensions } from "@/node-extensions";
import { failureFields } from "@/shared/observability";

export type { AgentAuthoritySql, AgentToolAuthority };

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  toolBundle: readonly CatalogBoundTool[];
  /** Create the person's billing account when they turn an account row On and have none yet. */
  ensureBillingAccount: (userId: string) => Promise<string>;
}): AgentToolAuthority {
  return createHostAuthority({
    sql: deps.sql,
    nodeAdmin: deps.nodeAdmin,
    log: deps.log,
    tools: deps.toolBundle.map((tool) => ({
      id: tool.contract.name,
      requires: tool.contract.requires,
    })),
    ...(nodeExtensions.routes ? { routes: nodeExtensions.routes } : {}),
    graphs: Object.values(LANGGRAPH_CATALOG),
    systemUserIds: [COGNI_SYSTEM_PRINCIPAL_USER_ID],
    ensureBillingAccount: deps.ensureBillingAccount,
    failureFields,
  });
}
