// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-acts-in-admin`
 * Purpose: ADMIN_ACTS_IN_ADMIN import lock (task.0114, task.0116). The admin port, its mint and the admin UI live only in the Admin area, and no other
 *   file asks the node-admin question. The lock fails on a new violation; the allowlist below holds today's violations and may only shrink (task.0115).
 * Scope: Reads source files only; renders nothing.
 * Invariants: ADMIN_ACTS_IN_ADMIN; ONE_MINT (no `as AdminSession` outside the mint); a stale allowlist entry fails.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../../src");
const ADMIN_DIRS = ["app/(admin)/", "app/api/v1/admin/"];
const MINT = "app/(admin)/_lib/admin-session.ts";

/** Wiring that may name the port: its definition and the container that builds it. The routes and pages reach it only through the container. */
const PORT_WIRING = ["ports/node-admin.port.ts", "ports/index.ts", "bootstrap/node-admin-port.ts", "bootstrap/container.ts"];

/** Today's `isDaoAdmin(`, `isLedgerApprover(`, `checkApprover(`, `nodeAdmin.check(` and `checkNodeAdmin(` callers outside the Admin area. Remove an entry when task.0115 moves it; never add one. */
const ASK_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "app/api/v1/attribution/epochs/", reason: "epoch review, finalize, sign and distribution routes" }, // task.0115
  { path: "app/api/v1/attribution/_lib/approver-guard.ts", reason: "checkApprover definition" }, // task.0115
  { path: "app/_facades/work/items.server.ts", reason: "work-items facade: priority 0/1" }, // task.0115
  { path: "bootstrap/node-admin-gate.ts", reason: "the node-admin check itself" }, // task.0115
  { path: "bootstrap/agent-authority.ts", reason: "tool-guard admin check" }, // task.0115
  { path: "app/(admin)/layout.tsx", reason: "layout gate" }, // task.0115
  { path: "app/(admin)/admin/payments/money-plane.server.ts", reason: "payments page gate" }, // task.0115
  { path: "auth.ts", reason: "session isApprover flag" }, // task.0115
  { path: "shared/config/repoSpec.server.ts", reason: "isDaoAdmin and isLedgerApprover definitions" }, // task.0115
];
const ASK = /\b(isDaoAdmin|isLedgerApprover|checkApprover|checkNodeAdmin)\(|\bnodeAdmin\.check\(/;
// The container also hands the node-admin authority to the knowledge store and work-item capability as an object (not a call), so those files have no match to list.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const files = sourceFiles(SRC).map((file) => ({ rel: relative(SRC, file), text: readFileSync(file, "utf8") }));
const outsideAdmin = files.filter((f) => !ADMIN_DIRS.some((dir) => f.rel.startsWith(dir)));
const importsOf = (text: string) => text.match(/import[^;]*?from\s*["'][^"']+["']/g) ?? [];

describe("ADMIN_ACTS_IN_ADMIN", () => {
  it("imports AgentAccessSection and the agent-access endpoints only from the Admin area", () => {
    const importers = files.filter(
      (f) => /import[^;]*\bAgentAccessSection\b[^;]*from/.test(f.text) || /from\s+["'][^"']*agent-access-endpoints["']/.test(f.text)
    );
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.map((f) => f.rel).filter((rel) => !ADMIN_DIRS.some((dir) => rel.startsWith(dir)))).toEqual([]);
  });

  it("names NodeAdminPort, AdminSession, nodeAdminPort or the admin-session mint only in the Admin area and the explicit port wiring", () => {
    const outside = outsideAdmin
      .filter((f) => !PORT_WIRING.includes(f.rel))
      .filter((f) => importsOf(f.text).some((i) => /node-admin\.port|admin-session|\b(NodeAdminPort|AdminSession)\b/.test(i)) || /\bnodeAdminPort\b/.test(f.text));
    expect(outside.map((f) => f.rel)).toEqual([]);
  });

  it("makes an AdminSession only in the mint", () => {
    const minters = files.filter((f) => /\bas\s+AdminSession\b|<AdminSession>/.test(code(f.text))).map((f) => f.rel);
    expect(minters).toEqual([MINT]);
  });

  it("asks the node-admin question (isDaoAdmin, isLedgerApprover, checkApprover, checkNodeAdmin, nodeAdmin.check) only where the allowlist says", () => {
    const allowed = (rel: string) => ASK_ALLOWLIST.some((entry) => rel.startsWith(entry.path));
    // The mint is the one place that asks. Every other file, in the Admin area or not, is a violation unless listed.
    const violations = files.filter((f) => f.rel !== MINT && ASK.test(code(f.text))).map((f) => f.rel);
    expect(violations.filter((rel) => !allowed(rel))).toEqual([]);
    // The list can only shrink: an entry nothing matches any more must be deleted.
    const stale = ASK_ALLOWLIST.filter((entry) => !violations.some((rel) => rel.startsWith(entry.path))).map((entry) => entry.path);
    expect(stale).toEqual([]);
  });
});
