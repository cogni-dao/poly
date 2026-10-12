// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Graph-local guard for the raw EDO hypothesis tool.
 *
 * The shared EDO contract intentionally accepts broad knowledge ids and
 * model-supplied provenance. These two scheduled graphs write into Poly's
 * curated strategy domain, whose live contribution shape is narrower. This
 * wrapper validates that shape and pins graph-owned provenance before the
 * underlying capability can write.
 */
import {
	EDO_HYPOTHESIZE_NAME,
	EdoHypothesizeInputSchema,
	KNOWLEDGE_READ_NAME,
} from "@cogni/ai-tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
	DynamicStructuredTool,
	type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";

export const ScheduledGraphHypothesisIdSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+){0,3}$/);

const ScheduledGraphEdoInputSchema = EdoHypothesizeInputSchema.omit({
	domain: true,
	sourceType: true,
	sourceRef: true,
	sourceNode: true,
}).extend({
	id: ScheduledGraphHypothesisIdSchema,
});

export interface GuardedEdoToolOptions {
	readonly domain: "strategy";
	readonly sourceRef: string;
	readonly sourceNode: string;
	readonly requiredTag: string;
}

interface KnowledgeReadResult {
	readonly error?: unknown;
	readonly entries?: ReadonlyArray<{
		readonly id?: unknown;
		readonly domain?: unknown;
		readonly title?: unknown;
		readonly confidencePct?: unknown;
		readonly sourceType?: unknown;
		readonly tags?: unknown;
	}>;
}

function parseToolJson(result: unknown): Record<string, unknown> | null {
	if (typeof result !== "string") {
		return result !== null && typeof result === "object"
			? (result as Record<string, unknown>)
			: null;
	}
	try {
		const parsed: unknown = JSON.parse(result);
		return parsed !== null && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Replace the raw EDO tool while retaining its canonical tool id. */
export function createGuardedEdoTool(
	underlying: StructuredToolInterface,
	knowledgeRead: StructuredToolInterface,
	options: GuardedEdoToolOptions,
): StructuredToolInterface {
	return new DynamicStructuredTool({
		name: EDO_HYPOTHESIZE_NAME,
		description:
			"File one bounded Poly strategy hypothesis. The graph pins domain and provenance; provide a 1-4 segment lowercase-kebab id with at most 40 characters.",
		schema: ScheduledGraphEdoInputSchema,
		func: async (
			input: z.infer<typeof ScheduledGraphEdoInputSchema>,
			_runManager?: unknown,
			config?: RunnableConfig,
		): Promise<string> => {
			const readExisting = async (): Promise<KnowledgeReadResult | null> => {
				const result = await knowledgeRead.invoke({ id: input.id }, config);
				return parseToolJson(result) as KnowledgeReadResult | null;
			};
			const reuseOrConflict = (
				read: KnowledgeReadResult | null,
			): string | null => {
				if (read === null || read.error !== undefined) {
					return JSON.stringify({
						error: "preflight_read_failed",
						message:
							"Could not verify whether the hypothesis id already exists",
						committed: false,
					});
				}
				const existing = read.entries?.[0];
				if (existing === undefined) return null;
				const tags = Array.isArray(existing.tags) ? existing.tags : [];
				if (
					existing.id === input.id &&
					existing.domain === options.domain &&
					tags.includes(options.requiredTag)
				) {
					return JSON.stringify({
						entry: existing,
						reused: true,
						committed: false,
						message: `Hypothesis '${input.id}' already exists and was reused without a write`,
					});
				}
				return JSON.stringify({
					error: "hypothesis_id_conflict",
					message: `Hypothesis id '${input.id}' exists without the required graph tag`,
					committed: false,
				});
			};

			const beforeWrite = reuseOrConflict(await readExisting());
			if (beforeWrite !== null) return beforeWrite;

			const result = await underlying.invoke(
				{
					...input,
					domain: options.domain,
					sourceType: "agent",
					sourceRef: options.sourceRef,
					sourceNode: options.sourceNode,
					tags: [...new Set([...(input.tags ?? []), options.requiredTag])],
				},
				config,
			);

			const parsed = parseToolJson(result);
			if (parsed?.error !== undefined) {
				const afterFailure = reuseOrConflict(await readExisting());
				if (
					afterFailure !== null &&
					!afterFailure.includes("preflight_read_failed")
				) {
					return afterFailure;
				}
			}
			return typeof result === "string" ? result : JSON.stringify(result);
		},
	}) as StructuredToolInterface;
}

/** Filter to the graph allowlist and replace the raw EDO writer with its guard. */
export function guardScheduledGraphTools(
	tools: ReadonlyArray<StructuredToolInterface>,
	allowedToolIds: ReadonlySet<string>,
	options: GuardedEdoToolOptions,
): StructuredToolInterface[] {
	const knowledgeRead = tools.find((tool) => tool.name === KNOWLEDGE_READ_NAME);
	const hasEdo = tools.some((tool) => tool.name === EDO_HYPOTHESIZE_NAME);
	if (hasEdo && knowledgeRead === undefined) {
		throw new Error("Guarded EDO tool requires the knowledge-read tool");
	}

	return tools
		.filter((tool) => allowedToolIds.has(tool.name))
		.map((tool) =>
			tool.name === EDO_HYPOTHESIZE_NAME
				? createGuardedEdoTool(
						tool,
						knowledgeRead as StructuredToolInterface,
						options,
					)
				: tool,
		);
}
