// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/constants/agent-principals`
 * Purpose: Seeded internal agent principals: the users graphs act as (catalog slug -> user id).
 * Scope: Deterministic UUIDs and slugs. Does not contain authorization logic.
 * Invariants: IDs match the rows seeded by migration 0037_seed_agent_principals.sql. Each user has no wallet
 *   and no credential (AGENTS_HOLD_NO_WALLET, a payout guard), so no user-centric payout reaches it.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

/** `node-ai`: the general node agent (brain). */
export const NODE_AI_PRINCIPAL_SLUG = "node-ai" as const;
export const NODE_AI_PRINCIPAL_USER_ID =
  "00000000-0000-4000-a000-0000000a0001" as const;

/** `prioritizer`: the mission-loop scorer (work-prioritizer). */
export const PRIORITIZER_PRINCIPAL_SLUG = "prioritizer" as const;
export const PRIORITIZER_PRINCIPAL_USER_ID =
  "00000000-0000-4000-a000-0000000a0002" as const;
