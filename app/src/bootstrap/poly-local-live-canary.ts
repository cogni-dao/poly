// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/poly-local-live-canary`
 * Purpose: Compose the local canary onto the existing production tenant
 *   wallet and trade-executor factory without widening the frozen container.
 * Scope: Dependency wiring only; all gates and behavior live in the feature.
 * Invariants: Uses `createPolyTradeExecutorFactory` unchanged; never constructs
 *   a second placement implementation or raw-key signer.
 * Side-effects: Adapter/factory construction; external I/O remains lazy until
 *   the returned executor is resolved.
 * Links: task.1791070987, app/src/bootstrap/capabilities/poly-trade-executor.ts
 * @public
 */

import { noopMetrics } from "@cogni/poly-market-provider";
import type { Logger } from "pino";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import { getPolyTraderWalletAdapter } from "@/bootstrap/poly-trader-wallet";
import type { ServerEnv } from "@/shared/env/server-env";

export function createLocalLiveCanaryExecutorResolver(params: {
	logger: Logger;
	env: Pick<
		ServerEnv,
		"POLYGON_RPC_URL" | "PAPER_SIDECAR_URL" | "PAPER_ENFORCE_MODE"
	>;
}) {
	const factory = createPolyTradeExecutorFactory({
		walletPort: getPolyTraderWalletAdapter(params.logger),
		logger: params.logger,
		metrics: noopMetrics,
		polygonRpcUrl: params.env.POLYGON_RPC_URL,
		...(params.env.PAPER_SIDECAR_URL
			? { paperSidecarUrl: params.env.PAPER_SIDECAR_URL }
			: {}),
		...(params.env.PAPER_ENFORCE_MODE
			? { paperEnforceMode: params.env.PAPER_ENFORCE_MODE }
			: {}),
	});
	return factory.getPolyTradeExecutorFor;
}
