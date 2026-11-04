// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Composition of existing authorized executor, RLS ledger and bounded helper observations. */
import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import { PolymarketAdapter } from "@cogni/poly-market-provider/adapters/polymarket";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { qualificationHelper } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";
import { assertQualificationFixture } from "@/features/deploy-qualification/fixture-access";
import type { QualificationFixture } from "@/features/deploy-qualification/fixtures";
import type { QualificationDependencies } from "@/features/deploy-qualification/service";

export function resolveQualificationDependencies(
	fixture: QualificationFixture,
	sidecarUrl: string,
	signal: AbortSignal,
): QualificationDependencies {
	const container = getContainer();
	const ledger = container.orderLedger.forTenant({
		billing_account_id: fixture.accountId,
		created_by_user_id: fixture.ownerId,
	});
	const executor = () =>
		container.getBoundedPaperExecutor(fixture.accountId, signal);
	let executorPromise: ReturnType<typeof executor> | undefined;
	const getExecutor = () => {
		executorPromise ??= executor();
		return executorPromise;
	};
	return {
		fixture,
		now: () => new Date(),
		checkFixture: () =>
			withTenantScope(
				resolveAppDb(),
				userActor(toUserId(fixture.ownerId)),
				(tx) => assertQualificationFixture(tx, fixture, new Date()),
			),
		helper: async (requestSignal) => {
			const response = await fetch(new URL("/version", sidecarUrl), {
				redirect: "error",
				cache: "no-store",
				signal: AbortSignal.any([requestSignal, AbortSignal.timeout(2000)]),
			});
			if (!response.ok)
				throw new QualificationError("paper_helper_unreachable");
			return qualificationHelper.parse(await response.json());
		},
		selectIntent: async (requestSignal) => {
			// Real discovery, not a claim that this order will fill. The engine must accept it.
			const markets = await new PolymarketAdapter().listMarkets({
				activeOnly: true,
				limit: 20,
			});
			requestSignal.throwIfAborted();
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
		},
		claim: (intent, ids, observedAt) =>
			ledger.claimPending({
				target_id: ids.targetId,
				fill_id: ids.fillId,
				observed_at: observedAt,
				intent,
			}),
		load: (ids) => ledger.readOperation(ids.targetId, ids.fillId),
		place: async (intent) => (await getExecutor()).placeIntent(intent),
		cancel: async (orderId) => (await getExecutor()).cancelOrder(orderId),
		getOrder: async (orderId) => (await getExecutor()).getOrder(orderId),
		save: (receipt) =>
			container.orderLedger.markOrderId({
				client_order_id: receipt.client_order_id,
				receipt,
			}),
	};
}
