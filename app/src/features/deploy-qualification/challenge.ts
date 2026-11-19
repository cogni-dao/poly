// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Purpose-separated service authentication; never resolves a human session. */
import { hkdfSync } from "node:crypto";
import { jwtVerify } from "jose";
import {
	type QualificationChallenge,
	qualificationChallenge,
} from "@/contracts/deploy.qualification.v1.contract";

export class QualificationError extends Error {
	constructor(
		readonly code: string,
		readonly status = 503,
	) {
		super(code);
	}
}
/** Poly supports precisely its declared private paper service, or none in production. */
export function assertQualificationCompanions(c: QualificationChallenge) {
	const selected = c.env === "production" ? [] : ["paper-trader"];
	const exactKeys = (map: Record<string, unknown>, expected = selected) =>
		Object.keys(map).length === expected.length &&
		expected.every((service) => Object.hasOwn(map, service));
	if (
		!exactKeys(c.services, ["app", ...selected]) ||
		!exactKeys(c.companionReadiness) ||
		(selected.length > 0 &&
			c.companionReadiness["paper-trader"]?.port !== 9100) ||
		(c.mode === "qualify"
			? c.helperBootId !== null || c.companionBootIds !== null
			: c.companionBootIds === null ||
				!exactKeys(c.companionBootIds) ||
				(selected.length === 0
					? c.helperBootId !== null
					: !c.helperBootId ||
						c.helperBootId !== c.companionBootIds["paper-trader"]))
	)
		throw new QualificationError("qualification_companions_invalid", 401);
}
export async function verifyQualificationChallenge(input: {
	authorization: string | null;
	mode?: "qualify" | "readback";
	authSecret: string;
	nodeId: string;
	env: string | undefined;
	sourceSha: string | undefined;
	now?: Date;
}): Promise<QualificationChallenge> {
	try {
		if (
			!input.authorization?.startsWith("Bearer ") ||
			input.authorization.length > 16000
		)
			throw new Error();
		const now = input.now ?? new Date();
		const purpose = "cogni-release-qualification-v1";
		const key = new Uint8Array(
			hkdfSync("sha256", input.authSecret, purpose, purpose, 32),
		);
		const { payload, protectedHeader } = await jwtVerify(
			input.authorization.slice(7),
			key,
			{
				algorithms: ["HS256"],
				typ: "JWT",
				issuer: "cogni-operator",
				audience: "cogni-release-qualification",
				requiredClaims: ["iat", "exp", "jti"],
				currentDate: now,
			},
		);
		const c = qualificationChallenge.parse(payload);
		const seconds = Math.floor(now.getTime() / 1000);
		if (
			protectedHeader.alg !== "HS256" ||
			protectedHeader.typ !== "JWT" ||
			c.iat > seconds ||
			c.exp <= c.iat ||
			c.exp - c.iat > 60 ||
			seconds - c.iat > 60 ||
			c.nodeId !== input.nodeId ||
			c.env !== input.env ||
			c.sourceSha !== input.sourceSha ||
			(input.mode !== undefined && c.mode !== input.mode)
		)
			throw new Error();
		assertQualificationCompanions(c);
		return c;
	} catch {
		throw new QualificationError("qualification_auth_invalid", 401);
	}
}
