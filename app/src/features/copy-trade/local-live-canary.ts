// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/copy-trade/local-live-canary`
 * Purpose: Opt-in local live canary that sends one deterministic fixed input
 *   through the production mirror planner, INSERT_BEFORE_PLACE ledger,
 *   tenant authorization, Privy signer, and Polymarket CLOB executor.
 * Scope: Request-independent orchestration. HTTP/session binding stays in the
 *   route; adapter construction stays in the bootstrap container.
 * Invariants:
 *   - LOCAL_ONLY_AND_NEVER_CI — both conditions are checked before any DB,
 *     wallet, market, or CLOB call.
 *   - GEO_PERMISSION_IS_EXPLICIT — only a cached `permitted` verdict may
 *     proceed. Blocked, unreachable, and unproven all fail closed.
 *   - HARD_CAP_IS_SERVER_OWNED — callers cannot choose notional and two
 *     independent checks reject a code-owned value above $2.
 *   - PRODUCTION_PATH_ONLY — paper dispatch is refused; placement runs only
 *     through `runMirrorTick` and the existing tenant executor.
 *   - VERSION_CHANGES_IDENTITY — algorithm version is in fill identity, so a
 *     version bump produces a new client order id while a same-version retry
 *     remains idempotent across restarts.
 *   - CLEANUP_AFTER_PROOF — nonterminal placed orders are canceled after the
 *     receipt/status evidence is captured.
 * Side-effects: DB reads/writes, public market-constraint read, tenant wallet
 *   authorization/signing, one bounded CLOB placement, and best-effort cancel.
 * Links: task.1791070987, story.5018, docs/spec/poly-copy-trade-execution.md
 * @public
 */

import { createHash } from "node:crypto";
import type { Database } from "@cogni/db-client";
import {
	polyCopyTradeDecisions,
	polyCopyTradeFills,
} from "@cogni/poly-db-schema";
import {
	clientOrderIdFor,
	type Fill,
	type GetOrderResult,
	type LoggerPort,
	noopMetrics,
	normalizeLimitPriceToTick,
	type OrderIntent,
	type OrderReceipt,
} from "@cogni/poly-market-provider";
import {
	POLY_LOCAL_LIVE_CONFIRMATION,
	type PolyLocalLiveCanaryInput,
	type PolyLocalLiveCanaryOutput,
} from "@cogni/poly-node-contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { OrderLedger } from "@/features/trading";

import { runMirrorTick } from "./mirror-pipeline";
import { targetIdFromWallet } from "./target-id";
import type { MirrorTargetConfig } from "./types";

export const LOCAL_LIVE_CANARY_HARD_CAP_USDC = 2;

/**
 * The deliberate edit point for the second proof run. Change the version and
 * one parameter together; Next dev recompiles the route without deployment.
 */
export const LOCAL_LIVE_CANARY_ALGORITHM = Object.freeze({
	version: "local-live-canary-v1",
	orderUsdc: 1,
});

/** Dedicated synthetic provenance only; it is never enrolled as a copy target. */
const CANARY_TARGET_WALLET =
	"0x000000000000000000000000000000000000ca11" as const;

export type LocalLiveCanaryErrorCode =
	| "confirmation_required"
	| "local_development_only"
	| "ci_forbidden"
	| "live_dispatch_required"
	| "local_sha_unavailable"
	| "egress_geoblocked"
	| "egress_unproven"
	| "wallet_executor_unconfigured"
	| "market_ineligible"
	| "canary_execution_failed";

export class LocalLiveCanaryError extends Error {
	constructor(
		readonly code: LocalLiveCanaryErrorCode,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "LocalLiveCanaryError";
	}
}

export interface LocalLiveCanaryRuntimeGate {
	nodeEnv: string | undefined;
	appEnv: string | undefined;
	ci: string | undefined;
	paperEnforceMode: "paper" | undefined;
	localSha: string | undefined;
	confirmation: string;
	egress: {
		latched: boolean;
		lastVerdict: "blocked" | "permitted" | "unreachable" | null;
		egressCountry: string | null;
		egressRegion: string | null;
	};
}

