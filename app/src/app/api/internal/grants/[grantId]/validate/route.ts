// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/grants/[grantId]/validate`
 * Purpose: Internal endpoint for scheduler-worker to validate an execution grant against a scoped action.
 * Scope: Auth-protected POST — delegates to ExecutionGrantWorkerPort.validateGrantForScope. Worker holds no DB credentials; this is the only validation path.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - GRANT_NODE_BINDING (M1): if the body carries `nodeId` it MUST equal getNodeId() (else 403 grant_node_mismatch)
 *   - SCOPE_GENERALIZED (M2): required scope is `scope`, else derived from `graphId` as `graph:execute:<graphId>`
 *   - SELF_COLLECT_AUTHORIZED (story.5001): the node self-authorizes (200, no DB lookup) the EXACT scope `task:dispatch:<ownNodeId>:/api/internal/attribution/collect` — the operator mints that grant in its own DB (not node-resolvable), and a node always permits the trusted operator scheduler to collect its OWN ledger. Narrow: exact route + self nodeId only.
 *   - 403 on grant-not-found/expired/revoked/scope-mismatch/node-mismatch with machine-readable error code
 * Side-effects: IO (reads grants via ExecutionGrantWorkerPort)
 * Links: grants.validate.internal.v1.contract, task.0280, task.5029
 * @internal
 */

import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
  type InternalValidateGrantError,
  InternalValidateGrantInputSchema,
  type InternalValidateGrantOutput,
} from "@cogni/node-contracts";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
  verifySchedulerBearer,
} from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  isGrantExpiredError,
  isGrantNodeMismatchError,
  isGrantNotFoundError,
  isGrantRevokedError,
  isGrantScopeMismatchError,
} from "@/ports/server";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ grantId: string }>;
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "grants.validate.internal", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, routeParams) => {
    const env = serverEnv();
    const log = ctx.log;

    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        env.SCHEDULER_API_TOKEN
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!routeParams) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { grantId } = await routeParams.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = InternalValidateGrantInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const ownNodeId = getNodeId();
    // M1 grant↔node binding: the worker tells us which node it is dispatching
    // for. The request reached THIS node's URL, so a mismatch means a routing /
    // spoofing bug — fail closed before touching the grant.
    const dispatchNodeId = parsed.data.nodeId ?? ownNodeId;
    if (parsed.data.nodeId && parsed.data.nodeId !== ownNodeId) {
      log.warn(
        { grantId, requestedNodeId: parsed.data.nodeId, ownNodeId },
        "Grant validation node mismatch (request reached the wrong node)"
      );
      const response: InternalValidateGrantError = {
        ok: false,
        error: "grant_node_mismatch",
      };
      return NextResponse.json(response, { status: 403 });
    }

    // M2 scope generalization: prefer the explicit `scope`; otherwise derive
    // the graph scope from the back-compat `graphId`.
    const requiredScope =
      parsed.data.scope ??
      (parsed.data.graphId ? `graph:execute:${parsed.data.graphId}` : null);
    if (!requiredScope) {
      return NextResponse.json(
        { error: "one of `scope` or `graphId` is required" },
        { status: 400 }
      );
    }

    // SELF_COLLECT_AUTHORIZED: a node always permits the trusted operator
    // scheduler to trigger collection of its OWN ledger. The per-grant lookup
    // gates cross-tenant graph execution; it is not needed when the node is
    // self-authorizing its own epoch-collect under the trusted
    // SCHEDULER_API_TOKEN (already verified above) for its OWN nodeId
    // (asserted by M1). Kept NARROW — an exact match on this node's own
    // epoch-collect route only, never a wildcard over `task:dispatch` — so it
    // can't authorize dispatch to arbitrary internal routes. The operator mints
    // this grant in ITS OWN DB, which is not node-resolvable, so a DB lookup
    // here would always 403 grant_not_found (story.5001).
    const selfCollectScope = `task:dispatch:${ownNodeId}:/api/internal/attribution/collect`;
    if (requiredScope === selfCollectScope) {
      const response: InternalValidateGrantOutput = {
        ok: true,
        grant: {
          id: grantId,
          userId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
          billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
          scopes: [requiredScope],
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
        },
      };
      log.info(
        { grantId, requiredScope, ownNodeId },
        "Self-authorized epoch-collect (SELF_COLLECT_AUTHORIZED)"
      );
      return NextResponse.json(response, { status: 200 });
    }

    const container = getContainer();

    try {
      const grant =
        await container.executionGrantWorkerPort.validateGrantForScope(
          SYSTEM_ACTOR,
          dispatchNodeId,
          grantId,
          requiredScope
        );
      const response: InternalValidateGrantOutput = {
        ok: true,
        grant: {
          id: grant.id,
          userId: grant.userId,
          billingAccountId: grant.billingAccountId,
          scopes: [...grant.scopes],
          expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
          revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
          createdAt: grant.createdAt.toISOString(),
        },
      };
      return NextResponse.json(response, { status: 200 });
    } catch (err) {
      let errorCode: InternalValidateGrantError["error"] | null = null;
      if (isGrantNotFoundError(err)) errorCode = "grant_not_found";
      else if (isGrantExpiredError(err)) errorCode = "grant_expired";
      else if (isGrantRevokedError(err)) errorCode = "grant_revoked";
      else if (isGrantNodeMismatchError(err)) errorCode = "grant_node_mismatch";
      else if (isGrantScopeMismatchError(err))
        errorCode = "grant_scope_mismatch";

      if (errorCode) {
        log.info(
          { grantId, requiredScope, errorCode },
          "Grant validation rejected"
        );
        const response: InternalValidateGrantError = {
          ok: false,
          error: errorCode,
        };
        return NextResponse.json(response, { status: 403 });
      }

      log.error(
        { grantId, requiredScope, err },
        "Unexpected error validating grant"
      );
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }
);
