// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/schedule-capability-subject.int.test`
 * Purpose: V5 at the database: schedule tools run as the run subject (else the principal) under real RLS, so user A
 *   cannot change user B's schedule, and a run with no identity cannot touch schedules (task.5456).
 * Scope: Real `createScheduleCapability` + real `DrizzleScheduleUserAdapter` on the app role (FORCE RLS) + the real
 *   ExecutionScope. Temporal control is a recording stub; it must never be reached for a foreign schedule.
 * Invariants: RLS_ENFORCED, THREE_IDENTITIES (`scopeUserId` = subject, else principal).
 * Side-effects: IO (Postgres)
 */

import { randomUUID } from "node:crypto";
import { type Database, DrizzleScheduleUserAdapter } from "@cogni/db-client";
import {
  billingAccounts,
  executionGrants,
  schedules,
  users,
} from "@cogni/db-schema";
import { NODE_AI_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { generateTestWallet } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import { createScheduleCapability } from "@/bootstrap/capabilities/schedule";

const scope = (identity: { subjectUserId?: string; principalId?: string }) => ({
  billing: { billingAccountId: "payer", virtualKeyId: "vk" },
  usageSource: "litellm" as const,
  llmService: {} as never,
  ...identity,
});

describe("schedule capability binds to the subject (real RLS)", () => {
  let seed: Database;
  const userA = randomUUID();
  const userB = randomUUID();
  const scheduleA = randomUUID();
  const control = { deleteSchedule: vi.fn(async () => {}) };
  const grants = { revokeGrant: vi.fn(async () => {}) };
  let capability: ReturnType<typeof createScheduleCapability>;

  beforeAll(async () => {
    seed = getSeedDb();
    for (const id of [userA, userB])
      await seed.insert(users).values({ id, name: "subject fixture", walletAddress: generateTestWallet(id) });
    const billing = randomUUID();
    const grant = randomUUID();
    await seed.insert(billingAccounts).values({ id: billing, ownerUserId: userA, balanceCredits: 0n });
    await seed.insert(executionGrants).values({ id: grant, userId: userA, billingAccountId: billing, scopes: ["graph:execute:test:subject"] });
    await seed.insert(schedules).values({
      id: scheduleA,
      ownerUserId: userA,
      executionGrantId: grant,
      graphId: "test:subject",
      input: {},
      cron: "0 0 * * *",
      timezone: "UTC",
      enabled: true,
      nextRunAt: new Date(Date.now() + 86_400_000),
    });
    capability = createScheduleCapability({
      // biome-ignore lint/suspicious/noExplicitAny: recording stubs for the Temporal and grant ports
      scheduleManager: new DrizzleScheduleUserAdapter(getAppDb(), control as any, grants as any),
      getOrCreateBillingAccountId: async () => randomUUID(),
    });
  });

  afterAll(async () => {
    await seed.delete(users).where(inArray(users.id, [userA, userB]));
  });

  it("the subject sees and owns their own schedule", async () => {
    const list = await runInScope(scope({ subjectUserId: userA, principalId: NODE_AI_PRINCIPAL_USER_ID }), () => capability.list());
    expect(list.map((s) => s.id)).toEqual([scheduleA]);
  });

  it("user B (the subject) cannot see or change user A's schedule, even through a principal that holds the role", async () => {
    const asB = scope({ subjectUserId: userB, principalId: NODE_AI_PRINCIPAL_USER_ID });
    expect(await runInScope(asB, () => capability.list())).toEqual([]);
    await expect(runInScope(asB, () => capability.remove(scheduleA))).rejects.toThrow();
    await expect(runInScope(asB, () => capability.setEnabled(scheduleA, false))).rejects.toThrow();
    expect(control.deleteSchedule).not.toHaveBeenCalled();
    const [row] = await seed.select().from(schedules).where(eq(schedules.id, scheduleA));
    expect(row?.enabled).toBe(true);
  });

  it("a bearer agent is the subject: it sees only its own rows and cannot touch user A's", async () => {
    const agent = randomUUID();
    await seed.insert(users).values({ id: agent, name: "bearer agent fixture" });
    try {
      const asAgent = scope({ subjectUserId: agent, principalId: NODE_AI_PRINCIPAL_USER_ID });
      expect(await runInScope(asAgent, () => capability.list())).toEqual([]);
      await expect(runInScope(asAgent, () => capability.remove(scheduleA))).rejects.toThrow();
      await expect(runInScope(asAgent, () => capability.setEnabled(scheduleA, false))).rejects.toThrow();
      expect(control.deleteSchedule).not.toHaveBeenCalled();
      const [row] = await seed.select().from(schedules).where(eq(schedules.id, scheduleA));
      expect(row?.enabled).toBe(true);
    } finally {
      await seed.delete(users).where(eq(users.id, agent));
    }
  });

  it("with no subject the principal's own user id is used, never another user's", async () => {
    const asPrincipal = scope({ principalId: NODE_AI_PRINCIPAL_USER_ID });
    expect(await runInScope(asPrincipal, () => capability.list())).toEqual([]);
    await expect(runInScope(asPrincipal, () => capability.remove(scheduleA))).rejects.toThrow();
  });

  it("with no subject and no principal the call fails before the database", async () => {
    await expect(runInScope(scope({}), () => capability.list())).rejects.toThrow(/no subject or principal/);
  });
});
