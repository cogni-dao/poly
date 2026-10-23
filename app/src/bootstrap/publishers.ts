// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/publishers`
 * Purpose: Node-local process metrics publisher (heap, RSS, event loop delay).
 * Scope: Bootstrap-only exception for node-internal data. Does not poll external sources.
 *   External source monitoring uses ingestion-core + Temporal. See data-streams.md.
 * Invariants:
 *   - PROCESS_HEALTH_ONLY: No external source polling from bootstrap
 * Side-effects: IO (Redis publish via NodeStreamPort; one info log per window)
 * Links: docs/spec/data-streams.md, @cogni/node-streams, bug.5520
 * @internal
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NodeStreamPort, ProcessHealthEvent } from "@cogni/node-streams";
import type { Logger } from "pino";

import { EVENT_NAMES } from "@/shared/observability/events";

const HEALTH_INTERVAL_MS = 60_000;

interface PublisherDeps {
  port: NodeStreamPort;
  streamKey: string;
  signal: AbortSignal;
  logger: Logger;
  environment: string;
}

/**
 * Start process health publisher. Call once after container wiring.
 * Publishes heap/RSS/uptime/event-loop-delay every 60s, and logs the window's
 * event-loop delay max/p99 (bug.5520). The histogram resets each window so
 * both figures describe the last 60s, not process lifetime.
 *
 * This is the ONLY acceptable bootstrap publisher pattern.
 * External sources (GitHub, Polymarket, etc.) flow through
 * ingestion-core + Temporal, not setInterval.
 */
export function startProcessHealthPublisher({
  port,
  streamKey,
  signal,
  logger,
  environment,
}: PublisherDeps): void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  signal.addEventListener("abort", () => histogram.disable());

  const publish = async () => {
    const eventLoopDelayMaxMs = Math.round(histogram.max / 1e6);
    const eventLoopDelayP99Ms = Math.round(histogram.percentile(99) / 1e6);
    histogram.reset();
    logger.info(
      {
        event: EVENT_NAMES.PROCESS_EVENT_LOOP_DELAY,
        event_loop_delay_max_ms: eventLoopDelayMaxMs,
        event_loop_delay_p99_ms: eventLoopDelayP99Ms,
        window_ms: HEALTH_INTERVAL_MS,
      },
      "event loop delay"
    );
    try {
      const mem = process.memoryUsage();
      const event: ProcessHealthEvent = {
        type: "process_health",
        timestamp: new Date().toISOString(),
        source: "process-metrics",
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
        uptimeSeconds: Math.round(process.uptime()),
        eventLoopDelayMs: eventLoopDelayP99Ms,
        environment,
      };
      await port.publish(streamKey, event);
    } catch (err) {
      logger.warn(
        { err, event: "publisher.process_health.error" },
        "Process health publish failed"
      );
    }
  };

  void publish();
  const id = setInterval(() => void publish(), HEALTH_INTERVAL_MS);
  signal.addEventListener("abort", () => clearInterval(id));
}
