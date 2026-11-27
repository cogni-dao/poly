// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exercise the actual published lease projection through Poly composition. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toWorkItemId, type WorkItemLeasePort } from "@cogni/work-items";
import {
	workItemsHeartbeatOperation,
	workItemsReleaseOperation,
} from "@cogni/node-contracts";

const { content } = vi.hoisted(() => ({
	content: {
		get: vi.fn(),
		patch: vi.fn(),
		list: vi.fn(),
		listRelations: vi.fn(),
		listSummaries: vi.fn(),
		listBoardColumns: vi.fn(),
	},
}));
vi.mock("@cogni/work-items/adapters/doltgres", async (original) => ({
	...(await original<object>()),
	DoltgresWorkItemAdapter: vi.fn(function ContentAdapter() {
		return content;
	}),
}));
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import { createPolyWorkItemAdapter } from "@/adapters/server/db/doltgres/work-items-adapter";

const id = toWorkItemId("task.5001");
const item = (itemId = id) => ({
	id: itemId,
	title: itemId,
	type: "task",
	status: "needs_triage",
	revision: 4,
});
const receipt = {
	id,
	runId: "run-1",
	leaseToken: "00000000-0000-4000-8000-000000000001",
	active: true,
	claimedAt: "2026-11-27T00:00:00Z",
	expiresAt: "2026-11-27T00:05:00Z",
	lastCommand: "implement",
};
const leases = {
	claim: vi.fn(),
	heartbeat: vi.fn(),
	release: vi.fn(),
	getMany: vi.fn(),
} satisfies WorkItemLeasePort;
const adapter = () => createPolyWorkItemAdapter({} as never, leases);

describe("Published operational leases in Poly", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		leases.getMany.mockResolvedValue(new Map());
	});

	it("projects exactly one page batch, removes old Dolt claims, never exposes tokens", async () => {
		content.list.mockResolvedValue({
			items: [
				item(),
				{ ...item(toWorkItemId("task.5002")), claimedByRun: "obsolete" },
			],
			pageInfo: { endCursor: null, hasMore: false },
		});
		leases.getMany.mockResolvedValue(new Map([[id, receipt]]));
		const result = await adapter().list({ limit: 2 });
		expect(leases.getMany).toHaveBeenCalledExactlyOnceWith([id, "task.5002"]);
		expect(result.items[0]).toMatchObject({
			claimedByRun: "run-1",
			revision: 4,
		});
		expect(result.items[1]).not.toHaveProperty("claimedByRun");
		expect(JSON.stringify(result)).not.toContain(receipt.leaseToken);
	});

	it("forwards summary and board bounds without querying leases", async () => {
		const store = adapter(),
			signal = new AbortController().signal;
		await store.listSummaries({ limit: 25 }, { signal, maxScanRows: 500 });
		await store.listBoardColumns?.({}, ["needs_design"], 20, { signal });
		expect(content.listSummaries).toHaveBeenCalledWith(
			{ limit: 25 },
			{ signal, maxScanRows: 500 },
		);
		expect(content.listBoardColumns).toHaveBeenCalledWith(
			{},
			["needs_design"],
			20,
			{ signal },
		);
		expect(leases.getMany).not.toHaveBeenCalled();
	});

	it("preserves bridge locking and content guidance resolver", () => {
		const entryResolver = { resolve: vi.fn() } as never;
		createPolyWorkItemAdapter({} as never, leases, undefined, {
			entryResolver,
		});
		expect(DoltgresWorkItemAdapter).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				entryResolver,
				idFloor: 5000,
				writerLockProtocol: "bridge",
			}),
		);
	});

	it("preserves patch reason, cites, revision and actor without a lease write", async () => {
		content.patch.mockResolvedValue(item());
		const input = {
			id,
			expectedRevision: 3,
			reason: "Document change",
			cites: [{ id: "work-item-artifacts" }],
			set: { title: "t" },
		};
		await adapter().patch(input, {
			actor: "agent-1",
			requestedBy: "requester",
			run: { id: "run-1", kind: "system_scheduled" },
		});
		expect(content.patch).toHaveBeenCalledWith(
			input,
			expect.objectContaining({ actor: "agent-1", requestedBy: "requester" }),
		);
		expect(leases.claim).not.toHaveBeenCalled();
		expect(leases.getMany).not.toHaveBeenCalled();
	});

	it("checks content existence for claim and returns only the owner receipt", async () => {
		content.get.mockResolvedValue(item());
		leases.claim.mockResolvedValue(receipt);
		const owner = {
			id,
			runId: "run-1",
			principalId: "principal",
			command: "implement",
		};
		expect(await adapter().claim(owner)).toEqual(receipt);
		expect(leases.claim).toHaveBeenCalledExactlyOnceWith(owner);
		content.get.mockResolvedValue(null);
		await expect(adapter().claim(owner)).rejects.toThrow("Work item not found");
		expect(leases.claim).toHaveBeenCalledTimes(1);
	});

	it("heartbeat and release require no Dolt read, even when content is unavailable", async () => {
		content.get.mockRejectedValue(new Error("Dolt unavailable"));
		leases.heartbeat.mockResolvedValue(receipt);
		leases.release.mockResolvedValue({ ...receipt, active: false });
		const owner = {
			id,
			runId: receipt.runId,
			principalId: "principal",
			leaseToken: receipt.leaseToken,
		};
		expect((await adapter().heartbeat(owner)).active).toBe(true);
		expect((await adapter().release(owner)).active).toBe(false);
		expect(content.get).not.toHaveBeenCalled();
		expect(leases.heartbeat).toHaveBeenCalledWith(owner);
		expect(leases.release).toHaveBeenCalledWith(owner);
	});

	it("wire contracts reject missing or malformed heartbeat and release tokens", () => {
		for (const operation of [
			workItemsHeartbeatOperation,
			workItemsReleaseOperation,
		]) {
			expect(operation.input.safeParse({ id, runId: "run-1" }).success).toBe(
				false,
			);
			expect(
				operation.input.safeParse({ id, runId: "run-1", leaseToken: "stale" })
					.success,
			).toBe(false);
			expect(
				operation.input.safeParse({
					id,
					runId: "run-1",
					leaseToken: receipt.leaseToken,
				}).success,
			).toBe(true);
			expect(operation.output.parse(receipt)).toEqual(receipt);
		}
	});
});
