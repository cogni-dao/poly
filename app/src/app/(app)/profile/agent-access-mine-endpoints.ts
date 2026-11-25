// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/agent-access-mine-endpoints`
 * Purpose: The human-plane routes the profile "AI access" calls. One constant, so a test can prove the routes exist.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY. The page sends the browser session only; the routes refuse any Authorization header.
 * Side-effects: none
 * Links: src/app/api/v1/agent-access/mine/route.ts, src/app/api/v1/agent-access/mine/preview/route.ts
 * @internal
 */

export const AGENT_ACCESS_MINE_PATH = "/api/v1/agent-access/mine" as const;
export const AGENT_ACCESS_MINE_PREVIEW_PATH = "/api/v1/agent-access/mine/preview" as const;
export const AGENT_ACCESS_MINE_ENDPOINTS = {
	roles: AGENT_ACCESS_MINE_PATH,
	preview: AGENT_ACCESS_MINE_PREVIEW_PATH,
} as const;
