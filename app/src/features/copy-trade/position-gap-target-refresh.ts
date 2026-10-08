// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Coalesces target-book refreshes across every tenant following one wallet.
 * Account-local planning remains independent after the shared refresh settles.
 */

import type {
	TargetBookProviderV1,
	TargetBookRefreshResultV1,
} from "@cogni/poly-market-provider";

type Waiter = {
	resolve: (result: TargetBookRefreshResultV1) => void;
};

type PendingRefresh = {
	full: boolean;
	dirty: Set<string>;
	waiters: Waiter[];
	running: boolean;
	inFlightKind: "dirty" | "full" | null;
};

export class PositionGapTargetRefreshCoordinator {
	private readonly pending = new Map<string, PendingRefresh>();

	constructor(private readonly provider: TargetBookProviderV1) {}

	/** Zero target-I/O cache read used by every 30s account-local timer. */
	readFresh(targetWallet: string) {
		return this.provider.readFresh(targetWallet);
	}

	refreshFull(targetWallet: string): Promise<TargetBookRefreshResultV1> {
		return this.enqueue(targetWallet, true, []);
	}

	refreshDirty(
		targetWallet: string,
		conditionIds: readonly string[],
	): Promise<TargetBookRefreshResultV1> {
		return this.enqueue(targetWallet, false, conditionIds);
	}

	private enqueue(
		targetWallet: string,
		full: boolean,
		conditionIds: readonly string[],
	): Promise<TargetBookRefreshResultV1> {
		const key = targetWallet.toLowerCase();
		const entry = this.pending.get(key) ?? {
			full: false,
			dirty: new Set<string>(),
			waiters: [],
			running: false,
			inFlightKind: null,
		};
		// A second account requesting the same full refresh while it is already
		// on the wire joins that generation. It must not manufacture another
		// provider call after the first settles.
		if (!(full && entry.inFlightKind === "full")) entry.full ||= full;
		for (const conditionId of conditionIds) {
			entry.dirty.add(conditionId.toLowerCase());
		}
		this.pending.set(key, entry);
		const promise = new Promise<TargetBookRefreshResultV1>((resolve) => {
			entry.waiters.push({ resolve });
		});
		if (!entry.running) {
			entry.running = true;
			queueMicrotask(() => void this.drain(key, entry));
		}
		return promise;
	}

	private async drain(key: string, entry: PendingRefresh): Promise<void> {
		let result: TargetBookRefreshResultV1 = {
			published: false,
			reason: "missing_snapshot",
			retainedSnapshotId: null,
		};
		try {
			while (entry.full || entry.dirty.size > 0) {
				const full = entry.full;
				const dirty = [...entry.dirty].sort();
				entry.full = false;
				entry.dirty.clear();
				entry.inFlightKind = full ? "full" : "dirty";
				result = full
					? await this.provider.refreshFull(key)
					: await this.provider.refreshDirty(key, dirty);
				entry.inFlightKind = null;
			}
		} catch {
			result = {
				published: false,
				reason: "upstream",
				retainedSnapshotId: this.provider.readFresh(key)?.snapshotId ?? null,
			};
		} finally {
			entry.inFlightKind = null;
			const waiters = entry.waiters.splice(0, entry.waiters.length);
			entry.running = false;
			this.pending.delete(key);
			for (const waiter of waiters) waiter.resolve(result);
		}
	}
}
