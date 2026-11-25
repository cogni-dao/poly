// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/request-identity`
 * Purpose: Unified request identity resolver — returns a SessionUser for
 *   a valid HMAC-signed machine bearer token (`cogni_ag_sk_v1_...`), a revocable hashed key (the `REVOCABLE_KEY_PREFIX` token,
 *   one store lookup), or a browser session cookie. One entry point for all auth surfaces.
 * Scope: Bearer parser + HMAC signer/verifier (issueAgentApiKey exported to
 *   the register route only), and resolveRequestIdentity which
 *   wrapRouteHandlerWithLogging consumes via `auth.getSessionUser`. Does NOT
 *   read from the database for sessions — all session IO happens via getServerSessionUser. Credential-store reads are listed below.
 * Invariants:
 *   - V1_PATH_UNCHANGED (task.0070 C2): `parseAgentToken` and its HMAC/expiry checks are byte-for-byte what they were. A revocable key is routed
 *     BEFORE them by prefix; it never reaches the v1 verifier.
 *   - V1_SUPERSEDED: once the verified v1 identity's user holds a CONFIRMED revocable credential (revoked or not), the request is refused with
 *     `V1SupersededError` (401 `v1_superseded`). Revoking the revocable key therefore cannot revive a leaked signed key. One store read per v1 request.
 *   - REVOCABLE_STORE_OUTAGE_IS_503: a store failure throws `CredentialStoreUnavailableError` (the route wrapper answers 503), never null (401).
 *   - SERVICE_ASSERTION_BEARER (story.0038): a bearer that is a compact JWT (not a `cogni_ag_sk_` key) is a service assertion from a trusted home. A verified
 *     assertion whose service has asked (it has a principal) is that principal with `via: "bearer"`; every other outcome is null (401) except an unreachable key
 *     set (`ServiceAuthUnavailableError`, 503). The grant row, never the assertion, decides what it may do. A `jti` is single-use, so the verdict is memoised per
 *     request (the headers object) and one request never replays itself.
 *   - REVOCABLE_ACTIVE_ONLY: the generic resolver admits only an `active` revocable key. A pending or renew_only key reaches only the
 *     credential routes that opt in through `verifyRevocableKey`.
 *   - VIA_IS_LOGGING_AND_WRITE_GATE: the resolved identity carries `via: "bearer" | "session"`. It is for logging and the DENY_BY_DEFAULT
 *     write gate in the route wrapper (bug.0045); it is never a tool-authority input: every authenticated caller is the run subject, bearer agents included (task.5456).
 *   - NO_AUTH_CYCLE: imports getServerSessionUser DIRECTLY from @/lib/auth/server.
 *     Must NOT import getSessionUser from @/app/_lib/auth/session (that module
 *     re-exports this resolver and would create unbounded async recursion on
 *     every non-bearer request — candidate-a OOM class of bug).
 *   - BEARER_CLAIMS_EXCLUSIVE: when a bearer token is present but invalid,
 *     returns null (does not fall back to session cookies). Prevents a stolen
 *     cookie from winning when the client claimed machine identity.
 *   - NO_REDOS: extractBearerToken uses startsWith/slice (O(n)), not regex
 *     backtracking. Flagged by SonarQube on the original /^Bearer\s+(.+)$/i.
 * Side-effects: IO (next/headers read, NextAuth session fetch via server.ts).
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/security-auth.md, https://cognidao.org/knowledge/node-template-identity-model
 * @public
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  assertV1NotSuperseded,
  CredentialRateLimitedError,
  type CredentialState,
  CredentialStoreUnavailableError,
  isRevocableKey,
  type VerifyResult,
  verifyBearer,
} from "@cogni/agent-grants/credentials";
import type { SessionUser } from "@cogni/node-shared";
import { headers } from "next/headers";
import { ServiceAuthUnavailableError } from "@/bootstrap/service-auth-error";
import { getServerSessionUser } from "@/lib/auth/server";
import { serverEnv } from "@/shared/env/server";

type AgentTokenPayload = {
  sub: string;
  displayName: string | null;
  iat: number;
  exp: number;
};

const TOKEN_PREFIX = "cogni_ag_sk_v1_";
const AGENT_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  // Avoid regex backtracking: use startsWith + slice (O(n), no ReDoS risk).
  // Flagged by SonarQube on /^Bearer\s+(.+)$/i — the (.+) group allowed
  // super-linear backtracking on crafted Authorization headers.
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trimStart();
  return token || null;
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", serverEnv().AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

