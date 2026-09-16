// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/system/page`
 * Purpose: Preserve old Governance System links by redirecting to the dashboard.
 * Scope: Route compatibility only. The obsolete System view no longer exists.
 * Invariants: SYSTEM_SURFACE_REMOVED, PERMANENT_REDIRECT.
 * Side-effects: navigation redirect
 * Links: task.5038
 * @public
 */

import { permanentRedirect } from "next/navigation";

export default function SystemActivityPage(): never {
  permanentRedirect("/dashboard");
}
