// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { extractGovernanceConfig, parseRepoSpec } from "@cogni/repo-spec";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  config: { schedules: [] } as ReturnType<typeof extractGovernanceConfig>,
  held: false,
  locked: false,
  acquired: true,
  enabled: true,
  tamper: "",
  fail: "",
  phases: 0,
  commits: 0,
  rollbacks: 0,
  lost: 0,
  sql: [] as string[],
  effects: [] as string[],
  waiters: [] as (() => void)[],
  service: null as unknown,
  blocked: null as null | (() => void),
}));
vi.mock("@cogni/db-client", () => ({
  withTenantScope: vi.fn(async (db, _actor, callback) => callback(db)),
}));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));
vi.mock("@cogni/node-shared", () => ({
  COGNI_SYSTEM_BILLING_ACCOUNT_ID: "billing",
  COGNI_SYSTEM_PRINCIPAL_USER_ID: "00000000-0000-4000-a000-000000000001",
}));
vi.mock(
  "@cogni/scheduler-core",
  async () =>
    import(
      "../../../../packages/scheduler-core/src/services/syncGovernanceSchedules"
    )
);
vi.mock("@/shared/config", () => ({
  getGovernanceConfig: () => state.config,
  getNodeId: () => "node_%",
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ GOVERNANCE_SCHEDULES_ENABLED: state.enabled }),
}));
vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => state.service,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: { info() {}, warn() {} },
    executionGrantPort: {
      ensureGrant: async () => {
        state.effects.push("grant");
        if (state.tamper)
          state.db!.exec(
            `update schedules set ${state.tamper} where id='000001'`
          );
        return { id: "grant" };
      },
    },
    scheduleControl: {
      createSchedule: async ({ scheduleId }: { scheduleId: string }) => {
        state.effects.push(`create:${scheduleId}`);
        if (state.fail === "callback") throw new Error("callback failure");
      },
      pauseSchedule: async (id: string) => {
        state.effects.push(`pause:${id}`);
      },
      triggerSchedule: async () => {
        throw new Error("sovereign ledger trigger");
      },
      listScheduleIds: async () => {
        throw new Error("namespace scan");
      },
    },
  }),
}));

import { withTenantScope, type Database } from "@cogni/db-client";
import type { ActorId } from "@cogni/ids";
import type { ServiceAccountService } from "@/ports";
import { DrizzleGovernanceStatusAdapter } from "@/adapters/server/governance/drizzle-governance-status.adapter";
import {
  resetStartupAssertionsForTest,
  startSystemTenantAssertionOnBoot,
} from "@/bootstrap/startup-assertions";
import { runGovernanceSchedulesSyncJob } from "@/bootstrap/jobs/syncGovernanceSchedules.job";
import {
  attemptGovernanceStartupReconcile,
  GOVERNANCE_RECONCILE_MAX_ATTEMPTS,
  GOVERNANCE_RECONCILE_RETRY_DELAY_MS,
} from "@/bootstrap/startup-reconcile";

