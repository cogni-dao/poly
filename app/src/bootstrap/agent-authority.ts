// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's authority object: `createAgentToolAuthority` from `@cogni/agent-grants/host` (the guard store, decision log, admin check,
 *   and the role, ask and mine calls) over this node's tool contracts and its one composed graph catalog (`POLY_NODE_LANGGRAPH_CATALOG`).
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and `agent_principals` are
 *   deny-all for the app role. Decides nothing itself (ONE_AUTHORIZE_FN lives in the package). No org, service-auth or payer methods: those
 *   join the package after task.0181's release.
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS, DECLARED_SCOPES_FROM_CONTRACTS, NO_SECRETS_IN_LOGS: owned by the package host; see `@cogni/agent-grants/host`.
 *   - POLY_LEGACY_GRANTS_UNTOUCHED: Poly's own account-grant plane (`features/agent-grants`) is not read here; it retires in a later PR.
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
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import type { Logger } from "pino";

import { failureFields } from "@/shared/observability";

import { POLY_NODE_LANGGRAPH_CATALOG } from "./ai/node-catalog";

export type { AgentAuthoritySql, AgentToolAuthority };

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  toolBundle: readonly CatalogBoundTool[];
}): AgentToolAuthority {
  return createHostAuthority({
    sql: deps.sql,
    nodeAdmin: deps.nodeAdmin,
    log: deps.log,
    tools: deps.toolBundle.map((tool) => ({
      id: tool.contract.name,
      requires: tool.contract.requires,
    })),
    graphs: Object.values(POLY_NODE_LANGGRAPH_CATALOG),
    systemUserIds: [COGNI_SYSTEM_PRINCIPAL_USER_ID],
    failureFields,
  });
}
