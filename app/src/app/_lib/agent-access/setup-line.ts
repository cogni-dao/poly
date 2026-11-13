// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/agent-access/setup-line`
 * Purpose: The ONE copyable line a person gives their new AI. It carries the one-time setup code, so it is shown once, in answer to the
 *   "Add an AI" click, and nowhere else (HUMAN_SURFACE_TOKENLESS: the profile list never prints it).
 * Scope: Pure string builder. The endpoints named here are the node's own public contract (`/.well-known/agent.json` lists them).
 * Side-effects: none
 * Links: src/app/api/v1/profile/ai/route.ts
 * @internal
 */

import { serverEnv } from "@/shared/env";

/** The public origin this request reached the node through (behind a proxy, `request.url` shows the pod bind address). */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/**
 * The absolute URL of a page on THIS node, from CONFIG (`APP_BASE_URL`), never from the request's Host header: a link an agent hands a human must not be steerable by a
 * forged header. With no configured origin the answer is the bare path (still unique and still correct on the node the agent called).
 */
export function configuredUrl(path: string): string {
  const configured = serverEnv().APP_BASE_URL;
  if (!configured) return path;
  try {
    return `${new URL(configured).origin}${path}`;
  } catch {
    return path;
  }
}

export function buildSetupLine(input: { origin: string; grant: string; expiresAt: string }): string {
  const { origin, grant, expiresAt } = input;
  return (
    `Set yourself up as my AI on ${origin}: read ${origin}/.well-known/agent.json, then POST ${origin}/api/v1/agent/register ` +
    `with {"name":"<a name you choose>","spawnGrant":"${grant}"}, and confirm the key it returns with POST ${origin}/api/v1/agent/credentials/confirm ` +
    `(Authorization: Bearer <that key>). This setup code works once and expires ${expiresAt}.`
  );
}