// Execute the submitted Drizzle SQL, translating only PostgreSQL scalar syntax.
// SQLite is a predicate oracle here, not native Postgres/session proof.
function sqliteSql(sql: string): string {
  return sql
    .replace(/\bleft\(/gi, "pg_left(")
    .replace(
      /substring\(("schedules"\."temporal_schedule_id") from length\((\$\d+)\) \+ 1\)/gi,
      "substr($1, length($2) + 1)"
    );
}
function proxy(pinned: boolean) {
  return drizzle(async (query, params) => {
    if (!pinned && state.held) {
      state.blocked?.();
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    state.sql.push(query);
    if (query.includes("advisory")) {
      expect(query).toBe(
        "SELECT pg_try_advisory_xact_lock(hashtext('governance_sync')) AS acquired"
      );
      if (state.fail === "acquire") throw new Error("acquire failure");
      state.locked = state.acquired;
      return { rows: [{ acquired: state.acquired }] };
    }
    if (!state.locked) throw new Error("query without transaction lock");
    if (state.fail === "read" && query.startsWith("select"))
      throw new Error("read failure");
    if (query.startsWith('select "id", "temporal_schedule_id"')) {
      expect(params.at(-1)).toBe(1001);
      expect(query).toContain(" limit ");
    }
    const translated = sqliteSql(query);
    // Repeat positional PostgreSQL parameters in SQLite's positional order.
    const bindings: Array<string | number | null> = [];
    const statement = state.db!.prepare(
      translated.replace(/\$(\d+)/g, (_, n: string) => {
        const value: unknown = params[Number(n) - 1];
        bindings.push(
          typeof value === "boolean"
            ? Number(value)
            : value == null
              ? null
              : typeof value === "string" || typeof value === "number"
                ? value
                : JSON.stringify(value)
        );
        return "?";
      })
    );
    if (/^(select|.* returning )/i.test(query)) {
      return {
        rows: statement.all(...bindings).map((row) => Object.values(row)),
      };
    }
    statement.run(...bindings);
    state.effects.push("disable-or-upsert");
    return { rows: [] };
  });
}
function row(
  id: number,
  tid: string | null,
  owner = "00000000-0000-4000-a000-000000000001",
  enabled = true
) {
  state
    .db!.prepare(
      "insert into schedules(id, temporal_schedule_id, owner_user_id, enabled) values (?, ?, ?, ?)"
    )
    .run(String(id).padStart(6, "0"), tid, owner, Number(enabled));
}
function excluded() {
  row(10001, "governance:sibling:stale");
  row(10002, "governance:node_%:LEDGER_INGEST");
  row(10003, "governance:node_%:LeDgEr_InGeSt");
  row(10004, "governance:node_%:");
  row(10005, "governance:node_X:stale");
  row(10006, "governance:node_%:foreign", "foreign");
  row(
    10007,
    "governance:node_%:disabled",
    "00000000-0000-4000-a000-000000000001",
    false
  );
  row(10008, "ordinary:node_%:user");
  row(10009, null);
}
beforeEach(() => {
  Object.assign(state, {
    held: false,
    locked: false,
    acquired: true,
    enabled: true,
    tamper: "",
    fail: "",
    phases: 0,
    commits: 0,
    rollbacks: 0,
    lost: 0,
    sql: [],
    effects: [],
    waiters: [],
    blocked: null,
  });
  state.config = extractGovernanceConfig(
    parseRepoSpec(
      readFileSync(
        new URL("../../../../.cogni/repo-spec.yaml", import.meta.url),
        "utf8"
      )
    )
  );
  state.db = new DatabaseSync(":memory:");
  state.db.function("pg_left", (text, n) =>
    text == null ? null : String(text).slice(0, Number(n))
  );
  state.db.function("split_part", (text, separator, n) =>
    text == null
      ? null
      : (String(text).split(String(separator))[Number(n) - 1] ?? "")
  );
  state.db.function("string_to_array", (text, separator) =>
    text == null ? null : JSON.stringify(String(text).split(String(separator)))
  );
  state.db.function("array_length", (text, _dimension) =>
    text == null ? null : (JSON.parse(String(text)) as unknown[]).length
  );
  state.db.exec(
    "create table schedules(id text primary key default 'inserted', temporal_schedule_id text, owner_user_id text, enabled integer default 1, execution_grant_id text, graph_id text, input text, cron text, timezone text, next_run_at text, last_run_at text, created_at text, updated_at text)"
  );
  state.service = Object.assign(proxy(false), {
    transaction: async (
      callback: (tx: ReturnType<typeof proxy>) => Promise<unknown>
    ) => {
      state.held = true;
      state.phases++;
      state.db!.exec("begin");
      try {
        const result = await callback(proxy(true));
        if (state.fail === "commit" || state.fail === "session") {
          if (state.fail === "session") state.lost++;
          throw new Error(`${state.fail} failure`);
        }
        state.db!.exec("commit");
        state.commits++;
        return result;
      } catch (error) {
        state.db!.exec("rollback");
        state.rollbacks++;
        throw error;
      } finally {
        state.locked = false;
        state.held = false;
        for (const wake of state.waiters.splice(0)) wake();
      }
    },
  });
});
afterEach(() => {
  state.db?.close();
});

describe("native transaction wiring and submitted SQL", () => {
  it("uses the single resource, complete local preflight and exact disable predicates", async () => {
    excluded();
    row(1, "governance:node_%:stale");
    row(2, "governance:ledger_ingest");
    row(3, "governance:legacy");
    const blocked = new Promise<"blocked">((resolve) => {
      state.blocked = () => resolve("blocked");
    });
    const result = await Promise.race([
      runGovernanceSchedulesSyncJob(),
      blocked,
    ]);
    expect(result).not.toBe("blocked");
    expect(state.effects.filter((e) => e.startsWith("pause:"))).toEqual([
      "pause:governance:node_%:stale",
    ]);
    expect(
      state
        .db!.prepare("select id from schedules where enabled=0 order by id")
        .all()
        .map((r) => r.id)
    ).toEqual(["000001", "000002", "000003", "010007"]);
    expect(state.sql[1]).toMatch(
      /^select "id", "temporal_schedule_id" from "schedules" where /
    );
    expect(state.sql[1]).toContain('order by "schedules"."id" asc limit');
    expect(state.phases).toBe(1);
    expect(state.commits).toBe(1);
    expect(state.held).toBe(false);
    // Compile each submitted disable predicate and falsify each selected identity dimension.
    const update = state.sql.find((s) => s.startsWith("update"))!;
    for (const field of [
      '"id"',
      '"owner_user_id"',
      '"enabled"',
      '"temporal_schedule_id"',
    ])
      expect(update).toContain(field);
  });
  it.each([
    "owner_user_id='foreign'",
    "enabled=0",
    "temporal_schedule_id='governance:sibling:stale'",
    "temporal_schedule_id='governance:node_%:replacement'",
    "id='replaced'",
    "temporal_schedule_id='governance:node_%:LEDGER_INGEST'",
  ])("rechecks selected row after drift: %s", async (change) => {
    row(1, "governance:node_%:stale");
    state.tamper = change;
    await runGovernanceSchedulesSyncJob();
    expect(
      state.db!.prepare("select updated_at from schedules").get()?.updated_at
    ).toBeNull();
  });
  it("processes all 1000 eligible rows including the last stale row; excluded rows consume no budget", async () => {
    excluded();
    for (let n = 1; n <= 1000; n++) row(n, `governance:node_%:stale${n}`);
    const summary = await runGovernanceSchedulesSyncJob();
    expect(summary.paused).toBe(1000);
    expect(state.effects).toContain("pause:governance:node_%:stale1000");
    expect(
      state
        .db!.prepare("select count(*) as n from schedules where enabled=1")
        .get()?.n
    ).toBe(8);
  });
  it("rejects 1001 before any grant, upsert, disable or Temporal effect", async () => {
    for (let n = 1; n <= 1001; n++) row(n, `governance:node_%:stale${n}`);
    await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
      "capacity exceeded"
    );
    expect(state.effects).toEqual([]);
    expect(state.rollbacks).toBe(1);
  });
  it("runs the actual ledger-only config without upsert, trigger or second phase", async () => {
    expect(state.config.schedules.map((s) => s.charter)).toEqual([
      "LEDGER_INGEST",
    ]);
    await runGovernanceSchedulesSyncJob();
    expect(state.effects).toEqual(["grant"]);
    expect(state.phases).toBe(1);
  });
  it("runs non-ledger lookup/upsert on the same resource and preserves Poly input", async () => {
    state.config = {
      schedules: [
        {
          charter: "COMMUNITY",
          cron: "0 * * * *",
          timezone: "UTC",
          entrypoint: "COMMUNITY",
        },
      ],
    };
    row(1, "governance:node_%:community");
    await runGovernanceSchedulesSyncJob();
    expect(state.effects).toContain("create:governance:node_%:community");
    const stored = state
      .db!.prepare("select input from schedules where id='000001'")
      .get();
    expect(JSON.parse(String(stored?.input))).toEqual({
      message: "COMMUNITY",
      model: "kimi-k2.5",
    });
  });
  it.each(["acquire", "read", "commit", "session", "callback"])(
    "delegates %s failure and cleanup to native completion",
    async (failure) => {
      state.fail = failure;
      if (failure === "callback") {
        state.config = {
          schedules: [
            {
              charter: "COMMUNITY",
              cron: "0 * * * *",
              timezone: "UTC",
              entrypoint: "COMMUNITY",
            },
          ],
        };
        row(1, "governance:node_%:community");
      }
      if (failure === "acquire" || failure === "read")
        await expect(runGovernanceSchedulesSyncJob()).rejects.toMatchObject({
          cause: { message: `${failure} failure` },
        });
      else
        await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
          `${failure} failure`
        );
      expect(state.held).toBe(false);
      expect(state.locked).toBe(false);
      expect(state.rollbacks).toBe(1);
      if (failure === "session") expect(state.lost).toBe(1);
    }
  );
  it.each(["contention", "disabled"])(
    "fulfills %s with zero summary and startup does not retry",
    async (kind) => {
      if (kind === "contention") state.acquired = false;
      else state.enabled = false;
      const retry = vi.fn();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await attemptGovernanceStartupReconcile(
        {
          runSync: runGovernanceSchedulesSyncJob,
          log,
          scheduleRetry: retry,
          maxAttempts: GOVERNANCE_RECONCILE_MAX_ATTEMPTS,
          retryDelayMs: GOVERNANCE_RECONCILE_RETRY_DELAY_MS,
        },
        1
      );
      expect(retry).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalled();
      expect(state.effects).toEqual([]);
    }
  );
  it("retries rejected calls eight times at fifteen seconds, then resolves", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runSync = vi.fn().mockRejectedValue(new Error("native failure"));
    const queued: Array<() => void> = [];
    const scheduleRetry = vi.fn((cb: () => void) => queued.push(cb));
    const deps = {
      runSync,
      log,
      scheduleRetry,
      maxAttempts: GOVERNANCE_RECONCILE_MAX_ATTEMPTS,
      retryDelayMs: GOVERNANCE_RECONCILE_RETRY_DELAY_MS,
    };
    await attemptGovernanceStartupReconcile(deps, 1);
    for (let n = 2; n <= 8; n++) {
      queued.shift()!();
      await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(n));
    }
    expect(scheduleRetry).toHaveBeenCalledTimes(7);
    expect(scheduleRetry).toHaveBeenLastCalledWith(expect.any(Function), 15000);
    expect(log.error).toHaveBeenCalledOnce();
    expect(queued).toHaveLength(0);
  });
});

