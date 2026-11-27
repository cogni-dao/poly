// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected service-role client).
 * Invariants:
 *   - An internal principal row points at a seeded `users` row that has no credential.
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_roles` has ENABLE + FORCE RLS and one narrow select policy (an account row naming the
 *     connection's own user as principal); no write policy. `agent_principals` is readable by every role and writable only by a
 *     BYPASSRLS service connection. FORCE is added by hand in the migration (package SQL tail).
 *   - ONE_GRANT_PLANE: an account grant is one `agent_roles` row (`resource = 'account'`); Poly's own `agent_capability_grants` plane is gone (migration 0093).
 *   - No `agent_credentials`, `payer_bindings`, orgs or service-auth tables here: those join in a later PR.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { defineAgentAuthoritySchema } from "@cogni/agent-grants/schema";

import { billingAccounts, users } from "./refs";

/** `agent_principals` and `agent_roles` come from `@cogni/agent-grants/schema` over this node's own `users` and `billing_accounts`; `db:generate` writes their migration. */
export const { agentPrincipals, agentRoles } = defineAgentAuthoritySchema({
  users,
  billingAccounts,
});
