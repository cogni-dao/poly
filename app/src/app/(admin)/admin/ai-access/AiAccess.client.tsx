// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ai-access/AiAccess.client`
 * Purpose: Client mount for the shared AgentAccessSection with the human-plane roles endpoint.
 * Scope: Renders the section only. Does not decide who is an admin.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING, HUMAN_SURFACE_TOKENLESS (the link token is read from the fragment and removed at once).
 * Side-effects: IO (the section's fetches to the roles route)
 * Links: task.0114
 * @internal
 */

"use client";

import { AgentAccessSection, useApprovalFragment } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { AGENT_ACCESS_ENDPOINTS } from "./agent-access-endpoints";

export function AiAccessClient(): ReactElement {
	// An AI's one-time link (`/admin/ai-access#agent-request=<token>`): read once, removed from the address bar at once, and used to highlight the ask.
	const token = useApprovalFragment();
	return <AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} token={token} />;
}
