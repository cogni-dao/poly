// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Native configured HTTP resource. Feature code owns wire parsing and observation policy. */
export function createPaperCompanionTransport(
	binding: string,
	deadlineAt: number | undefined,
	timeoutError: () => Error,
) {
	return {
		binding,
		open(signal: AbortSignal) {
			// One native budget covers headers and bodies of every observation read.
			const observationSignal = AbortSignal.any([
				signal,
				AbortSignal.timeout(2000),
			]);
			return {
				signal: observationSignal,
				get(path: string) {
					const url = new URL(path, binding);
					observationSignal.throwIfAborted();
					if (deadlineAt !== undefined && Date.now() >= deadlineAt)
						throw timeoutError();
					return fetch(url, {
						redirect: "error",
						cache: "no-store",
						signal: observationSignal,
					});
				},
			};
		},
	};
}
