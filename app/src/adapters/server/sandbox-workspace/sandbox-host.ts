// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox-workspace/sandbox-host`
 * Purpose: Derive the public origin of one of this node's isolated services from the app's own public origin.
 * Scope: Pure host-string math. Does not read env, resolve DNS, or perform I/O.
 * Invariants:
 *   - ISOLATED_HOST_CONVENTION: mirrors the operator's hostForEnv() — production `<slug>-<service>.<base>`,
 *     other envs `<slug>-<service>-<env-suffix>.<base>` (e.g. `red-test` → `red-sandbox-test`).
 *   - HTTPS_ONLY: a non-https or single-label app origin (local dev) yields null, never a guessed host.
 * Side-effects: none
 * Links: services/sandbox/, .cogni/repo-spec.yaml (deployment.services[sandbox])
 * @internal
 */

/** Repo-spec service name of Red's isolated code-execution workspace. */
export const SANDBOX_SERVICE_NAME = "sandbox";

export interface IsolatedServiceOriginInput {
  /** The node app's own public origin, e.g. `https://red-test.cognidao.org`. */
  readonly appBaseUrl: string;
  /** The node slug (repo-spec `intent.name`), e.g. `red`. */
  readonly nodeSlug: string;
  /** Repo-spec service name, e.g. `sandbox`. */
  readonly service: string;
}

/**
 * `https://red.cognidao.org`         → `https://red-sandbox.cognidao.org`
 * `https://red-test.cognidao.org`    → `https://red-sandbox-test.cognidao.org`
 * `https://red-preview.cognidao.org` → `https://red-sandbox-preview.cognidao.org`
 * `http://localhost:3200`            → null
 */
export function deriveIsolatedServiceOrigin(
  input: IsolatedServiceOriginInput
): string | null {
  let url: URL;
  try {
    url = new URL(input.appBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const [label, ...domain] = url.hostname.toLowerCase().split(".");
  if (!label || domain.length < 2) return null;

  const slug = input.nodeSlug.toLowerCase();
  const service = input.service.toLowerCase();
  let serviceLabel: string;
  if (label === slug) {
    serviceLabel = `${slug}-${service}`;
  } else if (label.startsWith(`${slug}-`)) {
    serviceLabel = `${slug}-${service}-${label.slice(slug.length + 1)}`;
  } else {
    return null;
  }
  return `https://${serviceLabel}.${domain.join(".")}`;
}
