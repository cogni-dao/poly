// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Authenticate service principal and bind only configured release-proof dependencies. */

import {
	assertQualificationLifetime,
	withinQualificationLifetime,
} from "@/app/_lib/qualification-body";
import {
	type QualificationChallenge,
	qualificationOperation,
	qualificationSubject,
} from "@/contracts/deploy.qualification.v1.contract";
import {
	assertQualificationCompanions,
	QualificationError,
	verifyQualificationChallenge,
} from "@/features/deploy-qualification/challenge";
import { qualificationFixtures } from "@/features/deploy-qualification/fixtures";
import { qualifyRelease } from "@/features/deploy-qualification/service";
import { getNodeId } from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";

export async function authenticateQualification(authorization: string | null) {
	const env = serverEnv();
	return verifyQualificationChallenge({
		authorization,
		authSecret: env.AUTH_SECRET,
		nodeId: getNodeId(),
		env: env.DEPLOY_ENVIRONMENT,
		sourceSha: env.APP_BUILD_SHA,
	});
}

export async function qualifyDeployment(
	c: QualificationChallenge,
	signal: AbortSignal,
	deadlineAt: number,
) {
	return withinQualificationLifetime(
		signal,
		deadlineAt,
		async (actionSignal) => {
			assertQualificationCompanions(c);
			const env = serverEnv();
			if (c.env === "production")
				return qualificationOperation.output.parse({
					...qualificationSubject.parse(c),
					status: "not_declared",
					companions: {},
					observedAt: new Date().toISOString(),
					nonce: c.jti,
				});
			if (!env.PAPER_SIDECAR_URL)
				throw new QualificationError("paper_binding_missing");
			// Capability admission precedes loading/initializing trading dependencies.
			// This import and all required disposal spend the original entry budget.
			const { resolveQualificationDependencies } = await import(
				"@/bootstrap/qualification"
			);
			assertQualificationLifetime(actionSignal, deadlineAt);
			const deps = resolveQualificationDependencies(
				qualificationFixtures[c.env],
				env.PAPER_SIDECAR_URL,
				actionSignal,
				deadlineAt,
			);
			try {
				return await qualifyRelease(c, deps, actionSignal);
			} finally {
				await deps.dispose();
			}
		},
	);
}
