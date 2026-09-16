// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/review/page`
 * Purpose: Server entrypoint for the Finish Epoch workspace.
 * Scope: Resolves the signed-in wallet and current approver set for client-side action eligibility.
 * Invariants: Unauthorized users may inspect progress; mutation routes remain the authorization boundary.
 * Side-effects: IO (auth session read, config read)
 * Links: src/app/api/v1/attribution/_lib/approver-guard.ts
 * @public
 */

import type { ReactElement } from "react";

import { getServerSessionUser } from "@/lib/auth/server";
import { getLedgerApprovers, getNodeId } from "@/shared/config";

import { ReviewView } from "./view";

export default async function ReviewPage(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  const approvers = getLedgerApprovers();

  const walletAddress = user?.walletAddress?.toLowerCase() ?? null;
  const isCurrentApprover =
    walletAddress !== null && approvers.includes(walletAddress);

  return (
    <ReviewView
      walletAddress={walletAddress}
      isCurrentApprover={isCurrentApprover}
      operatorSetupUrl={`https://cognidao.org/nodes/${getNodeId()}`}
    />
  );
}
