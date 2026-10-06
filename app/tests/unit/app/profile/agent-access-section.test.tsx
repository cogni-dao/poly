// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/profile/agent-access-section`
 * Purpose: UI behavior tests for Profile AI access approval and lifecycle controls.
 * Scope: Browser rendering and HTTP intent only; authorization and persistence are covered by backend tests.
 * Invariants: Approval fragments are removed, opaque identifiers stay hidden, and every lifecycle state has a human label.
 * Side-effects: fetch and browser history are mocked.
 * Links: src/app/(app)/profile/_components/AgentAccessSection.tsx
 * @public
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import type { AgentAccessRequestOwner } from "@cogni/poly-node-contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAccessSection } from "@/app/(app)/profile/_components/AgentAccessSection";

const BASE_REQUEST: AgentAccessRequestOwner = {
	id: "83a98e35-4fc7-42ac-8d87-ae4d59442ffd",
	agent_display_name: "Research Copilot",
	scope: "performance:read",
	expires_at: "2026-11-03T12:00:00.000Z",
	requested_at: "2026-10-03T12:00:00.000Z",
	decided_at: null,
	status: "pending",
	grant_id: null,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("AgentAccessSection", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/profile");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("explains the approval-link flow without credential or UUID setup", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(jsonResponse({ requests: [] }))),
		);

		render(<AgentAccessSection />);

		expect(await screen.findByText("No AI access yet")).toBeInTheDocument();
		expect(
			screen.getByText(
				"When an AI asks to connect, open its approval link while signed in.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/API key/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/billing account/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/command/i)).not.toBeInTheDocument();
	});

	it("previews and approves a fragment-carried request without displaying its token", async () => {
		const approvalToken = "opaque-approval-token-at-least-32-chars";
		window.history.replaceState(
			null,
			"",
			`/profile#agent-request=${approvalToken}`,
		);
		const operationOrder: string[] = [];
		const replaceState = window.history.replaceState.bind(window.history);
		vi.spyOn(window.history, "replaceState").mockImplementation(
			(...args: Parameters<History["replaceState"]>) => {
				operationOrder.push("replaceState");
				replaceState(...args);
			},
		);
		let approved = false;
		const fetchMock = vi.fn(
			async (
				input: RequestInfo | URL,
				_init?: RequestInit,
			): Promise<Response> => {
				operationOrder.push("fetch");
				const url = String(input);
				if (url.endsWith("/preview")) {
					return jsonResponse({ request: BASE_REQUEST });
				}
				if (url.endsWith("/decision")) {
					approved = true;
					return jsonResponse({
						request: {
							...BASE_REQUEST,
							status: "active",
							grant_id: "1c382e92-3a5f-477b-ac6e-f1d1bd4766e0",
							decided_at: "2026-10-03T12:05:00.000Z",
						},
					});
				}
				if (url === "/api/v1/poly/agent-access-requests") {
					return jsonResponse({
						requests: approved
							? [
									{
										...BASE_REQUEST,
										status: "active",
										grant_id: "1c382e92-3a5f-477b-ac6e-f1d1bd4766e0",
										decided_at: "2026-10-03T12:05:00.000Z",
									},
								]
							: [],
					});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();

		render(<AgentAccessSection />);

		expect(await screen.findByText("Review AI access")).toBeInTheDocument();
		expect(operationOrder[0]).toBe("replaceState");
		expect(screen.getByText("Research Copilot")).toBeInTheDocument();
		expect(screen.getByText("Read account data")).toBeInTheDocument();
		expect(window.location.hash).toBe("");
		expect(screen.queryByText(approvalToken)).not.toBeInTheDocument();

		const previewCall = fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith("/preview"),
		);
		expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual({
			approval_token: approvalToken,
		});

		await user.click(screen.getByRole("button", { name: "Approve access" }));

		expect(await screen.findByText("Active")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Revoke access" }),
		).toBeInTheDocument();
		const decisionCall = fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith("/decision"),
		);
		expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
			approval_token: approvalToken,
			decision: "approve",
		});
	});

	it("labels active and historical access and revokes an active grant", async () => {
		const statuses = [
			"pending",
			"active",
			"expired",
			"denied",
			"revoked",
		] as const;
		let revoked = false;
		const requests: AgentAccessRequestOwner[] = statuses.map(
			(status, index) => ({
				...BASE_REQUEST,
				id: `00000000-0000-4000-8000-00000000000${index}`,
				agent_display_name: `Agent ${status}`,
				status,
				grant_id:
					status === "active" ? "b4d430ad-8a88-4df6-840a-48ad74c63bef" : null,
				decided_at: status === "pending" ? null : "2026-10-03T12:05:00.000Z",
			}),
		);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/agent-grants/")) {
				revoked = true;
				return jsonResponse({ grant: {} });
			}
			return jsonResponse({
				requests: revoked
					? requests.map((request) =>
							request.status === "active"
								? { ...request, status: "revoked", grant_id: null }
								: request,
						)
					: requests,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();

		render(<AgentAccessSection />);

		for (const status of [
			"Pending",
			"Active",
			"Expired",
			"Denied",
			"Revoked",
		]) {
			expect(await screen.findByText(status)).toBeInTheDocument();
		}

		await user.click(screen.getByRole("button", { name: "Revoke access" }));

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Revoke access" }),
			).not.toBeInTheDocument();
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/v1/poly/agent-grants/b4d430ad-8a88-4df6-840a-48ad74c63bef",
			{ method: "DELETE", credentials: "include" },
		);
	});

	it("shows a non-disclosing message for an invalid approval link", async () => {
		window.history.replaceState(
			null,
			"",
			"/profile#agent-request=invalid-token",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn((input: RequestInfo | URL) =>
				Promise.resolve(
					String(input).endsWith("/preview")
						? jsonResponse({ error: "not_found" }, 404)
						: jsonResponse({ requests: [] }),
				),
			),
		);

		render(<AgentAccessSection />);

		expect(
			await screen.findByText(
				"This approval link is invalid, expired, or already used.",
			),
		).toBeInTheDocument();
		expect(window.location.hash).toBe("");
	});
});
