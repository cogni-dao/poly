// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Composition of existing authorized executor, RLS ledger and bounded helper observations. */
import { createAppDbClient, withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import { PolymarketAdapter } from "@cogni/poly-market-provider/adapters/polymarket";
import { getContainer } from "@/bootstrap/container";
import { qualificationHelper } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";
import { assertQualificationFixture } from "@/features/deploy-qualification/fixture-access";
import type { QualificationFixture } from "@/features/deploy-qualification/fixtures";
import type { QualificationDependencies } from "@/features/deploy-qualification/service";
import {
	createExecutionVenueResolver,
	createPaperVenue,
} from "@/features/paper-accounts";
import { createOrderLedger } from "@/features/trading/order-ledger";
import { serverEnv } from "@/shared/env";

// One transient app-role backend per process, including concurrent capability replays.
// Default app pool 1 + qualification 1; blue/green together stay within app role 4.
let qualificationConnectionInUse = false;

export function resolveQualificationDependencies(
	fixture: QualificationFixture,
	sidecarUrl: string,
	signal: AbortSignal,
	deadlineAt: number,
): QualificationDependencies & { dispose(): Promise<void> } {
	signal.throwIfAborted();
	const container = getContainer();
	const remaining = Math.floor(deadlineAt - Date.now());
	if (remaining <= 0) throw new QualificationError("qualification_timeout");
	// postgres-js begin()/reserve() do not expose cancellation while waiting for a
	// shared pool. Own ONE app-role connection for this authenticated action; abort
	// closes only this handle, including connection/BEGIN waits and blocked queries.
	if (qualificationConnectionInUse)
		throw new QualificationError("qualification_busy");
	const db = createAppDbClient(serverEnv().DATABASE_URL, {
		max: 1,
		connectTimeoutSeconds: Math.max(1, Math.min(10, remaining / 1000)),
		statementTimeoutMs: remaining,
	});
	qualificationConnectionInUse = true;
	const lifetime = { signal, deadlineAt };
	const actor = userActor(toUserId(fixture.ownerId));
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= db.$client.end({ timeout: 0 }).finally(() => {
			qualificationConnectionInUse = false;
		});
		return closing;
	};
	const abort = () => {
		void close();
	};
	signal.addEventListener("abort", abort, { once: true });
	const scoped = <T>(
		fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
	) => {
		signal.throwIfAborted();
		return withTenantScope(db, actor, fn, lifetime);
	};
	const resolveExecutionVenue = (accountId: string) =>
		scoped((tx) => createExecutionVenueResolver({ db: tx })(accountId));
	const paperVenue = {
		resolveAccount: (accountId: string) =>
			scoped((tx) => createPaperVenue({ db: tx }).resolveAccount(accountId)),
		authorizeIntent: (
			accountId: string,
			intent: Parameters<
				ReturnType<typeof createPaperVenue>["authorizeIntent"]
			>[1],
		) =>
			scoped((tx) =>
				createPaperVenue({ db: tx }).authorizeIntent(accountId, intent),
			),
	};
	const ledger = createOrderLedger({
		db,
		appDb: db,
		logger: container.log,
		resolveExecutionMode: resolveExecutionVenue,
		tenantLifetime: lifetime,
	}).forTenant({
		billing_account_id: fixture.accountId,
		created_by_user_id: fixture.ownerId,
	});
	const executor = () =>
		container.getBoundedPaperExecutor(fixture.accountId, signal, {
			resolveExecutionVenue,
			paperVenue,
		});
	let executorPromise: ReturnType<typeof executor> | undefined;
	const getExecutor = () => {
		executorPromise ??= executor();
		return executorPromise;
	};
	return {
		dispose: async () => {
			signal.removeEventListener("abort", abort);
			await close();
		},
		fixture,
		now: () => new Date(),
		checkFixture: () =>
			scoped((tx) => assertQualificationFixture(tx, fixture, new Date())),
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
			const markets = await new PolymarketAdapter({
				signal: requestSignal,
			}).listMarkets({
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
		save: (receipt, ids) =>
			ledger.markReceipt(ids.targetId, ids.fillId, receipt),
	};
}
