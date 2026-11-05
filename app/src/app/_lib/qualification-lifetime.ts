// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bound qualification waiting, including disposal, without abandoning effect ownership. */
import { QualificationError } from "@/features/deploy-qualification/challenge";

export function assertQualificationLifetime(
	signal: AbortSignal,
	deadlineAt: number,
) {
	signal.throwIfAborted();
	if (Date.now() >= deadlineAt)
		throw new QualificationError("qualification_timeout");
}

export async function withinQualificationLifetime<T>(
	requestSignal: AbortSignal,
	deadlineAt: number,
	action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	assertQualificationLifetime(requestSignal, deadlineAt);
	const controller = new AbortController();
	const signal = AbortSignal.any([requestSignal, controller.signal]);
	const timer = setTimeout(
		() => controller.abort(new QualificationError("qualification_timeout")),
		deadlineAt - Date.now(),
	);
	let abort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	try {
		assertQualificationLifetime(signal, deadlineAt);
		// The losing action retains its finally/cleanup chain. The aborted signal
		// fences its later continuations; a timeout never resets its reservation.
		const result = await Promise.race([action(signal), aborted]);
		assertQualificationLifetime(signal, deadlineAt);
		return result;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}
