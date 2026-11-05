// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Port-level behavioral proof: dispatch ownership, unknown outcomes and stale runtime subjects. */
import { hkdfSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { NormalizedMarket, OrderIntent, OrderReceipt } from "@cogni/poly-market-provider";
import { SignJWT } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { createPaperCompanionTransport } from "@/bootstrap/qualification-companion";
import type { QualificationChallenge, QualificationReadiness } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError, verifyQualificationChallenge } from "@/features/deploy-qualification/challenge";
import {
	type QualificationDependencies,
	createQualificationIntentSelector,
	observePaperCompanion as observeCompanion,
	qualificationOperationIds,
	qualifyRelease,
} from "@/features/deploy-qualification/service";

// Exercise the feature policy with its real native transport, including dispatch fences.
function observePaperCompanion(
  binding: string,
  readiness: QualificationReadiness,
  signal: AbortSignal,
  now?: () => Date,
  deadlineAt?: number,
) {
  return observeCompanion(createPaperCompanionTransport(
    binding, deadlineAt, () => new QualificationError("qualification_timeout"),
  ), readiness, signal, now);
}

const qualificationComposition = vi.hoisted(() => ({ resolve: vi.fn(), env: vi.fn(() => ({})) }));
vi.mock("@/bootstrap/qualification", () => ({ resolveQualificationDependencies: qualificationComposition.resolve }));
vi.mock("@/shared/env", () => ({ serverEnv: qualificationComposition.env }));
vi.mock("@/shared/config/repoSpec.server", () => ({ getNodeId: () => "4b06359a-a859-4399-888e-a8c7a6696f7e" }));
const routeLog = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  log.child.mockImplementation(() => log);
  return log;
});
const envelope = vi.hoisted(() => ({ prelude: vi.fn(async () => {}), start: vi.fn(), end: vi.fn(), count: vi.fn(), duration: vi.fn(), legacy: vi.fn() }));
vi.mock("@/shared/observability", async () => ({
  createRequestContext: (await import("../../../../../packages/node-shared/src/observability/context/factory")).createRequestContext,
  makeLogger: () => routeLog, statusBucket: (status: number) => `${Math.floor(status / 100)}xx`,
  logRequestStart: envelope.start, logRequestEnd: envelope.end,
  httpRequestsTotal: { inc: envelope.count }, httpRequestDurationMs: { observe: envelope.duration },
}));
vi.mock("@/bootstrap/otel", () => ({
  getCurrentTraceId: () => "0".repeat(32),
  withRootSpan: async (_name: string, _attrs: unknown, action: (ctx: unknown) => Promise<unknown>) => {
    await envelope.prelude();
    return action({ traceId: "1".repeat(32), span: { setAttribute: vi.fn() } });
  },
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: (ctx: unknown, request: Request) => Promise<Response>) =>
    (request: Request) => { envelope.legacy(); return handler({ log: routeLog }, request); },
}));

const now = new Date("2026-11-04T20:00:00.000Z");
const sha = "a".repeat(40);
const image = `ghcr.io/cogni-dao/poly@sha256:${"b".repeat(64)}`;
const challenge: QualificationChallenge = {
	iss: "cogni-operator",
	aud: "cogni-release-qualification",
	iat: now.getTime() / 1000,
	exp: now.getTime() / 1000 + 60,
	jti: "challenge-1",
	nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e",
	env: "candidate-a",
	releaseId: "release-a",
	sourceSha: sha,
	bundleDigest: image,
	services: { app: image, "paper-trader": image },
	attemptId: "attempt-a",
	allocation: "allocation-a",
	mode: "qualify",
	helperBootId: null,
	companionReadiness: { "paper-trader": { port: 9100, path: "/healthz" } },
	companionBootIds: null,
};
const signal = () => new AbortController().signal;
function rig() {
	const fixture = {
		accountId: "dedicated-fixture",
		ownerId: "dedicated-agent",
	};
	type Row = {
		mode: string;
		status: string;
		order_id: string | null;
		client_order_id: string;
		attributes: Record<string, unknown> | null;
	};
	// A durable port fake, not a mocked SQL database. New callers reuse only these saved facts.
	const state: { row: Row | null; receipt: OrderReceipt | null; boot: string } =
		{ row: null, receipt: null, boot: "boot-a" };
	const deps: QualificationDependencies = {
		fixture,
		now: () => now,
		checkFixture: vi.fn(async () => {}),
		helper: vi.fn(async (_signal, readiness) => ({ buildSha: sha, bootId: state.boot, ready: { ...readiness, status: 200, observedAt: deps.now().toISOString() } })),
		selectIntent: vi.fn(async () => ({
			market_id: "prediction-market:polymarket:real-discovered-condition",
			outcome: "YES",
		})),
		claim: vi.fn(async (intent: OrderIntent) => {
			if (state.row) return { inserted: false, mode: "paper" };
			state.row = {
				mode: "paper",
				status: "pending",
				order_id: null,
				client_order_id: intent.client_order_id,
				attributes: intent.attributes ?? null,
			};
			return { inserted: true, mode: "paper" };
		}),
		load: vi.fn(async () => state.row),
		place: vi.fn(async (intent) => {
			state.receipt = {
				order_id: "venue-order-1",
				client_order_id: intent.client_order_id,
				status: "open",
				filled_size_usdc: 0,
				submitted_at: now.toISOString(),
			};
			return state.receipt;
		}),
		save: vi.fn(async (receipt) => {
			if (!state.row) throw new Error("no reservation");
			state.row.order_id = receipt.order_id;
			state.row.status = receipt.status;
		}),
		cancel: vi.fn(async () => {
			if (state.receipt) state.receipt.status = "canceled";
		}),
		getOrder: vi.fn(async () =>
			state.receipt ? { found: { ...state.receipt } } : { status: "not_found" },
		),
	};
	return { deps, state };
}

