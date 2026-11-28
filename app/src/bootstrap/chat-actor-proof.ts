// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Bind an authenticated chat actor to its durable workflow invocation.
 *
 * SOURCE PORT RECORD (https://cognidao.org/knowledge/port-node-source-once; story.0090). The literal port beside the shared provider is the run-claim signer
 * and verifier the facade and the internal run route call (`shell-caller-run-claim`). The provider reads only the route's `runClaimVerified` flag.
 *   - Source: node-template's claim helpers, as adopted by red#88; here `signChatActor`, `verifyChatActor`.
 *   - Also ported from the same source and formerly recorded in the provider header (now deleted): `bootstrap/capabilities/schedule-model.ts` (`bindScheduleModel`), `app/(admin)/_lib/admin-session.ts`
 *     (the one AdminSession mint) and `shared/observability/db-error-fields.ts` (`failureFields`). No package exports them yet; each leaves with the release that does.
 *   - Exit: `@cogni-dao/graph-execution` 0.2.0 (`buildRunClaim`, `checkRunClaim`, `claimSlotOwnedBy`), which is not released yet. The same PR that adopts it deletes this file.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

interface ChatActorIdentity {
  readonly nodeId: string;
  readonly lane: string;
  readonly idempotencyKey: string;
  readonly transportKey: string;
  readonly requestHash: string;
  readonly runId: string;
  readonly graphId: string;
  readonly actorUserId: string;
  readonly billingAccountId: string;
  readonly virtualKeyId: string;
  readonly payload: unknown;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  return value;
}
export function signChatActor(
  identity: ChatActorIdentity,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update("shared-cogni-chat-actor:v3\0")
    .update(
      JSON.stringify([
        identity.nodeId,
        identity.lane,
        identity.idempotencyKey,
        identity.transportKey,
        identity.requestHash,
        identity.runId,
        identity.graphId,
        identity.actorUserId,
        identity.billingAccountId,
        identity.virtualKeyId,
        canonicalize(identity.payload),
      ]),
    )
    .digest("hex");
}
export function verifyChatActor(
  identity: ChatActorIdentity,
  secret: string,
  proof: unknown,
): boolean {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  return timingSafeEqual(
    Buffer.from(proof, "hex"),
    Buffer.from(signChatActor(identity, secret), "hex"),
  );
}
