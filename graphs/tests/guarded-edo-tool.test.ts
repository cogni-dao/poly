// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
	createGuardedEdoTool,
	ScheduledGraphHypothesisIdSchema,
} from "../src/graphs/guarded-edo-tool";

describe("scheduled graph EDO guard", () => {
	function createKnowledgeRead(
		result: Record<string, unknown> = {
			mode: "get",
			entries: [],
			totalFound: 0,
		},
	) {
		return new DynamicStructuredTool({
			name: "core__knowledge_read",
			description: "read",
			schema: z.object({ id: z.string() }),
			func: async () => JSON.stringify(result),
		});
	}

	it("rejects ids that bypass the live knowledge shape", () => {
		expect(
			ScheduledGraphHypothesisIdSchema.safeParse("valid-hypothesis").success,
		).toBe(true);
		expect(
			ScheduledGraphHypothesisIdSchema.safeParse("poly:dated-row").success,
		).toBe(false);
		expect(
			ScheduledGraphHypothesisIdSchema.safeParse("one-two-three-four-five")
				.success,
		).toBe(false);
	});

	it("blocks a malformed id before the raw writer runs", async () => {
		const execute = vi.fn(async () => JSON.stringify({ committed: true }));
		const raw = new DynamicStructuredTool({
			name: "core__edo_hypothesize",
			description: "raw",
			schema: z.record(z.unknown()),
			func: execute,
		});
		const guarded = createGuardedEdoTool(raw, createKnowledgeRead(), {
			domain: "strategy",
			sourceRef: "story.5017/test/v1",
			sourceNode: "test-graph",
			requiredTag: "test-graph-v1",
		});

		await expect(
			guarded.invoke({
				id: "strategy:dated-row",
				title: "A falsifiable title",
				content: "A falsifiable statement with a bounded outcome.",
				evaluateAt: "2026-10-19T20:00:00.000Z",
			}),
		).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
	});

	it("pins domain and provenance before invoking the raw writer", async () => {
		const execute = vi.fn(async () => JSON.stringify({ committed: true }));
		const raw = new DynamicStructuredTool({
			name: "core__edo_hypothesize",
			description: "raw",
			schema: z.record(z.unknown()),
			func: execute,
		});
		const guarded = createGuardedEdoTool(raw, createKnowledgeRead(), {
			domain: "strategy",
			sourceRef: "story.5017/test/v1",
			sourceNode: "test-graph",
			requiredTag: "test-graph-v1",
		});

		await guarded.invoke({
			id: "valid-hypothesis",
			title: "A falsifiable title",
			content: "A falsifiable statement with a bounded outcome.",
			evaluateAt: "2026-10-19T20:00:00.000Z",
		});

		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "valid-hypothesis",
				domain: "strategy",
				sourceType: "agent",
				sourceRef: "story.5017/test/v1",
				sourceNode: "test-graph",
				tags: ["test-graph-v1"],
			}),
			undefined,
			expect.objectContaining({ runName: "core__edo_hypothesize" }),
		);
	});

	it("reuses a matching graph hypothesis without invoking the raw writer", async () => {
		const execute = vi.fn(async () => JSON.stringify({ committed: true }));
		const raw = new DynamicStructuredTool({
			name: "core__edo_hypothesize",
			description: "raw",
			schema: z.record(z.unknown()),
			func: execute,
		});
		const guarded = createGuardedEdoTool(
			raw,
			createKnowledgeRead({
				mode: "get",
				entries: [
					{
						id: "valid-hypothesis",
						domain: "strategy",
						title: "Existing",
						sourceType: "agent",
						tags: ["test-graph-v1"],
					},
				],
				totalFound: 1,
			}),
			{
				domain: "strategy",
				sourceRef: "story.5017/test/v1",
				sourceNode: "test-graph",
				requiredTag: "test-graph-v1",
			},
		);

		const result = await guarded.invoke({
			id: "valid-hypothesis",
			title: "A falsifiable title",
			content: "A falsifiable statement with a bounded outcome.",
			evaluateAt: "2026-10-19T20:00:00.000Z",
		});

		expect(JSON.parse(result as string)).toEqual(
			expect.objectContaining({ reused: true, committed: false }),
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("unwraps nested ToolMessage content before deciding reuse", async () => {
		const execute = vi.fn(async () => JSON.stringify({ committed: true }));
		const raw = new DynamicStructuredTool({
			name: "core__edo_hypothesize",
			description: "raw",
			schema: z.record(z.unknown()),
			func: execute,
		});
		const wrappedRead = new DynamicStructuredTool({
			name: "core__knowledge_read",
			description: "read",
			schema: z.object({ id: z.string() }),
			func: async () => ({
				content: JSON.stringify({
					mode: "get",
					entries: [
						{
							id: "valid-hypothesis",
							domain: "strategy",
							tags: ["test-graph-v1"],
						},
					],
					totalFound: 1,
				}),
			}),
		});
		const guarded = createGuardedEdoTool(raw, wrappedRead, {
			domain: "strategy",
			sourceRef: "story.5017/test/v1",
			sourceNode: "test-graph",
			requiredTag: "test-graph-v1",
		});

		const result = await guarded.invoke({
			id: "valid-hypothesis",
			title: "A falsifiable title",
			content: "A falsifiable statement with a bounded outcome.",
			evaluateAt: "2026-10-19T20:00:00.000Z",
		});

		expect(JSON.parse(result as string)).toEqual(
			expect.objectContaining({ reused: true, committed: false }),
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("pins bootstrap semantics before the raw writer", async () => {
		const execute = vi.fn(async () => JSON.stringify({ committed: true }));
		const raw = new DynamicStructuredTool({
			name: "core__edo_hypothesize",
			description: "raw",
			schema: z.record(z.unknown()),
			func: execute,
		});
		const guarded = createGuardedEdoTool(raw, createKnowledgeRead(), {
			domain: "strategy",
			sourceRef: "story.5017/test/v1",
			sourceNode: "test-graph",
			requiredTag: "test-graph-v1",
			pinnedHypotheses: {
				"evidence-bootstrap": {
					title: "Restore canonical evidence",
					content: "Canonical evidence must exist before strategy selection.",
					evidenceForIds: [],
				},
			},
		});

		await guarded.invoke({
			id: "evidence-bootstrap",
			title: "Invented winning strategy",
			content: "Place money on an unsupported strategy.",
			evaluateAt: "2026-10-19T20:00:00.000Z",
			evidenceForIds: ["invented-evidence"],
		});

		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Restore canonical evidence",
				content: "Canonical evidence must exist before strategy selection.",
				evidenceForIds: [],
			}),
			undefined,
			expect.objectContaining({ runName: "core__edo_hypothesize" }),
		);
	});
});
