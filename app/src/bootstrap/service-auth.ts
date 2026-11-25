// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-auth`
 * Purpose: This node's composition of `@cogni-dao/agent-grants` service assertions and orgs: the optional signer (this node as a home), the verifier over the
 *   trusted homes (this node as a target), (no org owner source: orgs are not part of this node).
 * Scope: Env reading and composition only. The GitHub read, the trusted-homes parser, the signer, the verifier and every decision live in the package (the operator
 *   plugs in the same code). Never logs a token or a key.
 * Invariants:
 *   - ALL_OPTIONAL: no signing key = no signer (an outbound need is 503) and no jwks route; no trusted homes = every assertion is `untrusted_issuer`.
 *   - SIGNER_FAILS_LOUD: a malformed signing seed (not 64 hex characters) or an unusable origin is no signer plus one
 *     `service_auth.signer_unavailable` warning naming the reason, never a silent null and never the key.
 *   - SINGLE_REPLICA_REPLAY: the replay store is in memory; a target with several replicas needs a shared store behind the same interface.
 * Side-effects: IO (HTTPS to a home's JWKS)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import {
  createMemoryReplayStore,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  type ServiceAssertionResult,
  type ServiceAssertionSigner,
  type ServiceAssertionVerifier,
  type TrustedHome,
} from "@cogni/agent-grants/service-auth";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";

export interface ServiceAuth {
  /** This node as a home: the signer, or null until the signing key and kid are configured and valid. Resolved once. */
  getSigner(): Promise<ServiceAssertionSigner | null>;
  /** This node as a target: refuses every assertion until a trusted home is configured. */
  readonly verifier: ServiceAssertionVerifier;
  /** Verify an assertion and log the outcome (`service_auth.verified` / `service_auth.rejected`). */
  verify(token: string): Promise<ServiceAssertionResult>;
}

interface SignerEnv {
  readonly SERVICE_ASSERTION_SIGNING_SEED?: string | undefined;
  readonly APP_BASE_URL?: string | undefined;
}

/**
 * The signer from the 32-byte hex seed and this node's own origin. Null and silent when no seed is set (this node is not a home); null with ONE warning naming the reason
 * when the seed is malformed or the origin is unusable. Never logs the seed. The key pair and its kid derive from the seed inside the package.
 */
export async function buildSigner(env: SignerEnv, log: Pick<Logger, "warn">): Promise<ServiceAssertionSigner | null> {
  if (!env.SERVICE_ASSERTION_SIGNING_SEED) return null;
  const fail = (reason: string): null => {
    log.warn({ event: EVENT_NAMES.SERVICE_AUTH_SIGNER_UNAVAILABLE, reason }, EVENT_NAMES.SERVICE_AUTH_SIGNER_UNAVAILABLE);
    return null;
  };
  let origin: string;
  try {
    origin = new URL(env.APP_BASE_URL ?? "").origin;
  } catch {
    return fail("app_base_url_unusable");
  }
  try {
    return await createServiceAssertionSignerFromSeed({ issuer: origin, seedHex: env.SERVICE_ASSERTION_SIGNING_SEED });
  } catch {
    return fail("signing_seed_malformed");
  }
}

/** Refusals that are routine noise (an unknown caller, junk input) log at debug; every other refusal is a warning. */
const QUIET_REFUSALS: ReadonlySet<string> = new Set(["untrusted_issuer", "malformed"]);

export function createServiceAuth(deps: {
  env: SignerEnv;
  /** The homes this deployment trusts, from `.cogni/service-links.yaml` (empty = every assertion is `untrusted_issuer`). */
  trustedHomes: readonly TrustedHome[];
  nodeId: string;
  log: Logger;
}): ServiceAuth {
  const verifier = createServiceAssertionVerifier({
    selfNodeId: deps.nodeId,
    trustedHomes: [...deps.trustedHomes],
    replay: createMemoryReplayStore(),
  });
  let signer: Promise<ServiceAssertionSigner | null> | undefined;
  return {
    getSigner: () => (signer ??= buildSigner(deps.env, deps.log)),
    verifier,
    async verify(token) {
      const result = await verifier.verify(token);
      // Never the token. On a refusal the issuer and service are the unverified claims, for diagnosis only.
      if (result.ok)
        deps.log.info(
          { event: EVENT_NAMES.SERVICE_AUTH_VERIFIED, issuer: result.issuer, service: result.service },
          EVENT_NAMES.SERVICE_AUTH_VERIFIED
        );
      else
        deps.log[QUIET_REFUSALS.has(result.code) ? "debug" : "warn"](
          { event: EVENT_NAMES.SERVICE_AUTH_REJECTED, code: result.code, issuer: result.issuer, service: result.service },
          EVENT_NAMES.SERVICE_AUTH_REJECTED
        );
      return result;
    },
  };
}
