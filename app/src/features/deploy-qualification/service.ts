// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bounded useful-work proof. The committed ledger PK winner alone can dispatch.
 * Unknown commits/placements and every replay are readback-only. No helper-direct orders.
 */
import { createHash } from "node:crypto";
import type {
	GetOrderResult,
	OrderIntent,
	OrderReceipt,
} from "@cogni/poly-market-provider";
import { z } from "zod";
import {
	type QualificationChallenge,
	type QualificationHelper,
	qualificationHelper,
	qualificationOperation,
	qualificationSubject,
} from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "./challenge";
import type { QualificationFixture } from "./fixtures";

const reservationSchema = qualificationSubject
	.extend({ helper: qualificationHelper, reservedAt: z.iso.datetime() })
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
	helper(signal: AbortSignal): Promise<QualificationHelper>;
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
	await deps.checkFixture();
	signal.throwIfAborted();
	const before = qualificationHelper.parse(await deps.helper(signal));
	signal.throwIfAborted();
	if (
		before.buildSha !== c.sourceSha ||
		(c.mode === "readback" && c.helperBootId !== before.bootId)
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
			helper: before,
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
			// Attempt to preserve the real venue id before normal cancellation.
			let persistenceFailed = false;
			let persistenceFailure: unknown;
			try {
				await deps.save(receipt, ids);
			} catch (error) {
				persistenceFailed = true;
				persistenceFailure = error;
			}
			// A known synthetic order still needs normal cleanup if saving its id failed.
			// Cleanup shares the action budget; neither failure permits another dispatch.
			try {
				signal.throwIfAborted();
				if (["open", "partial", "pending"].includes(receipt.status)) {
					await deps.cancel(receipt.order_id, signal);
				}
			} catch (error) {
				if (!persistenceFailed) throw error;
			}
			if (persistenceFailed) throw persistenceFailure;
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
	const after = qualificationHelper.parse(await deps.helper(signal));
	signal.throwIfAborted();
	if (!sameHelper(before, after))
		throw new QualificationError("helper_identity_changed");
	return qualificationOperation.output.parse({
		...qualificationSubject.parse(c),
		status: "qualified",
		helper: { service: "paper-trader", ...after },
		evidenceId: ids.clientOrderId,
		observedAt: deps.now().toISOString(),
		nonce: c.jti,
	});
}
