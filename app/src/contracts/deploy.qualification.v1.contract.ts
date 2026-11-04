// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Release qualification wire v1. Exact subject; no caller-selected fixture or destination. */
import { z } from "zod";

const digest = z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const qualificationMode = z.enum(["qualify", "readback"]);
export const qualificationSubject = z.object({
	nodeId: z.uuid(),
	env: z.enum(["candidate-a", "preview", "production"]),
	releaseId: z.string().min(1).max(200),
	sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
	bundleDigest: digest,
	services: z.record(z.string(), digest),
	attemptId: z.string().min(1).max(200),
	allocation: z.string().min(1).max(500),
});
export const qualificationChallenge = qualificationSubject
	.extend({
		iss: z.literal("cogni-operator"),
		aud: z.literal("cogni-release-qualification"),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().nonnegative(),
		jti: z.string().min(1).max(200),
		mode: qualificationMode,
		helperBootId: z.string().min(1).max(200).nullable(),
	})
	.strict();
export const qualificationHelper = z.object({
	buildSha: z.string().regex(/^[a-f0-9]{40}$/),
	bootId: z.string().min(1).max(200),
});
export const qualificationOperation = {
	id: "deploy.qualification.v1",
	input: z.object({ mode: qualificationMode }).strict(),
	output: qualificationSubject
		.extend({
			status: z.enum(["qualified", "not_declared"]),
			helper: qualificationHelper
				.extend({ service: z.literal("paper-trader") })
				.optional(),
			evidenceId: z.string().min(1).optional(),
			observedAt: z.iso.datetime(),
			nonce: z.string().min(1),
		})
		.strict(),
};
export type QualificationChallenge = z.infer<typeof qualificationChallenge>;
export type QualificationSubject = z.infer<typeof qualificationSubject>;
export type QualificationHelper = z.infer<typeof qualificationHelper>;
