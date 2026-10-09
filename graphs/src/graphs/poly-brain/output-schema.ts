// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/graphs/poly-brain/output-schema`
 * Purpose: Typed v1 result for Poly's recurring strategy review.
 * Scope: Pure Zod contract. No I/O or runtime policy.
 * Invariants: BOUNDED_COMPARISON, EXACTLY_ONE_NEXT_EXPERIMENT, EDO_RECEIPT_REQUIRED.
 * Side-effects: none
 * Links: task.1791070993, story.5017
 * @public
 */

import { EDO_HYPOTHESIZE_NAME } from "@cogni/ai-tools";
import { z } from "zod";

export const POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION =
	"poly-brain.strategy-review.v1" as const;

export const POLY_BRAIN_DAO_OBJECTIVE =
	"Poly learns which ethical profit strategy to test next" as const;

export const PolyBrainEvidenceKindSchema = z.enum([
	"knowledge",
	"work_item",
	"repo",
	"web",
	"account",
]);

export const PolyBrainEvidenceRefSchema = z.object({
	kind: PolyBrainEvidenceKindSchema,
	ref: z.string().min(1),
	finding: z.string().min(1),
});

export const PolyBrainStrategyDirectionSchema = z.object({
	id: z.string().min(1),
	rank: z.number().int().min(1).max(4),
	title: z.string().min(1),
	thesis: z.string().min(1),
	evidenceRefs: z.array(z.string().min(1)).min(1),
	ethicalFit: z.enum(["pass", "question", "fail"]),
	confidence: z.enum(["low", "medium", "high"]),
});

export const PolyBrainNextExperimentSchema = z.object({
	strategyId: z.string().min(1),
	title: z.string().min(1),
	hypothesis: z.string().min(1),
	method: z.string().min(1),
	successCriterion: z.string().min(1),
	failureCriterion: z.string().min(1),
	timebox: z.string().min(1),
	workItemIds: z.array(z.string()).default([]),
});

const PolyBrainCommittedPersistenceSchema = z.object({
	status: z.literal("committed"),
	tool: z.literal(EDO_HYPOTHESIZE_NAME),
	hypothesisId: z.string().min(1),
	sourceRef: z.string().min(1),
	evaluateAt: z.string().datetime(),
	evidenceForIds: z.array(z.string().min(1)).min(1),
	committed: z.literal(true),
});

const PolyBrainReusedPersistenceSchema = z.object({
	status: z.literal("reused"),
	hypothesisId: z.string().min(1),
	sourceRef: z.string().min(1),
	evaluateAt: z.string().datetime(),
	evidenceForIds: z.array(z.string().min(1)).min(1),
	committed: z.literal(false),
});

const PolyBrainFailedPersistenceSchema = z.object({
	status: z.literal("failed"),
	hypothesisId: z.string().nullable(),
	sourceRef: z.string().min(1),
	committed: z.literal(false),
	error: z.string().min(1),
});

export const PolyBrainStrategyReviewV1Schema = z
	.object({
		schemaVersion: z.literal(POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION),
		objective: z.literal(POLY_BRAIN_DAO_OBJECTIVE),
		summary: z.string().min(1),
		evidence: z.array(PolyBrainEvidenceRefSchema).min(3).max(20),
		comparedStrategies: z.array(PolyBrainStrategyDirectionSchema).min(2).max(4),
		nextExperiment: PolyBrainNextExperimentSchema,
		persistence: z.discriminatedUnion("status", [
			PolyBrainCommittedPersistenceSchema,
			PolyBrainReusedPersistenceSchema,
			PolyBrainFailedPersistenceSchema,
		]),
		gaps: z.array(z.string()),
	})
	.superRefine((review, ctx) => {
		const strategyIds = review.comparedStrategies.map(
			(strategy) => strategy.id,
		);
		if (new Set(strategyIds).size !== strategyIds.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["comparedStrategies"],
				message: "strategy ids must be unique",
			});
		}

		const ranks = review.comparedStrategies
			.map((strategy) => strategy.rank)
			.sort((a, b) => a - b);
		if (!ranks.every((rank, index) => rank === index + 1)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["comparedStrategies"],
				message: "strategy ranks must be contiguous from 1",
			});
		}

		if (!strategyIds.includes(review.nextExperiment.strategyId)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["nextExperiment", "strategyId"],
				message: "next experiment must select a compared strategy",
			});
		}
	});

export type PolyBrainStrategyReviewV1 = z.infer<
	typeof PolyBrainStrategyReviewV1Schema
>;