describe("retained read and boot boundaries", () => {
  it("keeps scoped and flat charter names readable through the RLS seam", async () => {
    state.locked = true;
    row(1, "governance:node_%:community");
    row(2, "governance:engineering");
    row(3, "governance:foreign", "foreign");
    state.db!.exec("update schedules set cron='0 * * * *', timezone='UTC'");
    const db = proxy(true) as unknown as Database;
    const actor = "00000000-0000-4000-a000-000000000001" as ActorId;
    const result = await new DrizzleGovernanceStatusAdapter(
      db,
      actor
    ).getUpcomingRuns({ limit: 10 });
    expect(result.map((r) => r.name).sort()).toEqual([
      "Community",
      "Engineering",
    ]);
    expect(withTenantScope).toHaveBeenCalledWith(
      db,
      actor,
      expect.any(Function)
    );
  });
  it.each(["missing", "error", "capacity", "timeout"])(
    "qualifies the system tenant separately: %s",
    async (kind) => {
      resetStartupAssertionsForTest();
      const exit = vi.fn();
      const service = {
        getBillingAccountById: vi.fn(async () => {
          if (kind === "capacity")
            throw Object.assign(new Error("capacity"), { code: "53300" });
          if (kind === "error") throw new Error("database failure");
          if (kind === "timeout") return new Promise(() => {});
          return null;
        }),
      } as unknown as ServiceAccountService;
      if (kind === "timeout") vi.useFakeTimers();
      try {
        const call = startSystemTenantAssertionOnBoot(service, {
          exit,
          force: true,
          timeoutMs: 10000,
        });
        const assertion =
          kind === "capacity"
            ? expect(call).resolves.toBeUndefined()
            : expect(call).rejects.toThrow();
        if (kind === "timeout") await vi.advanceTimersByTimeAsync(10000);
        await assertion;
        if (kind === "capacity") expect(exit).not.toHaveBeenCalled();
        else expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(state.sql).toEqual([]);
        expect(state.phases).toBe(0);
      } finally {
        vi.useRealTimers();
        resetStartupAssertionsForTest();
      }
    }
  );
});
