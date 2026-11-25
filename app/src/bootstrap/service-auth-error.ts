// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-auth-error`
 * Purpose: The one typed error a service assertion check throws when it could not decide because the home's key set was unreachable. The route wrapper answers it
 *   503 `authz_unavailable` (never 401: the caller did nothing wrong).
 * Scope: A class only, so the identity resolver and the route wrapper share it without importing the service wiring.
 * Side-effects: none
 * @internal
 */

export class ServiceAuthUnavailableError extends Error {
  constructor() {
    super("service assertion could not be verified");
    this.name = "ServiceAuthUnavailableError";
  }
}
