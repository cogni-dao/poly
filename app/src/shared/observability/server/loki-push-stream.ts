// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/observability/server/loki-push-stream`
 * Purpose: Env-gated, in-process Loki push sink for lease deployments (bug.5127).
 *   Nodes placed on off-cluster compute (Akash leases) have no Alloy/daemonset
 *   reading their stdout, so the app ships its own logs: pino tees every line
 *   to this stream, which batches and POSTs to Grafana Cloud Loki with the
 *   write-only credential the operator's compute-workload-controller injects.
 * Scope: One buffered stream + batch pusher. Does NOT replace stdout emission
 *   (stdout stays the primary sink everywhere) and does NOT run on k3s/local —
 *   `LOKI_PUSH_URL` is only ever injected into lease workload env.
 * Invariants:
 *   - FAIL_OPEN: logging can never crash or block the app. Construction, write,
 *     and flush swallow every error; push failures DROP the batch (no requeue).
 *   - MEMORY_CAPPED: bounded entry count + bounded bytes; overflow drops the
 *     OLDEST lines and reports the drop count in the next successful batch.
 *   - NON_BLOCKING: writes are in-memory appends; network IO happens on an
 *     unref'd timer (never keeps the process alive), one request in flight.
 *   - LABELS_MATCH_READ_PATH: streams carry {service="app", service_name=<slug>,
 *     node=<nodeId>, env, source} — `service`/`node`/`env` are what the
 *     operator's node log proxy forces (observability-logs.ts), `service_name`
 *     is the Grafana Cloud Logs default service label, `source` distinguishes
 *     lease-pushed lines from Alloy-scraped ones.
 * Side-effects: IO (HTTP POST to Loki) on the flush timer.
 * Links: bug.5127, operator compute-workload-reconciler.ts (env injection),
 *   nodes/operator observability-logs.ts (forced read labels)
 * @public
 */

export interface LokiPushDeps {
  /** Process-env view; only LOKI_PUSH_* / identity keys are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Injected clock for tests; defaults to Date.now. */
  readonly now?: () => number;
}

export interface LokiPushStream {
  /** pino-multistream sink: one serialized JSON log line (newline-terminated) per call. */
  write(line: string): void;
  /** Force a flush (tests + best-effort shutdown). Never throws. */
  flushNow(): void;
}

/** Flush cadence; matches the operator v000 stdout pump. */
const FLUSH_INTERVAL_MS = 2_000;
/** Flush immediately once a batch reaches this many lines. */
const MAX_BATCH_ENTRIES = 500;
/** Hard entry cap — beyond this the oldest lines are dropped. */
const MAX_BUFFER_ENTRIES = 2_000;
/** Hard byte cap across buffered lines (~1 MiB). */
const MAX_BUFFER_BYTES = 1_048_576;
/** Single-line cap; longer lines are truncated, never buffered whole. */
const MAX_LINE_BYTES = 32_768;
/** Abort a hung push rather than accumulate sockets. */
const PUSH_TIMEOUT_MS = 5_000;

/**
 * Create the push stream, or `undefined` when `LOKI_PUSH_URL` is not set —
 * the one env gate. Only the operator's compute controller injects that
 * variable (lease workloads); everywhere else this module is inert.
 */
export function createLokiPushStream(
  deps: LokiPushDeps
): LokiPushStream | undefined {
  try {
    const { env } = deps;
    const url = env.LOKI_PUSH_URL;
    if (!url) return undefined;
    const fetchFn = deps.fetchFn ?? globalThis.fetch;
    const now = deps.now ?? Date.now;
    const auth =
      env.LOKI_PUSH_USER && env.LOKI_PUSH_PASSWORD
        ? `Basic ${Buffer.from(
            `${env.LOKI_PUSH_USER}:${env.LOKI_PUSH_PASSWORD}`
          ).toString("base64")}`
        : undefined;
    const serviceName = env.SERVICE_NAME ?? "app";
    const labels: Record<string, string> = {
      service: serviceName,
      service_name: env.NODE_NAME ?? serviceName,
      source: env.LOKI_PUSH_SOURCE ?? "lease",
      ...(env.DEPLOY_ENVIRONMENT ? { env: env.DEPLOY_ENVIRONMENT } : {}),
      ...(env.COGNI_NODE_ID ? { node: env.COGNI_NODE_ID } : {}),
    };

    let buffer: [string, string][] = [];
    let bufferedBytes = 0;
    let dropped = 0;
    let inFlight = false;

    const flush = (): void => {
      try {
        if (inFlight || buffer.length === 0) return;
        const values = buffer;
        buffer = [];
        bufferedBytes = 0;
        if (dropped > 0) {
          values.push([
            `${now()}000000`,
            JSON.stringify({
              level: 40,
              msg: "loki_push_dropped",
              droppedLines: dropped,
            }),
          ]);
          dropped = 0;
        }
        inFlight = true;
        fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: auth } : {}),
          },
          body: JSON.stringify({ streams: [{ stream: labels, values }] }),
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        })
          // FAIL_OPEN: a failed push drops this batch; requeueing would defeat
          // the memory cap and can never block or crash the app.
          .catch(() => {})
          .finally(() => {
            inFlight = false;
          });
      } catch {
        inFlight = false;
      }
    };

    // Unref'd: the sink must never keep the process alive.
    const timer = setInterval(flush, FLUSH_INTERVAL_MS);
    timer.unref?.();

    return {
      write(line: string): void {
        try {
          for (const raw of line.split("\n")) {
            if (raw === "") continue;
            const entry =
              raw.length > MAX_LINE_BYTES ? raw.slice(0, MAX_LINE_BYTES) : raw;
            buffer.push([`${now()}000000`, entry]);
            bufferedBytes += entry.length;
            while (
              buffer.length > MAX_BUFFER_ENTRIES ||
              bufferedBytes > MAX_BUFFER_BYTES
            ) {
              const oldest = buffer.shift();
              if (!oldest) break;
              bufferedBytes -= oldest[1].length;
              dropped += 1;
            }
          }
          if (buffer.length >= MAX_BATCH_ENTRIES) flush();
        } catch {
          // FAIL_OPEN: a sink defect must never surface into app code paths.
        }
      },
      flushNow(): void {
        flush();
      },
    };
  } catch {
    return undefined;
  }
}

type GlobalWithLokiPush = typeof globalThis & {
  __cogniLokiPushStream?: LokiPushStream | undefined;
  __cogniLokiPushInit?: boolean;
};

/**
 * Process-wide singleton (globalThis-backed, same pattern as metricsRegistry):
 * `makeLogger` is called per component, but one buffer/timer/push pipeline per
 * process is enough — and required for the memory cap to be a real cap.
 */
export function getLokiPushStream(): LokiPushStream | undefined {
  const g = globalThis as GlobalWithLokiPush;
  if (!g.__cogniLokiPushInit) {
    g.__cogniLokiPushInit = true;
    // Direct env read mirrors logger.ts (safe at module scope; no serverEnv).
    g.__cogniLokiPushStream = createLokiPushStream({ env: process.env });
  }
  return g.__cogniLokiPushStream;
}
