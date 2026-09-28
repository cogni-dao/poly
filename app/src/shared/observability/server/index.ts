// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/server`
 * Purpose: Server-side logging utilities — app-local (pino/prom-client) + extracted (@cogni/node-shared) helpers.
 * Scope: Re-exports from app-local logger/metrics/redact + package logEvent/helpers.
 * Invariants: none
 * Side-effects: IO (logging to stdout)
 * @public
 */

import type { Logger } from "pino";

import type { EventBase, EventName } from "../events";

import { logEvent as logSharedEvent } from "@cogni/node-shared/observability/server";

export function logEvent(
  logger: Logger,
  eventName: EventName,
  fields: EventBase & Record<string, unknown>,
  message?: string
): void {
  logSharedEvent(logger, eventName as never, fields, message);
}

// Extracted to @cogni/node-shared
export {
  logRequestEnd,
  logRequestError,
  logRequestStart,
  logRequestWarn,
} from "@cogni/node-shared/observability/server";
// App-local (pino runtime, prom-client runtime)
export * from "./logger";
export * from "./metrics";
export { REDACT_PATHS } from "./redact";
