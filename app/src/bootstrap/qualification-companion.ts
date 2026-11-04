// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Observe only the configured private binding. Signed readiness is a claim, never a host. */
import {
	type QualificationReadiness,
	qualificationCompanion,
	qualificationHelper,
	qualificationReadiness,
} from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";

export async function observePaperCompanion(
	sidecarUrl: string,
	declared: QualificationReadiness,
	signal: AbortSignal,
	now: () => Date = () => new Date(),
) {
	signal.throwIfAborted();
	const readiness = qualificationReadiness.parse(declared);
	const base = new URL(sidecarUrl);
	if (
		readiness.port !== 9100 ||
		base.port !== String(readiness.port) ||
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== "/"
	)
		throw new QualificationError("paper_binding_invalid");
	// One native budget covers headers and bodies of all three observations. The
	// caller's action signal also cancels them; no detached work or redirect follows.
	const observationSignal = AbortSignal.any([
		signal,
		AbortSignal.timeout(2000),
	]);
	const get = (path: string) =>
		fetch(new URL(path, base), {
			redirect: "error",
			cache: "no-store",
			signal: observationSignal,
		});
	const identity = async () => {
		const response = await get("/version");
		if (response.status !== 200) {
			await response.body?.cancel();
			throw new QualificationError("paper_helper_unreachable");
		}
		const value = qualificationHelper.parse(await response.json());
		observationSignal.throwIfAborted();
		return value;
	};
	const before = await identity();
	const response = await get(readiness.path);
	await response.body?.cancel();
	observationSignal.throwIfAborted();
	if (response.status !== 200)
		throw new QualificationError("companion_readiness_failed");
	const observedAt = now().toISOString();
	const after = await identity();
	if (before.buildSha !== after.buildSha || before.bootId !== after.bootId)
		throw new QualificationError("helper_identity_changed");
	return qualificationCompanion.parse({
		...after,
		ready: { ...readiness, status: 200, observedAt },
	});
}
