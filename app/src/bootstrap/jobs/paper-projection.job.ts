// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/paper-projection.job`
 * Purpose: Process-local scheduler for the paper-account fact projection —
 *   turns this node's own `poly_copy_trade_fills` (mode='paper') into
 *   `poly_trader_*` facts and a `poly_wallet_balance_snapshots` NAV row.
 * Scope: Wiring + cadence only. The feature service owns the tick body.
 * Invariants:
 *   - GATED_ON_DATA_NOT_A_FLAG: this job runs on every lane. Its real gate is
 *     `runPaperProjectionTick`'s own question — does an active paper account
 *     exist — so a lane with no paper accounts does one cheap indexed SELECT
 *     per tick and logs `idle_no_paper_accounts`.
 *   - NOT_THE_OBSERVATION_WRITER: deliberately NOT gated on
 *     `POLY_TRADER_OBSERVATION_WRITER_ENABLED`. That lever throttles Data-API
 *     observation, whose write load is paginated `/activity` + `/positions`
 *     for every target and tenant wallet plus per-token snapshots every 30s,
 *     on non-prod lanes whose DBs live on the prod VM by custody
 *     (bug.5297/bug.5206). The paper projection is a local SQL projection over
 *     this node's own ledger, scoped to the paper accounts that exist, with one
 *     authoritative mark read per open position. Reusing that flag would conflate two
 *     unrelated write loads and leave the paper dashboard structurally
 *     unrenderable on precisely the lanes paper trading runs on — which is the
 *     bug this slice exists to fix.
 *   - NO_NEW_ENV_KEY: the gate is derived from data on purpose. Adding a
 *     declared secret/env key to turn paper on has broken every poly promote
 *     that tried it (bug.5277), so the lever is "create a paper account".
 *   - SEPARATE_TIMER_SINGLE_OWNER: this job owns the paper projection outright.
 *     The trader-observation tick skips `kind='paper_wallet'` rows defensively
 *     (`paper_wallet_skipped`), so the two schedulers can never double-write a
 *     paper wallet nor apply the Data-API path to a synthetic address.
 *   - TICK_IS_SELF_HEALING: escaped errors are logged and the interval
 *     continues; a tick never overlaps itself.
 *   - TICK_TIMEOUT_IS_REAL_CANCELLATION: the timeout aborts an AbortSignal
 *     threaded into the tick, which stops between accounts.
 * Side-effects: starts a timer, performs IO through injected deps.
 * Links: migration 0083, docs/spec/capability-plane.md
 * @internal
 */

import type { LoggerPort } from "@cogni/poly-market-provider";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  type PaperMidPriceReader,
  runPaperProjectionTick,
} from "@/features/wallet-analysis/server/paper-fact-source";
import {
  OBSERVATION_STATEMENT_TIMEOUT_MS,
  withStatementTimeout,
} from "@/features/wallet-analysis/server/trader-observation-service";
import { EVENT_NAMES } from "@/shared/observability/events";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/**
 * Matches the trader-observation cadence so a paper dashboard refreshes as
 * promptly as a live one, and comfortably inside the 10-minute
 * `WALLET_BALANCE_FRESHNESS_MS` window that would otherwise mark the NAV stale.
 */
const PAPER_PROJECTION_POLL_MS = 30_000;

/**
 * Well under the poll interval: the tick is a handful of bounded SQL
 * statements plus one bounded mark read per open position, so exceeding this
 * means something is wedged, not merely slow.
 */
const TICK_TIMEOUT_MS = 25_000;

export type PaperProjectionJobStopFn = () => void;

export interface PaperProjectionJobDeps {
  db: Db;
  /** Live midpoint or authoritative settlement used to mark paper positions. */
  readPaperMidPrice: PaperMidPriceReader;
  logger: LoggerPort;
  pollMs?: number;
}

function errorDimensions(error: unknown): Record<string, string | undefined> {
  const err = error instanceof Error ? error : null;
  const cause = err?.cause instanceof Error ? err.cause : null;
  const codeOf = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as {
      code?: unknown;
      details?: { error_code?: unknown };
    };
    if (typeof candidate.code === "string") return candidate.code;
    return typeof candidate.details?.error_code === "string"
      ? candidate.details.error_code
      : undefined;
  };
  return {
    err_class: err?.name ?? typeof error,
    err_code: codeOf(error),
    cause_class: cause?.name,
    cause_code: codeOf(cause),
  };
}

export function startPaperProjectionJob(
  deps: PaperProjectionJobDeps
): PaperProjectionJobStopFn {
  const pollMs = deps.pollMs ?? PAPER_PROJECTION_POLL_MS;
  const log = deps.logger.child({ component: "paper-projection-job" });
  let running = false;

  log.info(
    {
      event: EVENT_NAMES.POLY_PAPER_PROJECT,
      phase: "job_start",
      poll_ms: pollMs,
    },
    "paper projection job starting"
  );

  async function tick(): Promise<void> {
    if (running) {
      log.warn(
        {
          event: EVENT_NAMES.POLY_PAPER_PROJECT,
          phase: "tick_skipped_running",
        },
        "paper projection tick skipped; previous tick still running"
      );
      return;
    }
    running = true;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`paper projection tick exceeded ${TICK_TIMEOUT_MS}ms`)
      );
    }, TICK_TIMEOUT_MS);
    timer.unref?.();
    try {
      const result = await runPaperProjectionTick({
        db: deps.db,
        readMidPrice: deps.readPaperMidPrice,
        logger: log,
        signal: controller.signal,
        // Bound every projection statement in Postgres itself: drizzle takes no
        // AbortSignal, so a wedged write is only stoppable server-side.
        runBounded: (fn) =>
          withStatementTimeout(deps.db, OBSERVATION_STATEMENT_TIMEOUT_MS, fn),
      });
      // The idle case already logged its own reason inside the tick; logging a
      // second "complete" line for it would bury the signal.
      if (result.idleReason === undefined) {
        log.info(
          {
            event: EVENT_NAMES.POLY_PAPER_PROJECT,
            phase: "tick_complete",
            paper_accounts: result.paperAccounts,
            wallets_projected: result.walletsProjected,
            fills: result.fills,
            positions: result.positions,
            unpriced_positions: result.unpricedPositions,
            navs_published: result.navsPublished,
            errors: result.errors,
            tick_ms: Date.now() - startedAt,
          },
          "paper projection tick complete"
        );
      }
    } catch (err: unknown) {
      const timedOut = controller.signal.aborted;
      log.error(
        {
          event: EVENT_NAMES.POLY_PAPER_PROJECT,
          phase: "tick_failed",
          errorCode: timedOut
            ? "paper_projection_timeout"
            : "paper_projection_failed",
          tick_ms: Date.now() - startedAt,
          ...errorDimensions(err),
        },
        "paper projection tick failed — retrying on the next interval"
      );
    } finally {
      clearTimeout(timer);
      running = false;
    }
  }

  void tick();
  const interval = setInterval(() => void tick(), pollMs);
  interval.unref?.();
  return () => clearInterval(interval);
}
