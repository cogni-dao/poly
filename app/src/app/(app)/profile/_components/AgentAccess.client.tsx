// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/_components/AgentAccess.client`
 * Purpose: Client mount for the shared AgentAccessSection on the profile, with the person's own access routes.
 * Scope: Renders the shared section only. Decides nothing: the owner approves or turns Off an AI's `account:read` on their own account here.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, PROFILE_NEVER_SHOWS_NODE_ROWS, HUMAN_SURFACE_TOKENLESS (the link token is read from the fragment and removed at once).
 * Side-effects: IO (the section's fetches to the mine route)
 * Links: src/app/api/v1/agent-access/mine/route.ts
 * @internal
 */

"use client";

import { AgentAccessSection, useApprovalFragment } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

export const PROFILE_AGENT_ACCESS_ENDPOINTS = {
  roles: "/api/v1/agent-access/mine",
  preview: "/api/v1/agent-access/mine/preview",
} as const;

export function ProfileAgentAccess(): ReactElement {
  // An AI's one-time link (`/profile#agent-request=<token>`): read once, removed from the address bar at once, and used to highlight the ask.
  const token = useApprovalFragment();
  return <AgentAccessSection endpoints={PROFILE_AGENT_ACCESS_ENDPOINTS} token={token} />;
}
