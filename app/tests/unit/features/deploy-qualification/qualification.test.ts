// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Port-level behavioral proof: dispatch ownership, unknown outcomes and stale runtime subjects. */
import { hkdfSync } from "node:crypto";
import type { OrderIntent, OrderReceipt } from "@cogni/poly-market-provider";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { observePaperCompanion } from "@/bootstrap/qualification-companion";
import type { QualificationChallenge } from "@/contracts/deploy.qualification.v1.contract";
import { verifyQualificationChallenge } from "@/features/deploy-qualification/challenge";
import {
	type QualificationDependencies,
	qualificationOperationIds,
	qualifyRelease,
} from "@/features/deploy-qualification/service";

const qualificationComposition = vi.hoisted(() => ({ resolve: vi.fn(), env: vi.fn(() => ({})) }));
vi.mock("@/bootstrap/qualification", () => ({ resolveQualificationDependencies: qualificationComposition.resolve }));
vi.mock("@/shared/env", () => ({ serverEnv: qualificationComposition.env }));
vi.mock("@/shared/config/repoSpec.server", () => ({ getNodeId: () => "4b06359a-a859-4399-888e-a8c7a6696f7e" }));

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