describe("release qualification dispatch ownership", () => {
	it("cancels before a blocked receipt save exhausts the action; preserves failure and never redispatches", async () => {
		const { deps, state } = rig();
		const controller = new AbortController();
		const failure = new Error("blocked receipt save expired");
		let entered!: () => void;
		const saving = new Promise<void>((resolve) => { entered = resolve; });
		deps.save = vi.fn(() => new Promise<void>((_resolve, reject) => {
			entered();
			controller.signal.addEventListener("abort", () => reject(failure), { once: true });
		}));
		const action = expect(qualifyRelease(challenge, deps, controller.signal)).rejects.toBe(failure);
		await saving;
		const canceledBeforeSaveExpired = vi.mocked(deps.cancel).mock.calls.length === 1;
		controller.abort(new Error("action deadline"));
		await action;
		expect(canceledBeforeSaveExpired).toBe(true);
		expect(deps.cancel).toHaveBeenCalledExactlyOnceWith("venue-order-1", controller.signal);
		expect(state.receipt?.status).toBe("canceled");
		await expect(qualifyRelease(challenge, { ...deps }, signal())).rejects.toThrow("qualification_receipt_missing");
		expect(deps.place).toHaveBeenCalledTimes(1);
		expect(deps.cancel).toHaveBeenCalledTimes(1);
	});
	it("reserves then uses normal place/cancel/get and saves the real receipt", async () => {
		const { deps, state } = rig();
		const result = await qualifyRelease(challenge, deps, signal());
		expect(result.status).toBe("qualified");
		expect(result.helper).toEqual({
			service: "paper-trader",
			buildSha: sha,
			bootId: "boot-a",
		});
		expect(state.row).toMatchObject({
			mode: "paper",
			status: "canceled",
			order_id: "venue-order-1",
		});
		expect(deps.place).toHaveBeenCalledTimes(1);
		expect(deps.cancel).toHaveBeenCalledTimes(1);
		expect(vi.mocked(deps.claim).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(deps.place).mock.invocationCallOrder[0] ?? 0,
		);
		expect(result.evidenceId).toBe(
			qualificationOperationIds(deps.fixture.accountId, challenge.releaseId)
				.clientOrderId,
		);
	});
	it.each([false, true])("cancels a known open receipt after save fails (cancel also fails: %s)", async (cancelFails) => {
    const { deps, state } = rig();
    const failure = new Error("receipt persistence failed");
    deps.save = vi.fn(async () => { throw failure; });
    if (cancelFails) deps.cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    await expect(qualifyRelease(challenge, deps, signal())).rejects.toBe(failure);
    expect(deps.cancel).toHaveBeenCalledExactlyOnceWith("venue-order-1", expect.any(AbortSignal));
    expect(state.row).toMatchObject({ status: "pending", order_id: null });
    await expect(qualifyRelease(challenge, { ...deps }, signal())).rejects.toThrow("qualification_receipt_missing");
    expect(deps.place).toHaveBeenCalledTimes(1);
    expect(deps.cancel).toHaveBeenCalledTimes(1);
  });
  it("retains a real saved open receipt when cancellation fails; retry is readback-only", async () => {
    const { deps, state } = rig();
    deps.cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow("cancel failed");
    expect(state.row).toMatchObject({ status: "open", order_id: "venue-order-1" });
    await expect(qualifyRelease(challenge, { ...deps }, signal())).rejects.toThrow("qualification_receipt_missing");
    expect(deps.place).toHaveBeenCalledTimes(1);
    expect(deps.cancel).toHaveBeenCalledTimes(1);
  });
	it("allows at most one placement under concurrent qualification requests", async () => {
		const { deps } = rig();
		const results = await Promise.allSettled(
			Array.from({ length: 12 }, () =>
				qualifyRelease(challenge, deps, signal()),
			),
		);
		expect(results.some((r) => r.status === "fulfilled")).toBe(true);
		expect(deps.place).toHaveBeenCalledTimes(1);
		expect(deps.cancel).toHaveBeenCalledTimes(1);
	});
	it("does not dispatch when the committed reservation reply is lost", async () => {
		const { deps, state } = rig();
		const claim = deps.claim;
		deps.claim = vi.fn(async (...args) => {
			await claim(...args);
			throw new Error("COMMIT response lost");
		});
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"qualification_receipt_missing",
		);
		expect(state.row).not.toBeNull();
		await expect(
			qualifyRelease(challenge, { ...deps }, signal()),
		).rejects.toThrow();
		expect(deps.place).not.toHaveBeenCalled();
	});
	it("keeps a reservation after placement loses its reply; restart cannot post again", async () => {
		const { deps, state } = rig();
		const place = deps.place;
		deps.place = vi.fn(async (...args) => {
			await place(...args);
			throw new Error("placement response lost");
		});
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"placement response lost",
		);
		expect(state.receipt?.order_id).toBe("venue-order-1");
		expect(state.row?.order_id).toBeNull();
		await expect(
			qualifyRelease(challenge, { ...deps }, signal()),
		).rejects.toThrow("qualification_receipt_missing");
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("recovers a lost qualification response by saved receipt readback after caller restart", async () => {
		const { deps } = rig();
		await qualifyRelease(challenge, deps, signal());
		const restarted = { ...deps };
		const result = await qualifyRelease(
			{
				...challenge,
				mode: "readback",
				helperBootId: "boot-a",
				companionBootIds: { "paper-trader": "boot-a" },
				jti: "fresh-nonce",
			},
			restarted,
			signal(),
		);
		expect(result.nonce).toBe("fresh-nonce");
		expect(deps.place).toHaveBeenCalledTimes(1);
		expect(deps.cancel).toHaveBeenCalledTimes(1);
	});
	it.each([
		"attemptId",
		"allocation",
		"bundleDigest",
		"sourceSha",
	] as const)("rejects a changed %s without replacement placement", async (field) => {
		const { deps } = rig();
		await qualifyRelease(challenge, deps, signal());
		const replacement =
			field === "bundleDigest"
				? `ghcr.io/cogni-dao/poly@sha256:${"c".repeat(64)}`
				: field === "sourceSha"
					? "d".repeat(40)
					: "replacement";
		await expect(
			qualifyRelease({ ...challenge, [field]: replacement }, deps, signal()),
		).rejects.toThrow();
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("rejects a different selected digest set, even with the same source build", async () => {
		const { deps } = rig();
		await qualifyRelease(challenge, deps, signal());
		await expect(
			qualifyRelease(
				{
					...challenge,
					services: {
						...challenge.services,
						"paper-trader": `ghcr.io/x@sha256:${"c".repeat(64)}`,
					},
				},
				deps,
				signal(),
			),
		).rejects.toThrow("qualification_subject_stale");
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("refuses A's evidence on B even when B is ready and its order endpoint is broken", async () => {
		const { deps, state } = rig();
		await qualifyRelease(challenge, deps, signal());
		state.boot = "boot-b";
		deps.getOrder = vi.fn(async () => {
			throw new Error("broken order endpoint");
		});
		await expect(
			qualifyRelease(
				{
					...challenge,
					allocation: "allocation-b",
					mode: "readback",
					helperBootId: "boot-a",
				companionBootIds: { "paper-trader": "boot-a" },
				},
				deps,
				signal(),
			),
		).rejects.toThrow("helper_identity_changed");
		expect(deps.getOrder).not.toHaveBeenCalled();
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("refuses stale success after a volatile helper restart; never repairs via POST", async () => {
		const { deps, state } = rig();
		await qualifyRelease(challenge, deps, signal());
		state.boot = "boot-b";
		state.receipt = null;
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"qualification_subject_stale",
		);
		expect(deps.place).toHaveBeenCalledTimes(1);
		expect(state.row?.order_id).toBe("venue-order-1");
	});
	it("fails when the order endpoint breaks despite stable readiness and boot", async () => {
		const { deps } = rig();
		await qualifyRelease(challenge, deps, signal());
		deps.getOrder = vi.fn(async () => {
			throw new Error("broken order endpoint");
		});
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"broken order endpoint",
		);
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("detects helper restart during useful work", async () => {
		const { deps, state } = rig();
		const save = deps.save;
		deps.save = async (receipt) => {
			await save(receipt, qualificationOperationIds(deps.fixture.accountId, challenge.releaseId));
			if (receipt.status === "canceled") state.boot = "boot-b";
		};
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"helper_identity_changed",
		);
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("requires an actual current terminal receipt, not a saved success flag", async () => {
		const { deps, state } = rig();
		await qualifyRelease(challenge, deps, signal());
		state.receipt = null;
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"paper_order_not_found",
		);
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("rejects stale reservation timestamps", async () => {
		const { deps } = rig();
		await qualifyRelease(challenge, deps, signal());
		deps.now = () => new Date(now.getTime() + 60001);
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"qualification_subject_stale",
		);
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it("fails without a real owned fixture or grant", async () => {
		const { deps } = rig();
		deps.checkFixture = vi.fn(async () => {
			throw new Error("qualification_paper_grant_missing");
		});
		await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
			"qualification_paper_grant_missing",
		);
		expect(deps.claim).not.toHaveBeenCalled();
		expect(deps.place).not.toHaveBeenCalled();
	});
	it("aborts before dispatch if its budget expires while reserving", async () => {
		const { deps } = rig();
		const controller = new AbortController();
		const claim = deps.claim;
		deps.claim = async (...args) => {
			const r = await claim(...args);
			controller.abort();
			return r;
		};
		await expect(
			qualifyRelease(challenge, deps, controller.signal),
		).rejects.toThrow();
		expect(deps.place).not.toHaveBeenCalled();
	});
});

const secret = "purpose-separated-secret-at-least-32-characters";
async function signed(
	c: Record<string, unknown> = challenge,
	keyPurpose = "cogni-release-qualification-v1",
	typ = "JWT",
) {
	const key = new Uint8Array(
		hkdfSync("sha256", secret, keyPurpose, keyPurpose, 32),
	);
	return `Bearer ${await new SignJWT(c).setProtectedHeader({ alg: "HS256", typ }).sign(key)}`;
}
function verify(authorization: string | null, extra = {}) {
	return verifyQualificationChallenge({
		authorization,
		mode: "qualify",
		authSecret: secret,
		nodeId: challenge.nodeId,
		env: challenge.env,
		sourceSha: sha,
		now,
		...extra,
	});
}
describe("qualification wire v1 service authentication", () => {
	it("accepts the exact signed runtime subject and 60-second expiry", async () => {
		await expect(verify(await signed())).resolves.toEqual(challenge);
	});
	it.each([
		{ env: "preview" },
		{ nodeId: "00000000-0000-4000-8000-000000000000" },
		{ sourceSha: "f".repeat(40) },
		{ exp: now.getTime() / 1000 + 61 },
		{ exp: now.getTime() / 1000 },
		{ iat: now.getTime() / 1000 + 1 },
		{ mode: "readback" },
		{ helperBootId: "unexpected" },
		{ services: { app: image } },
		{ bundleDigest: "mutable:tag" },
		{ services: { app: image, "paper-trader": "mutable:tag" } },
		{ jti: "" },
		{ audience: "extra-claim" },
	])("rejects mismatched, expired or malformed claims %j", async (patch) => {
		await expect(
			verify(await signed({ ...challenge, ...patch })),
		).rejects.toThrow("qualification_auth_invalid");
	});
	it("rejects missing auth, session-purpose keys and wrong JWT types", async () => {
		await expect(verify(null)).rejects.toThrow();
		await expect(
			verify(await signed(challenge, "human-session")),
		).rejects.toThrow();
		await expect(
			verify(await signed(challenge, undefined, "other")),
		).rejects.toThrow();
	});
	it("requires matching readback mode and the observed helper boot", async () => {
		await expect(
			verify(
				await signed({
					...challenge,
					mode: "readback",
					helperBootId: "boot-a",
				companionBootIds: { "paper-trader": "boot-a" },
				}),
				{ mode: "readback" },
			),
		).resolves.toMatchObject({ mode: "readback" });
		await expect(
			verify(
				await signed({ ...challenge, mode: "readback", helperBootId: null }),
				{ mode: "readback" },
			),
		).rejects.toThrow();
	});
});

it("accepts null helper boot for excluded-companion production readback", async () => {
	const token = await signed({
		...challenge,
		env: "production",
		services: { app: image },
		companionReadiness: {},
		companionBootIds: {},
		mode: "readback",
		helperBootId: null,
	});
	await expect(
		verify(token, { env: "production", mode: "readback" }),
	).resolves.toMatchObject({ env: "production", services: { app: image } });
});


describe("qualification native discovery cancellation", () => {
	it("rolls back real native SQLite work released after expiry and preserves ordinary defaults", () => {
		const result = spawnSync("python3", ["-c", `
import sqlite3, sys, tempfile, threading, time
sys.path.insert(0, sys.argv[1])
from pm_trader.deadline import ActionDeadline
from pathlib import Path
from pm_trader.db import Database
from pm_trader.deadline import sqlite_transaction
from pm_trader.orders import init_orders_schema, create_order, cancel_order

for operation in ("place", "cancel", "account", "schema", "open"):
  for stage in (("lock", "mutation", "commit") if operation != "open" else ("mutation",)):
    entered, release = threading.Event(), threading.Event()
    class GatedConnection(sqlite3.Connection):
        armed = False
        def execute(self, sql, *args):
            target = {"place": "INSERT INTO limit_orders", "cancel": "UPDATE limit_orders", "account": "INSERT OR REPLACE INTO account", "schema": "CREATE TABLE", "open": "PRAGMA journal_mode=WAL"}[operation]
            if self.armed and stage == "mutation" and sql.lstrip().startswith(target):
                entered.set()
                assert release.wait(2)
            return super().execute(sql, *args)
        def commit(self):
            if self.armed and stage == "commit":
                entered.set()
                assert release.wait(2)
            return super().commit()
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        conn = sqlite3.connect(str(path / "paper.db"), factory=GatedConnection, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        db = Database(path)
        db._conn = conn
        if operation not in ("schema", "open"):
            db.init_schema()
            init_orders_schema(conn)
        args = dict(market_slug="fixture", market_condition_id="condition", outcome="Yes", side="buy", amount=1, limit_price=0.01)
        if operation == "cancel": create_order(conn, **args)
        blocker = sqlite3.connect(str(db.db_path))
        if stage == "lock": blocker.execute("BEGIN IMMEDIATE")
        errors = []
        conn.armed = True
        original_connect = sqlite3.connect
        def connect(*a, **kw):
            kw["factory"] = GatedConnection
            kw["check_same_thread"] = False
            result = original_connect(*a, **kw)
            result.armed = True
            return result
        def action():
            try:
                deadline = ActionDeadline(int(time.time()*1000)+80)
                if operation == "place": create_order(conn, **args, deadline=deadline)
                elif operation == "cancel": cancel_order(conn, 1, deadline=deadline)
                elif operation == "account": db.init_account(100, deadline=deadline)
                elif operation == "schema":
                    with sqlite_transaction(conn, deadline):
                        db.init_schema(deadline=deadline)
                        init_orders_schema(conn, deadline=deadline)
                        deadline.remaining()
                        conn.commit()
                else:
                    sqlite3.connect = connect
                    try: Database(path, deadline=deadline)
                    finally: sqlite3.connect = original_connect
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=action)
        worker.start()
        if stage != "lock": assert entered.wait(1), (operation, stage)
        time.sleep(0.12)
        blocker.rollback()
        release.set()
        worker.join(1)
        assert not worker.is_alive()
        assert len(errors) == 1, (operation, stage, errors)
        assert not conn.in_transaction, (operation, stage)
        conn.armed = False
        if operation in ("schema", "open"):
            assert conn.execute("SELECT count(*) FROM sqlite_master WHERE name IN ('account','limit_orders')").fetchone()[0] == 0
            deadline = ActionDeadline(int(time.time()*1000)+1000)
            fresh = Database(path, deadline=deadline)
            with sqlite_transaction(fresh.conn, deadline):
                fresh.init_schema(deadline=deadline)
                init_orders_schema(fresh.conn, deadline=deadline)
                deadline.remaining()
                fresh.conn.commit()
            assert fresh.init_account(100, deadline=deadline).cash == 100
            fresh.close()
        elif operation == "account":
            assert db.get_account() is None
            assert db.init_account(100).cash == 100
        elif operation == "cancel":
            assert conn.execute("SELECT status FROM limit_orders WHERE id=1").fetchone()[0] == "pending"
            assert cancel_order(conn, 1).status == "cancelled"
        else:
            assert conn.execute("SELECT count(*) FROM limit_orders").fetchone()[0] == 0
            create_order(conn, **args)
            assert conn.execute("SELECT count(*) FROM limit_orders").fetchone()[0] == 1
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        blocker.close()
        conn.close()
print("native SQLite expiry and ordinary defaults passed")
`, resolve(process.cwd(), "../sidecars/paper-trader/vendor/pm_trader")], { encoding: "utf8", timeout: 10000 });
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
		expect(result.stdout).toContain("native SQLite expiry and ordinary defaults passed");
	});
	it("carries the absolute action deadline to the native helper without changing normal callers", async () => {
		const { PaperAdapter } = await import("../../../../../packages/poly-market-provider/src/adapters/paper/paper.adapter");
		const sent: Record<string, unknown>[] = [];
		const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body);
			return Response.json({ order_id: "paper-1", client_order_id: body.client_order_id, status: "open", filled_size_usdc: 0, submitted_at: now.toISOString() });
		});
		const intent: OrderIntent = { provider: "polymarket", market_id: "market", outcome: "YES", side: "BUY", size_usdc: 1, limit_price: 0.01, client_order_id: "proof" };
		const config = { accountId: "fixture", startingBalanceUsdc: 100, fetchImpl };
		const actionDeadlineAt = Date.now() + 5000;
		await new PaperAdapter({ ...config, actionDeadlineAt }).placeOrder(intent);
		await new PaperAdapter(config).placeOrder(intent);
		expect(sent[0]).toHaveProperty("action_deadline_at_ms", actionDeadlineAt);
		expect(sent[1]).not.toHaveProperty("action_deadline_at_ms");
	});
  it("carries lifetime and account identity on cancel and read paths; ordinary callers omit it", async () => {
    const { PaperAdapter } = await import("../../../../../packages/poly-market-provider/src/adapters/paper/paper.adapter");
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      calls.push(new URL(String(url)));
      if (init?.method === "POST") return new Response(null, { status: 204 });
      if (new URL(String(url)).pathname === "/orders") return Response.json([]);
      return new Response(null, { status: 404 });
    });
    const actionDeadlineAt = Date.now() + 5000;
    for (const bounded of [true, false]) {
      const adapter = new PaperAdapter({ accountId: "fixture / exact", startingBalanceUsdc: 100, fetchImpl, ...(bounded ? { actionDeadlineAt } : {}) });
      await adapter.cancelOrder("boot/order");
      expect(await adapter.getOrder("boot/order")).toEqual({ status: "not_found" });
      expect(await adapter.listOpenOrders()).toEqual([]);
    }
    expect(calls).toHaveLength(6);
    calls.forEach((url, index) => {
      expect(url.searchParams.get("account_id")).toBe("fixture / exact");
      expect(url.searchParams.get("starting_balance_usdc")).toBe("100");
      expect(url.searchParams.get("action_deadline_at_ms")).toBe(index < 3 ? String(actionDeadlineAt) : null);
    });
    expect(calls[0]?.pathname).toBe("/orders/boot%2Forder/cancel");
  });
  it.each(["headers", "body"] as const)("cancels discovery stalled at %s and cannot place later", async (stage) => {
    const { PolymarketAdapter } = await import("../../../../../packages/poly-market-provider/src/adapters/polymarket/polymarket.adapter");
    const { deps } = rig();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let released = false;
    const blocked = () => new Promise<never>((_, reject) => {
      entered();
      controller.signal.addEventListener("abort", () => { released = true; reject(controller.signal.reason); }, { once: true });
    });
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      if (stage === "headers") return blocked();
      return { ok: true, json: blocked } as Response;
    });
    deps.selectIntent = async (actionSignal) => {
      await new PolymarketAdapter({ signal: actionSignal, fetchImpl }).listMarkets();
      return { market_id: "late-market", outcome: "YES" };
    };
    const action = qualifyRelease(challenge, deps, controller.signal);
    const rejected = expect(action).rejects.toThrow("deadline");
    await started;
    controller.abort(new Error("deadline"));
    await rejected;
    expect(released).toBe(true);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.place).not.toHaveBeenCalled();
  });
  it("cannot dispatch when a prerequisite completes after the shared deadline", async () => {
    const { deps } = rig();
    const controller = new AbortController();
    let finish!: () => void;
    deps.checkFixture = () => new Promise<void>(resolve => { finish = resolve; });
    const action = qualifyRelease(challenge, deps, controller.signal);
    const rejected = expect(action).rejects.toThrow("deadline");
    controller.abort(new Error("deadline"));
    finish();
    await rejected;
    expect(deps.helper).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.place).not.toHaveBeenCalled();
  });
});

