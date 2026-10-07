// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Delegable agent transport for the saved target-position portfolio view. */

import { polyAccountReadTargetPositionsOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
	ACCOUNT_READ_TERMINAL_EVENTS,
	classifyTargetPositionsError,
	targetPositionsAccountReadHandler,
	targetPositionsExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
	{
		routeId: "poly.account.target_positions",
		auth: { mode: "required", getSessionUser },
	},
	accountReadGetHandler({
		resolveDb: resolveAppDb,
		operation: polyAccountReadTargetPositionsOperation,
		eventName:
			ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadTargetPositionsOperation.id],
		handler: targetPositionsAccountReadHandler,
		extra: targetPositionsExtra,
		classifyError: classifyTargetPositionsError,
	}),
);
