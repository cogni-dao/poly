// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Frozen claims for one operator-authorized, node-executed action. */

import { z } from "zod";
import { IdentityAttestationOriginSchema } from "./identity.attestation.v1.contract";

export const NODE_ACTION_V1 = "node.action.v1" as const;
export const NODE_ACTION_TTL_SECONDS = 60;
export const NODE_ACTION_V1_PROTOCOL_SHA256 =
	"65feeb796f44286d8d67d1c7e300ff3071eea7ee72b169dae135be447b56322b" as const;
export const NodeActionNodeIdSchema = z.string().uuid();
export const NodeActionIdSchema = z
	.string()
	.min(3)
	.max(128)
	.regex(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/);
export function nodeActionAudience(nodeId: string): string {
	return `urn:cogni:node-action:${NodeActionNodeIdSchema.parse(nodeId)}`;
}
export const NodeActionClaimsSchema = z
	.object({
		type: z.literal(NODE_ACTION_V1),
		protocol: z.literal(NODE_ACTION_V1_PROTOCOL_SHA256),
		iss: IdentityAttestationOriginSchema,
		aud: z.string(),
		nodeId: NodeActionNodeIdSchema,
		environment: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		actorId: z.string().min(3).max(200).regex(/^(user|agent|service):[^\s]+$/),
		action: NodeActionIdSchema,
		target: z.string().min(1).max(256).regex(/^\/api\/internal\/node-actions\/[a-z0-9/_-]+$/),
		bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().positive(),
		jti: z.string().uuid(),
	})
	.strict()
	.superRefine((claims, ctx) => {
		if (claims.aud !== nodeActionAudience(claims.nodeId)) {
			ctx.addIssue({ code: "custom", path: ["aud"], message: "aud mismatch" });
		}
		const ttl = claims.exp - claims.iat;
		if (ttl <= 0 || ttl > NODE_ACTION_TTL_SECONDS) {
			ctx.addIssue({ code: "custom", path: ["exp"], message: "ttl exceeds 60s" });
		}
	});
export type NodeActionClaims = z.infer<typeof NodeActionClaimsSchema>;
