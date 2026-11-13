// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/same-door-routes`
 * Purpose: SAME_DOOR wiring. Every route id in `SAME_DOOR_ROUTES` is declared by an app route that also names its tool
 *   (`routeId: "<id>"` next to `sameDoor: "<toolId>"`), so the map cannot drift from the routes.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFERRED_WRITE_ROUTES, NO_ROUTE_TWIN, OPEN_BY_DESIGN_ROUTES, ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "@cogni/agent-grants";
import { POLY_GRANT_DECLARATION_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "../../../src/app/api");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}
const sources = routeFiles(API).map((f) => readFileSync(f, "utf8"));

const DECLARED: Record<string, { routes: readonly string[] }> = {
  ...SAME_DOOR_ROUTES,
  ...ROUTE_ONLY_CAPABILITIES,
};

// A route the package declares but this node does not ship (poly has no knowledge browse page route). The door is declared once
// in the package; a node without the route has nothing to gate.
const NODE_HAS_NO_ROUTE = new Set(["knowledge.browse"]);

describe("same-door routes", () => {
  for (const [tool, entry] of Object.entries(DECLARED)) {
    for (const routeId of entry.routes.filter((r) => !NODE_HAS_NO_ROUTE.has(r))) {
      it(`${routeId} declares sameDoor: ${tool}`, () => {
        const declared = sources.some((s) =>
          new RegExp(`routeId:\\s*"${routeId.replace(".", "\\.")}",\\s*sameDoor:\\s*"${tool}"`).test(s)
        );
        expect(declared).toBe(true);
      });
    }
  }

  it("no route declares sameDoor for a tool the map does not list", () => {
    const declared = sources.flatMap((s) => [...s.matchAll(/sameDoor:\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const tool of declared) expect(tool && tool in DECLARED, String(tool)).toBe(true);
  });

  it("S4: no route-twin scope is admin-subject until an AI admin check exists (item I2); otherwise any bearer with a role row would pass it", () => {
    const contracts = new Map(POLY_GRANT_DECLARATION_BUNDLE.map((t) => [t.contract.name, t.contract]));
    for (const tool of Object.keys(SAME_DOOR_ROUTES))
      expect(contracts.get(tool)?.requires?.subject, tool).not.toBe("admin");
    for (const [id, cap] of Object.entries(ROUTE_ONLY_CAPABILITIES))
      expect(cap.requires.subject, id).not.toBe("admin");
    // The admin-subject tools are exactly the allowlisted ones.
    for (const [name, contract] of contracts)
      if (contract.requires?.subject === "admin") expect(name in NO_ROUTE_TWIN, name).toBe(true);
  });

  it("every non-read_only tool this node declares is mapped to a route twin or allowlisted, and declares `requires`", () => {
    const writers = POLY_GRANT_DECLARATION_BUNDLE.map((t) => t.contract).filter((c) => c.effect !== "read_only");
    expect(writers.filter((c) => !(c.name in SAME_DOOR_ROUTES) && !(c.name in NO_ROUTE_TWIN)).map((c) => c.name)).toEqual([]);
    expect(writers.filter((c) => c.requires === undefined).map((c) => c.name)).toEqual([]);
    for (const c of writers) {
      const mapped = SAME_DOOR_ROUTES[c.name];
      if (mapped) expect(mapped.scope, c.name).toBe(c.requires?.scope);
    }
  });

  it("S5: every write handler under work, schedules, edo, knowledge and metrics declares sameDoor or is on the deferred list", () => {
    const dirs = ["work", "schedules", "edo", "knowledge", "metrics", "agent/access-requests", "agent/register"].map((d) => join(API, "v1", d));
    const unaccounted: string[] = [];
    for (const dir of dirs)
      for (const file of routeFiles(dir)) {
        const parts = readFileSync(file, "utf8").split(/export const (POST|PATCH|PUT|DELETE) =/);
        for (let i = 1; i < parts.length; i += 2) {
          const chunk = (parts[i + 1] ?? "").slice(0, 600);
          const routeId = /routeId:\s*"([^"]+)"/.exec(chunk)?.[1] ?? `${file}#${parts[i]}`;
          if (/sameDoor:/.test(chunk) || routeId in DEFERRED_WRITE_ROUTES || routeId in OPEN_BY_DESIGN_ROUTES) continue;
          unaccounted.push(routeId);
        }
      }
    expect(unaccounted).toEqual([]);
  });

  it("the ask door is on the open-by-design list, says why, and is not also gated", () => {
    const gated = new Set(Object.values(DECLARED).flatMap((e) => e.routes));
    expect(Object.keys(OPEN_BY_DESIGN_ROUTES)).toEqual(["agent.access.requests.create", "agent.register"]);
    for (const [routeId, reason] of Object.entries(OPEN_BY_DESIGN_ROUTES)) {
      expect(gated.has(routeId), routeId).toBe(false);
      expect(reason.length).toBeGreaterThan(30);
      expect(reason).toMatch(/NO_SELF_APPROVAL|bug\.0297/);
      expect(sources.join("\n")).toContain(`routeId: "${routeId}"`);
    }
  });

  it("S5: the deferred list names a route that exists and is not also gated, and every entry names its design item", () => {
    const gated = new Set(Object.values(DECLARED).flatMap((e) => e.routes));
    const all = sources.join("\n");
    for (const [routeId, reason] of Object.entries(DEFERRED_WRITE_ROUTES)) {
      expect(all.includes(`routeId: "${routeId}"`), routeId).toBe(true);
      expect(gated.has(routeId), routeId).toBe(false);
      expect(reason, routeId).toMatch(/task\.54(65|66)|retired/);
    }
  });
});
