// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPatchWorkItem = vi.fn();
const SESSION_USER = { id: "agent-1", displayName: "Agent" };

vi.mock("@/app/_facades/work/items.server", () => ({
	deleteWorkItem: vi.fn(),
	getWorkItem: vi.fn(),
	patchWorkItem: (...args: unknown[]) => mockPatchWorkItem(...args),
	WorkItemForbiddenError: class WorkItemForbiddenError extends Error {},
	WorkItemNotFoundError: class WorkItemNotFoundError extends Error {},
	WorkItemsBackendNotReadyError: class WorkItemsBackendNotReadyError extends Error {},
}));

vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));

vi.mock("@/bootstrap/http", () => ({
	wrapRouteHandlerWithLogging:
		(_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
		(request: Request, context: unknown) =>
			handler(
				{ log: { info: vi.fn() } },
				request,
				SESSION_USER,
				context,
			),
}));

import { PATCH } from "@/app/api/v1/work/items/[id]/route";

function request(body: unknown) {
	return new NextRequest("http://localhost/api/v1/work/items/task.5001", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const context = { params: Promise.resolve({ id: "task.5001" }) };

describe("PATCH /api/v1/work/items/:id", () => {
	beforeEach(() => vi.clearAllMocks());

	it("rejects a body id that differs from the path id", async () => {
		const response = await PATCH(
			request({ id: "task.9999", set: { title: "wrong target" } }),
			context,
		);

		expect(response.status).toBe(400);
		expect(mockPatchWorkItem).not.toHaveBeenCalled();
	});

	it("binds the mutation to the path id", async () => {
		mockPatchWorkItem.mockResolvedValue({
			id: "task.5001",
			type: "task",
			title: "right target",
			status: "needs_implement",
			node: "poly",
			assignees: [],
			externalRefs: [],
			labels: [],
			specRefs: [],
			revision: 2,
			deployVerified: false,
			createdAt: "2026-10-02T12:00:00.000Z",
			updatedAt: "2026-10-02T12:01:00.000Z",
		});
		await PATCH(request({ set: { title: "right target" } }), context);

		expect(mockPatchWorkItem).toHaveBeenCalledWith(
			{ id: "task.5001", set: { title: "right target" } },
			{ id: "agent-1" },
		);
	});
});
