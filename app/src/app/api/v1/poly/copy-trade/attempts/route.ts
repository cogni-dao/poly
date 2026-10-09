// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Owner-session transport for the canonical decision-backed attempt tape. */

import { polyAccountReadRecentAttemptsOwnerOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
	ACCOUNT_READ_TERMINAL_EVENTS,
	classifyRecentAttemptsError,
	recentAttemptsExtra,
	recentAttemptsOwnerAccountReadHandler,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
	{
		routeId: "poly.copy_trade.attempts",
		auth: { mode: "required", getSessionUser },
	},
	accountReadGetHandler({
		resolveDb: resolveAppDb,
		operation: polyAccountReadRecentAttemptsOwnerOperation,
		eventName:
			ACCOUNT_READ_TERMINAL_EVENTS[
				polyAccountReadRecentAttemptsOwnerOperation.id
			],
		handler: recentAttemptsOwnerAccountReadHandler,
		classifyError: classifyRecentAttemptsError,
		extra: recentAttemptsExtra,
	}),
);
