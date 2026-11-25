// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-authority`
 * Purpose: This node's wiring of `@cogni-dao/agent-grants`: principal lookup, the guard's store and admin check,
 *   the decision log, and the role grant/revoke the admin route calls.
 * Scope: Composition only. Takes the service-role (BYPASSRLS) postgres.js client from the container: `agent_roles` and
 *   `agent_principals` are deny-all for the app role. Does not decide anything itself (ONE_AUTHORIZE_FN lives in the package).
 * Invariants:
 *   - ADMIN_FROM_USER_BINDINGS: the human's wallet(s) come from `user_bindings` (provider = wallet), never from the
 *     request. Any bound admin wallet passes; no wallet is denied; no configured admins is unavailable.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE (a payout guard, not an authority rule): an agent may bind a wallet (`/api/v1/identity/wallet/bind`), so it can pass
 *     `adminCheck` when the DAO lists that wallet (AUTHORITY_IS_NOT_KIND). Claimant resolution skips agent-owned wallets and the database refuses a payout leaf for one.
 *   - DECLARED_SCOPES_FROM_CONTRACTS: the scopes a role may name are exactly those the node's tool contracts declare.
 *   - NO_SECRETS_IN_LOGS: `agent_tool.authz` carries ids, tool, decision and code only.
 * Side-effects: IO (service-role database reads and writes)
 * Links: packages/agent-grants, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import {
  type AdminCheck,
  type ApprovalCaller,
  agentNameKey,
  type AskOutcome,
  type AuthzDecision,
  authorizeCaller,
  buildAskView,
  ROUTE_ONLY_CAPABILITIES,
  type AuthzEvent,
  AgentRolesError,
  createPostgresAgentGrantsStore,
  createPostgresPayerBindingStore,
  buildNodeAiView,
  decidePayerBinding,
  payerFor,
  requestPayerBinding,
  revokePayerBinding,
  type GuardDeps,
  type GrantResource,
  denyRequest,
  grantRole,
  listMine,
  listOwnAccess,
  type PrincipalRef,
  previewAsk,
  type PrincipalKind,
  principalKindOf,
  type PrincipalClass,
  classifyPrincipal,
  requestAccess,
  type RoleState,
  type NodeAiPermissionView,
  resolveInternalPrincipal,
  revokeRole,
  scopesByPrincipalOf,
  turnMineOff,
  turnMineOn,
  type SqlTag,
  type ToolRequires,
  type WithStore,
  writeExternalPrincipal,
} from "@cogni/agent-grants";
import {
  findServicePrincipal,
  requestServiceAccess,
  type VerifiedServiceAssertion,
} from "@cogni/agent-grants/service-auth";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared/constants";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import type { Logger } from "pino";
import { EVENT_NAMES, failureFields } from "@/shared/observability";
import { buildPermissionCatalog, buildRequiresById, type PermissionBoundTool } from "./agent-permissions";

/** The slice of a graph catalog entry that names its internal AI and the tools it lists. */
export interface PrincipalCatalogEntry {
  readonly principal?: string | undefined;
  readonly toolIds: readonly string[];
}

