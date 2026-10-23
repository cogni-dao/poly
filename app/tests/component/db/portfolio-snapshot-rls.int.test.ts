// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/portfolio-snapshot-rls.int.test`
 * Purpose: Prove migration 0075 — the delegated SELECT policies on
 *   `poly_wallet_connections` and `poly_wallet_balance_snapshots` — does the
 *   two things it must and nothing more: an approved agent READS the owner's
 *   wallet identity/readiness and cash facts, and still cannot WRITE them or
 *   see a second tenant.
 * Scope: Real Postgres, app role, two tenants. Transport and the capability
 *   plane are out of scope; this is the RLS backstop underneath them.
 * Invariants:
 *   - DELEGATED_READ_IS_NOT_A_SILENT_EMPTY — before 0075 these two tables had
 *     an owner-only `tenant_isolation` policy, so a correctly-granted agent
 *     passed `authorize()` and then read ZERO rows. That presents as a
 *     well-formed snapshot of a disconnected, zero-balance wallet rather than
 *     as a denial, which is the fabrication class story.5004 exists to kill.
 *     Asserting the grant reads actual rows is the whole point of this file.
 *   - WRITES_STAY_OWNER_ONLY — the new policies are FOR SELECT, so delegation
 *     widens reads and nothing else.
 *   - SCOPE_ALIAS_TOLERANCE — a grant holding only the legacy
 *     `performance:read` must read exactly as well as one holding
 *     `account:read`, matching `aliasesFor()` and migration 0074.
 * Side-effects: IO (testcontainers Postgres)
 * Links: task.1791070962, migrations/0075_portfolio_snapshot_delegated_select.sql
 * @internal
 */

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import { toUserId, userActor } from "@cogni/ids";
import type { AgentCapabilityScope } from "@cogni/poly-node-contracts";
import type { PolyAccountPortfolioSnapshotOutput } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { readTenantWalletDashboardIn, type WalletDashboardReadDiagnostics } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import { buildEconomicPositionProjectionQuery } from "@/features/wallet-analysis/server/economic-position-read-model";
import type { EconomicObservationV1 } from "@/features/wallet-analysis/server/economic-observation-recovery";
import { createEconomicProjectionPlanProbe } from "@/features/wallet-analysis/server/economic-projection-plan";
import {
  billingAccounts,
  polyWalletBalanceSnapshots,
  polyWalletConnections,
  users,
} from "@/shared/db/schema";

/**
 * The fields the parity contract covers: saved facts, with the per-request
 * snapshot envelope removed. `capturedAt` necessarily differs between two
 * requests, and every `observedAt`/`ageMs` on a `fresh` fact is derived from
 * it, so comparing them would report a false mismatch.
 */
function savedFacts(snapshot: PolyAccountPortfolioSnapshotOutput) {
  const { observedAt: _readinessObservedAt, ...readiness } = snapshot.readiness;
  const {
    capturedAt: _overviewCapturedAt,
    // Derived as `capturedAt - positions_synced_at`, so it moves by the
    // milliseconds between the two reads. Excluded for the same reason
    // `capturedAt` is, not because it is allowed to disagree.
    positions_sync_age_ms: _overviewSyncAge,
    ...overview
  } = snapshot.overview;
  const {
    capturedAt: _executionCapturedAt,
    tradeActivity,
    ...executionFacts
  } = snapshot.execution;
  const execution = {
    ...executionFacts,
    // Bucket boundaries are derived from each request's capturedAt. Counts and
    // grain are the saved-fact parity surface; boundary instants belong to the
    // per-request snapshot envelope excluded above.
    tradeActivity:
      tradeActivity === undefined
        ? undefined
        : {
            bucketUnit: tradeActivity.bucketUnit,
            buckets: tradeActivity.buckets.map((bucket) => bucket.n),
          },
  };
  return {
    interval: snapshot.interval,
    readiness,
    overview,
    execution,
    factStatuses: Object.fromEntries(
      Object.entries(snapshot.facts).map(([name, fact]) => [
        name,
        { status: fact.status, source: fact.source, complete: fact.complete },
      ])
    ),
    warnings: snapshot.warnings,
  };
}

type Principal = { userId: string; name: string };
type Tenant = Principal & { billingAccountId: string };

const future = new Date("2099-01-01T00:00:00.000Z");
const past = new Date("2000-01-01T00:00:00.000Z");

function principal(name: string): Principal {
  return { userId: randomUUID(), name };
}

function tenant(name: string): Tenant {
  return { ...principal(name), billingAccountId: randomUUID() };
}

function address(): `0x${string}` {
  const hex = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  return `0x${hex.slice(0, 40)}` as `0x${string}`;
}

