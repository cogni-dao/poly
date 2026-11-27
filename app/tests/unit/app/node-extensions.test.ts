// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/node-extensions`
 * Purpose: Prove Poly's node composition root (`app/src/node-extensions.ts`) over the REAL shared catalog: the quant reads ride the baseline `account:read`
 *   grant, the composition adds only (empty module = baseline unchanged), and the package's SAME_DOOR parity suite passes over Poly's composed set.
 * Scope: Pure composition. No database. Route ids are checked against the real route files.
 * Invariants:
 *   - DECLARE_NEVER_BUILD: Poly declares no scope of its own; `account:read` comes out of the catalog as the one account-kind, owner-approved permission.
 *   - ROUTE_IDS_ARE_REAL: every route id the capability lists is the `routeId` of a route file that serves an account-read operation.
 *   - ORDER_NEVER_CHANGES_THE_RESULT: the composed routes do not depend on key order.
 *   - NODE_OWNS_ITS_PREFIX: the capability id starts with `poly.`.
 * Side-effects: filesystem reads (route files)
 * Links: story.0090, task.0205, https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { composeAgentRoutes } from "@cogni/agent-grants";
import {
  buildPermissionCatalog,
  buildRequiresById,
} from "@cogni/agent-grants/host";
import { runSameDoorParity } from "@cogni/agent-grants/same-door-parity";
import { POLY_ACCOUNT_READ_OPERATIONS } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

import { POLY_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import {
  nodeExtensions,
  POLY_ACCOUNT_READ_CAPABILITY,
  POLY_ACCOUNT_READ_ROUTE_IDS,
} from "@/node-extensions";

const apiRoot = path.resolve(import.meta.dirname, "../../../src/app");
const contracts = POLY_CORE_TOOL_BUNDLE.map((tool) => tool.contract);
const routes = composeAgentRoutes(nodeExtensions.routes);

describe("poly node extensions: the quant read is the shared account:read grant", () => {
  it("declares one route-only capability, prefixed poly., and no scope of its own", () => {
    const capabilities = nodeExtensions.routes?.routeOnlyCapabilities ?? {};
    expect(Object.keys(capabilities)).toEqual([POLY_ACCOUNT_READ_CAPABILITY]);
    expect(POLY_ACCOUNT_READ_CAPABILITY.startsWith("poly.")).toBe(true);
    expect(capabilities[POLY_ACCOUNT_READ_CAPABILITY]?.requires.scope).toBe("account:read");
    expect(nodeExtensions.tools).toBeUndefined();
    expect(nodeExtensions.routes?.sameDoorRoutes).toBeUndefined();
  });

  it("makes account:read declared, account-kind and askable, with the shared words", () => {
    const catalog = buildPermissionCatalog(
      buildRequiresById(contracts.map((contract) => ({ id: contract.name, requires: contract.requires }))),
      nodeExtensions.routes
    );
    expect(catalog.declaredScopes).toContain("account:read");
    expect(catalog.scopeKinds["account:read"]).toBe("account");
    expect(catalog.askableScopes).toContain("account:read");
    const permission = catalog.permissions.find((entry) => entry.scope === "account:read");
    expect(permission?.label).toBe("Read your account data");
  });

  it("keeps every baseline entry and adds only Poly's capability (an empty module changes nothing)", () => {
    const baseline = composeAgentRoutes(undefined);
    expect(Object.keys(routes.sameDoorRoutes)).toEqual(Object.keys(baseline.sameDoorRoutes));
    expect(routes.noRouteTwin).toEqual(baseline.noRouteTwin);
    expect(Object.keys(routes.routeOnlyCapabilities).sort()).toEqual(
      [...Object.keys(baseline.routeOnlyCapabilities), POLY_ACCOUNT_READ_CAPABILITY].sort()
    );
    for (const [key, value] of Object.entries(baseline.routeOnlyCapabilities))
      expect(routes.routeOnlyCapabilities[key]).toEqual(value);
  });

  it("composes the same set whatever the order of the declaration", () => {
    const capability = nodeExtensions.routes?.routeOnlyCapabilities?.[POLY_ACCOUNT_READ_CAPABILITY];
    if (!capability) throw new Error("capability missing");
    const reversed = composeAgentRoutes({
      routeOnlyCapabilities: {
        [POLY_ACCOUNT_READ_CAPABILITY]: { ...capability, routes: [...capability.routes].reverse() },
      },
    });
    expect(
      [...(reversed.routeOnlyCapabilities[POLY_ACCOUNT_READ_CAPABILITY]?.routes ?? [])].sort()
    ).toEqual([...POLY_ACCOUNT_READ_ROUTE_IDS].sort());
  });

  it("lists the routeId of a real route file for every published account-read operation", () => {
    for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
      const file = path.join(apiRoot, operation.path.replace(/^\/api\//, "api/"), "route.ts");
      const source = readFileSync(file, "utf8");
      const ids = [...source.matchAll(/routeId:\s*"([^"]+)"/g)].map((match) => match[1]);
      expect(
        ids.filter((id) => (POLY_ACCOUNT_READ_ROUTE_IDS as readonly string[]).includes(id)),
        `${operation.path} must list one of its routeIds`
      ).toHaveLength(1);
    }
    expect(POLY_ACCOUNT_READ_ROUTE_IDS).toHaveLength(POLY_ACCOUNT_READ_OPERATIONS.length);
  });
});

// The package's SAME_DOOR parity suite over Poly's composed set (task.0205: the node runs it over ITS bundle and ITS routes).
runSameDoorParity({
  describe,
  it,
  expect,
  contracts,
  routes,
  // The package baseline names tools of the node-template bundle that Poly's pinned ai-tools (0.16.0, a train member) does not carry or bind. Each id
  // is listed on purpose; any other baseline or node entry must be a real tool. Adopting the 0.26 train removes this list.
  options: {
    absentBaseline: [
      "core__work_item_update",
      "core__work_item_artifact_record",
      "core__account_credits_read",
    ],
  },
});