/** The service-role postgres.js client (`serviceDb.$client`): a tagged template that can also open a transaction. */
export interface AgentAuthoritySql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
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
  /**
   * An agent asks for a scope for itself (a pending row, no approver) and gets one one-time link path, picked by the scope's declared kind.
   * Idempotent: a waiting row is reported and its link rotated. Throws AgentRolesError on a bad scope or too many asks.
   */
  requestAccess(input: {
    principalUserId: string;
    scope: string;
  }): Promise<AskOutcome>;
  /** The waiting ask a link token opens on this page's resource, as a table row; null for any unusable token (one non-disclosing answer). */
  previewAsk(input: { token: string; resource: GrantResource }): Promise<NodeAiPermissionView | null>;
  /**
   * The profile table for ONE person: the live account rows on their own account (this node's AI and outside agents), this node's AI Off until On,
   * and no node rows. An account that does not exist yet lists no rows.
   */
  listMine(userId: string): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** The person turns an ACCOUNT row On: an outside AI's ask by its token, or this node's AI directly. The person's account is created if absent. */
  turnMineOn(
    me: ApprovalCaller,
    input:
      | { token: string; accountId?: string | undefined }
      | { principalUserId: string; scope: string }
  ): Promise<{ changed: boolean }>;
  /** The person turns a live ACCOUNT row Off by id, or dismisses a waiting ask by its token (with `accountId`, for an org account the person co-owns). */
  turnMineOff(me: ApprovalCaller, input: { rowId: string } | { token: string; accountId?: string | undefined }): Promise<{ changed: boolean }>;
  /**
   * PAYER_IS_AUTHORIZED: a subject (any principal) asks to be billed to `billingAccountId`. Grants nothing. Throws AgentRolesError (`principal_not_found`,
   * `not_allowed` when a live binding must be turned Off first, `too_many_requests`).
   */
  requestPayerBinding(subjectUserId: string, billingAccountId: string): Promise<{ id: string; state: "pending" | "live"; created: boolean }>;
  /** An owner of the account turns a pending binding On (`approve`) or dismisses it. */
  decidePayerBinding(me: ApprovalCaller, id: string, approve: boolean): Promise<{ changed: boolean }>;
  /** An owner of the account turns a binding Off. The subject's next run falls back to its own account. */
  revokePayerBinding(me: ApprovalCaller, id: string): Promise<{ changed: boolean }>;
  /** The account a live binding names for this subject, or null. Read on every call, never cached, so Off refuses the next run. */
  payerFor(subjectUserId: string): Promise<string | null>;
  /**
   * True when `name` matches (case, spacing and look-alike forms ignored) any user's name or any of this node's AI slugs. Used at
   * registration so an outside agent cannot take a name that looks like this node's AI on the screen where an admin says yes.
   */
  nameTaken(name: string): Promise<boolean>;
  /**
   * Registration (REGISTRATION_WRITES_THE_PRINCIPAL): one transaction writes the user and its external `agent_principals` row, so a
   * registered AI is never a user without a kind. No wallet, no grant (REGISTRATION_GRANTS_NOTHING).
   */
  registerAgent(input: { userId: string; name: string }): Promise<void>;
  /** `org` for an org's user, `agent` for any other `agent_principals` row, else `human` (KIND_IS_THE_ROW). */
  principalKind(userId: string): Promise<PrincipalKind>;
  /** The principal of a verified service assertion, or null until that service has asked (a call before the ask is a 401). */
  servicePrincipalOf(assertion: Pick<VerifiedServiceAssertion, "issuer" | "service">): Promise<string | null>;
  /**
   * A verified service's ask: creates or reuses its ONE principal and writes ONE pending ask for `scope`. Nothing is granted; an admin turns it On.
   * Throws AgentRolesError for a scope outside the assertion, an undeclared or unaskable scope, or too many open asks.
   */
  requestServiceAccess(assertion: VerifiedServiceAssertion, scope: string): Promise<AskOutcome>;
  /** The one classifier of a write's actor: internal, external, human, system (the node's `cogni_system` principal) or unclassified (task.0133). */
  principalClass(userId: string): Promise<PrincipalClass>;
  /** The wallets bound to this user (`user_bindings`, provider `wallet`), for the self-check (`/api/v1/agent/me`). */
  boundWallets(userId: string): Promise<string[]>;
  /** The agent's own rows by state. */
  listOwnAccess(
    principalUserId: string
  ): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>>;
  /**
   * The admin table: one row per grant row, in three blocks. Name and description come from the declarations only.
   * Outside rows are bounded (`MAX_ADMIN_OUTSIDE_ROWS`); `more` counts the ones cut.
   */
  listNodeAi(): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** The same admin check the guard uses, for the role routes. */
  readonly adminCheck: AdminCheck;
  /**
   * SAME_DOOR: the route twin of a guarded tool. A bearer caller is its own principal and needs a live role row; a human
   * session passes the subject rules. Logs `agent_tool.authz` with the route id. A tool with no declared `requires` is denied.
   */
  authorizeRoute(input: {
    toolId: string;
    routeId: string;
    userId: string;
    via: "bearer" | "session";
    /** The account the route names. Required for an account-kind tool. */
    accountId?: string;
  }): Promise<AuthzDecision>;
}

