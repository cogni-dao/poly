// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node-local composition of the published grants store for shared programs. */
import {
  type AdminCheck,
  createPostgresAgentGrantsStore,
  type GuardDeps,
  resolveInternalPrincipal,
  type SqlTag,
  type WithStore,
} from "@cogni/agent-grants";
import type { NodeAdminAuthority } from "@cogni-dao/knowledge-store";
import type { Logger } from "pino";

export interface AgentAuthoritySql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
}

export function createSharedAgentAuthority(
  sql: AgentAuthoritySql,
  nodeAdmin: NodeAdminAuthority,
  log: Logger,
) {
  const withStore: WithStore = async (fn) => {
    let operation = "other";
    try {
      return await sql.begin((tx) => {
        const store = createPostgresAgentGrantsStore(tx);
        return fn({
          ...store,
          findInternalPrincipal: (...args) => {
            operation = "findInternalPrincipal";
            return store.findInternalPrincipal(...args);
          },
          liveScopes: (...args) => {
            operation = "liveScopes";
            return store.liveScopes(...args);
          },
          liveAccountScopes: (...args) => {
            operation = "liveAccountScopes";
            return store.liveAccountScopes(...args);
          },
          hasLiveRole: (...args) => {
            operation = "hasLiveRole";
            return store.hasLiveRole(...args);
          },
          hasLiveAccountGrant: (...args) => {
            operation = "hasLiveAccountGrant";
            return store.hasLiveAccountGrant(...args);
          },
        });
      });
    } catch (error) {
      // Do not log SQL messages or values. Retain the class and SQLSTATE to diagnose missing schema.
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      // PostgreSQL's undefined-column message contains the identifier, not a
      // value. Only expose columns from the released authority lookup contract.
      const columns = new Set([
        "principal_user_id",
        "scope",
        "resource",
        "approved_by",
        "revoked_at",
        "account_id",
        "expires_at",
      ]);
      const missing =
        code === "42703" && error instanceof Error
          ? /column (?:[a-z_]+\.)?"?([a-z_]+)"? does not exist/i.exec(
              error.message,
            )?.[1]
          : undefined;
      const missingColumn =
        missing && columns.has(missing) ? missing : undefined;
      log.error(
        {
          event: "agent_authority.store_unavailable",
          operation,
          errorName: error instanceof Error ? error.name : "unknown",
          ...(code && { code }),
          ...(missingColumn && { missingColumn }),
        },
        "agent authority store unavailable",
      );
      throw error;
    }
  };
  const adminCheck: AdminCheck = async (userId) => {
    const rows =
      (await sql`SELECT external_id FROM user_bindings WHERE user_id = ${userId} AND provider = 'wallet' ORDER BY external_id LIMIT 20`) as ReadonlyArray<{
        external_id: string;
      }>;
    if (!rows.length) {
      const result = await nodeAdmin.check({ userId });
      return !result.ok && result.errorCode === "authz_unavailable"
        ? "unavailable"
        : "denied";
    }
    for (const row of rows) {
      const result = await nodeAdmin.check({
        userId,
        walletAddress: row.external_id,
      });
      if (result.ok) return "allow";
      if (result.errorCode === "authz_unavailable") return "unavailable";
    }
    return "denied";
  };
  const guardDeps: Omit<GuardDeps, "runAs"> = {
    withStore,
    adminCheck,
    onDecision: (decision) =>
      log.info(
        { event: "agent_tool.authz", ...decision },
        "agent tool authorization",
      ),
  };
  return {
    guardDeps,
    resolvePrincipal: (slug: string) =>
      withStore((store) => resolveInternalPrincipal(store, slug)),
  };
}
