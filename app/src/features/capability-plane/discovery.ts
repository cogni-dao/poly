// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane/discovery`
 * Purpose: Project the pure account-read catalog into the machine discovery
 *   document. Method, path, required scope, and both JSON schemas are derived
 *   from the descriptors, so `.well-known/agent.json` cannot drift from the
 *   code an agent actually calls.
 * Scope: Pure projection — no IO, no DB, no auth. The discovery route is a
 *   transport that spreads these maps.
 * Invariants:
 *   - GENERATED_DISCOVERY — no hand-authored input/output schemas. The only
 *     hand-maintained values are the stable public key names, which are keyed
 *     by the catalog's id union so a new capability cannot be published
 *     anonymously or forgotten.
 *   - PUBLIC_KEY_NAMES_ARE_A_CONTRACT — `readCopyTradePnl` / `copyTradePnl`
 *     already ship to registered agents and must keep their names.
 *   - PROJECTION_FAILURE_IS_ISOLATED — one descriptor can never blank the
 *     document for the others. `z.toJSONSchema` throws on anything it cannot
 *     represent (a `.transform()`, most commonly), and this projection is
 *     spread whole into `.well-known/agent.json`, so an unguarded throw took
 *     discovery down for EVERY capability — not just the offending one. That
 *     is how `poly.account.portfolio-snapshot.v1` came to be deliberately held
 *     out of the catalog. Each descriptor is now projected independently.
 *   - SCHEMA_DEGRADES_NEVER_LIES — a schema that cannot be projected in output
 *     mode falls back to input mode, which yields the PRE-transform type (for
 *     an address `.toLowerCase()` that is the same `string`, so it is accurate
 *     rather than merely permissive). Only if both modes fail is the schema
 *     omitted — the capability still publishes its method, path and scope, so
 *     it stays callable and discoverable. We never emit a fabricated schema.
 * Side-effects: none
 * Links: task.1791070961, app/src/app/.well-known/agent.json/route.ts
 * @public
 */

import {
  type AccountReadOperation,
  POLY_ACCOUNT_READ_OPERATIONS,
  type PolyAccountReadOperationId,
} from "@cogni/poly-node-contracts";
import { z } from "zod";

/** Stable public names for each capability in the discovery document. */
const DISCOVERY_NAMES: Record<
  PolyAccountReadOperationId,
  { action: string; endpoint: string }
> = {
  "poly.research-copy-trade-pnl.v1": {
    action: "readCopyTradePnl",
    endpoint: "copyTradePnl",
  },
  "poly.research-copy-trade-investigation.v1": {
    action: "readCopyTradeInvestigation",
    endpoint: "copyTradeInvestigation",
  },
  "poly.research-copy-trade-investigation-evidence.v1": {
    action: "readCopyTradeInvestigationEvidence",
    endpoint: "copyTradeInvestigationEvidence",
  },
  // task.1791070959 — copy-operations reads. These entries are REQUIRED, not
  // optional: `DISCOVERY_NAMES` is keyed by the catalog's id union, so adding a
  // descriptor without naming it here is a compile error. That is the
  // GENERATED_DISCOVERY invariant doing its job — a capability cannot ship
  // unpublished.
  "poly.account.copy-setup.v1": {
    action: "readCopySetup",
    endpoint: "copySetup",
  },
  "poly.account.recent-attempts.v1": {
    action: "readRecentAttempts",
    endpoint: "recentAttempts",
  },
  "poly.copy-trade.orders.v1": {
    action: "readCopyTradeOrders",
    endpoint: "copyTradeOrders",
  },
  // task.1791070962 — the portfolio snapshot, the capability the parity
  // inventory calls the flagship read. Published now that an unprojectable
  // output degrades instead of blanking the document.
  "poly.account.portfolio-snapshot.v1": {
    action: "readPortfolioSnapshot",
    endpoint: "portfolioSnapshot",
  },
};

export type AccountReadDiscoveryAction = {
  method: AccountReadOperation["method"];
  endpoint: string;
  summary: string;
  auth: { type: "bearer"; requiredScope: AccountReadOperation["requiredScope"] };
  /** Omitted only when neither projection mode can represent the schema. */
  inputSchema?: unknown;
  outputSchema?: unknown;
};

/**
 * Project one zod schema to JSON Schema, degrading rather than throwing.
 *
 * Output mode is tried first because it describes what the caller actually
 * receives. It throws on an unrepresentable node — Zod's default is
 * `unrepresentable: "throw"` — so we fall back to input mode, which projects
 * the pre-transform type. Deliberately NOT `unrepresentable: "any"`: that
 * silently emits `{}` for the offending node, which is a lossy schema
 * masquerading as a complete one.
 */
export function projectSchema(
  schema: AccountReadOperation["input"]
): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    try {
      return z.toJSONSchema(schema, { io: "input" });
    } catch {
      return undefined;
    }
  }
}

/** `actions` entries for every account read, projected from the descriptors. */
export function accountReadDiscoveryActions(
  origin: string
): Record<string, AccountReadDiscoveryAction> {
  const actions: Record<string, AccountReadDiscoveryAction> = {};
  for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
    // PROJECTION_FAILURE_IS_ISOLATED: a descriptor that cannot be projected
    // loses only its own schemas, never the whole document.
    const inputSchema = projectSchema(operation.input);
    const outputSchema = projectSchema(operation.output);
    actions[DISCOVERY_NAMES[operation.id].action] = {
      method: operation.method,
      endpoint: `${origin}${operation.path}`,
      summary: operation.summary,
      auth: { type: "bearer", requiredScope: operation.requiredScope },
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
  }
  return actions;
}

/** `endpoints` entries for every account read, projected from the descriptors. */
export function accountReadDiscoveryEndpoints(
  origin: string
): Record<string, string> {
  const endpoints: Record<string, string> = {};
  for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
    endpoints[DISCOVERY_NAMES[operation.id].endpoint] =
      `${origin}${operation.path}`;
  }
  return endpoints;
}
