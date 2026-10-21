// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/installed-work-items-composition`
 * Purpose: Prove Poly's published content + PG lease + knowledge composition on real engines.
 * Scope: One consumer seam, not the publisher's recovery suite; resolves installed JS, bypassing source aliases.
 * Invariants: Heartbeat/release never touch Dolt; content reads bypass held writer admission; both bundles share the DB mutex.
 * Side-effects: IO (isolated Dolt 0.57.3 container and existing component PostgreSQL service role).
 * Links: bootstrap/container.ts, packages/db-schema/src/work-item-leases.ts
 * @internal
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const requireInstalled = createRequire(import.meta.url);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const principalId = "poly-installed-conformance";
const database = "knowledge_poly_conformance";
const image = "dolthub/doltgresql:0.57.3";
const execute = promisify(execFile);

// Node resolution deliberately selects shipped JS rather than Vitest tsconfig aliases.
async function installed<T>(specifier: string): Promise<T> {
  const entry = requireInstalled.resolve(specifier);
  if (!entry.endsWith(".js"))
    throw new Error(`Installed JS required: ${specifier}`);
  return import(/* @vite-ignore */ pathToFileURL(entry).href) as Promise<T>;
}

describe("Poly installed shared-runtime composition", () => {
  let container: StartedTestContainer | undefined;
  let pg: Sql;
  let databaseUrl: string;
  const clients: Sql[] = [];
  let contentCalls = 0;
  const pool = (countContent = false): Sql => {
    const sql = postgres(databaseUrl, { max: 1, fetch_types: false });
    clients.push(sql);
    if (!countContent) return sql;
    // Count attempts too: queued reserve/SQL must not disappear from zero-call proof.
    return new Proxy(sql, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "reserve" || key === "unsafe") contentCalls++;
          return Reflect.apply(value, target, args);
        };
      },
      apply(target, thisArg, args) {
        contentCalls++;
        return Reflect.apply(target, thisArg, args);
      },
    });
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_SERVICE_URL)
      throw new Error("Component service-role PostgreSQL is required");
    pg = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
    // The normal component setup applied Poly's own journal, including its lease migration.
    await pg.unsafe("SELECT work_item_id FROM work_item_leases LIMIT 0");
    container = await new GenericContainer(image)
      .withEnvironment({ DOLTGRES_PASSWORD: "poly-conformance" })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i).withStartupTimeout(
          60_000
        )
      )
      .start();
    const base = `postgresql://postgres:poly-conformance@${container.getHost()}:${container.getMappedPort(5432)}`;
    const bootstrap = postgres(`${base}/postgres`, {
      max: 1,
      fetch_types: false,
    });
    try {
      await bootstrap.unsafe(`CREATE DATABASE ${database}`);
    } finally {
      await bootstrap.end({ timeout: 2 });
    }
    databaseUrl = `${base}/${database}`;
    await execute(
      process.execPath,
      [
        path.join(root, "scripts/db/migrate-doltgres.mjs"),
        path.join(root, "app/src/adapters/server/db/doltgres-migrations"),
      ],
      {
        env: {
          ...process.env,
          NODE_NAME: "poly-conformance",
          DATABASE_URL: databaseUrl,
        },
        timeout: 60_000,
      }
    );
  }, 120_000);

  afterAll(async () => {
    if (pg) {
      await pg.unsafe("DELETE FROM work_item_leases WHERE principal_id = $1", [
        principalId,
      ]);
      await pg.end({ timeout: 2 });
    }
    await Promise.all(clients.map((client) => client.end({ timeout: 2 })));
    await container?.stop();
  }, 30_000);

  it("keeps one PG authority and isolated reads while separately bundled writers contend", async () => {
    const { withWorkItemLeases, toWorkItemId } =
      await installed<typeof import("@cogni/work-items")>("@cogni/work-items");
    const { DoltgresWorkItemAdapter, WorkItemsBusyError } = await installed<
      typeof import("@cogni/work-items/adapters/doltgres")
    >("@cogni/work-items/adapters/doltgres");
    const { PostgresWorkItemLeaseAdapter } = await installed<
      typeof import("@cogni/work-items/adapters/postgres")
    >("@cogni/work-items/adapters/postgres");
    const { DoltBranchSessionRunner, DoltgresKnowledgeStoreAdapter } =
      await installed<
        typeof import("@cogni/knowledge-store/adapters/doltgres")
      >("@cogni/knowledge-store/adapters/doltgres");
    const content = new DoltgresWorkItemAdapter(pool(true), {
      writerLockProtocol: "database",
      readClient: pool(true),
      recreateClient: () => pool(true),
      recreateReadClient: () => pool(true),
      readConnectionBudget: 2,
      lockWaitMs: 100,
      lockRetryMs: 10,
    });
    const work = withWorkItemLeases(
      content,
      new PostgresWorkItemLeaseAdapter(pg)
    );
    const knowledge = new DoltgresKnowledgeStoreAdapter({
      sql: pool(),
      writerSession: new DoltBranchSessionRunner(pool(), {
        writerProtocol: "database",
      }),
    });
    const observer = pool();
    const id = toWorkItemId("task.5278");
    await work.create(
      { id, type: "task", title: "Before contention" },
      principalId
    );
    const lease = await work.claim({
      id,
      principalId,
      runId: "poly-run",
      command: "implement",
    });
    await knowledge.registerDomain({
      id: "poly-conformance",
      name: "Red conformance",
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    let failed = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => {
      entered = resolve;
      failed = reject;
    });
    const holding = knowledge.withWrite(
      { operationId: "poly.installed.scope", message: "consumer composition" },
      async (write) => {
        await write.addKnowledge({
          id: "poly-composition",
          domain: "poly-conformance",
          title: "One operation",
          content: "Owned write",
          entryType: "finding",
          sourceType: "agent",
        });
        entered();
        await gate;
        return "committed";
      }
    );
    void holding.catch(failed);
    try {
      await ready;
      const headBefore = await observer.unsafe(
        "SELECT dolt_hashof('HEAD') AS head"
      );
      const owner = {
        id,
        principalId,
        runId: lease.runId,
        leaseToken: lease.leaseToken,
      };
      const beforeHeartbeat = contentCalls;
      // Recreate the PG adapter while Dolt is held: no process-local lease cache may be authoritative.
      const restarted = withWorkItemLeases(
        content,
        new PostgresWorkItemLeaseAdapter(pg)
      );
      await expect(restarted.heartbeat(owner)).resolves.toMatchObject({
        active: true,
        leaseToken: lease.leaseToken,
      });
      await expect(
        restarted.heartbeat({ ...owner, leaseToken: "00000000-0000-4000-8000-000000000000" })
      ).rejects.toMatchObject({ name: "WorkItemLeaseConflictError" });
      await expect(restarted.release(owner)).resolves.toMatchObject({
        active: false,
      });
      expect(contentCalls).toBe(beforeHeartbeat);
      expect(
        await observer.unsafe("SELECT dolt_hashof('HEAD') AS head")
      ).toEqual(headBefore);
      const observed = await work.get(id);
      expect(observed).toMatchObject({ title: "Before contention" });
      expect(observed).not.toHaveProperty("claimedByRun");
      await expect(work.list({ limit: 5 })).resolves.toMatchObject({
        items: [expect.objectContaining({ id })],
      });
      await expect(
        work.patch({ id, set: { title: "Must wait" } }, principalId)
      ).rejects.toBeInstanceOf(WorkItemsBusyError);
      release();
      await expect(holding).resolves.toBe("committed");
      await expect(
        work.patch({ id, set: { title: "After acknowledgment" } }, principalId)
      ).resolves.toMatchObject({ title: "After acknowledgment" });
      await expect(
        knowledge.getKnowledge("poly-composition")
      ).resolves.toMatchObject({ content: "Owned write" });
      const successor = await restarted.claim({
        id,
        principalId,
        runId: lease.runId,
        command: "successor",
      });
      expect(successor.leaseToken).not.toBe(lease.leaseToken);
      const beforeStale = contentCalls;
      await expect(restarted.heartbeat(owner)).rejects.toMatchObject({
        name: "WorkItemLeaseConflictError",
      });
      expect(contentCalls).toBe(beforeStale);
    } finally {
      release();
      await holding.catch(() => undefined);
    }
  }, 30_000);
});
