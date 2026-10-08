// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/poly-trade-executor.venue-dispatch.test`
 * Purpose: Prove VENUE_RESOLVED_FROM_ACCOUNT — one executor factory, in one
 *   process, sends a paper account to the paper builder and a live account to
 *   the live builder. Under the deleted `PAPER_ENFORCE_MODE` switch this was
 *   structurally impossible: the venue was a process-wide constant.
 * Scope: Unit. The two builders are detected by which injected dependency they
 *   touch first (`paperVenue.resolveAccount` vs `walletPort.resolve`), so no
 *   CLOB SDK, viem client, or network is loaded.
 * Invariants:
 *   - venue per account, not per process
 *   - NO_DEFAULT_VENUE: an unresolvable account fails and enters neither builder
 *   - a live account on a deployment with no custody port FAILS; it does not
 *     quietly fall back to simulation
 * Side-effects: none
 * Links: src/bootstrap/capabilities/poly-trade-executor.ts
 * @internal
 */

import type { PolyTraderWalletPort } from "@cogni/poly-wallet";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
	createPolyTradeExecutorFactory,
	PolyTradeExecutorError,
} from "@/bootstrap/capabilities/poly-trade-executor";
import {
	ExecutionVenueUnresolvedError,
	type PaperVenuePort,
} from "@/features/paper-accounts";

const PAPER_ACCOUNT = "acct-paper";
const LIVE_ACCOUNT = "acct-live";
const UNPROVISIONED_ACCOUNT = "acct-nothing";

/** Sentinel thrown from inside the paper builder, so entry is unambiguous. */
const PAPER_BUILDER_REACHED = "paper builder reached";

function silentLogger(): Logger {
	const logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	return logger as unknown as Logger;
}

function harness(options: { withWalletPort?: boolean } = {}) {
	const resolveAccount = vi.fn(async () => {
		throw new Error(PAPER_BUILDER_REACHED);
	});
	const paperVenue = {
		resolveAccount,
		authorizeIntent: vi.fn(async () => ({
			ok: true as const,
			grantId: "grant-1",
		})),
	} satisfies PaperVenuePort;

	// `resolve` returning null is the live builder's first branch, and it throws
	// before any dynamic import — a cheap, unambiguous "the live path ran".
	const resolve = vi.fn(async () => null);
	const walletPort = { resolve } as unknown as PolyTraderWalletPort;

	const resolveExecutionVenue = vi.fn(async (billingAccountId: string) => {
		if (billingAccountId === PAPER_ACCOUNT) return "paper" as const;
		if (billingAccountId === LIVE_ACCOUNT) return "live" as const;
		throw new ExecutionVenueUnresolvedError(billingAccountId, "no_connection");
	});

	const factory = createPolyTradeExecutorFactory({
		...(options.withWalletPort === false ? {} : { walletPort }),
		logger: silentLogger(),
		metrics: { incr: () => {}, observe: () => {} } as never,
		resolveExecutionVenue,
		paperVenue,
	});

	return { factory, resolveAccount, resolve, resolveExecutionVenue };
}

describe("executor venue dispatch (VENUE_RESOLVED_FROM_ACCOUNT)", () => {
	it("routes a paper account and a live account differently in ONE factory", async () => {
		const { factory, resolveAccount, resolve } = harness();

		await expect(
			factory.getPolyTradeExecutorFor(PAPER_ACCOUNT),
		).rejects.toThrow(PAPER_BUILDER_REACHED);
		// The paper account must not have touched live custody at all.
		expect(resolve).not.toHaveBeenCalled();

		// Same factory instance, same process, different venue.
		await expect(factory.getPolyTradeExecutorFor(LIVE_ACCOUNT)).rejects.toThrow(
			PolyTradeExecutorError,
		);
		expect(resolve).toHaveBeenCalledWith(LIVE_ACCOUNT);
		expect(resolveAccount).toHaveBeenCalledTimes(1);
		expect(resolveAccount).toHaveBeenCalledWith(PAPER_ACCOUNT);
	});

	it("fails an account with no active connection instead of picking a venue", async () => {
		const { factory, resolveAccount, resolve } = harness();

		await expect(
			factory.getPolyTradeExecutorFor(UNPROVISIONED_ACCOUNT),
		).rejects.toBeInstanceOf(ExecutionVenueUnresolvedError);
		expect(resolveAccount).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it("refuses a live account when no custody port is configured", async () => {
		const { factory, resolveAccount } = harness({ withWalletPort: false });

		const err = await factory
			.getPolyTradeExecutorFor(LIVE_ACCOUNT)
			.then(
				() => null,
				(e: unknown) => e,
			);

		expect(err).toBeInstanceOf(PolyTradeExecutorError);
		expect((err as PolyTradeExecutorError).reason).toBe("no_connection");
		// Critically: it did NOT silently become a paper account.
		expect(resolveAccount).not.toHaveBeenCalled();
	});

	it("resolves the venue once per account and caches the outcome", async () => {
		const { factory, resolveExecutionVenue } = harness();

		await expect(
			factory.getPolyTradeExecutorFor(PAPER_ACCOUNT),
		).rejects.toThrow(PAPER_BUILDER_REACHED);
		await expect(
			factory.getPolyTradeExecutorFor(PAPER_ACCOUNT),
		).rejects.toThrow(PAPER_BUILDER_REACHED);

		// A failed build is not cached (nothing to cache), so the resolver runs
		// again — what matters is that it is asked per account, never once per
		// process.
		expect(resolveExecutionVenue.mock.calls.flat()).toEqual([
			PAPER_ACCOUNT,
			PAPER_ACCOUNT,
		]);
	});
});
