// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bind an authenticated chat actor to its durable workflow invocation. */
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
