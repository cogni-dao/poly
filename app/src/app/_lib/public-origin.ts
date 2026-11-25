// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/public-origin`
 * Purpose: The public origin a request reached this node through, for URLs handed to a person or an agent (discovery, approval links).
 * Scope: Pure request read. In production the app runs behind Caddy or a k8s ingress, so `request.url` shows the in-pod bind address; the forwarded
 *   headers the proxy injects name the external host.
 * Invariants: NO_INTERNAL_BIND_ADDR: never return `0.0.0.0:3000` or another in-pod address when a forwarded host exists.
 * Side-effects: none
 * @public
 */

export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