function parseAgentToken(token: string): AgentTokenPayload | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const encoded = token.slice(TOKEN_PREFIX.length);
  const [payloadB64, signature] = encoded.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = signPayload(payloadB64);
  if (!safeCompare(signature, expected)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as AgentTokenPayload;
    if (!parsed.sub) return null;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function issueAgentApiKey(input: {
  userId: string;
  displayName: string | null;
}): string {
  const payload: AgentTokenPayload = {
    sub: input.userId,
    displayName: input.displayName,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + AGENT_KEY_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  return `${TOKEN_PREFIX}${payloadB64}.${signPayload(payloadB64)}`;
}

/** A compact JWT: three base64url segments. A signed agent key (`cogni_ag_sk_v1_`) has two and its own prefix. */
const COMPACT_JWT = /^[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{4,512}$/;

/** One verdict per request: a service assertion's `jti` is single-use, so asking twice in one request must not look like a replay. */
const serviceIdentityByRequest = new WeakMap<object, Promise<SessionUser | null>>();

async function resolveServiceIdentity(token: string): Promise<SessionUser | null> {
  const { getContainer } = await import("@/bootstrap/container");
  const container = getContainer();
  const result = await container.serviceAuth.verify(token);
  if (!result.ok) {
    if (result.code === "jwks_unavailable") throw new ServiceAuthUnavailableError();
    return null;
  }
  const userId = await container.agentAuthority.servicePrincipalOf(result);
  if (!userId) return null;
  return { id: userId, walletAddress: null, displayName: `${result.service}@${new URL(result.issuer).host}`, avatarColor: null, via: "bearer" };
}

function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** A cookie session identity, marked `via: "session"`: logging and the DENY_BY_DEFAULT write gate (a session passes it; anything else is treated as a bearer). */
async function resolveSessionIdentity(): Promise<SessionUser | null> {
  const user = await getServerSessionUser();
  return user ? { ...user, via: "session" } : null;
}

/**
 * Verify a revocable key against the credential store, accepting the listed states. Used by the credential routes (rotate, confirm, revoke) that
 * take a pending or renew_only key. The store is loaded lazily: the v1 and session paths never touch it.
 */
export async function verifyRevocableKey(
  token: string,
  allow: readonly CredentialState[]
): Promise<VerifyResult> {
  const { getAgentCredentialStore, admitCredentialLookup, recordCredentialMiss } = await import("@/bootstrap/agent-credentials");
  const h = await headers();
  return verifyBearer(getAgentCredentialStore(), token, allow, {
    admit: () => admitCredentialLookup(h),
    onInvalid: () => recordCredentialMiss(h),
  });
}

/** The bearer token of the current request, if any (the credential routes read it to tell a signed key from a revocable one). */
export async function currentBearerToken(): Promise<string | null> {
  try {
    return extractBearerToken((await headers()).get("authorization"));
  } catch {
    return null;
  }
}

export async function resolveRequestIdentity(): Promise<SessionUser | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return resolveSessionIdentity();
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (bearer) {
    if (isRevocableKey(bearer)) {
      const verified = await verifyRevocableKey(bearer, ["active"]);
      if (verified.ok) {
        return { id: verified.userId, walletAddress: null, displayName: verified.name, avatarColor: null, via: "bearer" };
      }
      if (verified.reason === "unavailable") throw new CredentialStoreUnavailableError(verified.cause);
      if (verified.reason === "rate_limited") throw new CredentialRateLimitedError();
      return null;
    }
    if (!bearer.startsWith(TOKEN_PREFIX) && COMPACT_JWT.test(bearer)) {
      let verdict = serviceIdentityByRequest.get(h);
      if (!verdict) {
        verdict = resolveServiceIdentity(bearer);
        serviceIdentityByRequest.set(h, verdict);
      }
      return verdict;
    }
    const payload = parseAgentToken(bearer);
    if (!payload) return null;
    const { getAgentCredentialStore } = await import("@/bootstrap/agent-credentials");
    await assertV1NotSuperseded(getAgentCredentialStore(), payload.sub);
    return {
      id: payload.sub,
      walletAddress: null,
      displayName: payload.displayName,
      avatarColor: null,
      via: "bearer",
    };
  }

  if (!isSameOrigin(h.get("origin"), h.get("host"))) {
    return null;
  }

  return resolveSessionIdentity();
}

/** Validated request provenance, only after resolveRequestIdentity succeeded. */
export async function resolveRequestActorKind(userId: string): Promise<"agent" | "user"> {
  const h = await headers();
  const token = extractBearerToken(h.get("authorization"));
  if (!token) return "user";
  const payload = parseAgentToken(token);
  if (!payload || payload.sub !== userId) throw new Error("invalid_principal_provenance");
  return "agent";
}
