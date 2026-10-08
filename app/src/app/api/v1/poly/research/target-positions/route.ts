// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Owner-session transport for the identical target-position capability. */

import {
	polyAccountReadTargetPositionsOperation,
	polyAccountReadTargetPositionsOwnerOperation,
} from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { sizingPolicyKindForTargetWallet } from "@/bootstrap/jobs/copy-trade-mirror.job";
import {
	ACCOUNT_READ_TERMINAL_EVENTS,
	classifyTargetPositionsError,
	targetPositionsAccountReadHandler,
	targetPositionsExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
	{
		routeId: "poly.research.target_positions",
		auth: { mode: "required", getSessionUser },
	},
	accountReadGetHandler({
		resolveDb: resolveAppDb,
		operation: polyAccountReadTargetPositionsOwnerOperation,
		eventName:
			ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadTargetPositionsOperation.id],
		handler: targetPositionsAccountReadHandler({
			resolveEffectiveKind: sizingPolicyKindForTargetWallet,
		}),
		extra: targetPositionsExtra,
		classifyError: classifyTargetPositionsError,
	}),
);
