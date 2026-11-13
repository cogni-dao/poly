// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ai-access/page`
 * Purpose: Node-wide AI permission approvals in the admin area (ADMIN_ACTS_IN_ADMIN).
 * Scope: Server component. Access gated upstream by `(admin)/layout.tsx` (non-approver wallets redirect to /dashboard); the shared section still renders nothing unless the roles route confirms canManage. Adds no authority logic.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING.
 * Side-effects: none (server render only)
 * Links: task.0114, src/app/api/v1/admin/ai-access/route.ts
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { AiAccessClient } from "./AiAccess.client";

export default function AiAccessPage(): ReactElement {
	return (
		<PageContainer maxWidth="2xl">
			<p className="max-w-prose text-muted-foreground">
				Permissions you approve here apply to the whole node.
			</p>
			<AiAccessClient />
		</PageContainer>
	);
}
