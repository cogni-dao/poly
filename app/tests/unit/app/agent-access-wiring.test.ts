// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-access-wiring`
 * Purpose: S1 wiring that no other test covers (task.5456): the admin-area route the admin AI-access page calls, its mount, and its absence from the profile. (The DTO-equals-view guarantee is a compile-time check in
 *   src/app/_lib/agent-access/dto-type-check.ts; a vitest test cannot enforce types.)
 * Scope: Reads source files and imports route modules; renders nothing. Fails if the admin page's endpoint path stops pointing at an existing admin-area route, or if an old route returns.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING (wiring half).
 * Side-effects: filesystem reads
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENT_ACCESS_ENDPOINTS,
  AGENT_ACCESS_ROLES_PATH,
} from "@/app/(admin)/admin/ai-access/agent-access-endpoints";

const SRC = resolve(__dirname, "../../../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("S1 wiring", () => {
  it("points the AI-access page at an existing admin-area route that serves GET, POST and DELETE", async () => {
    expect(AGENT_ACCESS_ROLES_PATH).toBe("/api/v1/admin/ai-access");
    expect(AGENT_ACCESS_ENDPOINTS.roles).toBe(AGENT_ACCESS_ROLES_PATH);
    const route = resolve(SRC, `app${AGENT_ACCESS_ROLES_PATH}/route.ts`);
    expect(existsSync(route)).toBe(true);
    const source = readFileSync(route, "utf8");
    for (const verb of ["GET", "POST", "DELETE"])
      expect(source).toMatch(new RegExp(`export const ${verb} =`));
    // Every handler takes its AdminSession from the one mint, and writes through the port.
    expect(source.match(/requireAdminSession\(request, /g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("nodeAdminPort");
    expect(source).not.toMatch(/agentAuthority|adminCheck/);
  });

  it("uses that endpoint in the admin AI-access client and mounts the block there", () => {
    const view = read("app/(admin)/admin/ai-access/AiAccess.client.tsx");
    expect(view).toContain('from "./agent-access-endpoints"');
    expect(view).toContain("<AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} highlightId={highlightId} />");
    expect(view).toContain('useSearchParams().get("request")'); // an approval link highlights its row
    expect(view).not.toMatch(/\/api\/v1\/agent\/roles/);
  });

  it("the profile renders the SAME shared section with the OWNER endpoints only (no admin route, no app-local AI-access component), and the admin page is linked from the admin index", () => {
    const profile = read("app/(app)/profile/view.tsx");
    expect(profile).toContain("<AgentAccessSection");
    expect(profile).toContain("endpoints={OWNER_ACCESS_ENDPOINTS}");
    expect(profile).toContain('searchParams.get("request")');
    expect(profile).toContain('searchParams.get("claim")');
    for (const path of ["/api/v1/agent-access/mine", "/api/v1/profile/ai", "/api/v1/profile/ai/revoke", "/api/v1/agent-access/mine/requests", "/api/v1/profile/ai/claims"])
      expect(profile).toContain(`"${path}"`);
    expect(profile).not.toMatch(/\/api\/v1\/admin\//);
    expect(profile).not.toContain("agent-access-endpoints");
    // No bespoke page or app-local component for AI access is left.
    for (const gone of [
      "app/(app)/profile/YourAis.tsx",
      "app/(app)/profile/YourAiAccess.tsx",
      "app/(app)/profile/ai",
      "app/(admin)/admin/ai-access/requests",
      "app/api/v1/admin/ai-access/requests",
    ])
      expect(existsSync(resolve(SRC, gone)), gone).toBe(false);
    expect(existsSync(resolve(SRC, "app/(app)/profile/agent-access-endpoints.ts"))).toBe(false);
    expect(read("app/(admin)/admin/page.tsx")).toContain('href="/admin/ai-access"');
    expect(existsSync(resolve(SRC, "app/(app)/gov/ai-access"))).toBe(false);
  });

  it("keeps the old AI-plane path and the old human roles route gone", () => {
    expect(existsSync(resolve(SRC, "app/api/v1/agent/roles/route.ts"))).toBe(false);
    expect(existsSync(resolve(SRC, "app/api/v1/agent-access/roles/route.ts"))).toBe(false);
  });
});