describe("portfolio snapshot delegated SELECT (migration 0075)", () => {
  let db: Database;
  const ownerA = tenant("Portfolio owner A");
  const ownerB = tenant("Portfolio owner B");
  const canonicalAgent = principal("account:read agent");
  const legacyAgent = principal("performance:read agent");
  const wrongScopeAgent = principal("research:run agent");
  const expiredAgent = principal("expired-grant agent");
  const revokedAgent = principal("revoked-grant agent");
  const ungrantedAgent = principal("ungranted agent");

  const principals = [
    ownerA,
    ownerB,
    canonicalAgent,
    legacyAgent,
    wrongScopeAgent,
    expiredAgent,
    revokedAgent,
    ungrantedAgent,
  ];

  const addressA = address();
  const addressB = address();
  const funderA = address();

    const connection = (owner: Tenant, addr: `0x${string}`, funder?: string) => ({
      billingAccountId: owner.billingAccountId,
      createdByUserId: owner.userId,
      privyWalletId: `privy-${randomUUID()}`,
      address: addr,
      ...(funder ? { funderAddress: funder } : {}),
      clobApiKeyCiphertext: Buffer.from("ciphertext"),
      encryptionKeyId: "test-key",
      custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
      custodialConsentActorKind: "user",
      custodialConsentActorId: owner.userId,
      tradingApprovalsReadyAt: new Date("2026-10-02T00:00:00.000Z"),
    });

  beforeAll(async () => {
    db = getAppDb();
    const seedDb = getSeedDb();

    await seedDb.insert(users).values(
      principals.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        walletAddress: address(),
      }))
    );
    await seedDb.insert(billingAccounts).values(
      [ownerA, ownerB].map((entry) => ({
        id: entry.billingAccountId,
        ownerUserId: entry.userId,
        balanceCredits: 0n,
      }))
    );

    const grant = (
      grantee: Principal,
      scopes: AgentCapabilityScope[],
      extra: Record<string, unknown> = {}
    ) => ({
      billingAccountId: ownerA.billingAccountId,
      granteePrincipalId: grantee.userId,
      scopes,
      expiresAt: future,
      createdByUserId: ownerA.userId,
      ...extra,
    });

    await seedDb.insert(agentCapabilityGrants).values([
      grant(canonicalAgent, ["account:read"]),
      grant(legacyAgent, ["performance:read"]),
      grant(wrongScopeAgent, ["research:run"]),
      grant(expiredAgent, ["account:read"], {
        expiresAt: past,
        createdAt: new Date("1999-01-01T00:00:00.000Z"),
        updatedAt: past,
      }),
      grant(revokedAgent, ["account:read"], {
        revokedAt: new Date("2026-10-04T00:00:00.000Z"),
        revokedByUserId: ownerA.userId,
      }),
    ]);

    await seedDb
      .insert(polyWalletConnections)
      .values([
        connection(ownerA, addressA, funderA),
        connection(ownerB, addressB),
      ]);

    await seedDb.insert(polyWalletBalanceSnapshots).values([
      {
        billingAccountId: ownerA.billingAccountId,
        address: funderA,
        usdcE: "12.5",
        pusd: "7.5",
        pol: "1.25",
        status: "ok",
        observedAt: new Date("2026-10-06T11:59:00.000Z"),
      },
      {
        billingAccountId: ownerB.billingAccountId,
        address: addressB,
        usdcE: "99.0",
        pusd: "1.0",
        pol: "2.0",
        status: "ok",
        observedAt: new Date("2026-10-06T11:59:00.000Z"),
      },
    ]);
  });

  /** The snapshot's identity+readiness read, as the given principal. */
  async function readConnection(principalId: string) {
    return withTenantScope(db, userActor(toUserId(principalId)), async (tx) =>
      tx
        .select({
          billingAccountId: polyWalletConnections.billingAccountId,
          address: polyWalletConnections.address,
          funderAddress: polyWalletConnections.funderAddress,
          tradingApprovalsReadyAt:
            polyWalletConnections.tradingApprovalsReadyAt,
          autoWrapFloor: polyWalletConnections.autoWrapFloorUsdceE6dp,
        })
        .from(polyWalletConnections)
        .where(
          eq(polyWalletConnections.billingAccountId, ownerA.billingAccountId)
        )
    );
  }

  /** The snapshot's cash/gas read, as the given principal. */
  async function readBalances(principalId: string) {
    return withTenantScope(db, userActor(toUserId(principalId)), async (tx) =>
      tx
        .select({
          billingAccountId: polyWalletBalanceSnapshots.billingAccountId,
          usdcE: polyWalletBalanceSnapshots.usdcE,
          pol: polyWalletBalanceSnapshots.pol,
        })
        .from(polyWalletBalanceSnapshots)
        .where(
          eq(
            polyWalletBalanceSnapshots.billingAccountId,
            ownerA.billingAccountId
          )
        )
    );
  }

  describe("full sparse LIVE projection app-role performance", () => {
    let capturedAt: Date;
    let walletId: string | undefined;

    beforeAll(async () => {
      capturedAt = new Date();
      const seed = getSeedDb();
      const wallet = await seed.execute<{
        id: string;
      }>(sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label)
          VALUES (${funderA},'cogni_wallet','Projection role plan fixture') RETURNING id`);
      walletId = wallet[0]?.id;
      if (!walletId) throw new Error("Missing projection plan wallet");
      // Full history drives 5080 lifetime keys; only 80 have a current
      // observation. History envelopes are valid but deliberately PARTIAL.
      const generationAt = new Date(capturedAt.getTime() - 1000).toISOString();
      const conditionId = `0x${"bc".repeat(32)}`;
      const historyObservation: Omit<EconomicObservationV1, "tokenId"> = {
        version: 1,
        wallet: funderA,
        conditionId,
        fetchedAt: generationAt,
        windowStart: new Date(capturedAt.getTime() - 86400_000).toISOString(),
        windowEnd: generationAt,
        coverage: "partial",
        reasons: ["missing_closed_position"],
        closedPosition: null,
        lifetimeBuyUsdc: 0.4,
        lifetimeBuyShares: 1,
        lifetimeSellUsdc: 0,
        lifetimePnlUsdc: null,
        redeemUsdc: 0,
        constituents: [],
        settlements: [],
      };
      await seed.execute(sql`INSERT INTO poly_trader_position_snapshots
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
        SELECT ${walletId}::uuid,${conditionId},n::text,1,.4,.5,.4,'role-plan-'||n,
          ${generationAt}::timestamptz,jsonb_build_object('economicObservationV1',
            ${JSON.stringify(historyObservation)}::jsonb || jsonb_build_object('tokenId',n::text))
        FROM generate_series(1,5080) n`);
      await seed.execute(sql`INSERT INTO poly_trader_fills
        (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
        SELECT ${walletId}::uuid,'data-api','role-plan-'||n,${conditionId},n::text,
          'BUY',.4,1,.4,${generationAt}::timestamptz-(n||' seconds')::interval,'{}'::jsonb
        FROM generate_series(1,5080) n`);
      await seed.execute(sql`INSERT INTO poly_trader_current_positions
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,first_observed_at,raw)
        SELECT ${walletId}::uuid,${conditionId},n::text,1,.4,.5,.4,'role-current-'||n,
          ${generationAt}::timestamptz,${generationAt}::timestamptz,'{}'::jsonb
        FROM generate_series(1,80) n`);
      await seed.execute(sql`INSERT INTO poly_trader_ingestion_cursors
        (trader_wallet_id,source,last_success_at,status)
        VALUES (${walletId}::uuid,'data-api-positions',${generationAt}::timestamptz,'ok')`);
      // ANALYZE as the migrated-table owner; the BYPASSRLS seeding role
      // cannot refresh these statistics. Measured reads keep their app role.
      await db.execute(sql`ANALYZE poly_trader_position_snapshots`);
      await db.execute(sql`ANALYZE poly_trader_fills`);
      await db.execute(sql`ANALYZE poly_trader_current_positions`);
    });

    afterAll(async () => {
      if (walletId) {
        await getSeedDb().execute(
          sql`DELETE FROM poly_trader_wallets WHERE id=${walletId}::uuid`,
        );
      }
    });

    function projectionQuery() {
      return buildEconomicPositionProjectionQuery({
        billingAccountId: ownerA.billingAccountId,
        walletAddress: funderA,
        connectionKind: "privy_live",
        capturedAt,
        interval: "ALL",
      });
    }

    async function expectAppRoleContext(
      tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
      actor: Principal,
    ) {
      const [context] = await tx.execute(sql`SELECT current_user AS role,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass_rls,
            current_setting('app.current_user_id') AS actor,
            current_setting('transaction_read_only') AS read_only,
            current_setting('transaction_isolation') AS isolation,
            current_setting('statement_timeout') AS timeout`);
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("Missing app database configuration");
      expect(context).toMatchObject({
        role: decodeURIComponent(new URL(databaseUrl).username),
        bypass_rls: false,
        actor: actor.userId,
        read_only: "on",
        isolation: "repeatable read",
        timeout: "8s",
      });
    }

    for (const [role, actor] of [
      ["owner", ownerA],
      ["delegated", canonicalAgent],
    ] as const) {
      it(`keeps plain projection empirical p95 below 200ms as ${role}`, async () => {
        await withTenantScope(
          db,
          userActor(toUserId(actor.userId)),
          async (tx) => {
            await tx.execute(
              sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
            );
            await tx.execute(sql`SET LOCAL statement_timeout = 8000`);
            await expectAppRoleContext(tx, actor);
            const query = projectionQuery();
            const sampleCount = 10;
            const budgetMs = 200;
            const samplesMs: number[] = [];
            // Include the first execution: no warmup, EXPLAIN, retries or context
            // queries inside the measured execute. All samples use this snapshot.
            for (let sample = 0; sample < sampleCount; sample += 1) {
              const startedAt = performance.now();
              await tx.execute(query);
              const elapsedMs = performance.now() - startedAt;
              samplesMs.push(elapsedMs);
              if (elapsedMs >= budgetMs) {
                console.info(
                  JSON.stringify({
                    probe: "economic_projection_app_role_plain_latency",
                    environment: "ci_fixture",
                    role,
                    method: "nearest_rank",
                    percentile: 0.95,
                    expectedSampleCount: sampleCount,
                    observedSampleCount: samplesMs.length,
                    samplesMs,
                    complete: false,
                  }),
                );
                // For N=10, nearest-rank p95 is the maximum. One >=200ms
                // sample makes the gate impossible; do not wait for a 5s timeout
                // or present this incomplete set as a completed p95 measurement.
                throw new Error(
                  `Plain projection ${role}: observed ${samplesMs.length}/${sampleCount} samples; ${elapsedMs.toFixed(3)}ms >= ${budgetMs}ms makes the complete nearest-rank p95 gate impossible`,
                );
              }
            }
            const sortedMs = [...samplesMs].sort((a, b) => a - b);
            const p95Ms = sortedMs[Math.ceil(0.95 * sampleCount) - 1];
            console.info(
              JSON.stringify({
                probe: "economic_projection_app_role_plain_latency",
                environment: "ci_fixture",
                role,
                method: "nearest_rank",
                percentile: 0.95,
                expectedSampleCount: sampleCount,
                observedSampleCount: samplesMs.length,
                samplesMs,
                p95Ms,
                complete: true,
              }),
            );
            expect(samplesMs).toHaveLength(sampleCount);
            expect(p95Ms).toBeLessThan(budgetMs);
          },
        );
      });

      it(`preserves complete projection semantics and plan diagnostics as ${role}`, async () => {
        await withTenantScope(
          db,
          userActor(toUserId(actor.userId)),
          async (tx) => {
            await tx.execute(
              sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
            );
            await tx.execute(sql`SET LOCAL statement_timeout = 8000`);
            const probe = createEconomicProjectionPlanProbe();
            const query = projectionQuery();
            const result = await probe(
              tx as unknown as Parameters<typeof probe>[0],
              query,
            );
            expect(result.status).toBe("captured");
            await expectAppRoleContext(tx, actor);
            expect(JSON.stringify(result)).not.toContain(ownerA.billingAccountId);
            expect(JSON.stringify(result)).not.toContain(funderA);
            const projected = await tx.execute<{
              live_count: number;
              closed_count: number;
              history_incomplete_count: number;
              missing_mark_count: number;
              positions_mtm_usdc: string | null;
              token_id: string;
              current_shares: string | null;
              current_value_usdc: string | null;
              inventory_authoritative: boolean | null;
              mark_available: boolean | null;
              history_complete: boolean | null;
              economic_bucket: string | null;
            }>(query);
            expect(projected).toHaveLength(500);
            expect(projected[0]).toMatchObject({
              live_count: 5080,
              closed_count: 0,
              history_incomplete_count: 5080,
              missing_mark_count: 5000,
              positions_mtm_usdc: null,
            });
            expect(
              projected.every(
                (row) =>
                  row.economic_bucket === "live" &&
                  row.history_complete === false,
              ),
            ).toBe(true);
            const current = projected.filter(
              (row) => row.current_shares !== null,
            );
            expect(current).toHaveLength(80);
            for (const row of current) {
              expect(Number(row.current_shares)).toBe(1);
              expect(Number(row.current_value_usdc)).toBe(0.5);
              expect(row.inventory_authoritative).toBe(true);
              expect(row.mark_available).toBe(true);
            }
            expect(
              projected
                .filter((row) => row.current_shares === null)
                .every(
                  (row) =>
                    row.current_value_usdc === null &&
                    row.mark_available === false,
                ),
            ).toBe(true);
            const [explained] = await tx.execute<{
              "QUERY PLAN": Array<Record<string, unknown>>;
            }>(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
            const detail = explained?.["QUERY PLAN"][0];
            if (!detail?.Plan)
              throw new Error("Missing executed projection plan");
            type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
            const nodes: PlanNode[] = [];
            const paths = new Map<PlanNode, number[]>();
            const visit = (node: PlanNode, path: number[]): void => {
              nodes.push(node);
              paths.set(node, path);
              for (const [index, child] of (node.Plans ?? []).entries())
                visit(child, [...path, index]);
            };
            visit(detail.Plan as PlanNode, []);
            // Numeric timings/costs/loops only: never log predicates, SQL, bindings,
            // account IDs, addresses or row data from the real app-role plan.
            const metric = (
              node: Record<string, unknown>,
              name: string,
            ): number | null =>
              typeof node[name] === "number" && Number.isFinite(node[name])
                ? (node[name] as number)
                : null;
            const jit = detail.JIT as Record<string, unknown> | undefined;
            const timing = jit?.Timing as Record<string, unknown> | undefined;
            const options = jit?.Options as Record<string, unknown> | undefined;
            const label = (value: unknown): string | null =>
              typeof value === "string" &&
              /^[A-Za-z][A-Za-z0-9_ .-]{0,119}$/.test(value)
                ? value
                : null;
            // Search the whole plan: materialized CTE definitions can be separate
            // InitPlans, not descendants of their consumers. Products rank work;
            // they are not exclusive timings or independently observed pair counts.
            const weighted = (node: PlanNode, name: string): number =>
              (metric(node, "Actual Loops") ?? 0) * (metric(node, name) ?? 0);
            const criticalRoots = [
              "CTE classified_raw",
              "CTE position_flows",
              "CTE fill_groups",
              "CTE driven_keys",
            ]
              .map((name) => nodes.find((node) => node["Subplan Name"] === name))
              .filter((node): node is PlanNode => node !== undefined);
            const directChildren = [...new Set([
              "CTE fill_groups",
              "CTE position_flows",
              "CTE classified_raw",
              "CTE driven_keys",
            ].flatMap((name) =>
              criticalRoots.find((node) => node["Subplan Name"] === name)?.Plans ?? [],
            ))];
            const joins = nodes.filter((node) => node["Join Type"] !== undefined);
            const cteScans = nodes.filter((node) => node["CTE Name"] !== undefined);
            const rankedJoins = [...joins].sort(
              (a, b) =>
                weighted(b, "Rows Removed by Join Filter") -
                  weighted(a, "Rows Removed by Join Filter") ||
                weighted(b, "Actual Rows") +
                  weighted(b, "Rows Removed by Join Filter") -
                  weighted(a, "Actual Rows") -
                  weighted(a, "Rows Removed by Join Filter") ||
                weighted(b, "Actual Total Time") -
                  weighted(a, "Actual Total Time"),
            );
            const rankedCteScans = [...cteScans].sort(
              (a, b) =>
                weighted(b, "Actual Rows") +
                  weighted(b, "Rows Removed by Filter") -
                  weighted(a, "Actual Rows") -
                  weighted(a, "Rows Removed by Filter") ||
                weighted(b, "Actual Total Time") -
                  weighted(a, "Actual Total Time"),
            );
            const remainingLogical = [...new Set([...joins, ...cteScans])].sort(
              (a, b) =>
                weighted(b, "Actual Rows") +
                  weighted(b, "Rows Removed by Join Filter") +
                  weighted(b, "Rows Removed by Filter") -
                  weighted(a, "Actual Rows") -
                  weighted(a, "Rows Removed by Join Filter") -
                  weighted(a, "Rows Removed by Filter") ||
                weighted(b, "Actual Total Time") -
                  weighted(a, "Actual Total Time"),
            );
            // Object identity deduplicates overlap; spare slots stay logical.
            const selectedNodes = [...new Set([
              ...criticalRoots,
              ...directChildren.slice(0, 8),
              ...rankedJoins.slice(0, 6),
              ...rankedCteScans.slice(0, 6),
              ...remainingLogical,
            ])].slice(0, 24);
            const actual = {
              planningMs: metric(detail, "Planning Time"),
              executionMs: metric(detail, "Execution Time"),
              jit: jit
                ? {
                    functions: metric(jit, "Functions"),
                    generationMs: timing ? metric(timing, "Generation") : null,
                    inliningMs: timing ? metric(timing, "Inlining") : null,
                    optimizationMs: timing
                      ? metric(timing, "Optimization")
                      : null,
                    emissionMs: timing ? metric(timing, "Emission") : null,
                    totalMs: timing ? metric(timing, "Total") : null,
                    inlining:
                      typeof options?.Inlining === "boolean"
                        ? options.Inlining
                        : null,
                    optimization:
                      typeof options?.Optimization === "boolean"
                        ? options.Optimization
                        : null,
                  }
                : null,
              nodeCount: nodes.length,
              truncated: selectedNodes.length < nodes.length,
              criticalRootExpected: 4,
              criticalRootFound: criticalRoots.length,
              criticalRootEmitted: criticalRoots.filter((node) =>
                selectedNodes.includes(node),
              ).length,
              directChildCandidateCount: directChildren.length,
              directChildEmittedCount: directChildren.filter((node) =>
                selectedNodes.includes(node),
              ).length,
              joinCandidateCount: joins.length,
              joinEmittedCount: joins.filter((node) =>
                selectedNodes.includes(node),
              ).length,
              cteScanCandidateCount: cteScans.length,
              cteScanEmittedCount: cteScans.filter((node) =>
                selectedNodes.includes(node),
              ).length,
              // Parent timings include child work; never sum these as
              // exclusive or uniquely attributable costs.
              nodes: selectedNodes
                .map((node) => ({
                  node: label(node["Node Type"]),
                  path: paths.get(node),
                  alias: label(node.Alias),
                  relation: label(node["Relation Name"]),
                  index: label(node["Index Name"]),
                  cte: label(node["CTE Name"]),
                  subplan: label(node["Subplan Name"]),
                  joinType: label(node["Join Type"]),
                  estimatedRows: metric(node, "Plan Rows"),
                  totalCost: metric(node, "Total Cost"),
                  actualRows: metric(node, "Actual Rows"),
                  actualLoops: metric(node, "Actual Loops"),
                  actualTotalMs: metric(node, "Actual Total Time"),
                  rowsRemovedByJoinFilter: metric(
                    node,
                    "Rows Removed by Join Filter",
                  ),
                  rowsRemovedByFilter: metric(node, "Rows Removed by Filter"),
                  sharedHitBlocks: metric(node, "Shared Hit Blocks"),
                  sharedReadBlocks: metric(node, "Shared Read Blocks"),
                })),
            };
            expect(actual.executionMs).not.toBeNull();
            expect(actual.executionMs).toBeLessThan(8000);
            console.info(
              JSON.stringify({
                probe: "economic_projection_app_role_execution",
                environment: "ci_fixture",
                role,
                ...actual,
              }),
            );
            console.info(
              JSON.stringify({
                probe: "economic_projection_app_role_plan",
                environment: "ci_fixture",
                role,
                ...result,
              }),
            );
          },
        );
      });
    }
  });

  it.each(["cross-key conflict", "equal duplicate", "no driven key", "empty"] as const)(
    "preserves fill identity groups behind rollup cursors: %s",
    async (scenario) => {
      const seed = getSeedDb();
      const fixtureAddress = `0xab${address().slice(4)}`.toLowerCase();
      const walletIds: string[] = [];
      const capturedAt = new Date();
      const observedAt = new Date(capturedAt.getTime() - 2000).toISOString();
      const conditionId = `collision-${randomUUID()}`;
      const tokenId = "driven-token";
      const nativeId = `collision-${randomUUID()}`;
      try {
        // Distinct physical wallets share one case-insensitive identity, allowing
        // the real source/native uniqueness constraint to retain both siblings.
        for (const walletAddress of [fixtureAddress, `0x${fixtureAddress.slice(2).toUpperCase()}`]) {
          const [wallet] = await seed.execute<{ id: string }>(sql`
            INSERT INTO poly_trader_wallets (wallet_address,kind,label)
            VALUES (${walletAddress},'cogni_wallet','Fill membership regression')
            RETURNING id`);
          if (!wallet) throw new Error("Missing fill membership wallet");
          walletIds.push(wallet.id);
        }
        const [firstWallet, secondWallet] = walletIds;
        if (!firstWallet || !secondWallet) throw new Error("Missing physical siblings");
        if (scenario !== "empty") {
          for (const [index, walletId] of walletIds.entries()) {
            const siblingConflict = scenario === "cross-key conflict" && index === 1;
            await seed.execute(sql`INSERT INTO poly_trader_fills
              (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,created_at,raw)
              VALUES (${walletId}::uuid,'data-api',${nativeId},
                ${siblingConflict ? `${conditionId}-not-driven` : conditionId},
                ${siblingConflict ? "not-driven-token" : tokenId},
                'BUY',.4,1,.4,${observedAt}::timestamptz,${observedAt}::timestamptz,'{}'::jsonb)`);
          }
        }
        // Every fill is behind its own physical cursor. No daily rollup is
        // seeded: neither raw-tail nor rollup discovery can drive a sibling.
        for (const walletId of walletIds) {
          await seed.execute(sql`INSERT INTO poly_trader_fill_rollup_cursors
            (trader_wallet_id,last_created_at,last_fill_id)
            VALUES (${walletId}::uuid,${capturedAt.toISOString()}::timestamptz,
              'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)`);
        }
        if (scenario === "cross-key conflict" || scenario === "equal duplicate") {
          const observation: EconomicObservationV1 = {
            version: 1, wallet: fixtureAddress, conditionId, tokenId,
            fetchedAt: observedAt, windowStart: observedAt, windowEnd: observedAt,
            coverage: "partial", reasons: ["missing_closed_position"],
            closedPosition: null, lifetimeBuyUsdc: 0.4, lifetimeBuyShares: 1,
            lifetimeSellUsdc: 0, lifetimePnlUsdc: null, redeemUsdc: 0,
            constituents: [], settlements: [],
          };
          // Only this exact key is saved; the conflicting sibling has no
          // origin, current observation, history envelope or rollup driver.
          await seed.execute(sql`INSERT INTO poly_trader_position_snapshots
            (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
            VALUES (${firstWallet}::uuid,${conditionId},${tokenId},1,.4,.4,.4,
              ${nativeId},${observedAt}::timestamptz,
              jsonb_build_object('economicObservationV1',${JSON.stringify(observation)}::jsonb))`);
        }
        await withTenantScope(db, userActor(toUserId(ownerA.userId)), async (tx) => {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
          const [context] = await tx.execute(sql`SELECT
            (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass_rls,
            current_setting('app.current_user_id') AS actor`);
          expect(context).toMatchObject({ bypass_rls: false, actor: ownerA.userId });
          const [tail] = await tx.execute(sql`SELECT count(*)::int AS count
            FROM poly_trader_fills f
            JOIN poly_trader_fill_rollup_cursors c ON c.trader_wallet_id=f.trader_wallet_id
            WHERE f.trader_wallet_id IN (${firstWallet}::uuid,${secondWallet}::uuid)
              AND (f.created_at,f.id) > (c.last_created_at,c.last_fill_id)`);
          expect(tail?.count).toBe(0);
          const rows = await tx.execute<{
            live_count: number; closed_count: number; incomplete_count: number;
            fill_identity_conflict_count: number; token_id: string | null;
            total_buy_usdc: string | null; total_buy_shares: string | null;
          }>(buildEconomicPositionProjectionQuery({
            billingAccountId: ownerA.billingAccountId, walletAddress: fixtureAddress,
            connectionKind: "privy_live", capturedAt, interval: "ALL",
          }));
          expect(rows).toHaveLength(1);
          if (scenario === "equal duplicate") {
            expect(rows[0]).toMatchObject({ live_count: 1, closed_count: 0,
              incomplete_count: 0, fill_identity_conflict_count: 0, token_id: tokenId });
            expect(Number(rows[0]?.total_buy_usdc)).toBe(0.4);
            expect(Number(rows[0]?.total_buy_shares)).toBe(1);
          } else {
            expect(rows[0]).toMatchObject({ live_count: 0, closed_count: 0,
              incomplete_count: scenario === "cross-key conflict" ? 1 : 0,
              fill_identity_conflict_count: scenario === "cross-key conflict" ? 1 : 0,
              token_id: null });
          }
        });
      } finally {
        for (const walletId of walletIds) {
          await seed.execute(sql`DELETE FROM poly_trader_wallets WHERE id=${walletId}::uuid`);
        }
      }
    },
  );

  it.each([
    { name: "future envelope bypasses malformed nested fields", futureEnvelope: true, settlements: "malformed", quantity: 1 },
    { name: "future event with empty settlements and zero current", futureEnvelope: false, settlements: "empty", quantity: 0 },
    { name: "future event with empty settlements and positive current", futureEnvelope: false, settlements: "empty", quantity: 1 },
    { name: "future event with empty settlements and absent current", futureEnvelope: false, settlements: "empty", quantity: null },
    { name: "future event with retained settlement and zero current", futureEnvelope: false, settlements: "nonempty", quantity: 0 },
    { name: "future event with retained settlement and positive current", futureEnvelope: false, settlements: "nonempty", quantity: 1 },
    { name: "future event with retained settlement and absent current", futureEnvelope: false, settlements: "nonempty", quantity: null },
    { name: "count-only malformed key retains native error", futureEnvelope: false, settlements: "malformed", quantity: null },
  ] as const)("preserves fully demanded event CASE: $name", async (scenario) => {
    const seed = getSeedDb();
    const fixtureAddress = address().toLowerCase();
    const capturedAt = new Date();
    const generationAt = new Date(capturedAt.getTime() - 1000).toISOString();
    const afterCutoff = new Date(capturedAt.getTime() + 60_000);
    const conditionId = `event-demand-${randomUUID()}`;
    const tokenId = "event-token";
    let walletId: string | undefined;
    try {
      const [wallet] = await seed.execute<{ id: string }>(sql`
        INSERT INTO poly_trader_wallets (wallet_address,kind,label)
        VALUES (${fixtureAddress},'cogni_wallet','Event CASE demand regression') RETURNING id`);
      walletId = wallet?.id;
      if (!walletId) throw new Error("Missing event CASE wallet");
      // Intentionally malformed persisted JSON is not cast to a valid typed
      // observation. Other fields stay valid to isolate the guarded expression.
      const observation = {
        version: 1, wallet: fixtureAddress, conditionId, tokenId,
        fetchedAt: scenario.futureEnvelope ? afterCutoff.toISOString() : generationAt,
        windowStart: generationAt, windowEnd: generationAt,
        coverage: "partial", reasons: ["missing_closed_position"],
        closedPosition: { last_event_at: scenario.settlements === "malformed"
          ? "unorderable" : String(afterCutoff.getTime() / 1000) },
        lifetimeBuyUsdc: 0, lifetimeBuyShares: 0, lifetimeSellUsdc: 0,
        lifetimePnlUsdc: null, redeemUsdc: 0, constituents: [],
        settlements: scenario.settlements === "malformed" ? { invalid: true }
          : scenario.settlements === "empty" ? [] : [{
            txHash: `0x${"ab".repeat(32)}`, blockNumber: "1", blockHash: `0x${"cd".repeat(32)}`,
            logIndex: 0, collateral: fixtureAddress, atomicAmount: "1",
            recipient: fixtureAddress, conditionId, tokenId, sharesAtomic: "1",
          }],
      };
      await seed.execute(sql`INSERT INTO poly_trader_position_snapshots
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
        VALUES (${walletId}::uuid,${conditionId},${tokenId},1,.4,.5,.4,
          'event-case-history',${generationAt}::timestamptz,
          jsonb_build_object('economicObservationV1',${JSON.stringify(observation)}::jsonb))`);
      if (scenario.quantity !== null) {
        await seed.execute(sql`INSERT INTO poly_trader_current_positions
          (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,first_observed_at,raw)
          VALUES (${walletId}::uuid,${conditionId},${tokenId},${scenario.quantity},
            ${scenario.quantity * 0.4},${scenario.quantity * 0.5},.4,'event-case-current',
            ${generationAt}::timestamptz,${generationAt}::timestamptz,'{}'::jsonb)`);
      }
      await seed.execute(sql`INSERT INTO poly_trader_ingestion_cursors
        (trader_wallet_id,source,last_success_at,status)
        VALUES (${walletId}::uuid,'data-api-positions',${generationAt}::timestamptz,'ok')`);
      await withTenantScope(db, userActor(toUserId(ownerA.userId)), async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const [context] = await tx.execute(sql`SELECT
          (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass_rls,
          current_setting('app.current_user_id') AS actor,
          current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS read_only`);
        expect(context).toMatchObject({ bypass_rls: false, actor: ownerA.userId,
          isolation: "repeatable read", read_only: "on" });
        const current = await tx.execute<{ shares: string }>(sql`SELECT shares
          FROM poly_trader_current_positions WHERE trader_wallet_id=${walletId}::uuid`);
        expect(current.map((row) => Number(row.shares))).toEqual(
          scenario.quantity === null ? [] : [scenario.quantity],
        );
        const query = buildEconomicPositionProjectionQuery({
          billingAccountId: ownerA.billingAccountId, walletAddress: fixtureAddress,
          connectionKind: "privy_live", capturedAt, interval: "ALL",
        });
        if (scenario.settlements === "malformed" && !scenario.futureEnvelope) {
          // No current, fills or outcome: the history key is outside every
          // preview, but complete counts still demand its event CASE. Roll back
          // the actual savepoint so the native error cannot poison the parent.
          await expect(tx.transaction((savepoint) => savepoint.execute(query)))
            .rejects.toMatchObject({ cause: { code: "22023" } });
          const [usable] = await tx.execute(sql`SELECT 1::int AS ok`);
          expect(usable?.ok).toBe(1);
          return;
        }
        const rows = await tx.execute<{
          live_count: number; closed_count: number; incomplete_count: number;
          history_incomplete_count: number; missing_mark_count: number;
          wallet_identity_count: number; observer_complete: boolean;
          token_id: string | null; economic_bucket: string | null;
          current_shares: string | null; current_value_usdc: string | null;
          positions_mtm_usdc: string | null; inventory_authoritative: boolean | null;
          mark_available: boolean | null; history_complete: boolean | null;
        }>(query);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        const positive = scenario.quantity === 1;
        const futureSettlement = positive && scenario.settlements === "nonempty";
        expect(row).toMatchObject({
          live_count: positive ? 1 : 0, closed_count: 0,
          incomplete_count: positive ? 0 : 1, history_incomplete_count: 1,
          missing_mark_count: futureSettlement ? 1 : 0,
          wallet_identity_count: 1, observer_complete: true,
          token_id: positive ? tokenId : null,
          economic_bucket: positive ? "live" : null,
        });
        if (positive) {
          expect(Number(row?.current_shares)).toBe(1);
          expect(row?.inventory_authoritative).toBe(!futureSettlement);
          expect(row?.mark_available).toBe(!futureSettlement);
          expect(row?.history_complete).toBe(false);
          if (futureSettlement) {
            expect(row?.current_value_usdc).toBeNull();
            expect(row?.positions_mtm_usdc).toBeNull();
          } else {
            expect(Number(row?.current_value_usdc)).toBe(0.5);
            expect(Number(row?.positions_mtm_usdc)).toBe(0.5);
          }
        } else {
          // Count-only keys expose the seed row, not their internal aliases.
          // Neither explicit zero nor absent current fabricates a preview fact.
          expect(row?.current_shares).toBeNull();
          expect(row?.current_value_usdc).toBeNull();
          expect(row?.inventory_authoritative).toBeNull();
          expect(row?.mark_available).toBeNull();
          expect(row?.positions_mtm_usdc).not.toBeNull();
          expect(Number(row?.positions_mtm_usdc)).toBe(0);
        }
      });
    } finally {
      if (walletId) await seed.execute(sql`DELETE FROM poly_trader_wallets WHERE id=${walletId}::uuid`);
    }
  });

  it("probes only after a real projection timeout rolls back and preserves unavailable facts", async () => {
    await withTenantScope(db, userActor(toUserId(canonicalAgent.userId)), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const dialect = new PgDialect();
      let projectionQuery: ReturnType<typeof dialect.sqlToQuery> | undefined;
      let explainedQuery: ReturnType<typeof dialect.sqlToQuery> | undefined;
      const trace: string[] = [];
      const wrap = (connection: typeof tx): typeof tx => new Proxy(connection, {
        get(target, property) {
          if (property === "execute") return async (query: SQL) => {
            const compiled = dialect.sqlToQuery(query);
            if (compiled.sql.trim().startsWith("WITH wallet_identity")) {
              projectionQuery = compiled;
              await target.execute(sql`SET LOCAL statement_timeout = 5`);
              return target.execute(sql`SELECT pg_sleep(0.025)`);
            }
            if (compiled.sql.startsWith("EXPLAIN")) {
              explainedQuery = compiled;
              trace.push("explain");
            }
            return target.execute(query);
          };
          if (property === "transaction") return async (read: (savepoint: typeof tx) => Promise<unknown>) => {
            try { return await target.transaction(savepoint => read(wrap(savepoint))); }
            catch (error) { trace.push("rollback"); throw error; }
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const diagnostics: WalletDashboardReadDiagnostics = {};
      const result = await readTenantWalletDashboardIn(wrap(tx) as unknown as Parameters<typeof readTenantWalletDashboardIn>[0], {
        billingAccountId: ownerA.billingAccountId, interval: "ALL", adapterConfigured: true, diagnostics,
      });
      expect(diagnostics).toMatchObject({ economicReadPhase: "projection", economicCauseCode: "57014",
        economicPlanProbe: { status: "captured" } });
      expect(result.facts.positions.status).toBe("unavailable");
      expect(result.facts.history.status).toBe("unavailable");
      expect(result.readiness.connected).toBe(true);
      expect(result.overview.address).toBe(funderA);
      expect(projectionQuery).toBeDefined();
      expect(explainedQuery?.sql).toBe(`EXPLAIN (FORMAT JSON) ${projectionQuery?.sql}`);
      expect(explainedQuery?.params).toEqual(projectionQuery?.params);
      expect(trace.indexOf("rollback")).toBeLessThan(trace.indexOf("explain"));
      const [budget] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
      expect(budget?.timeout).toBe("8s");
    });
  });

  it("bounds failed plan probes to one second and reserves cooldown/inflight before IO", async () => {
    await withTenantScope(db, userActor(toUserId(ownerA.userId)), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = 8000`);
      let clock = 1_000;
      const probe = createEconomicProjectionPlanProbe(() => clock);
      let explainCalls = 0;
      const slowed = new Proxy(tx, { get(target, property) {
        if (property === "transaction") return async (read: (savepoint: typeof tx) => Promise<unknown>) =>
          target.transaction(savepoint => read(new Proxy(savepoint, { get(saved, key) {
            if (key === "execute") return async (query: SQL) => {
              if (new PgDialect().sqlToQuery(query).sql.startsWith("EXPLAIN")) {
                explainCalls += 1;
                // Real PostgreSQL cancellation inside the probe's actual 1s savepoint.
                return saved.execute(sql`SELECT pg_sleep(1.1)`);
              }
              return saved.execute(query);
            };
            const value = Reflect.get(saved, key);
            return typeof value === "function" ? value.bind(saved) : value;
          } })));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const query = buildEconomicPositionProjectionQuery({ billingAccountId: ownerA.billingAccountId,
        walletAddress: funderA, connectionKind: "privy_live", capturedAt: new Date(), interval: "ALL" });
      const pending = probe(slowed as unknown as Parameters<typeof probe>[0], query);
      expect((await probe(tx as unknown as Parameters<typeof probe>[0], query)).status).toBe("skipped_inflight");
      const failed = await pending;
      expect(failed).toMatchObject({ status: "failed", cause_code: "57014" });
      expect((await probe(tx as unknown as Parameters<typeof probe>[0], query)).status).toBe("skipped_cooldown");
      expect(explainCalls).toBe(1);
      const [budget] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
      expect(budget?.timeout).toBe("8s");
      clock += 5 * 60_000;
      expect((await probe(tx as unknown as Parameters<typeof probe>[0], query)).status).toBe("captured");
    });
  });

  it("lets the owner read its own identity, readiness and cash", async () => {
    const [connection] = await readConnection(ownerA.userId);
    expect(connection?.address).toBe(addressA);
    expect(connection?.funderAddress).toBe(funderA);
    expect(connection?.tradingApprovalsReadyAt).not.toBeNull();
    // Inventory row 2.8: NOT NULL with a CHECK > 0, so a connected wallet
    // always has a floor — `auto_wrap_floor_usdce_atomic` is never a fake zero.
    expect(connection?.autoWrapFloor).toBeGreaterThan(0n);

    const [balance] = await readBalances(ownerA.userId);
    expect(Number(balance?.usdcE)).toBeCloseTo(12.5);
    expect(Number(balance?.pol)).toBeCloseTo(1.25);
  });

  it.each([
    ["canonical account:read", () => canonicalAgent],
    ["legacy performance:read", () => legacyAgent],
  ])(
    "lets a %s grant read real rows, not an empty set",
    async (_label, who) => {
      const connections = await readConnection(who().userId);
      const balances = await readBalances(who().userId);

      // THE point of 0075. Without it both of these are `[]`, and the snapshot
      // then reports a disconnected wallet with null balances — indistinguishable
      // to the caller from the truth, and therefore fabrication.
      expect(connections).toHaveLength(1);
      expect(connections[0]?.address).toBe(addressA);
      expect(connections[0]?.tradingApprovalsReadyAt).not.toBeNull();
      expect(balances).toHaveLength(1);
      expect(Number(balances[0]?.usdcE)).toBeCloseTo(12.5);
    }
  );

  it.each([
    ["no grant at all", () => ungrantedAgent],
    ["a wrong-scope grant", () => wrongScopeAgent],
    ["an expired grant", () => expiredAgent],
    ["a revoked grant", () => revokedAgent],
    ["a grant on a different account", () => ownerB],
  ])("shows nothing to a principal with %s", async (_label, who) => {
    expect(await readConnection(who().userId)).toEqual([]);
    expect(await readBalances(who().userId)).toEqual([]);
  });

  it("never shows one tenant's wallet through another tenant's session", async () => {
    const rows = await withTenantScope(
      db,
      userActor(toUserId(ownerB.userId)),
      async (tx) =>
        tx
          .select({
            billingAccountId: polyWalletConnections.billingAccountId,
          })
          .from(polyWalletConnections)
    );
    // Owner B sees only its own row, even though the delegated policy exists.
    expect(rows.map((row) => row.billingAccountId)).toEqual([
      ownerB.billingAccountId,
    ]);
  });

  describe("end-to-end: one read model, two principals", () => {
    /**
     * The production path for the capability: the app-role tenant transaction
     * the executor opens, with the read model running inside it. Called
     * directly rather than through the handler so the module-scope snapshot
     * cache cannot make the parity assertion below trivially true — this
     * compares what RLS actually returns for each principal.
     */
    async function snapshotAs(principalId: string) {
      return withTenantScope(
        db,
        userActor(toUserId(principalId)),
        async (tx) => {
          await tx.execute(
            sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
          );
          return readTenantWalletDashboardIn(
            tx as unknown as Parameters<typeof readTenantWalletDashboardIn>[0],
            {
              billingAccountId: ownerA.billingAccountId,
              interval: "1W",
              adapterConfigured: true,
            }
          );
        }
      );
    }

    it("returns the owner's readiness facts from the identity row", async () => {
      const snapshot = await snapshotAs(ownerA.userId);

      expect(snapshot.readiness.connected).toBe(true);
      // readiness.funder_address and overview.address are the SAME fact from
      // the SAME row, which is why they are read in one query.
      expect(snapshot.readiness.funder_address).toBe(funderA.toLowerCase());
      expect(snapshot.overview.address).toBe(funderA.toLowerCase());
      expect(snapshot.readiness.trading_ready).toBe(true);
      expect(snapshot.readiness.auto_wrap_consent_at).toBeNull();
      expect(snapshot.readiness.auto_wrap_floor_usdce_atomic).toBe("1000000");
      expect(snapshot.readiness.observedAt).toBe(snapshot.capturedAt);
    });

    it("gives an approved agent the same saved facts as the owner", async () => {
      const owner = await snapshotAs(ownerA.userId);
      const agent = await snapshotAs(canonicalAgent.userId);

      // The parity contract, over the saved facts only. `snapshotId`,
      // `capturedAt` and the `observedAt`/`ageMs` fields derived from it are
      // per-request by construction (inventory rows 11.1-11.2) and are
      // excluded from comparison rather than papered over.
      expect(savedFacts(agent)).toStrictEqual(savedFacts(owner));
    });

    it("degrades to typed nulls — never zeroes — for a principal RLS hides the wallet from", async () => {
      const snapshot = await snapshotAs(ungrantedAgent.userId);

      // NO_FABRICATED_VALUES. An ungranted principal should be DENIED by the
      // capability long before reaching here; this asserts the layer beneath
      // still refuses to invent a balance if it ever is reached.
      expect(snapshot.readiness.connected).toBe(false);
      expect(snapshot.readiness.funder_address).toBeNull();
      expect(snapshot.readiness.trading_ready).toBe(false);
      expect(snapshot.overview.usdc_available).toBeNull();
      expect(snapshot.overview.usdc_total).toBeNull();
      expect(snapshot.overview.pol_gas).toBeNull();
      expect(snapshot.warnings.map((entry) => entry.code)).toContain(
        "no_trading_wallet"
      );
    });
  });

  describe("the new policy does not degrade the identity-read plan", () => {
    const planOwners = Array.from({ length: 2048 }, (_, index) =>
      tenant(`Portfolio plan owner ${index}`)
    );

    beforeAll(async () => {
      const seedDb = getSeedDb();
      await seedDb.insert(users).values(
        planOwners.map(owner => ({ id: owner.userId, name: owner.name, walletAddress: address() }))
      );
      await seedDb.insert(billingAccounts).values(
        planOwners.map(owner => ({ id: owner.billingAccountId, ownerUserId: owner.userId, balanceCredits: 0n }))
      );
      await seedDb.insert(polyWalletConnections).values(
        planOwners.map(owner => connection(owner, address()))
      );
      // Refresh both selective-access fixture relations as their migrated owner;
      // the BYPASSRLS seeding role cannot ANALYZE them.
      await db.execute(sql`ANALYZE billing_accounts`);
      await db.execute(sql`ANALYZE poly_wallet_connections`);
      // Runs after both ordinary N10 gates; estimates may lag or be unknown.
      const relationObservations = await seedDb.execute(sql`
        SELECT counts.relation, counts.actual_count,
          c.reltuples, c.relpages, s.n_live_tup::text, s.n_dead_tup::text,
          s.n_mod_since_analyze::text, s.last_analyze::text, s.last_autoanalyze::text
        FROM (
          SELECT 'poly_wallet_connections' AS relation,
            'public.poly_wallet_connections'::regclass AS relation_oid,
            count(*)::text AS actual_count FROM public.poly_wallet_connections
          UNION ALL
          SELECT 'billing_accounts', 'public.billing_accounts'::regclass,
            count(*)::text FROM public.billing_accounts
          UNION ALL
          SELECT 'agent_capability_grants', 'public.agent_capability_grants'::regclass,
            count(*)::text FROM public.agent_capability_grants
        ) counts
        JOIN pg_class c ON c.oid = counts.relation_oid
        LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
      `);
      for (const row of relationObservations) {
        console.info(JSON.stringify({ probe: "identity_fixture_relations", ...row }));
      }
    });

    afterAll(async () => {
      const seedDb = getSeedDb();
      await seedDb.delete(billingAccounts).where(inArray(billingAccounts.id, planOwners.map(owner => owner.billingAccountId)));
      await seedDb.delete(users).where(inArray(users.id, planOwners.map(owner => owner.userId)));
      await db.execute(sql`ANALYZE billing_accounts`);
      await db.execute(sql`ANALYZE poly_wallet_connections`);
    });

    /**
     * Adding an RLS policy rewrites the plan of every SELECT on the table,
     * because the policy expression becomes part of the query. The identity
     * read runs on EVERY dashboard tick, so a policy that introduced a
     * sequential scan — of the table or of `agent_capability_grants` — would be
     * a latency regression hiding inside a security fix.
     *
     * WHAT IS ASSERTED: no sequential scan anywhere, and the grant lookup is a
     * SubPlan rather than a per-row join. Deliberately NOT asserted: which
     * index the planner picks. That is cost-based and fixture-size dependent.
     * With only a few owners a billing_accounts sequential scan is cheaper
     * and legitimate, so these tests add unrelated owner/account cardinality
     * plus one wallet connection each and fresh statistics before asserting
     * selective access. Grant fixtures and planner settings stay unchanged.
     * Pinning an index name
     * would still assert a fixture property rather than the policy contract.
     */
    async function identityPlan(principalId: string): Promise<string> {
      const rows = await withTenantScope(
        db,
        userActor(toUserId(principalId)),
        async (tx) =>
          tx.execute(sql`
            EXPLAIN (FORMAT JSON)
            SELECT
              lower(COALESCE(funder_address, address)) AS address,
              trading_approvals_ready_at,
              auto_wrap_consent_at,
              auto_wrap_revoked_at,
              auto_wrap_floor_usdce_6dp
            FROM poly_wallet_connections
            WHERE billing_account_id = ${ownerA.billingAccountId}
              AND revoked_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
          `)
      );
      const normalized = Array.isArray(rows)
        ? rows
        : ((rows as { rows?: unknown[] }).rows ?? []);
      return JSON.stringify(normalized);
    }

    it.each([
      ["the owner", () => ownerA.userId],
      ["a delegated principal", () => canonicalAgent.userId],
    ])("scans no table sequentially for %s", async (_label, who) => {
      const plan = await identityPlan(who());
      expect(plan).toContain("Index Scan");
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
    });

    it("evaluates both policy branches as indexed subplans, not per-row joins", async () => {
      const plan = await identityPlan(canonicalAgent.userId);

      // The owner branch and the delegated branch each collapse to a SubPlan
      // the planner hashes and evaluates ONCE per statement — so the policy
      // costs a constant, not one probe per candidate row. This is the real
      // performance property of migration 0075 and it is better than a
      // per-row index probe.
      expect(plan).toContain("SubPlan");
      expect(plan).toContain('"Relation Name":"billing_accounts"');
      expect(plan).toContain("agent_capability_grants");
      // Neither side of the OR may fall back to a scan. One generic check, not
      // a key-order-specific one: JSON key order is not a stable contract, so
      // an assertion pinned to it can never fail and is worse than none.
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
    });
  });

  describe("writes stay owner-only", () => {
    it("refuses a delegated UPDATE of wallet readiness", async () => {
      // The new policies are FOR SELECT. A delegated principal matches no
      // write policy, so FORCE RLS makes the UPDATE affect zero rows.
      const updated = await withTenantScope(
        db,
        userActor(toUserId(canonicalAgent.userId)),
        async (tx) =>
          tx
            .update(polyWalletConnections)
            .set({ tradingApprovalsReadyAt: null })
            .where(
              eq(
                polyWalletConnections.billingAccountId,
                ownerA.billingAccountId
              )
            )
            .returning({ id: polyWalletConnections.id })
      );
      expect(updated).toEqual([]);

      // And the owner's fact is untouched.
      const [connection] = await readConnection(ownerA.userId);
      expect(connection?.tradingApprovalsReadyAt).not.toBeNull();
    });

    it("refuses a delegated UPDATE of a cash snapshot", async () => {
      const updated = await withTenantScope(
        db,
        userActor(toUserId(canonicalAgent.userId)),
        async (tx) =>
          tx
            .update(polyWalletBalanceSnapshots)
            .set({ status: "error", usdcE: null, pusd: null, pol: null })
            .where(
              eq(
                polyWalletBalanceSnapshots.billingAccountId,
                ownerA.billingAccountId
              )
            )
            .returning({
              billingAccountId: polyWalletBalanceSnapshots.billingAccountId,
            })
      );
      expect(updated).toEqual([]);

      const [balance] = await readBalances(ownerA.userId);
      expect(Number(balance?.usdcE)).toBeCloseTo(12.5);
    });

    it("refuses a delegated DELETE of a cash snapshot", async () => {
      const deleted = await withTenantScope(
        db,
        userActor(toUserId(canonicalAgent.userId)),
        async (tx) =>
          tx
            .delete(polyWalletBalanceSnapshots)
            .where(
              eq(
                polyWalletBalanceSnapshots.billingAccountId,
                ownerA.billingAccountId
              )
            )
            .returning({
              billingAccountId: polyWalletBalanceSnapshots.billingAccountId,
            })
      );
      expect(deleted).toEqual([]);
      expect(await readBalances(ownerA.userId)).toHaveLength(1);
    });
  });
});
