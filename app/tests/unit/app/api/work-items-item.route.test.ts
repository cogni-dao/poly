// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextRequest } from "next/server";
import {
	ChangeReasonInvalidError,
	CitesInvalidError,
	CitesUnsupportedError,
	EntryResolverUnavailableError,
	EntryUnresolvedError,
	MetricBaselineUnavailableError,
	MovesInvalidError,
} from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPatchWorkItem = vi.fn();
const SESSION_USER = { id: "agent-1", displayName: "Agent" };

vi.mock("@/app/_facades/work/items.server", async () => {
	const pkg = await import("@cogni/work-items");
	return {
	ChangeReasonInvalidError: pkg.ChangeReasonInvalidError,
	CitesInvalidError: pkg.CitesInvalidError,
	CitesUnsupportedError: pkg.CitesUnsupportedError,
	EntryResolverUnavailableError: pkg.EntryResolverUnavailableError,
	EntryUnresolvedError: pkg.EntryUnresolvedError,
	WorkItemScoresInvalidError: class WorkItemScoresInvalidError extends Error {},
	WorkItemRevisionConflictError: class WorkItemRevisionConflictError extends Error {},
	deleteWorkItem: vi.fn(),
	getWorkItem: vi.fn(),
	patchWorkItem: (...args: unknown[]) => mockPatchWorkItem(...args),
	WorkItemForbiddenError: class WorkItemForbiddenError extends Error {},
	WorkItemNotFoundError: class WorkItemNotFoundError extends Error {},
	WorkItemsBackendNotReadyError: class WorkItemsBackendNotReadyError extends Error {},
	};
});

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
			request({ id: "task.9999", reason: "test change", set: { title: "wrong target" } }),
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
		await PATCH(
			request({ reason: "test change", set: { title: "right target" } }),
			context,
		);

		expect(mockPatchWorkItem).toHaveBeenCalledWith(
			{ id: "task.5001", reason: "test change", set: { title: "right target" } },
			{ id: "agent-1" },
		);
	});

	// task.0086: reason is required and cites are pinned by the adapter; each failure writes nothing.
	it("rejects a PATCH with no reason as 400 and writes nothing", async () => {
		const response = await PATCH(request({ set: { title: "no reason" } }), context);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe("invalid input");
		expect(body.issues.some((i: { path: unknown[] }) => i.path[0] === "reason")).toBe(true);
		expect(mockPatchWorkItem).not.toHaveBeenCalled();
	});

	it("maps an unresolved cite to 400 cite_unresolved", async () => {
		mockPatchWorkItem.mockRejectedValue(new EntryUnresolvedError(["no-such-atom"]));
		const response = await PATCH(
			request({ reason: "test change", cites: [{ id: "no-such-atom" }], set: { title: "t" } }),
			context,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "invalid input",
			errorCode: "cite_unresolved",
			ids: ["no-such-atom"],
		});
	});

	it("maps cites with no resolver wired to 400 cites_unsupported", async () => {
		mockPatchWorkItem.mockRejectedValue(new CitesUnsupportedError());
		const response = await PATCH(
			request({ reason: "test change", cites: [{ id: "some-atom" }], set: { title: "t" } }),
			context,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ errorCode: "cites_unsupported" });
	});

	it("maps a resolver failure to 503", async () => {
		mockPatchWorkItem.mockRejectedValue(new EntryResolverUnavailableError("hub down"));
		const response = await PATCH(
			request({ reason: "test change", cites: [{ id: "some-atom" }], set: { title: "t" } }),
			context,
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: "cites_unavailable" });
	});

	it("maps a ChangeReasonInvalidError from the adapter to 400 with an issue at reason", async () => {
		mockPatchWorkItem.mockRejectedValue(new ChangeReasonInvalidError("reason must be at most 25 words"));
		const response = await PATCH(
			request({ reason: "test change", set: { title: "t" } }),
			context,
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe("invalid input");
		expect(body.issues).toEqual([
			{ code: "custom", path: ["reason"], message: "reason must be at most 25 words" },
		]);
	});

	it("maps a CitesInvalidError from the adapter to 400 with issues at cites", async () => {
		mockPatchWorkItem.mockRejectedValue(new CitesInvalidError(["too many cites"]));
		const response = await PATCH(
			request({ reason: "test change", cites: [{ id: "a" }], set: { title: "t" } }),
			context,
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe("invalid input");
		expect(body.issues).toEqual([
			{ code: "custom", path: ["cites"], message: "too many cites" },
		]);
	});

	// story.0033: `set.moves` errors map through the package table, with the issue at `set.moves`.
	it("maps an unknown metric in set.moves to 400 cite_unresolved with an issue at set.moves", async () => {
		mockPatchWorkItem.mockRejectedValue(
			new EntryUnresolvedError(["no-such-metric"], "moves"),
		);
		const response = await PATCH(
			request({
				reason: "test change",
				set: { moves: [{ metricId: "no-such-metric", direction: "up" }] },
			}),
			context,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			errorCode: "cite_unresolved",
			ids: ["no-such-metric"],
			issues: [
				{
					path: ["set", "moves"],
					message: "metric not found or deprecated: no-such-metric",
				},
			],
		});
	});

	it("maps a bad moves list to 400 moves_invalid at set.moves", async () => {
		mockPatchWorkItem.mockRejectedValue(new MovesInvalidError(["too many moves"]));
		const response = await PATCH(
			request({ reason: "test change", set: { moves: [] } }),
			context,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			errorCode: "moves_invalid",
			issues: [{ path: ["set", "moves"], message: "too many moves" }],
		});
	});

	it("maps a baseline failure to 503 metric_baseline_unavailable", async () => {
		mockPatchWorkItem.mockRejectedValue(new MetricBaselineUnavailableError("metrics down"));
		const response = await PATCH(
			request({
				reason: "test change",
				set: { moves: [{ metricId: "m", direction: "up" }] },
			}),
			context,
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			errorCode: "metric_baseline_unavailable",
		});
	});
});
