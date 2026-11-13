// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-permissions`
 * Purpose: The one derivation of this node's permission catalog from its declarations. The role routes (`declaredScopes`),
 *   the ask door (`askableScopes`) and agent discovery (`permissions`) all read it. There is no copy table.
 * Scope: Pure. No I/O.
 * Invariants:
 *   - DECLARED_ONCE_SHOWN_EVERYWHERE: every tool contract's `requires` plus every route-only capability is a declaration.
 *     A scope with no label and description is not shown (never raw).
 *   - ASKABLE_IS_REACHABLE: an outside agent can ask only for a scope a route twin uses (`SAME_DOOR_ROUTES`, `ROUTE_ONLY_CAPABILITIES`).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import type { CatalogBoundTool } from "@cogni/ai-tools";
import {
  ROUTE_ONLY_CAPABILITIES,
  SAME_DOOR_ROUTES,
  type ScopeDeclaration,
  type ToolRequires,
} from "@cogni/agent-grants";

export interface PermissionDeclaration {
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}

export interface GrantablePermission {
  readonly scope: string;
  readonly label: string;
  readonly description: string;
  readonly kind: ToolRequires["kind"];
}

export interface PermissionCatalog {
  readonly declarations: Readonly<Record<string, PermissionDeclaration>>;
  readonly declaredScopes: readonly string[];
  readonly askableScopes: readonly string[];
  /** Every declared scope's kind and subject. They decide who approves an ask: the agent's owner (a `member` scope, `account:read`) or a node-admin. */
  readonly scopes: Readonly<Record<string, ScopeDeclaration>>;
  /** Askable scopes with a name and description, by scope. What discovery shows. */
  readonly permissions: readonly GrantablePermission[];
}

/** `requiresById` from the contracts the node already loads. */
export function buildRequiresById(
  bundle: readonly CatalogBoundTool[]
): Record<string, ToolRequires> {
  const byId: Record<string, ToolRequires> = {};
  for (const tool of bundle) {
    if (tool.contract.requires) byId[tool.contract.name] = tool.contract.requires;
  }
  return byId;
}

export function buildPermissionCatalog(
  requiresById: Readonly<Record<string, ToolRequires>>
): PermissionCatalog {
  const requires: Record<string, ToolRequires> = {};
  for (const r of Object.values(requiresById)) requires[r.scope] = r;
  for (const cap of Object.values(ROUTE_ONLY_CAPABILITIES))
    requires[cap.requires.scope] = cap.requires;

  const declarations: Record<string, PermissionDeclaration> = {};
  for (const r of Object.values(requires))
    declarations[r.scope] = { label: r.label, description: r.description };
  const declaredScopes = Object.keys(declarations).sort();
  const scopes = Object.fromEntries(Object.values(requires).map((r) => [r.scope, { kind: r.kind, subject: r.subject }]));
  // The scopes an outside agent can actually use: a route twin it can call. An ask for any other scope would be an approvable
  // row that opens nothing, so it is refused up front.
  const askableScopes = [
    ...new Set([
      ...Object.values(SAME_DOOR_ROUTES).map((r) => r.scope),
      ...Object.values(ROUTE_ONLY_CAPABILITIES).map((c) => c.requires.scope),
    ]),
  ].sort();
  const permissions = askableScopes.flatMap((scope) => {
    const r = requires[scope];
    return r?.label && r.description
      ? [{ scope, label: r.label, description: r.description, kind: r.kind }]
      : [];
  });
  return { declarations, declaredScopes, askableScopes, scopes, permissions };
}
