// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/credits/page`
 * Purpose: Server entrypoint for the protected credits page; delegates to client component for USDC payment flow.
 * Scope: Server component only; delegates all client-side behavior to CreditsPageClient; does not perform data fetching or payment wiring.
 * Invariants: All payment configuration handled via backend intent endpoint (chain-agnostic).
 * Side-effects: none (server render only)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/payments-design.md
 * @public
 */

import type { ReactElement } from "react";

import { CreditsPageClient } from "./CreditsPage.client";

export default function CreditsPage(): ReactElement {
  return <CreditsPageClient />;
}
