// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/auth/request-identity`
 * Purpose: Regression tests for resolveRequestIdentity — guards against the circular re-export
 *   that caused unbounded async recursion and candidate-a OOM in an earlier revision of the
 *   agent-first auth lane.
 * Scope: Exercises the real resolver chain (request-identity.ts → session.ts → server.ts). Does
 *   not mock @/app/_lib/auth/request-identity or @/app/_lib/auth/session — only the leaf
 *   getServerSessionUser and next/headers. This placement is intentional: any re-introduction of
 *   the cycle would blow this test's call budget immediately.
 * Invariants:
 *   - NO_RECURSION: a non-bearer request calls the leaf session getter exactly once.
 *   - BEARER_PARSED: a bearer request never reaches the session getter.
 *   - BOUNDED_WORK: 1000 sequential resolver calls complete under 1 second with ≤ 1000 leaf calls.
 * Side-effects: none (mocked next/headers and @/lib/auth/server).
 * Links: src/app/_lib/auth/request-identity.ts, src/app/_lib/auth/session.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetServerSessionUser = vi.fn();
const mockHeaders = vi.fn();

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("next/headers", () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

const mockEverConfirmed = vi.fn();
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => ({ everConfirmed: (...args: unknown[]) => mockEverConfirmed(...args) }),
}));

vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "test-secret-for-unit-tests-only" }),
}));

import {
  issueAgentApiKey,
  resolveRequestIdentity,
} from "@/app/_lib/auth/request-identity";

function headersFromRecord(record: Record<string, string>) {
  const normalized = new Map(
    Object.entries(record).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
  };
}

const FAKE_SESSION_USER = {
  id: "user-42",
  walletAddress: null,
  displayName: "Tester",
  avatarColor: null,
};

describe("resolveRequestIdentity — circular-recursion regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getServerSessionUser exactly once for a cookie-only request", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(FAKE_SESSION_USER);

    const user = await resolveRequestIdentity();

    expect(user).toEqual({ ...FAKE_SESSION_USER, via: "session" });
    expect(mockGetServerSessionUser).toHaveBeenCalledTimes(1);
  });

  it("returns null without touching the session getter on an invalid bearer", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: "Bearer cogni_ag_sk_v1_not-a-real-token",
      })
    );

    const user = await resolveRequestIdentity();

    expect(user).toBeNull();
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });

  it("bounds work at O(1) per call across 1000 non-bearer requests", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(null);

    const ITERATIONS = 1000;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await resolveRequestIdentity();
    }
    const elapsedMs = performance.now() - start;

    // If request-identity.ts ever recurses into itself via session.ts, this count
    // explodes (each outer call triggers N inner calls) or the loop never terminates.
    expect(mockGetServerSessionUser).toHaveBeenCalledTimes(ITERATIONS);
    // Loose upper bound — a healthy resolver finishes 1000 mocked calls in well under 1s.
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("resolveRequestIdentity — via is recorded for logging (task.5456)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEverConfirmed.mockResolvedValue(false);
  });

  it("marks a cookie session as via=session", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(FAKE_SESSION_USER);
    expect((await resolveRequestIdentity())?.via).toBe("session");
  });

  it("marks a valid machine bearer as via=bearer and never reads the session", async () => {
    const apiKey = issueAgentApiKey({ userId: "agent-1", displayName: "Agent" });
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${apiKey}` })
    );
    const user = await resolveRequestIdentity();
    expect(user).toMatchObject({ id: "agent-1", via: "bearer" });
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });

  it("V1_SUPERSEDED: a valid signed key whose user holds a confirmed revocable key is refused with v1_superseded", async () => {
    mockEverConfirmed.mockResolvedValue(true);
    const apiKey = issueAgentApiKey({ userId: "agent-1", displayName: "Agent" });
    mockHeaders.mockResolvedValue(headersFromRecord({ authorization: `Bearer ${apiKey}` }));
    await expect(resolveRequestIdentity()).rejects.toMatchObject({ code: "v1_superseded" });
    expect(mockEverConfirmed).toHaveBeenCalledWith("agent-1");
  });

  it("a forged signed key never reads the store, and a store failure on the v1 gate is an outage (503), not a 401", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({ authorization: "Bearer cogni_ag_sk_v1_forged.sig" }));
    expect(await resolveRequestIdentity()).toBeNull();
    expect(mockEverConfirmed).not.toHaveBeenCalled();
    mockEverConfirmed.mockRejectedValue(new Error("db down"));
    const apiKey = issueAgentApiKey({ userId: "agent-1", displayName: "Agent" });
    mockHeaders.mockResolvedValue(headersFromRecord({ authorization: `Bearer ${apiKey}` }));
    await expect(resolveRequestIdentity()).rejects.toMatchObject({ code: "authz_unavailable" });
  });

  it("returns null for a missing session without inventing a via", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(null);
    expect(await resolveRequestIdentity()).toBeNull();
  });
});
