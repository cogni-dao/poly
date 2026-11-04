// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bounded qualification JSON transport. The route authenticates before calling this. */
import { qualificationOperation } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";

export async function readQualificationBody(
	request: Request,
	lifetime: AbortSignal,
) {
	const limit = 256;
	const length = request.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
		throw new QualificationError("qualification_body_too_large", 413);
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim() !==
		"application/json"
	)
		throw new QualificationError("invalid_request", 400);
	if (!request.body) throw new QualificationError("invalid_request", 400);
	const reader = request.body.getReader();
	const signal = AbortSignal.any([lifetime, AbortSignal.timeout(1000)]);
	let abort: () => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		abort = () => {
			// Cancel the actual stream, including a pending read; never await an
			// untrusted producer's cancel callback to return the bounded response.
			reject(new QualificationError("qualification_body_timeout", 408));
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	try {
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const part = await Promise.race([reader.read(), aborted]);
			if (signal.aborted)
				throw new QualificationError("qualification_body_timeout", 408);
			if (part.done) break;
			size += part.value.byteLength;
			if (size > limit)
				throw new QualificationError("qualification_body_too_large", 413);
			chunks.push(part.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		try {
			return qualificationOperation.input.parse(
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
			);
		} catch {
			throw new QualificationError("invalid_request", 400);
		}
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