/** Pure, exported so the money lane can prove every refusal without I/O. */
export function assertLocalLiveCanaryRuntime(
	gate: LocalLiveCanaryRuntimeGate,
): void {
	if (gate.confirmation !== POLY_LOCAL_LIVE_CONFIRMATION) {
		throw new LocalLiveCanaryError(
			"confirmation_required",
			`confirmation must equal ${POLY_LOCAL_LIVE_CONFIRMATION}`,
		);
	}
	if (gate.nodeEnv !== "development") {
		throw new LocalLiveCanaryError(
			"local_development_only",
			"live algorithm canary is available only with NODE_ENV=development",
		);
	}
	if (gate.ci !== undefined && gate.ci !== "" && gate.ci !== "false") {
		throw new LocalLiveCanaryError(
			"ci_forbidden",
			"live algorithm canary never runs when CI is set",
		);
	}
	if (gate.appEnv !== "production" || gate.paperEnforceMode === "paper") {
		throw new LocalLiveCanaryError(
			"live_dispatch_required",
			"live algorithm canary requires production adapters and refuses paper dispatch",
		);
	}
	if (!gate.localSha || gate.localSha.trim().length < 7) {
		throw new LocalLiveCanaryError(
			"local_sha_unavailable",
			"APP_BUILD_SHA must identify the local commit before live proof",
		);
	}
	if (gate.egress.latched || gate.egress.lastVerdict === "blocked") {
		throw new LocalLiveCanaryError(
			"egress_geoblocked",
			"Polymarket reports this process egress as geographically blocked",
			{
				verdict: gate.egress.lastVerdict,
				country: gate.egress.egressCountry,
				region: gate.egress.egressRegion,
			},
		);
	}
	if (gate.egress.lastVerdict !== "permitted") {
		throw new LocalLiveCanaryError(
			"egress_unproven",
			"live placement requires an explicit permitted verdict from Polymarket's geoblock oracle",
			{
				verdict: gate.egress.lastVerdict,
				country: gate.egress.egressCountry,
				region: gate.egress.egressRegion,
			},
		);
	}
}

export interface LocalLiveCanaryExecutor {
	placeIntent(intent: OrderIntent): Promise<OrderReceipt>;
	cancelOrder(orderId: string): Promise<void>;
	getOrder(orderId: string): Promise<GetOrderResult>;
	getMarketConstraints(
		tokenId: string,
		placement?: "limit" | "market_fok",
	): Promise<{
		minShares: number;
		minUsdcNotional?: number;
		tickSize?: number;
	}>;
}

export interface RunLocalLiveCanaryDeps {
	db: Database;
	ledger: OrderLedger;
	getExecutor: () => Promise<LocalLiveCanaryExecutor>;
	logger: LoggerPort;
	runtime: LocalLiveCanaryRuntimeGate;
	billingAccountId: string;
	createdByUserId: string;
	clock?: () => Date;
}

type CanaryResult = Omit<PolyLocalLiveCanaryOutput, "api">;

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function fixedInputId(
	input: PolyLocalLiveCanaryInput["fixed_input"],
): `0x${string}` {
	const canonical = JSON.stringify({
		condition_id: input.condition_id.toLowerCase(),
		token_id: input.token_id,
		outcome: input.outcome,
		price: input.price,
	});
	return `0x${sha256Hex(canonical)}`;
}

function correlationId(params: {
	billingAccountId: string;
	fixedInputId: string;
	algorithmVersion: string;
}): string {
	return `local-canary-${sha256Hex(
		`${params.billingAccountId}:${params.fixedInputId}:${params.algorithmVersion}`,
	).slice(0, 32)}`;
}

