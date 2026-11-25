// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's wiring of `@cogni/agent-grants`: principal lookup, the guard's store and admin check, the decision log, and the
 *   node-plane role grant/revoke/deny/ask the admin and agent routes call. Same shape as node-template's authority, minus the account plane,
 *   payer bindings, orgs and service enrollment: Poly keeps its own account grants and access requests (`features/agent-grants`), unchanged.
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and
 *   `agent_principals` are deny-all for the app role. Does not decide anything itself (ONE_AUTHORIZE_FN lives in the package).
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS: the human's wallet(s) come from `user_bindings` (provider = wallet), never from the request. Any bound
 *     admin wallet passes; no wallet is denied; no configured admins is unavailable.
 *   - DECLARED_SCOPES_FROM_CONTRACTS: the scopes a role may name are exactly those the node's tool contracts declare (`agent-permissions.ts`).
 *   - NO_SECRETS_IN_LOGS: `agent_tool.authz` carries ids, tool, decision and code only.
 * Side-effects: IO (service-role database reads and writes)
 * Links: packages/agent-grants, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AdminCheck,
  AgentRolesError,
  type ApprovalCaller,
  type AskOutcome,
  agentNameKey,
  buildAskView,
  buildNodeAiView,
  createPostgresAgentGrantsStore,
  denyRequest,
  type GrantResource,
  type GuardDeps,
  grantRole,
  listOwnAccess,
  type NodeAiPermissionView,
  type PrincipalKind,
  type PrincipalRef,
  previewAsk,
  principalKindOf,
  requestAccess,
  resolveInternalPrincipal,
  type RoleState,
  revokeRole,
  scopesByPrincipalOf,
  type SqlTag,
  type ToolRequires,
  type WithStore,
  writeExternalPrincipal,
} from "@cogni/agent-grants";
import type { NodeAdminAuthority } from "@cogni-dao/knowledge-store";
import type { Logger } from "pino";

import { EVENT_NAMES, failureFields } from "@/shared/observability";

import {
  buildPermissionCatalog,
  buildRequiresById,
  type PermissionBoundTool,
} from "./agent-permissions";

/** The service-role postgres.js client (`serviceDb.$client`): a tagged template that can also open a transaction. */
export interface AgentAuthoritySql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
}

/** The slice of a graph catalog entry that names its internal AI and the tools it lists. */
export interface PrincipalCatalogEntry {
  readonly principal?: string | undefined;
  readonly toolIds: readonly string[];
}

export interface AgentToolAuthority {
  /** The seeded user id for a catalog principal slug, or null when no row exists (the run is then denied). */
  resolvePrincipal(slug: string): Promise<string | null>;
  /** Guard dependencies. `runAs` is supplied by the provider, which owns the ExecutionScope. */
  readonly guardDeps: Omit<GuardDeps, "runAs">;
  /** Scopes a role may name. */
  readonly declaredScopes: readonly string[];
  /** The declared kind of every scope (it picks the resource, the approver and the page the approval link opens). */
  readonly scopeKinds: Readonly<Record<string, ToolRequires["kind"]>>;
  /** Turn a NODE row ON: approve a pending ask, or grant one of this node's AI directly. `me.admin` is the admin session (ONE_GATE). */
  grantRole(
    input: PrincipalRef & { scope: string; me: ApprovalCaller }
  ): Promise<{ principalUserId: string; created: boolean }>;
  /** Turn a live NODE row OFF. */
  revokeRole(
    input: PrincipalRef & { scope: string; me: ApprovalCaller }
  ): Promise<{ principalUserId: string; revoked: boolean }>;
  /** Dismiss a pending NODE ask (the agent then sees `denied`). */
  denyRequest(
    input: PrincipalRef & { scope: string; me: ApprovalCaller }
  ): Promise<{ principalUserId: string; denied: boolean }>;
  /** An outside agent asks for a node scope for itself (a pending row, no approver). Idempotent; throws AgentRolesError on a bad scope or too many asks. */
  requestAccess(input: { principalUserId: string; scope: string }): Promise<AskOutcome>;
  /** The waiting ask a link token opens on this page's resource, as a table row; null for any unusable token (one non-disclosing answer). */
  previewAsk(input: { token: string; resource: GrantResource }): Promise<NodeAiPermissionView | null>;
  /** True when `name` matches (case, spacing and look-alike forms ignored) any user's name or any of this node's AI slugs. Used at registration. */
  nameTaken(name: string): Promise<boolean>;
  /** Registration: one transaction writes the user and its external `agent_principals` row. No wallet, no grant. */
  registerAgent(input: { userId: string; name: string }): Promise<void>;
  /** `org` for an org's user, `agent` for any other `agent_principals` row, else `human` (KIND_IS_THE_ROW). */
  principalKind(userId: string): Promise<PrincipalKind>;
  /** The wallets bound to this user (`user_bindings`, provider `wallet`), for the self-check (`/api/v1/agent/me`). */
  boundWallets(userId: string): Promise<string[]>;
  /** The agent's own rows by state. */
  listOwnAccess(
    principalUserId: string
  ): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>>;
  /** The admin table: one row per node grant row, in three blocks. Name and description come from the declarations only. */
  listNodeAi(): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** The one admin check: the tool guard, the admin mint and `/api/v1/agent/me` all use it. */
  readonly adminCheck: AdminCheck;
}

