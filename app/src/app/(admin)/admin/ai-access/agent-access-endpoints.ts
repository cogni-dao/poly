// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ai-access/agent-access-endpoints`
 * Purpose: The admin-area route the admin "AI access" page calls. One constant, so a test can prove the route exists.
 * Invariants: ONE_ADMIN_CHECK. The page sends the browser session; the route runs the same admin check for a session or a bearer.
 * Side-effects: none
 * Links: tests/unit/app/agent-access-wiring.test.ts, src/app/api/v1/admin/ai-access/route.ts
 * @internal
 */

export const AGENT_ACCESS_ROLES_PATH = "/api/v1/admin/ai-access" as const;
export const AGENT_ACCESS_PREVIEW_PATH = "/api/v1/admin/ai-access/preview" as const;
export const AGENT_ACCESS_ENDPOINTS = {
	roles: AGENT_ACCESS_ROLES_PATH,
	preview: AGENT_ACCESS_PREVIEW_PATH,
} as const;
