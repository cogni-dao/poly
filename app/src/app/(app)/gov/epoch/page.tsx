// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/epoch/page`
 * Purpose: Server entrypoint for the current epoch governance page.
 * Scope: Server component only; resolves approver visibility and delegates client behavior to CurrentEpochView.
 * Invariants: Auth enforced by (app) layout guard. The mutation route remains authoritative.
 * Side-effects: none (server render only)
 * Links: src/features/governance/types.ts
 * @public
 */

import type { ReactElement } from "react";

import { getServerSessionUser } from "@/lib/auth/server";
import { getLedgerApprovers, getNodeId } from "@/shared/config";

import { CurrentEpochView } from "./view";

export default async function CurrentEpochPage(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  const approvers = getLedgerApprovers();
  const walletAddress = user?.walletAddress?.toLowerCase() ?? null;
  const isCurrentApprover =
    walletAddress !== null && approvers.includes(walletAddress);

  return (
    <CurrentEpochView
      isCurrentApprover={isCurrentApprover}
      operatorSetupUrl={`https://cognidao.org/nodes/${getNodeId()}`}
    />
  );
}
