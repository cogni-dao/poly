// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bounded useful-work proof. The committed ledger PK winner alone can dispatch.
 * Unknown commits/placements and every replay are readback-only. No helper-direct orders.
 */
import { createHash } from "node:crypto";
import type {
	GetOrderResult,
	NormalizedMarket,
	OrderIntent,
	OrderReceipt,
} from "@cogni/poly-market-provider";
import { z } from "zod";
import {
	type QualificationChallenge,
	type QualificationCompanion,
	type QualificationHelper,
	type QualificationReadiness,
	qualificationCompanion,
	qualificationHelper,
	qualificationOperation,
	qualificationReadiness,
	qualificationReadinessMap,
	qualificationSubject,
} from "@/contracts/deploy.qualification.v1.contract";
import { assertQualificationCompanions, QualificationError } from "./challenge";
import type { QualificationFixture } from "./fixtures";

/** Configured native HTTP resource. Features never construct fetch or adapter clients. */
export interface QualificationCompanionTransport {
	binding: string;
	open(signal: AbortSignal): {
		signal: AbortSignal;
		get(path: string): Promise<Response>;
	};
}

/** Select the safe useful-work intent through injected market discovery. */
export function createQualificationIntentSelector(
	discover: (signal: AbortSignal) => Promise<NormalizedMarket[]>,
) {
	return async (signal: AbortSignal) => {
		const markets = await discover(signal);
		signal.throwIfAborted();
		const market = markets.find(
			(m) =>
				m.active &&
				Date.parse(m.resolvesAt) > Date.now() &&
				typeof m.attributes.conditionId === "string" &&
				m.outcomes.some((o) => o.label.toUpperCase() === "YES"),
		);
		const outcome = market?.outcomes.find(
			(o) => o.label.toUpperCase() === "YES",
		);
		if (!market || !outcome)
			throw new QualificationError("qualification_market_unavailable");
		return {
			market_id: `prediction-market:polymarket:${market.attributes.conditionId}`,
			outcome: outcome.label,
		};
	};
}

export async function observePaperCompanion(
	transport: QualificationCompanionTransport,
	declared: QualificationReadiness,
	signal: AbortSignal,
	now: () => Date = () => new Date(),
) {
	signal.throwIfAborted();
	const readiness = qualificationReadiness.parse(declared);
	const base = new URL(transport.binding);
	if (
		readiness.port !== 9100 ||
		base.port !== String(readiness.port) ||
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== "/"
	)
		throw new QualificationError("paper_binding_invalid");
	// The injected transport opens one native budget for all three reads.
	const { signal: observationSignal, get } = transport.open(signal);
	const identity = async () => {
		const response = await get("/version");
		if (response.status !== 200) {
			await response.body?.cancel();
			throw new QualificationError("paper_helper_unreachable");
		}
		const value = qualificationHelper.parse(await response.json());
		observationSignal.throwIfAborted();
		return value;
	};
	const before = await identity();
	const response = await get(readiness.path);
	await response.body?.cancel();
	observationSignal.throwIfAborted();
	if (response.status !== 200)
		throw new QualificationError("companion_readiness_failed");
	const observedAt = now().toISOString();
	const after = await identity();
	if (before.buildSha !== after.buildSha || before.bootId !== after.bootId)
		throw new QualificationError("helper_identity_changed");
	return qualificationCompanion.parse({
		...after,
		ready: { ...readiness, status: 200, observedAt },
	});
}

const reservationSchema = qualificationSubject
	.extend({
		helper: qualificationHelper,
		companionReadiness: qualificationReadinessMap,
		reservedAt: z.iso.datetime(),
	})
	.strict();
