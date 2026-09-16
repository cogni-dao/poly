// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/epoch/page`
 * Purpose: Server entrypoint for the unified epoch overview.
 * Scope: Server component only; delegates lifecycle rendering to CurrentEpochView.
 * Invariants: Auth enforced by (app) layout guard. Admin settlement actions live in /gov/review.
 * Side-effects: none (server render only)
 * Links: src/features/governance/types.ts
 * @public
 */

import type { ReactElement } from "react";

import { CurrentEpochView } from "./view";

export default function CurrentEpochPage(): ReactElement {
  return <CurrentEpochView />;
}
