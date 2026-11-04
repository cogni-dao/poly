// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Authenticate service principal and bind only configured release-proof dependencies. */
import { resolveQualificationDependencies } from "@/bootstrap/qualification";
import {
	qualificationOperation,
	qualificationSubject,
} from "@/contracts/deploy.qualification.v1.contract";
import {
	QualificationError,
	verifyQualificationChallenge,
} from "@/features/deploy-qualification/challenge";
import { qualificationFixtures } from "@/features/deploy-qualification/fixtures";
import { qualifyRelease } from "@/features/deploy-qualification/service";
import { getNodeId } from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";

export async function qualifyDeployment(
	authorization: string | null,
	mode: "qualify" | "readback",
) {
	const env = serverEnv();
	const c = await verifyQualificationChallenge({
		authorization,
		mode,
		authSecret: env.AUTH_SECRET,
		nodeId: getNodeId(),
		env: env.DEPLOY_ENVIRONMENT,
		sourceSha: env.APP_BUILD_SHA,
	});
	if (c.env === "production")
		return qualificationOperation.output.parse({
			...qualificationSubject.parse(c),
			status: "not_declared",
			observedAt: new Date().toISOString(),
			nonce: c.jti,
		});
	if (!env.PAPER_SIDECAR_URL)
		throw new QualificationError("paper_binding_missing");
	const signal = AbortSignal.timeout(19000);
	const operation = qualifyRelease(
		c,
		resolveQualificationDependencies(
			qualificationFixtures[c.env],
			env.PAPER_SIDECAR_URL,
			signal,
		),
		signal,
	);
	return new Promise<Awaited<typeof operation>>((resolve, reject) => {
		const abort = () => reject(new QualificationError("qualification_timeout"));
		signal.addEventListener("abort", abort, { once: true });
		operation
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