describe("selected companion readiness claims", () => {
	it("refuses the unreleased legacy wire without new signed maps", async () => {
		const {
			companionReadiness: _readiness,
			companionBootIds: _boots,
			...legacy
		} = challenge;
		await expect(verify(await signed(legacy))).rejects.toThrow(
			"qualification_auth_invalid",
		);
	});
	it("returns actual readiness evidence for every selected companion", async () => {
		const { deps } = rig();
		const result = await qualifyRelease(challenge, deps, signal());
		expect(result).toHaveProperty("companions.paper-trader.ready.status", 200);
	});
});

describe("complete signed companion coverage", () => {
	it.each([
		{ companionReadiness: undefined },
		{ companionBootIds: undefined },
		{ companionReadiness: {} },
		{ companionReadiness: { other: { port: 9100, path: "/healthz" } } },
		{
			companionReadiness: {
				...challenge.companionReadiness,
				extra: { port: 9100, path: "/healthz" },
			},
		},
		{ services: { app: image, "paper-trader": image, extra: image } },
		{ services: { app: image, extra: image } },
		{ services: { "app,paper-trader": image } },
		{ companionBootIds: {} },
		{
			companionReadiness: { "paper-trader": { port: 9101, path: "/healthz" } },
		},
		{
			companionReadiness: {
				"paper-trader": {
					port: 9100,
					path: "/healthz",
					host: "external.invalid",
				},
			},
		},
	])(
		"refuses missing, unsupported or inconsistent selection: %j",
		async (patch) => {
			await expect(
				verify(await signed({ ...challenge, ...patch })),
			).rejects.toThrow("qualification_auth_invalid");
		},
	);
	it.each([
		"https://external.invalid/ready",
		"//external.invalid/ready",
		"/\\external.invalid",
		"/../ready",
		"/x/./ready",
		"/%2e%2e/ready",
		"/healthz?target=external",
		"/healthz#fragment",
		"/x//ready",
		"/healthz\n",
	])("refuses unsafe signed readiness path %j", async (path) => {
		await expect(
			verify(
				await signed({
					...challenge,
					companionReadiness: { "paper-trader": { port: 9100, path } },
				}),
			),
		).rejects.toThrow("qualification_auth_invalid");
	});
	it.each([
		null,
		{},
		{ other: "boot-a" },
		{ "paper-trader": "boot-a", extra: "boot-a" },
		{ "paper-trader": "boot-b" },
	])(
		"requires the full previous boot map consistent with the useful helper: %j",
		async (companionBootIds) => {
			await expect(
				verify(
					await signed({
						...challenge,
						mode: "readback",
						helperBootId: "boot-a",
						companionBootIds,
					}),
					{ mode: "readback" },
				),
			).rejects.toThrow("qualification_auth_invalid");
		},
	);
	it.each(["candidate-a", "preview"] as const)(
		"accepts the supported signed selection in %s",
		async (env) => {
			await expect(
				verify(await signed({ ...challenge, env }), { env }),
			).resolves.toMatchObject({
				companionReadiness: challenge.companionReadiness,
			});
		},
	);
	it.each(["qualify", "readback"] as const)(
		"requires an empty production selection in %s",
		async (mode) => {
			const empty = {
				...challenge,
				env: "production",
				mode,
				helperBootId: null,
				services: { app: image },
				companionReadiness: {},
				companionBootIds: mode === "qualify" ? null : {},
			};
			await expect(
				verify(await signed(empty), { env: "production", mode }),
			).resolves.toMatchObject({ companionReadiness: {} });
			await expect(
				verify(
					await signed({
						...empty,
						companionReadiness: challenge.companionReadiness,
					}),
					{ env: "production", mode },
				),
			).rejects.toThrow("qualification_auth_invalid");
		},
	);
	it("does not replace a receipt when the readiness declaration changes", async () => {
		const { deps } = rig();
		await qualifyRelease(challenge, deps, signal());
		await expect(
			qualifyRelease(
				{
					...challenge,
					companionReadiness: {
						"paper-trader": { port: 9100, path: "/different-ready" },
					},
				},
				deps,
				signal(),
			),
		).rejects.toThrow("qualification_subject_stale");
		expect(deps.place).toHaveBeenCalledTimes(1);
	});
	it.each(["path", "port", "time", "status"])(
		"refuses unobserved or mismatched readiness %s",
		async (field) => {
			const { deps } = rig();
			const observed = {
				buildSha: sha,
				bootId: "boot-a",
				ready: {
					port: 9100,
					path: "/healthz",
					status: 200,
					observedAt: now.toISOString(),
				},
			};
			const patch =
				field === "path"
					? { path: "/other" }
					: field === "port"
						? { port: 9101 }
						: field === "status"
							? { status: 503 }
							: { observedAt: new Date(now.getTime() - 1).toISOString() };
			deps.helper = vi.fn(async () => ({
				...observed,
				ready: { ...observed.ready, ...patch },
			})) as QualificationDependencies["helper"];
			await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow();
			expect(deps.claim).not.toHaveBeenCalled();
			expect(deps.place).not.toHaveBeenCalled();
		},
	);
});

