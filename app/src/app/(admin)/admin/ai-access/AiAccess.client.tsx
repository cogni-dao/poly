// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ai-access/AiAccess.client`
 * Purpose: Client mount for the shared AgentAccessSection with the human-plane roles endpoint.
 * Scope: Renders the section only. Does not decide who is an admin.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING.
 * Side-effects: IO (the section's fetches to the roles route)
 * Links: task.0114
 * @internal
 */

"use client";

import { AgentAccessSection } from "@cogni/knowledge-base-ui";
import { useSearchParams } from "next/navigation";
import type { ReactElement } from "react";

import { AGENT_ACCESS_ENDPOINTS } from "./agent-access-endpoints";

export function AiAccessClient(): ReactElement {
	// ?request=<id> (an ask's approval link) scrolls to and highlights that row.
	const highlightId = useSearchParams().get("request") ?? undefined;
	return <AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} highlightId={highlightId} />;
}