/** Wallet-bound admin check: any bound wallet that is a node admin passes. */
export function createAdminCheck(sql: SqlTag, nodeAdmin: NodeAdminAuthority): AdminCheck {
  return async (subjectUserId) => {
    const rows = (await sql`
      SELECT external_id FROM user_bindings
      WHERE user_id = ${subjectUserId} AND provider = 'wallet'
      ORDER BY external_id LIMIT 20`) as ReadonlyArray<{ external_id: string }>;
    if (rows.length === 0) {
      // No wallet is denied; but report an unconfigured node as unavailable, never as a plain deny.
      const probe = await nodeAdmin.check({ userId: subjectUserId });
      return !probe.ok && probe.errorCode === "authz_unavailable" ? "unavailable" : "denied";
    }
    for (const row of rows) {
      const decision = await nodeAdmin.check({ userId: subjectUserId, walletAddress: row.external_id });
      if (decision.ok) return "allow";
      if (decision.errorCode === "authz_unavailable") return "unavailable";
    }
    return "denied";
  };
}

/** Outside-agent rows the admin read returns at most (pending asks first). The rest are counted, not sent. */
export const MAX_ADMIN_OUTSIDE_ROWS = 100;

export function createAgentToolAuthority(deps: {
  sql: AgentAuthoritySql;
  nodeAdmin: NodeAdminAuthority;
  log: Logger;
  /** Every tool contract this node can run: the one source of the permission catalog. */
  toolBundle: readonly PermissionBoundTool[];
  /** The graph catalogs whose entries name an internal AI and its tools: which of this node's AI may use which scope. */
  principalCatalog: readonly PrincipalCatalogEntry[];
}): AgentToolAuthority {
  const requiresById = buildRequiresById(deps.toolBundle);
  // Declared once, shown everywhere: one derivation feeds the role routes, the ask door and agent discovery.
  const { declarations, scopeKinds, declaredScopes, askableScopes } = buildPermissionCatalog(requiresById);
  const adminCheck = createAdminCheck(deps.sql, deps.nodeAdmin);

  // One transaction per call, so a role read sees one consistent snapshot. A failure that is not a domain refusal is logged HERE, once,
  // with its class (name, SQLSTATE, constraint, table, column; never a message): the callers turn it into a quiet `authz_unavailable`.
  const withStore: WithStore = async (fn) => {
    try {
      return await deps.sql.begin((tx) => fn(createPostgresAgentGrantsStore(tx)));
    } catch (error) {
      if (!(error instanceof AgentRolesError))
        deps.log.error(
          { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.authority.store", ...failureFields(error) },
          EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
        );
      throw error;
    }
  };

  // The guard only reads. A pooled connection can die on the network path, so a guard read that loses its connection runs once more
  // on a fresh one before it fails closed.
  const withStoreRead: WithStore = (fn) =>
    withStore(fn).catch((error: unknown) => {
      if (isConnectionLoss(error)) return withStore(fn);
      throw error;
    });

  const principalRef = (input: PrincipalRef) =>
    input.principalSlug !== undefined
      ? { principalSlug: input.principalSlug }
      : { principalUserId: input.principalUserId as string };

  return {
    resolvePrincipal: (slug) => withStore((store) => resolveInternalPrincipal(store, slug)),
    guardDeps: {
      withStore: withStoreRead,
      adminCheck,
      onDecision: (event) => {
        const level = event.decision === "allow" ? "info" : "warn";
        deps.log[level]({ event: EVENT_NAMES.AGENT_TOOL_AUTHZ, ...event }, EVENT_NAMES.AGENT_TOOL_AUTHZ);
      },
    },
    scopeKinds,
    declaredScopes,
    adminCheck,
    async listNodeAi() {
      // Which scopes each of this node's AI may use comes from the contracts of every tool its graphs list. NODE scopes only: an account
      // scope is the person's (Poly's own account grants), and the admin table never shows account rows.
      const scopesByPrincipal = scopesByPrincipalOf(deps.principalCatalog, requiresById, "node");
      const { internal, listed } = await withStore(async (store) => ({
        internal: await store.listInternalPrincipals(),
        listed: await store.listRoleRows(MAX_ADMIN_OUTSIDE_ROWS),
      }));
      return {
        permissions: buildNodeAiView({ declarations, scopesByPrincipal, internal, rows: listed.rows }),
        more: listed.more,
      };
    },
    async grantRole(input) {
      const result = await withStore((store) => grantRole(store, { ...input, declaredScopes, scopeKinds }));
      if (result.created)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_GRANTED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            approvedBy: input.me.userId,
          },
          EVENT_NAMES.AGENT_ROLE_GRANTED
        );
      return result;
    },
    async revokeRole(input) {
      const result = await withStore((store) =>
        revokeRole(store, { ...principalRef(input), scope: input.scope, me: input.me, scopeKinds })
      );
      if (result.revoked)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_REVOKED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            revokedBy: input.me.userId,
          },
          EVENT_NAMES.AGENT_ROLE_REVOKED
        );
      return result;
    },
    async denyRequest(input) {
      const result = await withStore((store) =>
        denyRequest(store, { ...principalRef(input), scope: input.scope, me: input.me, scopeKinds })
      );
      if (result.denied)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_DENIED,
            principalUserId: result.principalUserId,
            scope: input.scope,
            resource: "node",
            deniedBy: input.me.userId,
          },
          EVENT_NAMES.AGENT_ROLE_DENIED
        );
      return result;
    },
    async requestAccess(input) {
      const result = await withStore((store) =>
        requestAccess(store, { ...input, declaredScopes, askableScopes, scopeKinds })
      );
      if (result.created)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_REQUESTED,
            principalUserId: input.principalUserId,
            scope: input.scope,
            resource: scopeKinds[input.scope] === "account" ? "account" : "node",
          },
          EVENT_NAMES.AGENT_ROLE_REQUESTED
        );
      return result;
    },
    async previewAsk({ token, resource }) {
      const ask = await withStore((store) => previewAsk(store, { token, resource }));
      return ask ? buildAskView(ask, declarations) : null;
    },
    async nameTaken(name) {
      const key = agentNameKey(name);
      if (!key) return true;
      // POSIX classes, not \s: a tagged template cooks backslashes away. This node's AI are identified by slug (their users row
      // carries the slug as its name too), so comparing against both covers them.
      const rows = await deps.sql`
        SELECT 1 AS taken FROM users
        WHERE lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = ${key}
        UNION ALL
        SELECT 1 AS taken FROM agent_principals
        WHERE lower(regexp_replace(btrim(slug), '[[:space:]]+', ' ', 'g')) = ${key}
        LIMIT 1`;
      return rows.length > 0;
    },
    async registerAgent({ userId, name }) {
      await deps.sql.begin(async (tx) => {
        await tx`INSERT INTO users (id, name) VALUES (${userId}, ${name})`;
        await writeExternalPrincipal(tx, userId);
      });
    },
    principalKind: (userId) => principalKindOf(deps.sql, userId),
    async boundWallets(userId) {
      const rows = (await deps.sql`
        SELECT external_id FROM user_bindings
        WHERE user_id = ${userId} AND provider = 'wallet'
        ORDER BY external_id LIMIT 20`) as ReadonlyArray<{ external_id: string }>;
      return rows.map((row) => row.external_id);
    },
    listOwnAccess: (principalUserId) => withStore((store) => listOwnAccess(store, principalUserId)),
  };
}

/** postgres.js codes for a connection that ended under a query; the transaction did not commit. */
const CONNECTION_LOSS_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);
function isConnectionLoss(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    CONNECTION_LOSS_CODES.has(String((error as { code?: unknown }).code))
  );
}
