// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
	decodeCursor,
	encodeCursor,
	type WorkItemCursor,
} from "@/adapters/server/db/doltgres/work-items-cursor";

describe("work-items cursor", () => {
	it("round-trips the complete keyset", () => {
		const cursor: WorkItemCursor = {
			p: 1,
			r: null,
			ts: "2026-10-02T12:00:00.000Z",
			id: "task.5001",
		};
		expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
	});

	it("rejects malformed and shape-invalid values", () => {
		expect(() => decodeCursor("not-a-cursor")).toThrow("invalid cursor");
		expect(() => decodeCursor("e30")).toThrow("invalid cursor");
	});
});
