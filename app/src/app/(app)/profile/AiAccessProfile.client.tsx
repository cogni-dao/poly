// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/AiAccessProfile.client`
 * Purpose: The profile's "AI access": the shared `AgentAccessSection` in account mode, mounted with this person's own endpoints. A person turns an outside AI's
 *   ask On from its one-time link (`/profile#agent-request=<token>`), turns this node's own AI On for their account, and turns any of them Off.
 * Scope: Client mount only. It reads the link token once from the URL fragment and removes it at once (`useApprovalFragment`); it decides nothing.
 *   The section renders for every signed-in person (no admin gate here): the routes are session only and the decision is the account owner's alone.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, PROFILE_NEVER_SHOWS_NODE_ROWS (node-wide permissions are approved in /admin/ai-access, never here),
 *   HUMAN_SURFACE_TOKENLESS.
 * Side-effects: IO (the section's fetches), history.replaceState (strips the token)
 * Links: src/app/api/v1/agent-access/mine/route.ts, https://cognidao.org/knowledge/grant-account-outside-ai
 * @internal
 */

"use client";

import { AgentAccessSection, useApprovalFragment } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { AGENT_ACCESS_MINE_ENDPOINTS } from "./agent-access-mine-endpoints";

export function AiAccessProfile(): ReactElement {
	// A child's effects run before its parent's, so the token is read and removed before the page's own fragment handling runs.
	const token = useApprovalFragment();
	return <AgentAccessSection mode="account" endpoints={AGENT_ACCESS_MINE_ENDPOINTS} token={token} />;
}