/** Wallet-bound admin check: any bound wallet that is a node admin passes. */
export function createAdminCheck(
  sql: SqlTag,
  nodeAdmin: NodeAdminAuthority
): AdminCheck {
  return async (subjectUserId) => {
    const rows = (await sql`
      SELECT external_id FROM user_bindings
      WHERE user_id = ${subjectUserId} AND provider = 'wallet'
      ORDER BY external_id LIMIT 20`) as ReadonlyArray<{
      external_id: string;
    }>;
    if (rows.length === 0) {
      // No wallet is denied; but report an unconfigured node as unavailable, never as a plain deny.
      const probe = await nodeAdmin.check({ userId: subjectUserId });
      return !probe.ok && probe.errorCode === "authz_unavailable"
        ? "unavailable"
        : "denied";
    }
    for (const row of rows) {
      const decision = await nodeAdmin.check({
        userId: subjectUserId,
        walletAddress: row.external_id,
      });
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
  /** The id of the billing account this person owns, created on first use. A person who never opened credits has none until they decide a grant. */
  ensureBillingAccount?: (userId: string) => Promise<string>;
}): AgentToolAuthority {
  const requiresById = buildRequiresById(deps.toolBundle);
  // Declared once, shown everywhere: one derivation feeds the role routes, the ask door and agent discovery.
  const { declarations, scopeKinds, declaredScopes, askableScopes } =
    buildPermissionCatalog(requiresById);
  // Which scopes each of this node's AI may use is the package's helper over this node's catalog: node scopes feed the admin table, account scopes the profile.
  const scopesOf = (plane: "account" | "node") =>
    scopesByPrincipalOf(deps.principalCatalog, requiresById, plane);
  const adminCheck = createAdminCheck(deps.sql, deps.nodeAdmin);

  // One transaction per call, so a role read sees one consistent snapshot. A failure that is not a domain refusal is logged HERE, once, with its class (name,
  // SQLSTATE, constraint, table, column; never a message), because the callers that follow (the tool guard, the route door, a route catch) turn it into a quiet
  // `authz_unavailable`: without this line a broken store is a 503 with nothing in Loki.
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

  // The guard only reads. A pooled connection can die on the network path (bug.0062), so a guard read that loses its connection
  // runs once more on a fresh one before it fails closed.
  const withStoreRead: WithStore = (fn) =>
    withStore(fn).catch((error: unknown) => {
      if (isConnectionLoss(error)) return withStore(fn);
      throw error;
    });

  const onDecision = (event: AuthzEvent): void => {
    const level = event.decision === "allow" ? "info" : "warn";
    deps.log[level](
      { event: EVENT_NAMES.AGENT_TOOL_AUTHZ, ...event },
      EVENT_NAMES.AGENT_TOOL_AUTHZ
    );
  };

  return {
    resolvePrincipal: (slug) => withStore((store) => resolveInternalPrincipal(store, slug)),
    guardDeps: { withStore: withStoreRead, adminCheck, onDecision },
    scopeKinds,
    async listNodeAi() {
      // The scopes each AI may use come from the contracts of every tool its graphs list. NODE scopes only: an account scope is the person's,
      // and the admin table never shows account rows.
      const scopesByPrincipal = scopesOf("node");
      const { internal, listed } = await withStore(async (store) => ({
        internal: await store.listInternalPrincipals(),
        listed: await store.listRoleRows(MAX_ADMIN_OUTSIDE_ROWS),
      }));
      return {
        permissions: buildNodeAiView({ declarations, scopesByPrincipal, internal, rows: listed.rows }),
        more: listed.more,
      };
    },
    declaredScopes,
    adminCheck,
    async authorizeRoute({ toolId, routeId, userId, via, accountId }) {
      const requires =
        requiresById[toolId] ?? ROUTE_ONLY_CAPABILITIES[toolId]?.requires;
      const decision: AuthzDecision = !requires
        ? { decision: "deny", code: "policy_denied", reason: "no_requires" }
        : await withStore((store) =>
            authorizeCaller(store, adminCheck, { userId, via, requires, accountId, owners: undefined })
          ).catch(
            (): AuthzDecision => ({
              decision: "deny",
              code: "authz_unavailable",
              reason: "store_unavailable",
            })
          );
      onDecision({
        principal: via === "bearer" ? userId : null,
        subject: via === "session" ? userId : null,
        payer: null,
        tool: toolId,
        decision: decision.decision,
        code: decision.decision === "allow" ? "allowed" : decision.code,
        reason: decision.decision === "allow" ? decision.basis : decision.reason,
        runId: null,
        route: routeId,
        account: accountId ?? null,
      });
      return decision;
    },
    async grantRole(input) {
      const result = await withStore((store) =>
        grantRole(store, { ...input, declaredScopes, scopeKinds })
      );
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
        revokeRole(store, {
          ...(input.principalSlug !== undefined
            ? { principalSlug: input.principalSlug }
            : { principalUserId: input.principalUserId as string }),
          scope: input.scope,
          me: input.me,
          scopeKinds,
        })
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
        denyRequest(store, {
          ...(input.principalSlug !== undefined
            ? { principalSlug: input.principalSlug }
            : { principalUserId: input.principalUserId as string }),
          scope: input.scope,
          me: input.me,
          scopeKinds,
        })
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
    listMine: (userId) =>
      withStore((store) => listMine(store, { userId, declarations, scopesByPrincipal: scopesOf("account") })),
    async turnMineOn(me, input) {
      // The orchestration (validate, then ensure the person's account, then decide) is the package's; this wrapper only wires the account hook and logs.
      const result = await withStore((store) =>
        turnMineOn(store, { me, on: input, declaredScopes, scopeKinds, ensureAccount: deps.ensureBillingAccount, owners: undefined })
      );
      if (result.changed)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_GRANTED,
            resource: "account",
            via: result.via,
            ...(result.principalUserId ? { principalUserId: result.principalUserId, scope: result.scope } : {}),
            approvedBy: me.userId,
          },
          EVENT_NAMES.AGENT_ROLE_GRANTED
        );
      return { changed: result.changed };
    },
    async turnMineOff(me, input) {
      const result = await withStore((store) => turnMineOff(store, { me, off: input, owners: undefined }));
      if (result.changed)
        deps.log.info(
          result.via === "row"
            ? { event: EVENT_NAMES.AGENT_ROLE_REVOKED, resource: "account", revokedBy: me.userId }
            : { event: EVENT_NAMES.AGENT_ROLE_DENIED, resource: "account", via: "link", deniedBy: me.userId },
          result.via === "row" ? EVENT_NAMES.AGENT_ROLE_REVOKED : EVENT_NAMES.AGENT_ROLE_DENIED
        );
      return { changed: result.changed };
    },
    async requestPayerBinding(subjectUserId, billingAccountId) {
      const outcome = await deps.sql.begin((tx) =>
        requestPayerBinding(createPostgresPayerBindingStore(tx), { subjectUserId, billingAccountId })
      );
      return { id: outcome.id, state: outcome.state, created: outcome.created };
    },
    async decidePayerBinding(me, id, approve) {
      const result = await deps.sql.begin((tx) =>
        decidePayerBinding(createPostgresPayerBindingStore(tx), createPostgresAgentGrantsStore(tx), {
          me,
          id,
          approve,
        })
      );
      if (result.decided)
        deps.log.info(
          {
            event: approve ? EVENT_NAMES.PAYER_BOUND : EVENT_NAMES.PAYER_REVOKED,
            subject: result.subjectUserId,
            billingAccountId: result.billingAccountId,
            ...(approve ? { approvedBy: me.userId } : { revokedBy: me.userId }),
          },
          approve ? EVENT_NAMES.PAYER_BOUND : EVENT_NAMES.PAYER_REVOKED
        );
      return { changed: result.decided };
    },
    async revokePayerBinding(me, id) {
      const result = await deps.sql.begin((tx) =>
        revokePayerBinding(createPostgresPayerBindingStore(tx), createPostgresAgentGrantsStore(tx), {
          me,
          id,
        })
      );
      if (result.revoked)
        deps.log.info(
          {
            event: EVENT_NAMES.PAYER_REVOKED,
            subject: result.subjectUserId,
            billingAccountId: result.billingAccountId,
            revokedBy: me.userId,
          },
          EVENT_NAMES.PAYER_REVOKED
        );
      return { changed: result.revoked };
    },
    payerFor: (subjectUserId) => payerFor(createPostgresPayerBindingStore(deps.sql), subjectUserId),
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
    servicePrincipalOf: (assertion) => findServicePrincipal(deps.sql, assertion),
    async requestServiceAccess(assertion, scope) {
      const { userId, outcome } = await deps.sql.begin((tx) =>
        requestServiceAccess({
          tx,
          store: createPostgresAgentGrantsStore(tx),
          assertion,
          scope,
          declaredScopes,
          askableScopes,
          scopeKinds,
        })
      );
      if (outcome.created)
        deps.log.info(
          {
            event: EVENT_NAMES.AGENT_ROLE_REQUESTED,
            principalUserId: userId,
            scope,
            resource: scopeKinds[scope] === "account" ? "account" : "node",
          },
          EVENT_NAMES.AGENT_ROLE_REQUESTED
        );
      return outcome;
    },
    principalClass: (userId) =>
      classifyPrincipal(deps.sql, userId, [COGNI_SYSTEM_PRINCIPAL_USER_ID]),
    async boundWallets(userId) {
      const rows = (await deps.sql`
        SELECT external_id FROM user_bindings
        WHERE user_id = ${userId} AND provider = 'wallet'
        ORDER BY external_id LIMIT 20`) as ReadonlyArray<{ external_id: string }>;
      return rows.map((row) => row.external_id);
    },
    listOwnAccess: (principalUserId) =>
      withStore((store) => listOwnAccess(store, principalUserId)),
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
