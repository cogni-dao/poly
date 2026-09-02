// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/identity/operator-attested-binding`
 * Purpose: Proves nonce redemption and binding import share one transaction.
 * Scope: Transactional in-memory service DB mock; no real database.
 * Invariants: concurrent redemption has one winner; infrastructure failures
 *   roll nonce consumption back; terminal conflicts consume the nonce.
 * Side-effects: none
 * Links: src/features/identity/services/operator-attested-binding.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockCreateBinding = vi.fn();
const mockProviderLoginWhere = vi.fn().mockResolvedValue(undefined);
const mockProviderLoginSet = vi.fn(() => ({ where: mockProviderLoginWhere }));

let nonceConsumed = false;
let transactionTail: Promise<void> = Promise.resolve();

function makeNonceUpdate(staged: { consumed: boolean }) {
	return {
		set: vi.fn().mockReturnValue({
			where: vi.fn().mockReturnValue({
				returning: vi.fn(async () => {
					if (nonceConsumed || staged.consumed) return [];
					staged.consumed = true;
					return [{ id: "nonce-1" }];
				}),
			}),
		}),
	};
}

const mockDb = {
	transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
		let release!: () => void;
		const previous = transactionTail;
		transactionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		const staged = { consumed: false };
		let updateCount = 0;
		const tx = {
			query: { userBindings: { findFirst: mockFindFirst } },
			update: vi.fn(() => {
				updateCount += 1;
				return updateCount === 1
					? makeNonceUpdate(staged)
					: { set: mockProviderLoginSet };
			}),
		};

		try {
			const result = await callback(tx);
			if (staged.consumed) nonceConsumed = true;
			return result;
		} finally {
			release();
		}
	}),
};

vi.mock("@/adapters/server/identity/create-binding", () => ({
	createBindingInTransaction: (...args: unknown[]) =>
		mockCreateBinding(...args),
}));

import { DrizzleIdentityBindingRepository } from "@/adapters/server/identity/identity-binding.adapter";
import { createIdentityBindingService } from "@/features/identity/services/operator-attested-binding";

const PARAMS = {
	userId: "user-1",
	nonce: "nonce-1",
	githubId: "12345",
	githubLogin: "octocat",
	issuer: "https://hub.test.example",
	jti: "jti-abc",
	iat: 1_700_000_000,
};

function redeemAttestedGithubBinding(params: typeof PARAMS) {
	return createIdentityBindingService({
		repository: new DrizzleIdentityBindingRepository(mockDb as never),
		clock: { now: () => "2026-08-17T00:00:00.000Z" },
		createNonceId: () => "nonce-1",
	}).redeemGithubBinding(params);
}

beforeEach(() => {
	vi.clearAllMocks();
	nonceConsumed = false;
	transactionTail = Promise.resolve();
	mockCreateBinding.mockResolvedValue({ created: true, eventId: "event-1" });
});

describe("redeemAttestedGithubBinding", () => {
	it("commits already_bound and refreshes provider login", async () => {
		mockFindFirst.mockResolvedValue({ id: "b1", userId: "user-1" });

		expect(await redeemAttestedGithubBinding(PARAMS)).toBe("already_bound");
		expect(nonceConsumed).toBe(true);
		expect(mockCreateBinding).not.toHaveBeenCalled();
		expect(mockProviderLoginSet).toHaveBeenCalledWith({
			providerLogin: "octocat",
		});
	});

	it("commits terminal already_linked without re-pointing", async () => {
		mockFindFirst.mockResolvedValue({ id: "b1", userId: "other-user" });

		expect(await redeemAttestedGithubBinding(PARAMS)).toBe("already_linked");
		expect(nonceConsumed).toBe(true);
		expect(mockCreateBinding).not.toHaveBeenCalled();
		expect(mockProviderLoginSet).not.toHaveBeenCalled();
	});

	it("creates binding and evidence inside the nonce transaction", async () => {
		mockFindFirst
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ id: "b2", userId: "user-1" });

		expect(await redeemAttestedGithubBinding(PARAMS)).toBe("created");
		expect(nonceConsumed).toBe(true);
		expect(mockCreateBinding).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"github",
			"12345",
			expect.objectContaining({
				method: "operator_attestation",
				issuer: "https://hub.test.example",
				jti: "jti-abc",
			}),
		);
	});

	it("reports already_bound when a same-user binding wins the insert race", async () => {
		mockFindFirst
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ id: "b2", userId: "user-1" });
		mockCreateBinding.mockResolvedValue({ created: false, eventId: null });

		expect(await redeemAttestedGithubBinding(PARAMS)).toBe("already_bound");
		expect(nonceConsumed).toBe(true);
		expect(mockProviderLoginSet).toHaveBeenCalledWith({
			providerLogin: "octocat",
		});
	});

	it("allows only one winner across concurrent redemption attempts", async () => {
		mockFindFirst
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ id: "b2", userId: "user-1" });

		const results = await Promise.all([
			redeemAttestedGithubBinding(PARAMS),
			redeemAttestedGithubBinding(PARAMS),
		]);

		expect(results).toEqual(["created", "invalid_nonce"]);
		expect(mockCreateBinding).toHaveBeenCalledTimes(1);
	});

	it("rolls nonce consumption back on infrastructure failure", async () => {
		mockFindFirst
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ id: "b2", userId: "user-1" });
		mockCreateBinding
			.mockRejectedValueOnce(new Error("database unavailable"))
			.mockResolvedValueOnce({ created: true, eventId: "event-1" });

		await expect(redeemAttestedGithubBinding(PARAMS)).rejects.toThrow(
			"database unavailable",
		);
		expect(nonceConsumed).toBe(false);

		expect(await redeemAttestedGithubBinding(PARAMS)).toBe("created");
		expect(nonceConsumed).toBe(true);
	});
});