type SavedOperation = {
	status: string;
	mode: string;
	order_id: string | null;
	client_order_id: string;
	attributes: Record<string, unknown> | null;
};
/** Ports are bound to the configured owner/account in composition, never request data. */
export interface QualificationDependencies {
	fixture: QualificationFixture;
	checkFixture(): Promise<void>;
	helper(
		signal: AbortSignal,
		readiness: QualificationReadiness,
	): Promise<QualificationCompanion>;
	selectIntent(
		signal: AbortSignal,
	): Promise<Pick<OrderIntent, "market_id" | "outcome">>;
	claim(
		intent: OrderIntent,
		ids: ReturnType<typeof qualificationOperationIds>,
		observedAt: Date,
	): Promise<{ inserted: boolean; mode: string }>;
	load(
		ids: ReturnType<typeof qualificationOperationIds>,
	): Promise<SavedOperation | null>;
	place(intent: OrderIntent, signal: AbortSignal): Promise<OrderReceipt>;
	getOrder(orderId: string, signal: AbortSignal): Promise<GetOrderResult>;
	cancel(orderId: string, signal: AbortSignal): Promise<void>;
	save(
		receipt: OrderReceipt,
		ids: ReturnType<typeof qualificationOperationIds>,
	): Promise<void>;
	now(): Date;
}
export function qualificationOperationIds(
	accountId: string,
	releaseId: string,
) {
	const hash = createHash("sha256")
		.update(JSON.stringify([accountId, releaseId]))
		.digest("hex");
	return {
		targetId: "b795c982-a623-5bc8-9986-8029855e831e",
		fillId: `qualification:${hash}`,
		clientOrderId: `0x${hash}`,
	};
}
function sameSubject(a: unknown, b: unknown): boolean {
	const x = qualificationSubject.parse(a),
		y = qualificationSubject.parse(b);
	return (
		x.nodeId === y.nodeId &&
		x.env === y.env &&
		x.releaseId === y.releaseId &&
		x.sourceSha === y.sourceSha &&
		x.bundleDigest === y.bundleDigest &&
		x.attemptId === y.attemptId &&
		x.allocation === y.allocation &&
		JSON.stringify(Object.entries(x.services).sort()) ===
			JSON.stringify(Object.entries(y.services).sort())
	);
}
function sameHelper(a: QualificationHelper, b: QualificationHelper) {
	return a.bootId === b.bootId && a.buildSha === b.buildSha;
}
function assertReceipt(
	receipt: OrderReceipt,
	clientId: string,
	orderId?: string,
) {
	if (
		receipt.client_order_id !== clientId ||
		(orderId && receipt.order_id !== orderId) ||
		!["filled", "canceled"].includes(receipt.status)
	)
		throw new QualificationError("paper_receipt_unproven");
}
export async function qualifyRelease(
	c: QualificationChallenge,
	deps: QualificationDependencies,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	assertQualificationCompanions(c);
	const readiness = c.companionReadiness["paper-trader"];
	if (!readiness)
		throw new QualificationError("qualification_companions_invalid");
	const observe = async () => {
		const started = deps.now().getTime();
		const observation = qualificationCompanion.parse(
			await deps.helper(signal, readiness),
		);
		signal.throwIfAborted();
		const observedAt = Date.parse(observation.ready.observedAt);
		if (
			observation.ready.port !== readiness.port ||
			observation.ready.path !== readiness.path ||
			observedAt < started ||
			observedAt > deps.now().getTime()
		)
			throw new QualificationError("companion_readiness_unproven");
		return observation;
	};
	await deps.checkFixture();
	signal.throwIfAborted();
	const before = await observe();
	signal.throwIfAborted();
	if (
		before.buildSha !== c.sourceSha ||
		(c.mode === "readback" &&
			(c.helperBootId !== before.bootId ||
				c.companionBootIds?.["paper-trader"] !== before.bootId))
	)
		throw new QualificationError("helper_identity_changed");
	const ids = qualificationOperationIds(deps.fixture.accountId, c.releaseId);
	const existing = await deps.load(ids);
	signal.throwIfAborted();
	let winner = false;
	if (!existing && c.mode === "qualify") {
		const market = await deps.selectIntent(signal);
		signal.throwIfAborted();
		const now = deps.now();
		const reservation = {
			...qualificationSubject.parse(c),
			helper: qualificationHelper.parse(before),
			companionReadiness: c.companionReadiness,
			reservedAt: now.toISOString(),
		};
		const intent: OrderIntent = {
			provider: "polymarket",
			...market,
			side: "BUY",
			size_usdc: 1,
			limit_price: 0.01,
			client_order_id: ids.clientOrderId,
			attributes: { release_qualification: reservation },
		};
		try {
			const claim = await deps.claim(intent, ids, now);
			winner = claim.inserted && claim.mode === "paper";
		} catch {
			// A lost COMMIT reply cannot confer dispatch authority. Read the saved operation only.
			winner = false;
		}
		if (winner) {
			signal.throwIfAborted();
			const receipt = await deps.place(intent, signal);
			if (receipt.client_order_id !== ids.clientOrderId)
				throw new QualificationError("paper_receipt_mismatch");
			// Cleanup gets the first opportunity after a known placement. A native DB
			// row lock must not consume the cancellation window. Retain the venue id
			// even if cancellation fails; a save failure remains the primary failure.
			let cleanupFailed = false;
			let cleanupFailure: unknown;
			try {
				signal.throwIfAborted();
				if (["open", "partial", "pending"].includes(receipt.status)) {
					await deps.cancel(receipt.order_id, signal);
				}
			} catch (error) {
				cleanupFailed = true;
				cleanupFailure = error;
			}
			await deps.save(receipt, ids);
			if (cleanupFailed) throw cleanupFailure;
			signal.throwIfAborted();
			const read = await deps.getOrder(receipt.order_id, signal);
			if (!("found" in read))
				throw new QualificationError("paper_order_not_found");
			assertReceipt(read.found, ids.clientOrderId, receipt.order_id);
			signal.throwIfAborted();
			await deps.save(read.found, ids);
		}
	}
	signal.throwIfAborted();
	const saved = await deps.load(ids);
	if (
		!saved ||
		!["filled", "canceled"].includes(saved.status) ||
		saved.mode !== "paper" ||
		!saved.order_id ||
		saved.client_order_id !== ids.clientOrderId
	)
		throw new QualificationError("qualification_receipt_missing");
	const reserved = reservationSchema.safeParse(
		saved.attributes?.release_qualification,
	);
	if (
		!reserved.success ||
		!sameSubject(reserved.data, c) ||
		JSON.stringify(Object.entries(reserved.data.companionReadiness).sort()) !==
			JSON.stringify(Object.entries(c.companionReadiness).sort()) ||
		!sameHelper(reserved.data.helper, before) ||
		deps.now().getTime() - Date.parse(reserved.data.reservedAt) > 60000 ||
		Date.parse(reserved.data.reservedAt) > deps.now().getTime()
	)
		throw new QualificationError("qualification_subject_stale");
	// Replays, conflicts, ambiguous writes and caller restarts NEVER place or cancel.
	const current = await deps.getOrder(saved.order_id, signal);
	if (!("found" in current))
		throw new QualificationError("paper_order_not_found");
	assertReceipt(current.found, ids.clientOrderId, saved.order_id);
	const after = await observe();
	signal.throwIfAborted();
	if (!sameHelper(before, after))
		throw new QualificationError("helper_identity_changed");
	return qualificationOperation.output.parse({
		...qualificationSubject.parse(c),
		status: "qualified",
		helper: { service: "paper-trader", ...qualificationHelper.parse(after) },
		companions: { "paper-trader": after },
		evidenceId: ids.clientOrderId,
		observedAt: deps.now().toISOString(),
		nonce: c.jti,
	});
}
