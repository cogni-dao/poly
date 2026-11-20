// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/collect/route`
 * Purpose: Session-authed endpoint to trigger epoch collection on demand via Temporal schedule trigger.
 * Scope: Auth-protected POST endpoint. Triggers this node's operator-owned `governance:{nodeId}:ledger_ingest` schedule immediately. Does not run collection logic — delegates to existing schedule/workflow.
 * Invariants:
 *   - WRITES_VIA_TEMPORAL: Collection runs through the existing Temporal schedule, not bypassing it
 *   - TRIGGER_IS_SCHEDULE: Uses ScheduleHandle.trigger() — same workflow, same input as the cron
 *   - COOLDOWN_ENFORCED: Rejects requests within 5 minutes of last run
 * Side-effects: IO (HTTP response, Temporal schedule trigger via ScheduleControlPort)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/attribution-ledger.md, contracts/attribution.collect-trigger.v1.contract
 * @public
 */

import {
  CollectTriggerCooldownResponseSchema,
  CollectTriggerResponseSchema,
} from "@cogni/node-contracts";
import { governanceScheduleId } from "@cogni/scheduler-core";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "ledger.collect-trigger",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx) => {
    const { scheduleControl } = getContainer();
    // The operator owns epoch collection: it creates this node's dispatch schedule
    // `governance:{nodeId}:ledger_ingest` in the shared namespace (bug.0026). The flat
    // `governance:ledger_ingest` id belongs to the operator and must never be triggered here.
    const ledgerScheduleId = governanceScheduleId(getNodeId(), "LEDGER_INGEST");

    // Check schedule exists and enforce cooldown
    const description = await scheduleControl.describeSchedule(
      ledgerScheduleId
    );
    if (!description) {
      return NextResponse.json(
        {
          error:
            "LEDGER_INGEST schedule not found. The operator creates this node's epoch-collect schedule; it may not be onboarded yet.",
        },
        { status: 404 }
      );
    }

    if (description.lastRunAtIso) {
      const lastRunAt = new Date(description.lastRunAtIso);
      const elapsed = Date.now() - lastRunAt.getTime();
      if (elapsed < COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return NextResponse.json(
          CollectTriggerCooldownResponseSchema.parse({
            error: "cooldown",
            retryAfterSeconds,
            lastRunAt: description.lastRunAtIso,
          }),
          { status: 429 }
        );
      }
    }

    await scheduleControl.triggerSchedule(ledgerScheduleId);

    logEvent(ctx.log, EVENT_NAMES.LEDGER_COLLECT_TRIGGERED, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      scheduleId: ledgerScheduleId,
    });

    return NextResponse.json(
      CollectTriggerResponseSchema.parse({
        triggered: true,
        scheduleId: ledgerScheduleId,
      }),
      { status: 200 }
    );
  }
);
