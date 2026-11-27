// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/approval-origin`
 * Purpose: The origin of an agent's approval link, resolved exclusively from deployment-owned config (never from a request header).
 * Scope: Pure config read. The non-primary node convention mirrors the operator's host_for_node helper: env-prefixed domains use `<slug>-<domain>`, root domains use
 *   `<slug>.<domain>`.
 * Invariants:
 *   - CONFIG_ORIGIN_ONLY: an agent that reaches the node by another hostname still hands its owner a link that works, and a forged Host or x-forwarded-host header cannot steer it.
 *   - FAIL_LOUD: a missing or non-canonical config value throws; no fallback to the request.
 * Side-effects: none
 * Links: story.0090, restored from the legacy `resolveAgentApprovalOrigin` (poly#342 review)
 * @public
 */

import { getNodeName } from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env/server";

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function canonicalHttpOrigin(configuredUrl: string): string {
  const url = new URL(configuredUrl);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("APP_BASE_URL must be a canonical HTTP(S) URL");
  }
  return url.origin;
}

function validatedDomain(configuredDomain: string): string {
  const domain = configuredDomain.trim().toLowerCase();
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DNS_LABEL_PATTERN.test(label))
  ) {
    throw new Error("DOMAIN must be a canonical DNS hostname");
  }
  return domain;
}

export function resolveAgentApprovalOrigin(): string {
  const env = serverEnv();
  if (env.APP_BASE_URL) return canonicalHttpOrigin(env.APP_BASE_URL);

  if (!env.DOMAIN) {
    throw new Error("APP_BASE_URL or DOMAIN is required for agent approval links");
  }

  const slug = getNodeName().trim().toLowerCase();
  if (!DNS_LABEL_PATTERN.test(slug)) {
    throw new Error("repo-spec node name must be a canonical DNS label");
  }
  const domain = validatedDomain(env.DOMAIN);
  const separator = domain.split(".").length >= 3 ? "-" : ".";
  return `https://${slug}${separator}${domain}`;
}
