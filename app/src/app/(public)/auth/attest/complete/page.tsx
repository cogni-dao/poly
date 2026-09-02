// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(public)/auth/attest/complete`
 * Purpose: Server shell for the sign-in intent gate — supplies THIS node's own name.
 * Scope: Reads repo-spec config and renders the client island. No auth, no IO beyond config.
 * Invariants:
 *   - NAME_COMES_FROM_THE_NODE: the attestation contract is frozen and carries no slug,
 *     so the destination name is read from this node's own repo-spec rather than from
 *     anything the operator sent. A node states its own name; nobody states it for it.
 * Side-effects: none
 * @public
 */

import type { ReactElement } from "react";
import { getNodeName } from "@/shared/config";
import { AttestSignInComplete } from "./view";

export const dynamic = "force-dynamic";

export default function AttestSignInCompletePage(): ReactElement {
	return <AttestSignInComplete nodeName={getNodeName()} />;
}
