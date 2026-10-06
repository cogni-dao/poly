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
 *     and flush swallow every error; push failures retain the active batch.
 *   - ACK_BEFORE_REMOVE: only a 2xx response retires the immutable active
 *     batch. Every other outcome retries while this process remains alive.
 *   - MEMORY_CAPPED: active plus queued data has bounded entries and bytes;
 *     overflow drops only queued lines and reports the count after recovery.
 *   - NON_BLOCKING: writes are in-memory appends; network IO happens on an
 *     unref'd timer (never keeps the process alive), one request in flight and
 *     at most one retry timer.
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
/** Keep individual Loki requests well below the total in-process byte cap. */
const MAX_BATCH_BYTES = 262_144;
/** Hard entry cap — beyond this the oldest lines are dropped. */
const MAX_BUFFER_ENTRIES = 2_000;
/** Hard byte cap across buffered lines (~1 MiB). */
const MAX_BUFFER_BYTES = 1_048_576;
/** Single-line cap; longer lines are truncated, never buffered whole. */
const MAX_LINE_BYTES = 32_768;
/** Abort a hung push rather than accumulate sockets. */
const PUSH_TIMEOUT_MS = 5_000;
/** First retry after an unacknowledged delivery. */
const RETRY_BASE_MS = 1_000;
/** Maximum retry delay, including a server-provided Retry-After. */
const RETRY_CAP_MS = 30_000;

type LokiValue = [timestamp: string, line: string];

interface ActiveBatch {
  readonly values: readonly LokiValue[];
  readonly bytes: number;
  readonly body: string;
  failures: number;
}

function exponentialRetryDelay(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (failures - 1));
}

function retryAfterDelay(
  response: Response | undefined,
  failures: number,
  now: () => number
): number {
  const fallback = exponentialRetryDelay(failures);
  if (response?.status !== 429 && response?.status !== 503) return fallback;

  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return fallback;

  let delay: number | undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (Number.isSafeInteger(seconds)) delay = seconds * 1_000;
  } else {
    const date = Date.parse(raw);
    if (Number.isFinite(date)) delay = Math.max(0, date - now());
  }
  if (delay === undefined || !Number.isSafeInteger(delay) || delay < 0) {
    return fallback;
  }
  return Math.min(RETRY_CAP_MS, Math.max(RETRY_BASE_MS, delay));
}

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
    const pushUrl: string = url;
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

    let buffer: LokiValue[] = [];
    let bufferedBytes = 0;
    let dropped = 0;
    let recoveredFailuresPending = 0;
    let active: ActiveBatch | undefined;
    let requestInFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastIssuedTimestampNs: bigint | undefined;

    // Loki requires nondecreasing values within a stream. Wall clocks can
    // move backwards, so every newly created value advances a logical clock.
    const issueTimestamp = (): string => {
      const observed = BigInt(now()) * 1_000_000n;
      const issued =
        lastIssuedTimestampNs === undefined || observed > lastIssuedTimestampNs
          ? observed
          : lastIssuedTimestampNs + 1n;
      lastIssuedTimestampNs = issued;
      return issued.toString();
    };

    const totalEntries = (): number =>
      (active?.values.length ?? 0) + buffer.length;
    const totalBytes = (): number => (active?.bytes ?? 0) + bufferedBytes;

    const enforceCap = (): void => {
      while (
        totalEntries() > MAX_BUFFER_ENTRIES ||
        totalBytes() > MAX_BUFFER_BYTES
      ) {
        const oldestQueued = buffer.shift();
        if (!oldestQueued) break;
        bufferedBytes -= oldestQueued[1].length;
        dropped += 1;
      }
    };

    const enqueue = (line: string): void => {
      buffer.push([issueTimestamp(), line]);
      bufferedBytes += line.length;
      enforceCap();
    };

    const enqueueDiagnostics = (): void => {
      if (dropped === 0 && recoveredFailuresPending === 0) return;
      const diagnosticLines = (): string[] => [
        ...(recoveredFailuresPending > 0
          ? [
              JSON.stringify({
                level: 40,
                msg: "loki_push_recovered",
                failedAttempts: recoveredFailuresPending,
              }),
            ]
          : []),
        ...(dropped > 0
          ? [
              JSON.stringify({
                level: 40,
                msg: "loki_push_dropped",
                droppedLines: dropped,
              }),
            ]
          : []),
      ];

      let lines = diagnosticLines();
      let bytes = lines.reduce((sum, line) => sum + line.length, 0);
      while (
        buffer.length + lines.length > MAX_BUFFER_ENTRIES ||
        bufferedBytes + bytes > MAX_BUFFER_BYTES
      ) {
        const oldestQueued = buffer.shift();
        if (!oldestQueued) break;
        bufferedBytes -= oldestQueued[1].length;
        dropped += 1;
        lines = diagnosticLines();
        bytes = lines.reduce((sum, line) => sum + line.length, 0);
      }
      const values: LokiValue[] = lines.map((line) => [issueTimestamp(), line]);
      buffer.push(...values);
      bufferedBytes += bytes;
      dropped = 0;
      recoveredFailuresPending = 0;
    };

    const claimBatch = (): void => {
      enqueueDiagnostics();
      if (buffer.length === 0) return;

      const values: LokiValue[] = [];
      let bytes = 0;
      while (values.length < MAX_BATCH_ENTRIES && buffer.length > 0) {
        const next = buffer[0];
        if (!next) break;
        if (values.length > 0 && bytes + next[1].length > MAX_BATCH_BYTES) {
          break;
        }
        buffer.shift();
        bufferedBytes -= next[1].length;
        values.push(next);
        bytes += next[1].length;
      }
      active = {
        values,
        bytes,
        body: JSON.stringify({ streams: [{ stream: labels, values }] }),
        failures: 0,
      };
    };

    const scheduleRetry = (response?: Response): void => {
      try {
        if (!active || retryTimer) return;
        active.failures += 1;
        const delay = retryAfterDelay(response, active.failures, now);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          pushActive();
        }, delay);
        retryTimer.unref?.();
      } catch {
        // FAIL_OPEN: logging failures never surface into application behavior.
      }
    };

    const acknowledge = (): void => {
      const recoveredFailures = active?.failures ?? 0;
      active = undefined;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (recoveredFailures > 0) {
        recoveredFailuresPending += recoveredFailures;
      }
      flush();
    };

    function pushActive(): void {
      try {
        if (!active || requestInFlight || retryTimer) return;
        requestInFlight = true;
        let request: Promise<Response>;
        try {
          request = fetchFn(pushUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(auth ? { authorization: auth } : {}),
            },
            body: active.body,
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          });
        } catch {
          requestInFlight = false;
          scheduleRetry();
          return;
        }
        void Promise.resolve(request).then(
          (response) => {
            requestInFlight = false;
            if (response.ok) acknowledge();
            else scheduleRetry(response);
          },
          () => {
            requestInFlight = false;
            scheduleRetry();
          }
        );
      } catch {
        requestInFlight = false;
        scheduleRetry();
      }
    }

    const flush = (): void => {
      try {
        if (requestInFlight || retryTimer) return;
        if (!active) claimBatch();
        pushActive();
      } catch {
        requestInFlight = false;
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
            enqueue(entry);
          }
          if (
            buffer.length >= MAX_BATCH_ENTRIES ||
            bufferedBytes >= MAX_BATCH_BYTES
          ) {
            flush();
          }
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