export async function runLocalLiveCanary(
	input: PolyLocalLiveCanaryInput,
	deps: RunLocalLiveCanaryDeps,
): Promise<CanaryResult> {
	assertLocalLiveCanaryRuntime(deps.runtime);

	const algorithm = LOCAL_LIVE_CANARY_ALGORITHM;
	if (
		!Number.isFinite(algorithm.orderUsdc) ||
		algorithm.orderUsdc <= 0 ||
		algorithm.orderUsdc > LOCAL_LIVE_CANARY_HARD_CAP_USDC
	) {
		throw new LocalLiveCanaryError(
			"canary_execution_failed",
			`algorithm order_usdc must be in (0, ${LOCAL_LIVE_CANARY_HARD_CAP_USDC}]`,
		);
	}

	const fixed_input_id = fixedInputId(input.fixed_input);
	const correlation_id = correlationId({
		billingAccountId: deps.billingAccountId,
		fixedInputId: fixed_input_id,
		algorithmVersion: algorithm.version,
	});
	// FillSource is a frozen cross-node contract. This local harness uses the
	// existing synthetic/chain namespace while its attributes make provenance
	// explicit; no chain transaction or external fill is claimed.
	const fill_id = `chain:local-canary:${algorithm.version}:${fixed_input_id.slice(2)}`;
	const target_id = targetIdFromWallet(CANARY_TARGET_WALLET);
	const expectedClientOrderId = clientOrderIdFor(
		deps.billingAccountId,
		target_id,
		fill_id,
	);
	const log = deps.logger.child({
		component: "local-live-algorithm-canary",
		correlation_id,
		algorithm_version: algorithm.version,
		fixed_input_id,
		fill_id,
		client_order_id: expectedClientOrderId,
	});

	const executor = await deps.getExecutor().catch((error: unknown) => {
		throw new LocalLiveCanaryError(
			"wallet_executor_unconfigured",
			error instanceof Error ? error.message : String(error),
		);
	});
	const constraints = await executor.getMarketConstraints(
		input.fixed_input.token_id,
		"limit",
	);
	const normalization = constraints.tickSize
		? normalizeLimitPriceToTick(input.fixed_input.price, constraints.tickSize)
		: ({ ok: true, price: input.fixed_input.price } as const);
	const normalizedPrice = normalization.ok
		? normalization.price
		: input.fixed_input.price;
	const constraintsKnown =
		Number.isFinite(constraints.minShares) &&
		constraints.minShares >= 0 &&
		constraints.minUsdcNotional !== undefined &&
		Number.isFinite(constraints.minUsdcNotional) &&
		constraints.minUsdcNotional >= 0;
	const minUsdcNotional = constraintsKnown
		? (constraints.minUsdcNotional ?? 0)
		: 0;
	const floorUsdc = Math.max(
		minUsdcNotional,
		Math.max(0, constraints.minShares) * normalizedPrice,
	);
	const marketEligibility = {
		eligible:
			constraintsKnown &&
			normalization.ok &&
			floorUsdc <= algorithm.orderUsdc + Number.EPSILON,
		min_shares: Math.max(0, constraints.minShares),
		min_usdc_notional: minUsdcNotional,
		floor_usdc: floorUsdc,
		normalized_price: normalizedPrice,
		tick_size: constraints.tickSize ?? null,
	};
	if (!marketEligibility.eligible) {
		throw new LocalLiveCanaryError(
			"market_ineligible",
			!constraintsKnown
				? "market minimum constraints are missing or invalid"
				: normalization.ok
					? `market floor ${floorUsdc.toFixed(6)} exceeds algorithm notional ${algorithm.orderUsdc.toFixed(6)}`
					: "fixed input price cannot be normalized to the market tick",
			{ market_eligibility: marketEligibility, correlation_id },
		);
	}

	const now = deps.clock ?? (() => new Date());
	const fill: Fill = {
		target_wallet: CANARY_TARGET_WALLET,
		fill_id,
		source: "chain",
		market_id: `prediction-market:polymarket:${input.fixed_input.condition_id.toLowerCase()}`,
		outcome: input.fixed_input.outcome,
		side: "BUY",
		price: normalizedPrice,
		size_usdc: algorithm.orderUsdc,
		observed_at: now().toISOString(),
		attributes: {
			asset: input.fixed_input.token_id,
			condition_id: input.fixed_input.condition_id.toLowerCase(),
			correlation_id,
			algorithm_version: algorithm.version,
			fixed_input_id,
			local_live_canary: true,
			observation_source: "local_live_canary_fixed_input",
		},
	};
	const target: MirrorTargetConfig = {
		target_id,
		target_wallet: CANARY_TARGET_WALLET,
		billing_account_id: deps.billingAccountId,
		created_by_user_id: deps.createdByUserId,
		sizing: { kind: "mirror_fill_exact" },
		placement: { kind: "mirror_limit" },
	};

	let placementReceipt: OrderReceipt | null = null;
	log.info(
		{
			event: "poly.local_live_canary.start",
			order_usdc: algorithm.orderUsdc,
			market_id: fill.market_id,
			token_id: input.fixed_input.token_id,
			market_floor_usdc: floorUsdc,
		},
		"local live algorithm canary: executing production mirror path",
	);

	await runMirrorTick({
		source: {
			fetchSince: async () => ({ fills: [fill], newSince: 0 }),
		},
		ledger: deps.ledger,
		placeIntent: async (intent) => {
			if (intent.size_usdc > LOCAL_LIVE_CANARY_HARD_CAP_USDC) {
				throw new LocalLiveCanaryError(
					"canary_execution_failed",
					`planner emitted ${intent.size_usdc} USDC above hard cap`,
				);
			}
			// The production ledger has already performed INSERT_BEFORE_PLACE at
			// this point. Stamp proof metadata before any external money I/O so a
			// crash after CLOB submission still leaves a correlatable DB row.
			const stamped = await deps.db
				.update(polyCopyTradeFills)
				.set({
					updatedAt: now(),
					attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
						{
							correlation_id,
							algorithm_version: algorithm.version,
							fixed_input_id,
							local_live_canary: true,
						},
					)}::jsonb`,
				})
				.where(
					and(
						eq(polyCopyTradeFills.billingAccountId, deps.billingAccountId),
						eq(polyCopyTradeFills.targetId, target_id),
						eq(polyCopyTradeFills.fillId, fill_id),
						eq(polyCopyTradeFills.clientOrderId, intent.client_order_id),
					),
				)
				.returning({ clientOrderId: polyCopyTradeFills.clientOrderId });
			if (stamped.length !== 1) {
				throw new LocalLiveCanaryError(
					"canary_execution_failed",
					"INSERT_BEFORE_PLACE ledger row was not available for correlation stamping",
					{ correlation_id },
				);
			}
			log.info(
				{
					event: "poly.local_live_canary.place_start",
					size_usdc: intent.size_usdc,
					limit_price: intent.limit_price,
				},
				"local live algorithm canary: authorization and placement starting",
			);
			placementReceipt = await executor.placeIntent(intent);
			log.info(
				{
					event: "poly.local_live_canary.place_complete",
					order_id: placementReceipt.order_id,
					order_status: placementReceipt.status,
				},
				"local live algorithm canary: CLOB receipt captured",
			);
			return placementReceipt;
		},
		getMarketConstraints: async () => constraints,
		target,
		getCursor: () => undefined,
		setCursor: () => undefined,
		logger: log,
		metrics: noopMetrics,
		clock: now,
	});

	const [decision] = await deps.db
		.select({
			outcome: polyCopyTradeDecisions.outcome,
			reason: polyCopyTradeDecisions.reason,
			intent: polyCopyTradeDecisions.intent,
			receipt: polyCopyTradeDecisions.receipt,
		})
		.from(polyCopyTradeDecisions)
		.where(
			and(
				eq(polyCopyTradeDecisions.billingAccountId, deps.billingAccountId),
				eq(polyCopyTradeDecisions.targetId, target_id),
				eq(polyCopyTradeDecisions.fillId, fill_id),
			),
		)
		.orderBy(desc(polyCopyTradeDecisions.decidedAt))
		.limit(1);
	const [ledgerBeforeCleanup] = await deps.db
		.select({
			clientOrderId: polyCopyTradeFills.clientOrderId,
			orderId: polyCopyTradeFills.orderId,
			status: polyCopyTradeFills.status,
			attributes: polyCopyTradeFills.attributes,
		})
		.from(polyCopyTradeFills)
		.where(
			and(
				eq(polyCopyTradeFills.billingAccountId, deps.billingAccountId),
				eq(polyCopyTradeFills.targetId, target_id),
				eq(polyCopyTradeFills.fillId, fill_id),
			),
		)
		.limit(1);

	const decisionOutcome =
		decision?.outcome === "placed" ||
		decision?.outcome === "skipped" ||
		decision?.outcome === "error"
			? decision.outcome
			: "error";
	const decisionIntent = decision?.intent as
		| Record<string, unknown>
		| null
		| undefined;
	const decisionSizeUsdc =
		typeof decisionIntent?.mirror_usdc === "number"
			? decisionIntent.mirror_usdc
			: null;
	if (
		decisionSizeUsdc === null ||
		!Number.isFinite(decisionSizeUsdc) ||
		decisionSizeUsdc <= 0 ||
		decisionSizeUsdc > LOCAL_LIVE_CANARY_HARD_CAP_USDC
	) {
		throw new LocalLiveCanaryError(
			"canary_execution_failed",
			"persisted decision intent is missing a valid capped mirror_usdc",
			{ correlation_id },
		);
	}
	const receiptFromDecision = decision?.receipt as
		| Record<string, unknown>
		| null
		| undefined;
	// TypeScript does not model assignment from the awaited pipeline callback;
	// recover the declared union after runMirrorTick has completed.
	const observedPlacementReceipt = placementReceipt as OrderReceipt | null;
	const orderId =
		observedPlacementReceipt?.order_id ??
		ledgerBeforeCleanup?.orderId ??
		(typeof receiptFromDecision?.order_id === "string"
			? receiptFromDecision.order_id
			: null);

	let clobStatus = observedPlacementReceipt?.status ?? null;
	let clobStatusSource: "get_order" | "placement_receipt" | "not_placed" =
		observedPlacementReceipt ? "placement_receipt" : "not_placed";
	if (orderId) {
		try {
			const statusResult = await executor.getOrder(orderId);
			if ("found" in statusResult) {
				clobStatus = statusResult.found.status;
				clobStatusSource = "get_order";
			}
		} catch (error) {
			log.warn(
				{
					event: "poly.local_live_canary.status_failed",
					order_id: orderId,
					err: error instanceof Error ? error.message : String(error),
				},
				"local live algorithm canary: CLOB status read failed; retaining placement receipt",
			);
		}
	}

	let cleanup: CanaryResult["cleanup"] = {
		attempted: false,
		status: orderId ? "already_terminal" : "not_needed",
		error: null,
	};
	if (
		orderId &&
		clobStatus !== "filled" &&
		clobStatus !== "canceled" &&
		clobStatus !== "error"
	) {
		cleanup = { attempted: true, status: "failed", error: null };
		try {
			await executor.cancelOrder(orderId);
			const canceled = await deps.db
				.update(polyCopyTradeFills)
				.set({
					status: "canceled",
					updatedAt: now(),
					attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
						{
							reason: "local_live_canary_cleanup",
							correlation_id,
							algorithm_version: algorithm.version,
						},
					)}::jsonb`,
				})
				.where(
					and(
						eq(polyCopyTradeFills.billingAccountId, deps.billingAccountId),
						eq(polyCopyTradeFills.targetId, target_id),
						eq(polyCopyTradeFills.fillId, fill_id),
						eq(
							polyCopyTradeFills.clientOrderId,
							ledgerBeforeCleanup?.clientOrderId ?? expectedClientOrderId,
						),
					),
				)
				.returning({ clientOrderId: polyCopyTradeFills.clientOrderId });
			if (canceled.length !== 1) {
				throw new Error("canceled CLOB order but ledger row was not found");
			}
			cleanup = { attempted: true, status: "canceled", error: null };
			log.info(
				{
					event: "poly.local_live_canary.cleanup_complete",
					order_id: orderId,
				},
				"local live algorithm canary: nonterminal order canceled",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			cleanup = {
				attempted: true,
				status: "failed",
				error: message.slice(0, 256),
			};
			log.error(
				{
					event: "poly.local_live_canary.cleanup_failed",
					order_id: orderId,
					err: message,
				},
				"local live algorithm canary: cancel failed; manual cleanup required",
			);
		}
	}

	const [ledgerAfterCleanup] = await deps.db
		.select({
			clientOrderId: polyCopyTradeFills.clientOrderId,
			orderId: polyCopyTradeFills.orderId,
			status: polyCopyTradeFills.status,
			attributes: polyCopyTradeFills.attributes,
		})
		.from(polyCopyTradeFills)
		.where(
			and(
				eq(polyCopyTradeFills.billingAccountId, deps.billingAccountId),
				eq(polyCopyTradeFills.targetId, target_id),
				eq(polyCopyTradeFills.fillId, fill_id),
			),
		)
		.limit(1);
	const ledger = ledgerAfterCleanup ?? ledgerBeforeCleanup;
	const ledgerAttributes = ledger?.attributes as
		| Record<string, unknown>
		| null
		| undefined;
	if (
		!ledger ||
		ledgerAttributes?.correlation_id !== correlation_id ||
		ledgerAttributes.algorithm_version !== algorithm.version
	) {
		throw new LocalLiveCanaryError(
			"canary_execution_failed",
			"persisted ledger evidence is missing the canary correlation or algorithm version",
			{ correlation_id },
		);
	}

	log.info(
		{
			event: "poly.local_live_canary.complete",
			decision_outcome: decisionOutcome,
			decision_reason: decision?.reason ?? null,
			decision_size_usdc: decisionSizeUsdc,
			ledger_status: ledger?.status ?? null,
			client_order_id: ledger?.clientOrderId ?? expectedClientOrderId,
			order_id: orderId,
			clob_status: clobStatus,
			cleanup_status: cleanup.status,
		},
		"local live algorithm canary: evidence complete",
	);

	return {
		schema_version: "poly.local-live-canary.v1",
		local_sha: deps.runtime.localSha as string,
		fixed_input_id,
		correlation_id,
		algorithm_version: algorithm.version,
		algorithm_parameter: { order_usdc: algorithm.orderUsdc },
		market_eligibility: marketEligibility,
		decision: {
			outcome: decisionOutcome,
			reason: decision?.reason ?? (decision ? null : "decision_missing"),
			size_usdc: decisionSizeUsdc,
		},
		ledger: {
			fill_id,
			client_order_id: ledger?.clientOrderId ?? null,
			order_id: ledger?.orderId ?? null,
			status:
				ledger?.status === "pending" ||
				ledger?.status === "open" ||
				ledger?.status === "filled" ||
				ledger?.status === "partial" ||
				ledger?.status === "canceled" ||
				ledger?.status === "error"
					? ledger.status
					: null,
			correlation_id: ledgerAttributes.correlation_id as string,
			algorithm_version: ledgerAttributes.algorithm_version as string,
		},
		clob: {
			order_id: orderId,
			status: clobStatus,
			status_source: clobStatusSource,
		},
		cleanup,
	};
}
