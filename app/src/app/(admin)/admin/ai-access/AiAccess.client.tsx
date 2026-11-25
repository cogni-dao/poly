// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Purpose: Helps a node-admin decide whether Cogni may use this node’s sandbox. */

"use client";

import {
  type AgentAccessEndpoints,
  AgentAccessSection,
} from "@cogni/knowledge-base-ui";

const endpoints: AgentAccessEndpoints = { roles: "/api/v1/admin/ai-access" };

/** Stock published direct On/Off table; all authority stays on the server. */
export function AiAccessClient() {
  return (
    <AgentAccessSection
      endpoints={endpoints}
      className="[&_button]:min-h-6 [&_[role=switch]]:min-w-11"
    />
  );
}
