// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The permission catalog is derived from Poly's own tool contracts. Defect named: the admin page offered `sandbox:exec` only,
 * because the scope list was a literal instead of the contracts' declarations.
 */
import { buildNodeAiView } from "@cogni/agent-grants";
import { SHARED_NODE_CATALOG } from "@cogni/langgraph-graphs";
import { scopesByPrincipalOf } from "@cogni/agent-grants";
import { describe, expect, it, vi } from "vitest";

import {
  createAgentToolAuthority,
  type AgentAuthoritySql,
} from "@/bootstrap/agent-authority";
import {
  buildPermissionCatalog,
  buildRequiresById,
} from "@/bootstrap/agent-permissions";
import { POLY_PERMISSION_TOOLS } from "@/bootstrap/ai/permission-tools";

const requiresById = buildRequiresById(POLY_PERMISSION_TOOLS);
const catalog = buildPermissionCatalog(requiresById);

describe("Poly permission catalog", () => {
  it("declares every node scope Poly's tool contracts carry", () => {
    for (const scope of [
      "sandbox:exec",
      "schedule:manage",
      "edo:write",
      "metric:compute",
      "account:read",
    ])
      expect(catalog.declaredScopes).toContain(scope);
    expect(catalog.scopeKinds["sandbox:exec"]).toBe("node");
    // Poly's delegated account read is askable at the one door and decided by the account owner, not on the admin page.
    expect(catalog.scopeKinds["account:read"]).toBe("account");
    expect(catalog.askableScopes).toContain("account:read");
  });

  it("shows node-ai one row per node scope its graph lists, Off until an admin turns it On", () => {
    const scopesByPrincipal = scopesByPrincipalOf(
      Object.values(SHARED_NODE_CATALOG),
      requiresById,
      "node",
    );
    const rows = buildNodeAiView({
      declarations: catalog.declarations,
      scopesByPrincipal,
      internal: [{ userId: "node-ai-user", slug: "node-ai" }],
      rows: [],
    });
    expect(rows.map((row) => row.scope)).toEqual(
      expect.arrayContaining(["sandbox:exec", "schedule:manage"]),
    );
    expect(rows.every((row) => row.who === "node-ai" && !row.on)).toBe(true);
  });
});

describe("authority store failures", () => {
  it("log the failure class and never the query values", async () => {
    const failure = Object.assign(new Error("column private_value missing"), {
      code: "42703",
    });
    const sql = Object.assign(async () => [], {
      begin: async () => {
        throw failure;
      },
    });
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const authority = createAgentToolAuthority({
      sql: sql as unknown as AgentAuthoritySql,
      nodeAdmin: { check: async () => ({ ok: true }) },
      log: log as never,
      toolBundle: [],
      principalCatalog: [],
    });
    await expect(authority.resolvePrincipal("private-slug")).rejects.toBe(
      failure,
    );
    const fields = log.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields.errorCode).toBe("42703");
    expect(JSON.stringify(fields)).not.toContain("private");
  });
});
