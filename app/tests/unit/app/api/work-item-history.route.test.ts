// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
	wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { GET } from "@/app/api/v1/work/items/[id]/history/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (
	ctx: unknown,
	request: Request,
	user: unknown,
	context: unknown,
) => Promise<Response>;
const ctx = {
	log: { info: vi.fn(), warn: vi.fn() },
	reqId: "test",
	routeId: "work.items.history",
};
const context = { params: Promise.resolve({ id: "task.5001" }) };
const entry = (commit: string) => ({
	version: commit,
	commit,
	at: "2026-11-01T00:00:00.000Z",
	actor: null,
	reason: "change",
	cites: [],
	changed: ["title"],
	diff: { title: { before: "old", after: "new", truncated: false } },
});

function get(query = "") {
	return (GET as unknown as Handler)(
		ctx,
		new Request(`http://localhost/api/v1/work/items/task.5001/history${query}`),
		{ id: "agent" },
		context,
	);
}

describe("work item history route with released handler", () => {
	it("returns refs pages with continuation and preserves the legacy history", async () => {
		const first = entry("abc123");
		const older = entry("def456");
		const history = vi.fn().mockResolvedValue([first, older]);
		const historyPage = vi
			.fn()
			.mockImplementation(async (_id, options) =>
				options.cursor
					? { entries: [older], nextCursor: null }
					: { entries: [first], nextCursor: first.commit },
			);
		vi.mocked(getContainer).mockReturnValue({
			doltgresWorkItems: {
				get: vi.fn().mockResolvedValue({}),
				history,
				historyPage,
			},
		} as never);

		const firstResponse = await get("?view=refs");
		expect(firstResponse.status).toBe(200);
		const firstPage = await firstResponse.json();
		expect(firstPage).toEqual({
			refs: [expect.objectContaining({ commit: first.commit })],
			nextCursor: first.commit,
		});
		expect(firstPage.refs[0]).not.toHaveProperty("diff");

		const olderResponse = await get(
			`?view=refs&cursor=${firstPage.nextCursor}`,
		);
		expect(olderResponse.status).toBe(200);
		expect(await olderResponse.json()).toEqual({
			refs: [expect.objectContaining({ commit: older.commit })],
			nextCursor: null,
		});
		expect(historyPage).toHaveBeenNthCalledWith(1, "task.5001", {
			cursor: undefined,
			limit: 20,
		});
		expect(historyPage).toHaveBeenNthCalledWith(2, "task.5001", {
			cursor: first.commit,
			limit: 20,
		});

		const legacyResponse = await get();
		expect(legacyResponse.status).toBe(200);
		expect(await legacyResponse.json()).toEqual({ items: [first, older] });
		expect(history).toHaveBeenCalledOnce();
	});
});
