// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Opaque keyset cursor for the Doltgres work-items read model.
 */

export class InvalidCursorError extends Error {
	constructor(message = "invalid cursor") {
		super(message);
		this.name = "InvalidCursorError";
	}
}

export type WorkItemCursor = {
	p: number | null;
	r: number | null;
	ts: string;
	id: string;
};

export function encodeCursor(cursor: WorkItemCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): WorkItemCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw new InvalidCursorError();
	}

	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("p" in parsed) ||
		!("r" in parsed) ||
		!("ts" in parsed) ||
		!("id" in parsed)
	) {
		throw new InvalidCursorError();
	}

	const value = parsed as Record<string, unknown>;
	const p = value.p === null ? null : Number(value.p);
	const r = value.r === null ? null : Number(value.r);
	if (p !== null && !Number.isFinite(p)) throw new InvalidCursorError();
	if (r !== null && !Number.isFinite(r)) throw new InvalidCursorError();

	return { p, r, ts: String(value.ts), id: String(value.id) };
}
