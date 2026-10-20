// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox-workspace`
 * Purpose: Barrel export for the remote sandbox workspace client.
 * Scope: Exports only; does not contain implementation logic.
 * Invariants: Exports must match public API surface.
 * Side-effects: none
 * Links: src/adapters/server/sandbox-workspace/execd-sandbox.client.ts
 * @internal
 */

export {
  EXECD_ACCESS_TOKEN_HEADER,
  ExecdSandboxClient,
  type ExecdSandboxClientConfig,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  SandboxRequestError,
} from "./execd-sandbox.client";
export {
  deriveIsolatedServiceOrigin,
  type IsolatedServiceOriginInput,
  SANDBOX_SERVICE_NAME,
} from "./sandbox-host";
