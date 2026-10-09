// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Typed, versioned result of one scheduled algorithm-evaluation run.
 *
 * The report deliberately keeps source facts as citations instead of numeric
 * rollups: canonical read tools own arithmetic, while the model interprets the
 * facts and chooses one falsifiable next experiment.
 */
import { z } from "zod";

export const POLY_ALGORITHM_EVALUATION_SCHEMA_VERSION =
	"poly-algorithm-evaluation.v1" as const;

export const PolyAlgorithmEvidenceCitationSchema = z.object({
	id: z.string().min(1),
	source: z.enum(["account_read", "knowledge", "edo"]),
	factPath: z.string().min(1),
	observedAt: z.string().datetime().nullable(),
	note: z.string().min(1),
});

export const PolyAlgorithmFindingSchema = z.object({
	rank: z.number().int().min(1).max(3),
	claim: z.string().min(1),
	confidencePct: z.number().int().min(0).max(100),
	evidenceIds: z.array(z.string().min(1)).min(1),
});

export const PolyAlgorithmGapSchema = z.object({
	code: z.enum([
		"account_read_unavailable",
		"algorithm_identity_missing",
		"evidence_incomplete",
		"evidence_stale",
		"paper_fidelity_unproven",
		"edo_attribution_unstamped",
		"edo_retry_idempotency_unproven",
		"persistence_failed",
	]),
	requiredFact: z.string().min(1),
	reason: z.string().min(1),
});

export const PolyAlgorithmNextExperimentSchema = z.object({
	title: z.string().min(1),
	hypothesis: z.string().min(1),
	metric: z.string().min(1),
	expectedDirection: z.string().min(1),
	evaluateAt: z.string().datetime(),
	riskBound: z.string().min(1),
	stopCondition: z.string().min(1),
	hypothesisId: z.string().min(1),
});

export const PolyAlgorithmPersistenceSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("committed"),
		tool: z.literal("core__edo_hypothesize"),
		hypothesisId: z.string().min(1),
		committed: z.literal(true),
	}),
	z.object({
		status: z.literal("reused"),
		hypothesisId: z.string().min(1),
		committed: z.literal(false),
	}),
	z.object({
		status: z.literal("failed"),
		hypothesisId: z.string().min(1),
		committed: z.literal(false),
		reason: z.string().min(1),
	}),
]);

export const PolyAlgorithmEvaluationReportSchema = z
	.object({
		schemaVersion: z.literal(POLY_ALGORITHM_EVALUATION_SCHEMA_VERSION),
		verdict: z.enum(["experiment_ready", "gap"]),
		algorithm: z.object({
			algorithmId: z.string().min(1).nullable(),
			algorithmVersionId: z.string().min(1).nullable(),
			configHash: z.string().min(1).nullable(),
		}),
		evidence: z.array(PolyAlgorithmEvidenceCitationSchema).min(1).max(20),
		gaps: z.array(PolyAlgorithmGapSchema).max(10),
		findings: z.array(PolyAlgorithmFindingSchema).min(1).max(3),
		nextExperiment: PolyAlgorithmNextExperimentSchema,
		persistence: PolyAlgorithmPersistenceSchema,
		summary: z.string().min(1),
	})
	.superRefine((report, ctx) => {
		const evidenceIds = new Set(report.evidence.map((item) => item.id));
		for (const finding of report.findings) {
			for (const evidenceId of finding.evidenceIds) {
				if (!evidenceIds.has(evidenceId)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["findings", finding.rank - 1, "evidenceIds"],
						message: `Finding cites unknown evidence id: ${evidenceId}`,
					});
				}
			}
		}

		const expectedRanks = report.findings.map((_, index) => index + 1);
		if (
			report.findings.some(
				(finding, index) => finding.rank !== expectedRanks[index],
			)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["findings"],
				message: "Finding ranks must be contiguous and start at one",
			});
		}

		if (report.verdict === "experiment_ready") {
			if (report.gaps.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["gaps"],
					message: "An experiment-ready report cannot contain evidence gaps",
				});
			}
			for (const [field, value] of Object.entries(report.algorithm)) {
				if (value === null) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["algorithm", field],
						message:
							"Experiment-ready reports require complete algorithm identity",
					});
				}
			}
			if (report.persistence.status === "failed") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["persistence"],
					message: "Experiment-ready reports require durable persistence",
				});
			}
		}

		if (
			report.persistence.status === "failed" &&
			!report.gaps.some((gap) => gap.code === "persistence_failed")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["gaps"],
				message: "A failed persistence attempt must be reported as a typed gap",
			});
		}

		if (
			report.nextExperiment.hypothesisId !== report.persistence.hypothesisId
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["nextExperiment", "hypothesisId"],
				message:
					"Next experiment must reference the committed, reused, or attempted hypothesis id",
			});
		}
	});

export type PolyAlgorithmEvaluationReport = z.infer<
	typeof PolyAlgorithmEvaluationReportSchema
>;
