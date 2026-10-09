// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Bounded, secret-scrubbed error fields for structured operational logs.
 *
 * Database clients commonly wrap the useful SQLSTATE/message several causes
 * deep. We retain that diagnostic shape without serializing an Error object or
 * emitting raw SQL values, credentials, bearer tokens, or unbounded payloads.
 */

const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_ERROR_LABEL_LENGTH = 80;
const MAX_CAUSE_DEPTH = 6;

function stringProperty(
	value: unknown,
	keys: readonly string[],
): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

function sanitizedMessage(value: unknown): string | undefined {
	const raw =
		value instanceof Error
			? value.message
			: typeof value === "string"
				? value
				: stringProperty(value, ["message", "detail"]);
	if (!raw) return undefined;
	return raw
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
		.replace(
			/\b(password|token|secret|api[_-]?key|authorization)\s*[=:]\s*\S+/gi,
			"$1=<redacted>",
		)
		.replace(/:\/\/[^@\s/]+@/g, "://<redacted>@")
		.replace(/'(?:[^']|'')*'/g, "'<redacted>'")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function safeLabel(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.replace(/[^a-zA-Z0-9_.:-]/g, "_")
		.slice(0, MAX_ERROR_LABEL_LENGTH);
}

function errorClass(value: unknown): string | undefined {
	if (value instanceof Error) return safeLabel(value.name);
	return safeLabel(stringProperty(value, ["name"]));
}

function errorCode(value: unknown): string | undefined {
	const direct = stringProperty(value, ["code", "sqlState", "sqlstate"]);
	if (direct) return safeLabel(direct);
	if (!value || typeof value !== "object") return undefined;
	return safeLabel(
		stringProperty((value as { details?: unknown }).details, [
			"error_code",
			"code",
			"sqlState",
			"sqlstate",
		]),
	);
}

function errorCause(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	return (value as { cause?: unknown }).cause;
}

export function safeErrorDimensions(
	error: unknown,
): Record<string, string | undefined> {
	let cause = errorCause(error);
	let causeDepth = 0;
	let nestedCode: string | undefined;
	let nestedMessage: string | undefined;
	let nestedClass: string | undefined;
	const visited = new Set<object>();
	while (cause !== undefined && causeDepth < MAX_CAUSE_DEPTH) {
		if (typeof cause === "object" && cause !== null) {
			if (visited.has(cause)) break;
			visited.add(cause);
		}
		nestedCode ??= errorCode(cause);
		nestedMessage ??= sanitizedMessage(cause);
		nestedClass ??= errorClass(cause);
		cause = errorCause(cause);
		causeDepth += 1;
	}

	return {
		err_class: errorClass(error) ?? safeLabel(typeof error),
		err: sanitizedMessage(error),
		err_code: errorCode(error),
		cause_class: nestedClass,
		cause_message: nestedMessage,
		cause_code: nestedCode,
	};
}
