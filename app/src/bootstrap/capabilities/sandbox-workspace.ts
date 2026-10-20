// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/sandbox-workspace`
 * Purpose: Factory for the remote sandbox workspace client from server environment.
 * Scope: Resolves sandbox origin + token. Does not implement transport or expose a model-facing tool.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: SANDBOX_EXECD_TOKEN resolved from env, never passed through tool params.
 *   - DERIVED_HOST: origin = SANDBOX_BASE_URL override, else derived from APP_BASE_URL + node slug.
 *   - UNCONFIGURED_IS_NULL: missing token or underivable origin returns null (feature off), never a guess.
 * Side-effects: none (factory only)
 * Links: src/adapters/server/sandbox-workspace/, services/sandbox/
 * @internal
 */

import {
  deriveIsolatedServiceOrigin,
  ExecdSandboxClient,
  SANDBOX_SERVICE_NAME,
} from "@/adapters/server/sandbox-workspace";
import { getNodeName } from "@/shared/config";
import type { ServerEnv } from "@/shared/env";

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

/** Create the sandbox client, or null when the token or origin is not configured. */
export function createSandboxWorkspaceClient(
  env: ServerEnv
): ExecdSandboxClient | null {
  const accessToken = env.SANDBOX_EXECD_TOKEN;
  if (!accessToken) return null;
  const baseUrl = resolveSandboxWorkspaceOrigin(env, getNodeName());
  if (!baseUrl) return null;
  return new ExecdSandboxClient({ baseUrl, accessToken });
}