function observedFetch(
	boot: () => string,
	readyStatus: () => number = () => 200,
) {
	return vi.fn<typeof fetch>(async (input, init) => {
		expect(init?.redirect).toBe("error");
		expect(init?.cache).toBe("no-store");
		expect(init?.headers).toBeUndefined();
		expect(new URL(String(input)).origin).toBe("http://paper-trader:9100");
		return new URL(String(input)).pathname === "/version"
			? Response.json({ buildSha: sha, bootId: boot() })
			: new Response(null, { status: readyStatus() });
	});
}
describe("actual private companion readiness transport", () => {
	it("uses the signed path on the configured private host before/after work and fresh readback", async () => {
		const { deps, state } = rig();
		const native = observedFetch(() => state.boot);
		vi.stubGlobal("fetch", native);
		try {
			deps.helper = (actionSignal, readiness) =>
				observePaperCompanion(
					"http://paper-trader:9100",
					readiness,
					actionSignal,
					deps.now,
				);
			const declared = {
				...challenge,
				companionReadiness: {
					"paper-trader": { port: 9100, path: "/declared-ready" },
				},
			};
			const actionSignal = signal();
			const first = await qualifyRelease(declared, deps, actionSignal);
			expect(first.companions).toEqual({
				"paper-trader": {
					buildSha: sha,
					bootId: "boot-a",
					ready: {
						port: 9100,
						path: "/declared-ready",
						status: 200,
						observedAt: now.toISOString(),
					},
				},
			});
			expect(first.helper).toEqual({
				service: "paper-trader",
				buildSha: sha,
				bootId: "boot-a",
			});
			const later = new Date(now.getTime() + 1000);
			deps.now = () => later;
			const fresh = await qualifyRelease(
				{
					...declared,
					mode: "readback",
					helperBootId: "boot-a",
					companionBootIds: { "paper-trader": "boot-a" },
				},
				deps,
				actionSignal,
			);
			expect(fresh.companions["paper-trader"]?.ready.observedAt).toBe(
				later.toISOString(),
			);
			expect(
				native.mock.calls.map(([url]) => new URL(String(url)).pathname),
			).toEqual(
				Array.from({ length: 4 }, () => [
					"/version",
					"/declared-ready",
					"/version",
				]).flat(),
			);
			expect(deps.place).toHaveBeenCalledTimes(1);
			expect(deps.cancel).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("refuses a newly signed failing readiness endpoint even when version and default readiness work", async () => {
		const { deps, state } = rig();
		const native = observedFetch(() => state.boot);
		native.mockImplementation(async (input) =>
			new URL(String(input)).pathname === "/fails"
				? new Response(null, { status: 503 })
				: new URL(String(input)).pathname === "/version"
					? Response.json({ buildSha: sha, bootId: state.boot })
					: new Response(null, { status: 200 }),
		);
		vi.stubGlobal("fetch", native);
		try {
			deps.helper = (actionSignal, readiness) =>
				observePaperCompanion(
					"http://paper-trader:9100",
					readiness,
					actionSignal,
					deps.now,
				);
			await qualifyRelease(challenge, deps, signal());
			const calls = native.mock.calls.length;
			await expect(
				qualifyRelease(
					{
						...challenge,
						mode: "readback",
						helperBootId: "boot-a",
						companionBootIds: { "paper-trader": "boot-a" },
						companionReadiness: {
							"paper-trader": { port: 9100, path: "/fails" },
						},
					},
					deps,
					signal(),
				),
			).rejects.toThrow("companion_readiness_failed");
			expect(
				native.mock.calls
					.slice(calls)
					.map(([url]) => new URL(String(url)).pathname),
			).toEqual(["/version", "/fails"]);
			expect(deps.place).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("refuses readiness that fails after useful work or on a fresh readback", async () => {
		const { deps, state } = rig();
		let ready = true;
		vi.stubGlobal(
			"fetch",
			observedFetch(
				() => state.boot,
				() => (ready ? 200 : 503),
			),
		);
		try {
			deps.helper = (actionSignal, readiness) =>
				observePaperCompanion(
					"http://paper-trader:9100",
					readiness,
					actionSignal,
					deps.now,
				);
			const save = deps.save;
			deps.save = async (...args) => {
				await save(...args);
				if (args[0].status === "canceled") ready = false;
			};
			await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
				"companion_readiness_failed",
			);
			await expect(
				qualifyRelease(
					{
						...challenge,
						mode: "readback",
						helperBootId: "boot-a",
						companionBootIds: { "paper-trader": "boot-a" },
					},
					deps,
					signal(),
				),
			).rejects.toThrow("companion_readiness_failed");
			expect(deps.place).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("refuses a boot change across the actual readiness request", async () => {
		let version = 0;
		vi.stubGlobal(
			"fetch",
			observedFetch(() => (++version === 1 ? "boot-a" : "boot-b")),
		);
		try {
			await expect(
				observePaperCompanion(
					"http://paper-trader:9100",
					{ port: 9100, path: "/healthz" },
					signal(),
					() => now,
				),
			).rejects.toThrow("helper_identity_changed");
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it.each(["headers", "body"] as const)(
		"cancels native observation stalled at %s through the same operation signal",
		async (stage) => {
			const controller = new AbortController();
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let released = false;
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async (_url, init) => {
					const blocked = () =>
						new Promise<never>((_, reject) => {
							expect(init?.signal).toBeInstanceOf(AbortSignal);
							init?.signal?.addEventListener(
								"abort",
								() => {
									released = true;
									reject(init.signal?.reason);
								},
								{ once: true },
							);
							entered();
						});
					return stage === "headers"
						? blocked()
						: ({ status: 200, json: blocked } as Response);
				}),
			);
			try {
				const observed = observePaperCompanion(
					"http://paper-trader:9100",
					{ port: 9100, path: "/healthz" },
					controller.signal,
					() => now,
				);
				const rejection = expect(observed).rejects.toThrow("deadline");
				await started;
				controller.abort(new Error("deadline"));
				await rejection;
				expect(released).toBe(true);
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
	it.each([
		["http://paper-trader:9101", { port: 9100, path: "/healthz" }],
		["http://paper-trader:9100", { port: 9101, path: "/healthz" }],
		[
			"http://paper-trader:9100",
			{ port: 9100, path: "//external.invalid/healthz" },
		],
		["http://paper-trader:9100/other", { port: 9100, path: "/healthz" }],
	] as const)(
		"rejects port or path disagreement before private HTTP: %s %j",
		async (binding, readiness) => {
			const native = vi.fn();
			vi.stubGlobal("fetch", native);
			try {
				await expect(
					observePaperCompanion(binding, readiness, signal(), () => now),
				).rejects.toThrow();
				expect(native).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
	it("refuses redirects from the declared readiness endpoint", async () => {
		const { deps, state } = rig();
		vi.stubGlobal(
			"fetch",
			observedFetch(
				() => state.boot,
				() => 302,
			),
		);
		try {
			deps.helper = (actionSignal, readiness) =>
				observePaperCompanion(
					"http://paper-trader:9100",
					readiness,
					actionSignal,
					deps.now,
				);
			await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow(
				"companion_readiness_failed",
			);
			expect(deps.place).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("production companion exclusion", () => {
	it.each(["qualify", "readback"] as const)(
		"returns not_declared and no companion observations in %s",
		async (mode) => {
			const { qualifyDeployment } = await import(
				"@/app/_facades/deploy-qualification.server"
			);
			qualificationComposition.resolve.mockClear();
			const result = await qualifyDeployment(
				{
					...challenge,
					env: "production",
					services: { app: image },
					mode,
					helperBootId: null,
					companionReadiness: {},
					companionBootIds: mode === "qualify" ? null : {},
				},
				signal(),
				Date.now() + 19000,
			);
			expect(result).toMatchObject({
				status: "not_declared",
				companions: {},
				services: { app: image },
			});
			expect(result.helper).toBeUndefined();
			expect(result.evidenceId).toBeUndefined();
			expect(qualificationComposition.resolve).not.toHaveBeenCalled();
		},
	);
});

it("rejects an empty-name companion even when production expects zero keys", async () => {
  await expect(verify(await signed({ ...challenge, env: "production", services: { app: image }, companionReadiness: { "": { port: 9100, path: "/healthz" } } }), { env: "production" })).rejects.toThrow("qualification_auth_invalid");
});

it("the native observation budget also cancels a stalled declared readiness request", async () => {
  const actionSignal = signal();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let released = false;
  const native = vi.fn<typeof fetch>(async (url, init) => {
    if (new URL(String(url)).pathname === "/version") return Response.json({ buildSha: sha, bootId: "boot-a" });
    expect(new URL(String(url)).pathname).toBe("/declared-ready");
    return new Promise<never>((_, reject) => {
      init?.signal?.addEventListener("abort", () => { released = true; reject(init.signal?.reason); }, { once: true });
      entered();
    });
  });
  vi.stubGlobal("fetch", native);
  try {
    const result = observePaperCompanion("http://paper-trader:9100", { port: 9100, path: "/declared-ready" }, actionSignal, () => now);
    const rejected = expect(result).rejects.toThrow();
    await started;
    await rejected;
    expect(released).toBe(true);
    expect(actionSignal.aborted).toBe(false);
    expect(native.mock.calls).toHaveLength(2);
    expect(native.mock.calls[0]?.[1]?.signal).toBe(native.mock.calls[1]?.[1]?.signal);
  } finally { vi.unstubAllGlobals(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function deadlineRoute(deps: QualificationDependencies & { dispose(): Promise<void> }, requestSignal?: AbortSignal, beforeImport?: Promise<void>) {
  qualificationComposition.env.mockReturnValue({
    AUTH_SECRET: secret, DEPLOY_ENVIRONMENT: challenge.env, APP_BUILD_SHA: sha,
    PAPER_SIDECAR_URL: "http://paper-trader:9100",
  });
  qualificationComposition.resolve.mockReturnValue(deps);
  routeLog.info.mockClear();
  routeLog.warn.mockClear();
  await beforeImport;
  const { POST } = await import("@/app/api/v1/deploy/qualification/route");
  return POST(new NextRequest("https://poly.invalid/api/v1/deploy/qualification", {
    method: "POST", headers: { authorization: await signed(), "content-type": "application/json" },
    body: JSON.stringify({ mode: "qualify" }), ...(requestSignal ? { signal: requestSignal } : {}),
  }));
}

describe("whole qualification lifetime including disposal", () => {
  it.each(["late", "never", "reject"])("fails by 19 seconds while %s disposal remains owned; replay never dispatches", async (completion) => {
    vi.useFakeTimers({ now });
    const { deps, state } = rig();
    const closing = deferred<void>();
    const disposing = deferred<void>();
    const check = deps.checkFixture;
    const started = deferred<void>();
    deps.checkFixture = async () => {
      started.resolve();
      await new Promise(resolve => setTimeout(resolve, 18000));
      await check();
    };
    const dispose = vi.fn(() => { disposing.resolve(); return closing.promise; });
    let settled = false;
    const response = deadlineRoute({ ...deps, dispose }).then(value => { settled = true; return value; });
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(18000);
      await disposing.promise;
      expect(state.row).toMatchObject({ status: "canceled", order_id: "venue-order-1" });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled, "response must not await native close beyond the action bound").toBe(true);
      const failed = await response;
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: "qualification_timeout" });
      expect(routeLog.info).not.toHaveBeenCalled();
      expect(routeLog.warn).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      if (completion === "late") closing.resolve();
      if (completion === "reject") closing.reject(new Error("native close failed later"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(routeLog.info).not.toHaveBeenCalled();
      expect(deps.place).toHaveBeenCalledTimes(1);
      await qualifyRelease(challenge, { ...deps, checkFixture: check }, signal());
      expect(deps.place).toHaveBeenCalledTimes(1);
      expect(deps.cancel).toHaveBeenCalledTimes(1);
    } finally {
      closing.resolve();
      await response;
      vi.useRealTimers();
    }
  });

  it("bounds failed useful work even if its finally disposal never settles", async () => {
    vi.useFakeTimers({ now });
    const { deps } = rig();
    deps.checkFixture = async () => { throw new Error("fixture refused"); };
    const disposing = deferred<void>();
    const closing = deferred<void>();
    const dispose = vi.fn(() => { disposing.resolve(); return closing.promise; });
    let settled = false;
    const response = deadlineRoute({ ...deps, dispose }).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await disposing.promise;
      await vi.advanceTimersByTimeAsync(19000);
      expect(settled).toBe(true);
      expect((await response).status).toBe(503);
      expect(routeLog.info).not.toHaveBeenCalled();
      expect(deps.claim).not.toHaveBeenCalled();
      expect(deps.place).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      closing.resolve();
      await response;
      vi.useRealTimers();
    }
  });

  it("cannot grant dispatch authority to a claim that completes after timeout", async () => {
    vi.useFakeTimers({ now });
    const { deps } = rig();
    const committed = deferred<void>();
    const claiming = deferred<void>();
    const claim = deps.claim;
    deps.claim = async (...args) => {
      const winner = await claim(...args);
      claiming.resolve();
      await committed.promise;
      return winner;
    };
    const dispose = vi.fn(async () => {});
    let settled = false;
    const response = deadlineRoute({ ...deps, dispose }).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await claiming.promise;
      await vi.advanceTimersByTimeAsync(19000);
      expect(settled).toBe(true);
      expect((await response).status).toBe(503);
      committed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(deps.place).not.toHaveBeenCalled();
      await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow("qualification_receipt_missing");
      expect(deps.place).not.toHaveBeenCalled();
      expect(routeLog.info).not.toHaveBeenCalled();
    } finally {
      committed.resolve();
      await response;
      vi.useRealTimers();
    }
  });

  it.each(["clock", "abort"])("rejects success after disposal on %s without waiting for a timer callback", async (expiry) => {
    vi.useFakeTimers({ now });
    const { deps } = rig();
    const controller = new AbortController();
    const dispose = vi.fn(async () => {
      if (expiry === "clock") vi.setSystemTime(now.getTime() + 19001);
      else controller.abort(new Error("request gone"));
    });
    try {
      const response = await deadlineRoute({ ...deps, dispose }, controller.signal);
      expect(response.status).toBe(503);
      expect(routeLog.info).not.toHaveBeenCalled();
      expect(deps.place).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

it("fences response serialization immediately before any successful publication", async () => {
  vi.useFakeTimers({ now });
  const { deps } = rig();
  const json = NextResponse.json;
  const serialize = vi.spyOn(NextResponse, "json").mockImplementationOnce((...args) => {
    const response = json(...args);
    vi.setSystemTime(now.getTime() + 19001); // Timers have not fired.
    return response;
  });
  try {
    const response = await deadlineRoute({ ...deps, dispose: async () => {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "qualification_timeout" });
    expect(routeLog.info).not.toHaveBeenCalled();
  } finally { serialize.mockRestore(); vi.useRealTimers(); }
});

it("bounds admission waiting and prevents work after authentication completes late", async () => {
  const facade = await import("@/app/_facades/deploy-qualification.server");
  const admission = deferred<QualificationChallenge>();
  const entered = deferred<void>();
  const authenticate = vi.spyOn(facade, "authenticateQualification").mockImplementation(() => {
    entered.resolve();
    return admission.promise;
  });
  vi.useFakeTimers({ now });
  const { deps } = rig();
  qualificationComposition.resolve.mockClear();
  let settled = false;
  const response = deadlineRoute({ ...deps, dispose: async () => {} }).then(value => { settled = true; return value; });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(19000);
    expect(settled).toBe(true);
    expect((await response).status).toBe(503);
    admission.resolve(challenge);
    await vi.advanceTimersByTimeAsync(0);
    expect(qualificationComposition.resolve).not.toHaveBeenCalled();
    expect(deps.place).not.toHaveBeenCalled();
    expect(routeLog.info).not.toHaveBeenCalled();
  } finally { admission.resolve(challenge); await response; authenticate.mockRestore(); vi.useRealTimers(); }
});

it("keeps JWT expiry as admission policy and succeeds when required disposal completes inside the action bound", async () => {
  vi.useFakeTimers({ now: now.getTime() + 59000 });
  const { deps } = rig();
  const disposing = deferred<void>();
  const closing = deferred<void>();
  const dispose = vi.fn(() => { disposing.resolve(); return closing.promise; });
  const response = deadlineRoute({ ...deps, dispose });
  try {
    await disposing.promise;
    await vi.advanceTimersByTimeAsync(2000); // JWT is expired, admitted action still has 17s.
    closing.resolve();
    const success = await response;
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ status: "qualified", releaseId: challenge.releaseId });
    expect(routeLog.info).toHaveBeenCalledTimes(1);
    expect(routeLog.warn).not.toHaveBeenCalled();
    expect(deps.place).toHaveBeenCalledTimes(1);
  } finally { closing.resolve(); await response; vi.useRealTimers(); }
});

it("bounds facade disposal for direct callers even without a route-owned abort timer", async () => {
  const { qualifyDeployment } = await import("@/app/_facades/deploy-qualification.server");
  vi.useFakeTimers({ now });
  const { deps } = rig();
  const closing = deferred<void>();
  const disposing = deferred<void>();
  qualificationComposition.env.mockReturnValue({ PAPER_SIDECAR_URL: "http://paper-trader:9100" });
  const dispose = vi.fn(() => { disposing.resolve(); return closing.promise; });
  qualificationComposition.resolve.mockReturnValue({ ...deps, dispose });
  let settled = false;
  const action = qualifyDeployment(challenge, signal(), Date.now() + 19000).finally(() => { settled = true; });
  const rejected = expect(action).rejects.toThrow("qualification_timeout");
  try {
    await disposing.promise;
    await vi.advanceTimersByTimeAsync(19000);
    expect(settled).toBe(true);
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(qualificationComposition.resolve.mock.lastCall?.[2].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { closing.resolve(); await rejected; vi.useRealTimers(); }
});

it("returns promptly on request cancellation while disposal remains pending", async () => {
  vi.useFakeTimers({ now });
  const { deps } = rig();
  const closing = deferred<void>();
  const disposing = deferred<void>();
  const controller = new AbortController();
  const dispose = vi.fn(() => { disposing.resolve(); return closing.promise; });
  const response = deadlineRoute({ ...deps, dispose }, controller.signal);
  try {
    await disposing.promise;
    controller.abort(new Error("request canceled"));
    const failed = await response;
    expect(failed.status).toBe(503);
    expect(Date.now()).toBe(now.getTime());
    expect(routeLog.info).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { closing.resolve(); await response; vi.useRealTimers(); }
});


describe("actual dispatch checks absolute time without timer callbacks", () => {
  it.each(["place", "cancel", "getOrder", "listOpenOrders"])("fences %s fetch but preserves optional ordinary callers", async (operation) => {
    const { PaperAdapter } = await import("../../../../../packages/poly-market-provider/src/adapters/paper/paper.adapter");
    vi.useFakeTimers({ now });
    const native = vi.fn<typeof fetch>(async () => new Response("{}", { status: operation === "place" ? 503 : 404 }));
    const deadlineAt = now.getTime() + 1000;
    const config = { accountId: "fixture", startingBalanceUsdc: 100, fetchImpl: native };
    const call = (adapter: InstanceType<typeof PaperAdapter>) => operation === "place"
      ? adapter.placeOrder({ provider: "polymarket", market_id: "market", outcome: "YES", side: "BUY", size_usdc: 1, limit_price: 0.01, client_order_id: "client" })
      : operation === "cancel" ? adapter.cancelOrder("order") : operation === "getOrder" ? adapter.getOrder("order") : adapter.listOpenOrders();
    try {
      vi.setSystemTime(deadlineAt);
      await expect(call(new PaperAdapter({ ...config, actionDeadlineAt: deadlineAt }))).rejects.toThrow();
      expect(native).not.toHaveBeenCalled();
      await call(new PaperAdapter(config)).catch(() => {});
      expect(native).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each([1, 2, 3])("fences companion request %s after clock-only expiry", async (requestNumber) => {
    vi.useFakeTimers({ now });
    const controller = new AbortController();
    const deadlineAt = now.getTime() + 1000;
    let calls = 0;
    const native = vi.fn<typeof fetch>(async () => {
      calls += 1;
      const response = calls === 2 ? new Response(null) : Response.json({ buildSha: sha, bootId: "boot-a" });
      if (calls === requestNumber - 1) vi.setSystemTime(deadlineAt);
      return response;
    });
    vi.stubGlobal("fetch", native);
    if (requestNumber === 1) vi.setSystemTime(deadlineAt);
    try {
      await expect(observePaperCompanion("http://paper-trader:9100", { port: 9100, path: "/healthz" }, controller.signal, () => new Date(), deadlineAt)).rejects.toThrow();
      expect(controller.signal.aborted).toBe(false);
      expect(native).toHaveBeenCalledTimes(requestNumber - 1);
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it.each(["place", "cancel"])("retains reservation and readback-only replay after expired %s fetch", async (seam) => {
    const { PaperAdapter } = await import("../../../../../packages/poly-market-provider/src/adapters/paper/paper.adapter");
    vi.useFakeTimers({ now });
    const { deps, state } = rig();
    const native = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const deadlineAt = now.getTime() + 1000;
    const adapter = new PaperAdapter({ accountId: "fixture", startingBalanceUsdc: 100, fetchImpl: native, actionDeadlineAt: deadlineAt });
    if (seam === "place") {
      const claim = deps.claim;
      deps.claim = async (...args) => { const result = await claim(...args); vi.setSystemTime(deadlineAt); return result; };
      deps.place = vi.fn((intent) => adapter.placeOrder(intent));
    } else {
      const place = deps.place;
      deps.place = async (...args) => { const result = await place(...args); vi.setSystemTime(deadlineAt); return result; };
      deps.cancel = vi.fn((id) => adapter.cancelOrder(id));
    }
    try {
      expect((await deadlineRoute({ ...deps, dispose: async () => {} })).status).toBe(503);
      expect(native).not.toHaveBeenCalled();
      const reserved = state.row;
      expect(reserved?.status).toBe(seam === "place" ? "pending" : "open");
      await expect(qualifyRelease(challenge, deps, signal())).rejects.toThrow("qualification_receipt_missing");
      expect(state.row).toBe(reserved);
      expect(native).not.toHaveBeenCalled();
      expect(routeLog.info).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("exported POST entry owns logging prelude and combined budget", () => {
  it.each(["late", "never", "abort"])("bounds %s prelude and prevents late useful work", async (mode) => {
    vi.useFakeTimers({ now });
    const { deps } = rig();
    const gate = deferred<void>();
    const controller = new AbortController();
    const entered = deferred<void>();
    const importGate = deferred<void>();
    envelope.prelude.mockClear();
    envelope.prelude.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    envelope.start.mockClear(); envelope.end.mockClear(); envelope.count.mockClear();
    qualificationComposition.resolve.mockClear();
    let settled = false;
    const settledLatch = deferred<void>();
    const response = deadlineRoute({ ...deps, dispose: async () => {} }, controller.signal, importGate.promise).then(value => { settled = true; settledLatch.resolve(); return value; });
    try {
      expect(envelope.prelude).not.toHaveBeenCalled();
      importGate.resolve();
      await entered.promise;
      if (mode === "abort") controller.abort(new Error("request aborted in prelude"));
      else await vi.advanceTimersByTimeAsync(19000);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await settledLatch.promise;
      expect((await response).status).toBe(503);
      expect(qualificationComposition.resolve).not.toHaveBeenCalled();
      if (mode !== "never") { gate.resolve(); await vi.advanceTimersByTimeAsync(0); }
      expect(deps.place).not.toHaveBeenCalled();
      expect(qualificationComposition.resolve).not.toHaveBeenCalled();
      expect(routeLog.info).not.toHaveBeenCalled();
      expect(envelope.start).toHaveBeenCalledTimes(1);
      expect(envelope.end).toHaveBeenCalledTimes(1);
      expect(envelope.count).toHaveBeenCalledTimes(1);
    } finally { importGate.resolve(); gate.resolve(); await response; envelope.prelude.mockReset().mockResolvedValue(); vi.useRealTimers(); }
  });

  it("charges prelude plus feature waiting to the single entry deadline", async () => {
    vi.useFakeTimers({ now });
    const { deps } = rig();
    const entered = deferred<void>();
    envelope.prelude.mockImplementationOnce(() => { entered.resolve(); return new Promise(resolve => setTimeout(resolve, 3000)); });
    const working = deferred<number>();
    deps.checkFixture = async () => { working.resolve(Date.now()); await new Promise(resolve => setTimeout(resolve, 18000)); };
    let settled = false;
    const settledLatch = deferred<void>();
    const response = deadlineRoute({ ...deps, dispose: async () => {} }).then(value => { settled = true; settledLatch.resolve(); return value; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(3000);
      expect(await working.promise).toBe(now.getTime() + 3000);
      await vi.advanceTimersByTimeAsync(16000);
      expect(settled).toBe(true);
      await settledLatch.promise;
      expect((await response).status).toBe(503);
      expect(qualificationComposition.resolve.mock.lastCall?.[3]).toBe(now.getTime() + 19000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(deps.claim).not.toHaveBeenCalled();
      expect(deps.place).not.toHaveBeenCalled();
      expect(routeLog.info).not.toHaveBeenCalled();
    } finally { await vi.advanceTimersByTimeAsync(30000); await response; envelope.prelude.mockReset().mockResolvedValue(); vi.useRealTimers(); }
  });

  it("rejects invalid capability before DI logging/container and qualification work", async () => {
    vi.useFakeTimers({ now });
    envelope.legacy.mockClear(); qualificationComposition.resolve.mockClear();
    const { POST } = await import("@/app/api/v1/deploy/qualification/route");
    try {
      const response = await POST(new NextRequest("https://poly.invalid/api/v1/deploy/qualification", { method: "POST", headers: { authorization: "Bearer invalid" } }));
      expect(response.status).toBe(401);
      expect(envelope.legacy).not.toHaveBeenCalled();
      expect(qualificationComposition.resolve).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});


describe("exported request bounds actual lazy qualification module initialization", () => {
  it.each(["late", "never", "abort"])("bounds %s module initialization without resetting deadline", async (completion) => {
    vi.useFakeTimers({ now });
    const { deps } = rig();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const controller = new AbortController();
    vi.resetModules();
    vi.doMock("@/bootstrap/qualification", async () => {
      entered.resolve();
      await gate.promise;
      return { resolveQualificationDependencies: qualificationComposition.resolve };
    });
    qualificationComposition.resolve.mockClear();
    let settled = false;
    const response = deadlineRoute({ ...deps, dispose: async () => {} }, controller.signal).then(value => { settled = true; return value; });
    try {
      await entered.promise;
      if (completion === "abort") controller.abort(new Error("aborted during initialization"));
      else await vi.advanceTimersByTimeAsync(19000);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect((await response).status).toBe(503);
      if (completion !== "never") { gate.resolve(); await vi.advanceTimersByTimeAsync(0); }
      expect(qualificationComposition.resolve).not.toHaveBeenCalled();
      expect(deps.place).not.toHaveBeenCalled();
      expect(routeLog.info).not.toHaveBeenCalled();
    } finally {
      gate.resolve(); await response;
      vi.doMock("@/bootstrap/qualification", () => ({ resolveQualificationDependencies: qualificationComposition.resolve }));
      vi.resetModules(); vi.useRealTimers();
    }
  });

  it("does not even load qualification dependencies for an invalid capability", async () => {
    vi.useFakeTimers({ now });
    const loading = vi.fn(() => { throw new Error("unauthenticated dependency load"); });
    vi.resetModules(); vi.doMock("@/bootstrap/qualification", loading);
    try {
      const { POST } = await import("@/app/api/v1/deploy/qualification/route");
      const response = await POST(new NextRequest("https://poly.invalid/api/v1/deploy/qualification", { method: "POST", headers: { authorization: "Bearer invalid" } }));
      expect(response.status).toBe(401);
      expect(loading).not.toHaveBeenCalled();
    } finally {
      vi.doMock("@/bootstrap/qualification", () => ({ resolveQualificationDependencies: qualificationComposition.resolve }));
      vi.resetModules(); vi.useRealTimers();
    }
  });
});


it("does not invoke native fetch when authorization logging crosses the deadline before placement", async () => {
  const { PaperAdapter } = await import("../../../../../packages/poly-market-provider/src/adapters/paper/paper.adapter");
  vi.doMock("@cogni/poly-market-provider/adapters/paper", () => ({ PaperAdapter }));
  vi.doMock("@cogni/poly-market-provider/adapters/polymarket", () => ({
    PolymarketClobAdapter: class { async getMarketConstraints() { throw new Error("unused read-only source"); } },
  }));
  const { createPolyTradeExecutorFactory } = await import("@/bootstrap/capabilities/poly-trade-executor");
  vi.useFakeTimers({ now });
  const deadlineAt = now.getTime() + 1000;
  const controller = new AbortController();
  const native = vi.fn<typeof fetch>(async () => { throw new Error("late native dispatch"); });
  vi.stubGlobal("fetch", native);
  const logger = {
    child: () => logger, debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    info: vi.fn((fields: { event?: string }) => { if (fields.event === "poly.mirror.place.tenant") vi.setSystemTime(deadlineAt); }),
  };
  const authorizeIntent = vi.fn(async () => ({ ok: true as const, grantId: "real-authority-port-grant" }));
  try {
    const factory = createPolyTradeExecutorFactory({
      logger: logger as unknown as import("pino").Logger,
      metrics: { incr: vi.fn(), observeDurationMs: vi.fn() },
      resolveExecutionVenue: async () => "paper",
      paperVenue: {
        resolveAccount: async () => ({ connectionId: "fixture", funderAddress: "0x1111111111111111111111111111111111111111", seedUsdc: "100" }),
        authorizeIntent,
      },
    });
    const executor = await factory.getBoundedPaperExecutor("fixture", controller.signal, { paperActionDeadlineAt: deadlineAt, resolveExecutionVenue: async () => "paper" });
    await expect(executor.placeIntent({ provider: "polymarket", market_id: "market", outcome: "YES", side: "BUY", size_usdc: 1, limit_price: 0.01, client_order_id: "proof" })).rejects.toThrow("deadline");
    expect(authorizeIntent).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
    expect(native).not.toHaveBeenCalled();
  } finally { vi.doUnmock("@cogni/poly-market-provider/adapters/paper"); vi.doUnmock("@cogni/poly-market-provider/adapters/polymarket"); vi.unstubAllGlobals(); vi.useRealTimers(); }
});


describe("qualification feature policy through injected resources", () => {
  it("observes the declared path and stable identity with one injected observation lifetime", async () => {
    const actionSignal = signal();
    const get = vi.fn(async (path: string) => path === "/version"
      ? Response.json({ buildSha: sha, bootId: "boot-port" })
      : new Response(null, { status: 200 }));
    const open = vi.fn((requestSignal: AbortSignal) => ({ signal: requestSignal, get }));
    const result = await observeCompanion({ binding: "http://paper-trader:9100", open }, { port: 9100, path: "/declared-ready" }, actionSignal, () => now);
    expect(open).toHaveBeenCalledExactlyOnceWith(actionSignal);
    expect(get.mock.calls.map(([path]) => path)).toEqual(["/version", "/declared-ready", "/version"]);
    expect(result).toEqual({ buildSha: sha, bootId: "boot-port", ready: { port: 9100, path: "/declared-ready", status: 200, observedAt: now.toISOString() } });
  });

  it("rejects an invalid configured binding before opening the injected resource", async () => {
    const open = vi.fn(() => { throw new Error("invalid resource opened"); });
    await expect(observeCompanion({ binding: "http://paper-trader:9200", open }, { port: 9100, path: "/healthz" }, signal(), () => now)).rejects.toThrow("paper_binding_invalid");
    expect(open).not.toHaveBeenCalled();
  });

  it("selects the active future YES condition through discovery and rejects an unavailable market", async () => {
    const valid: NormalizedMarket = {
      id: "prediction-market:polymarket:source", provider: "polymarket", sourceId: "source", title: "proof", category: "test", probabilityBps: 5000, spreadBps: 1, volume: 1,
      outcomes: [{ label: "Yes", probabilityBps: 5000 }], resolvesAt: "2099-01-01T00:00:00Z", active: true, attributes: { conditionId: "condition" }, updatedAt: now.toISOString(),
    };
    const invalid = [
      { ...valid, active: false },
      { ...valid, resolvesAt: "2000-01-01T00:00:00Z" },
      { ...valid, attributes: {} },
      { ...valid, outcomes: [{ label: "NO", probabilityBps: 5000 }] },
    ];
    const discover = vi.fn(async (_signal: AbortSignal) => [...invalid, valid]);
    const select = createQualificationIntentSelector(discover);
    const actionSignal = signal();
    expect(await select(actionSignal)).toEqual({ market_id: "prediction-market:polymarket:condition", outcome: "Yes" });
    expect(discover).toHaveBeenCalledExactlyOnceWith(actionSignal);
    discover.mockResolvedValue(invalid);
    await expect(select(actionSignal)).rejects.toThrow("qualification_market_unavailable");
  });

  it("refuses a late discovery result after caller abort", async () => {
    const controller = new AbortController();
    const select = createQualificationIntentSelector(async () => { controller.abort(new Error("caller aborted")); return []; });
    await expect(select(controller.signal)).rejects.toThrow("caller aborted");
  });
});
