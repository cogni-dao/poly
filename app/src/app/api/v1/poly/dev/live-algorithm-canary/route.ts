// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/dev/live-algorithm-canary`
 * Purpose: Authenticated, local-development-only transport for one capped
 *   live algorithm canary through the production mirror execution path.
 * Scope: Parse/auth/render only. The feature service owns safety gates,
 *   deterministic identity, execution, evidence, and cleanup.
 * Invariants:
 *   - NEVER_DEPLOYED — NODE_ENV must be development and CI must be absent.
 *   - EXPLICIT_OPT_IN_PER_CALL — the exact live-money phrase is required.
 *   - GEO_FAILS_CLOSED — only an explicit cached permitted verdict proceeds.
 * Side-effects: delegated to runLocalLiveCanary after every guard passes.
 * Links: task.1791070987, story.5018
 * @public
 */

import { toUserId } from "@cogni/ids";
import type { LoggerPort } from "@cogni/poly-market-provider";
import {
	type PolyLocalLiveCanaryError,
	polyLocalLiveCanaryErrorSchema,
	polyLocalLiveCanaryOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { createLocalLiveCanaryExecutorResolver } from "@/bootstrap/poly-local-live-canary";
import {
	assertLocalLiveCanaryProcessGate,
	assertLocalLiveCanaryRuntime,
	LocalLiveCanaryError,
	type LocalLiveCanaryRuntimeGate,
	runLocalLiveCanary,
} from "@/features/copy-trade/local-live-canary";
import { probePolymarketGeoblockOnce } from "@/lib/egress-geoblock";
import { serverEnv } from "@/shared/env/server";

export const dynamic = "force-dynamic";

const ROUTE_ID = "poly.dev.live_algorithm_canary" as const;

function errorStatus(code: LocalLiveCanaryError["code"]): number {
	switch (code) {
		case "confirmation_required":
			return 400;
		case "local_development_only":
			return 404;
		case "ci_forbidden":
			return 403;
		case "live_dispatch_required":
			return 409;
		case "egress_geoblocked":
			return 451;
		case "market_ineligible":
			return 422;
		case "local_sha_unavailable":
		case "egress_unproven":
		case "wallet_executor_unconfigured":
			return 503;
		case "canary_execution_failed":
			return 500;
	}
}

function renderError(error: LocalLiveCanaryError): NextResponse {
	const details = error.details ?? {};
	const payload: PolyLocalLiveCanaryError = {
		schema_version: "poly.local-live-canary.error.v1",
		error: error.code,
		reason: error.message.slice(0, 512),
		...(details.verdict === "blocked" ||
		details.verdict === "permitted" ||
		details.verdict === "unreachable" ||
		details.verdict === null
			? {
					egress: {
						verdict: details.verdict,
						country:
							typeof details.country === "string" ? details.country : null,
						region: typeof details.region === "string" ? details.region : null,
					},
				}
			: {}),
		...(details.market_eligibility &&
		typeof details.market_eligibility === "object"
			? {
					market_eligibility:
						details.market_eligibility as PolyLocalLiveCanaryError["market_eligibility"],
				}
			: {}),
		...(typeof details.correlation_id === "string"
			? { correlation_id: details.correlation_id }
			: {}),
	};
	return NextResponse.json(polyLocalLiveCanaryErrorSchema.parse(payload), {
		status: errorStatus(error.code),
	});
}

export const POST = wrapRouteHandlerWithLogging(
	{
		routeId: ROUTE_ID,
		auth: { mode: "required", getSessionUser },
	},
	async (ctx, request, sessionUser) => {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return NextResponse.json(
				{
					schema_version: "poly.local-live-canary.error.v1",
					error: "confirmation_required",
					reason: "request body must be valid JSON",
				},
				{ status: 400 },
			);
		}
		const parsed = polyLocalLiveCanaryOperation.input.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{
					schema_version: "poly.local-live-canary.error.v1",
					error: "confirmation_required",
					reason: "invalid fixed input or live-money confirmation",
				},
				{ status: 400 },
			);
		}

		const env = serverEnv();
		const processGate = {
			nodeEnv: env.NODE_ENV,
			appEnv: env.APP_ENV,
			// CI is a universal process guard, not an application feature flag.
			ci: process.env.CI,
			paperEnforceMode: env.PAPER_ENFORCE_MODE,
			localSha: env.APP_BUILD_SHA,
			confirmation: parsed.data.confirmation,
		};
		try {
			assertLocalLiveCanaryProcessGate(processGate);
		} catch (error) {
			if (error instanceof LocalLiveCanaryError) return renderError(error);
			throw error;
		}

		// Next dev may evaluate instrumentation and route modules in isolated
		// graphs, so their in-memory latch state is not a route safety proof.
		// Every explicit real-money request obtains its own current oracle verdict
		// before account, DB, wallet, or executor access.
		const egressProbe = await probePolymarketGeoblockOnce();
		const runtime: LocalLiveCanaryRuntimeGate = {
			...processGate,
			egress: {
				latched: egressProbe.verdict === "blocked",
				lastVerdict: egressProbe.verdict,
				egressCountry: egressProbe.country,
				egressRegion: egressProbe.region,
			},
		};
		try {
			// Run before resolving the user account or constructing a tenant
			// executor: blocked/unproven egress performs zero trade-path I/O.
			assertLocalLiveCanaryRuntime(runtime);
		} catch (error) {
			if (error instanceof LocalLiveCanaryError) return renderError(error);
			throw error;
		}

		const container = getContainer();
		let getExecutorFor: ReturnType<
			typeof createLocalLiveCanaryExecutorResolver
		>;
		try {
			getExecutorFor = createLocalLiveCanaryExecutorResolver({
				logger: ctx.log,
				env,
			});
		} catch (error) {
			return renderError(
				new LocalLiveCanaryError(
					"wallet_executor_unconfigured",
					error instanceof Error
						? error.message
						: "Privy user-wallets, wallet AEAD, and Polygon RPC configuration are required",
				),
			);
		}
		const account = await container
			.accountsForUser(toUserId(sessionUser.id))
			.getOrCreateBillingAccountForUser({ userId: sessionUser.id });

		try {
			const evidence = await runLocalLiveCanary(parsed.data, {
				db: container.serviceDb,
				ledger: container.orderLedger,
				getExecutor: () => getExecutorFor(account.id),
				logger: ctx.log as unknown as LoggerPort,
				runtime,
				billingAccountId: account.id,
				createdByUserId: sessionUser.id,
				clock: () => new Date(ctx.clock.now()),
			});
			const output = polyLocalLiveCanaryOperation.output.parse({
				...evidence,
				api: {
					request_id: ctx.reqId,
					route_id: ROUTE_ID,
					correlation_id: evidence.correlation_id,
				},
			});
			ctx.log.info(
				{
					event: "poly.local_live_canary.api_complete",
					correlation_id: evidence.correlation_id,
					algorithm_version: evidence.algorithm_version,
					fixed_input_id: evidence.fixed_input_id,
					decision_outcome: evidence.decision.outcome,
					decision_size_usdc: evidence.decision.size_usdc,
					decision_correlation_id: evidence.decision.correlation_id,
					decision_algorithm_version: evidence.decision.algorithm_version,
					client_order_id: evidence.ledger.client_order_id,
					order_id: evidence.clob.order_id,
					ledger_status: evidence.ledger.status,
					clob_status: evidence.clob.status,
					cleanup_status: evidence.cleanup.status,
				},
				"local live algorithm canary API evidence emitted",
			);
			return NextResponse.json(output, {
				status: evidence.decision.outcome === "placed" ? 200 : 422,
			});
		} catch (error) {
			if (error instanceof LocalLiveCanaryError) return renderError(error);
			return renderError(
				new LocalLiveCanaryError(
					"canary_execution_failed",
					error instanceof Error ? error.message : String(error),
				),
			);
		}
	},
);
