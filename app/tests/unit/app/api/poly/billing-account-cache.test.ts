// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/billing-account-cache`
 * Purpose: Prove the poly dashboard billing-floor cache (dashboard
 *   read-path floor fix): warm hits resolve with zero service calls,
 *   concurrent resolutions single-flight, the read path skips the
 *   transactional create branch when the account exists, the create branch
 *   runs exactly once on a genuine miss, entries are per-user, TTL-bounded,
 *   and errors are never cached.
 * Scope: Unit — exercises `resolveBillingAccountId` against a mocked
 *   `ServiceAccountService` subset and the real coalesce cache. No DB.
 * Side-effects: none (module cache reset per spec via `clearTtlCache`)
 * Links: src/app/api/v1/poly/_lib/billing-account-cache.ts,
 *        src/ports/accounts.port.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLING_ACCOUNT_ID_CACHE_TTL_MS,
  billingAccountIdCacheKey,
  resolveBillingAccountId,
} from "@/app/api/v1/poly/_lib/billing-account-cache";
import { clearTtlCache } from "@/features/wallet-analysis/server/coalesce";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function accountsWithExisting(id: string) {
  return {
    findBillingAccountIdForUser: vi.fn().mockResolvedValue(id),
    getOrCreateBillingAccountForUser: vi.fn(),
  };
}

describe("resolveBillingAccountId (poly billing floor)", () => {
  beforeEach(() => {
    clearTtlCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("existing account: read path only — the transactional create branch never runs", async () => {
    const accounts = accountsWithExisting(ACCOUNT_A);

    await expect(resolveBillingAccountId(accounts, USER_A)).resolves.toBe(
      ACCOUNT_A
    );

    expect(accounts.findBillingAccountIdForUser).toHaveBeenCalledTimes(1);
    expect(accounts.findBillingAccountIdForUser).toHaveBeenCalledWith(USER_A);
    expect(accounts.getOrCreateBillingAccountForUser).not.toHaveBeenCalled();
  });

  it("warm hit: zero service calls on the second resolution", async () => {
    const accounts = accountsWithExisting(ACCOUNT_A);

    await resolveBillingAccountId(accounts, USER_A);
    await expect(resolveBillingAccountId(accounts, USER_A)).resolves.toBe(
      ACCOUNT_A
    );

    expect(accounts.findBillingAccountIdForUser).toHaveBeenCalledTimes(1);
    expect(accounts.getOrCreateBillingAccountForUser).not.toHaveBeenCalled();
  });

  it("single-flight: a concurrent burst shares one resolution", async () => {
    const accounts = accountsWithExisting(ACCOUNT_A);

    const results = await Promise.all([
      resolveBillingAccountId(accounts, USER_A),
      resolveBillingAccountId(accounts, USER_A),
      resolveBillingAccountId(accounts, USER_A),
    ]);

    expect(results).toEqual([ACCOUNT_A, ACCOUNT_A, ACCOUNT_A]);
    expect(accounts.findBillingAccountIdForUser).toHaveBeenCalledTimes(1);
  });

  it("genuine miss: falls back to the idempotent create exactly once, then serves from cache", async () => {
    const accounts = {
      findBillingAccountIdForUser: vi.fn().mockResolvedValue(null),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: ACCOUNT_A,
        ownerUserId: USER_A,
        balanceCredits: 0,
        defaultVirtualKeyId: "vk-1",
      }),
    };

    await expect(resolveBillingAccountId(accounts, USER_A)).resolves.toBe(
      ACCOUNT_A
    );
    await expect(resolveBillingAccountId(accounts, USER_A)).resolves.toBe(
      ACCOUNT_A
    );

    expect(accounts.getOrCreateBillingAccountForUser).toHaveBeenCalledTimes(1);
    expect(accounts.getOrCreateBillingAccountForUser).toHaveBeenCalledWith({
      userId: USER_A,
    });
  });

  it("entries are per-user: two users resolve independently", async () => {
    const accounts = {
      findBillingAccountIdForUser: vi
        .fn()
        .mockImplementation(async (userId: string) =>
          userId === USER_A ? ACCOUNT_A : ACCOUNT_B
        ),
      getOrCreateBillingAccountForUser: vi.fn(),
    };

    await expect(resolveBillingAccountId(accounts, USER_A)).resolves.toBe(
      ACCOUNT_A
    );
    await expect(resolveBillingAccountId(accounts, USER_B)).resolves.toBe(
      ACCOUNT_B
    );
    expect(accounts.findBillingAccountIdForUser).toHaveBeenCalledTimes(2);
    expect(billingAccountIdCacheKey(USER_A)).not.toBe(
      billingAccountIdCacheKey(USER_B)
    );
  });

  it("TTL-bounded: past the TTL the id is re-resolved (self-healing bound)", async () => {
    vi.useFakeTimers();
    const accounts = accountsWithExisting(ACCOUNT_A);

    await resolveBillingAccountId(accounts, USER_A);
    vi.advanceTimersByTime(BILLING_ACCOUNT_ID_CACHE_TTL_MS + 1);
    await resolveBillingAccountId(accounts, USER_A);

    expect(accounts.findBillingAccountIdForUser).toHaveBeenCalledTimes(2);
  });

  it("errors are never cached: the next call retries", async () => {
    const accounts = {
      findBillingAccountIdForUser: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(ACCOUNT_A),
      getOrCreateBillingAccountForUser: vi.fn(),
    };

    await expect(resolveBillingAccountId(accounts, USER_A)).rejects.toThrow(
      "db down"
    );
    await expect(resolveBillingAccountId(accounts, USER_A)).resolves.toBe(
      ACCOUNT_A
    );
  });

  it("TTL sits in the 30-60s window (identity is immutable; TTL is a memory/self-heal bound)", () => {
    expect(BILLING_ACCOUNT_ID_CACHE_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(BILLING_ACCOUNT_ID_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});
