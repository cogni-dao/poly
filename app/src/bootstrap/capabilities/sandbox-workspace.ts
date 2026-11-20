// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/sandbox-workspace`
 * Purpose: Compose the sandbox shell capability (`core__sandbox_shell`) from server environment.
 * Scope: Thin composition over `@cogni/sandbox`: env keys in, capability out, tick readings to the event registry.
 *   Holds no transport or queue code.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: SANDBOX_EXECD_TOKEN resolved from env, never passed through tool params.
 *   - DERIVED_HOST: origin = SANDBOX_BASE_URL override, else derived from APP_BASE_URL + node slug.
 *   - UNCONFIGURED_IS_NULL: missing token or underivable origin returns null (the tool answers `unavailable`), never a guess.
 *   - RUN_FROM_THE_SCOPE: the run id comes from the execution scope the launcher binds, never from tool params.
 *   - PUSH_TOKEN_PER_CALL: each call gets a 1-hour, one-repo GH_TOKEN minted by the operator; no GitHub key
 *     reaches the sandbox lease (sandbox-push-token).
 * Side-effects: logs `adapter.sandbox.tick`
 * Links: services/sandbox/
 * @internal
 */

import type { SandboxShellCapability } from "@cogni/ai-tools";
import {
  createSandboxShellCapability as composeSandboxShellCapability,
  deriveIsolatedServiceOrigin,
  SANDBOX_SERVICE_NAME,
} from "@cogni/sandbox";

import { getExecutionScope } from "@/adapters/server";
import { getNodeName } from "@/shared/config";
import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { createSandboxPushTokenEnv } from "./sandbox-push-token";

const logger = makeLogger({ component: "SandboxShell" });

/** Resolve the sandbox origin this node's app should call, or null when unknown. */
export function resolveSandboxWorkspaceOrigin(
  env: Pick<ServerEnv, "SANDBOX_BASE_URL" | "APP_BASE_URL">,
  nodeSlug: string
): string | null {
  if (env.SANDBOX_BASE_URL) return env.SANDBOX_BASE_URL;
  if (!env.APP_BASE_URL) return null;
  return deriveIsolatedServiceOrigin({
    appBaseUrl: env.APP_BASE_URL,
    nodeSlug,
    service: SANDBOX_SERVICE_NAME,
  });
}

/** Create the sandbox shell capability, or null when the token or origin is not configured. */
export function createSandboxShellCapability(
  env: ServerEnv
): SandboxShellCapability | null {
  const accessToken = env.SANDBOX_EXECD_TOKEN;
  if (!accessToken) return null;
  const nodeSlug = getNodeName();
  const baseUrl = resolveSandboxWorkspaceOrigin(env, nodeSlug);
  if (!baseUrl) return null;
  return composeSandboxShellCapability({
    baseUrl,
    accessToken,
    runId: () => getExecutionScope().runId,
    callEnv: createSandboxPushTokenEnv(env, nodeSlug),
    onTick: (report) => {
      if ("errorCode" in report) {
        logger.warn(
          {
            event: EVENT_NAMES.ADAPTER_SANDBOX_TICK,
            error_code: report.errorCode,
          },
          EVENT_NAMES.ADAPTER_SANDBOX_TICK
        );
      } else {
        logger.info(
          { event: EVENT_NAMES.ADAPTER_SANDBOX_TICK, ...report },
          EVENT_NAMES.ADAPTER_SANDBOX_TICK
        );
      }
    },
  });
}
