// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { toUserId, userActor } from "@cogni/ids";
import type { PolyTraderWalletPort } from "@cogni/poly-wallet";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetWalletConnection,
  TARGET_QUIESCE_MS,
} from "@/features/wallet-recovery/reset-wallet-connection";
import type {
  PolyWalletResetState,
  PolyWalletResetStatePort,
} from "@/ports";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BILLING_ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-01T12:00:00.000Z");

const cleanState: PolyWalletResetState = {
  connection: {
    id: "connection-1",
    address: "0x1111111111111111111111111111111111111111",
    funderAddress: "0x2222222222222222222222222222222222222222",
  },
  unsettledOrderCount: 0,
  openPositionCount: 0,
  activeTargetCount: 0,
  latestTargetDisabledAt: null,
};

const inspect = vi.fn<PolyWalletResetStatePort["inspect"]>();
const disableActiveTargets =
  vi.fn<PolyWalletResetStatePort["disableActiveTargets"]>();
const revokeConnection =
  vi.fn<PolyWalletResetStatePort["revokeConnection"]>();
const getBalances =
  vi.fn<Pick<PolyTraderWalletPort, "getBalances">["getBalances"]>();
const getReprovisionWaitSeconds = vi.fn(async () => 300);

const deps = {
  state: { inspect, disableActiveTargets, revokeConnection },
  wallet: { getBalances },
  getReprovisionWaitSeconds,
  now: () => NOW,
};
const input = {
  actorId: userActor(toUserId(USER_ID)),
  userId: USER_ID,
  billingAccountId: BILLING_ACCOUNT_ID,
};

describe("resetWalletConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspect.mockResolvedValue(cleanState);
    disableActiveTargets.mockResolvedValue(0);
    revokeConnection.mockResolvedValue(2);
    getBalances.mockResolvedValue({
      address: cleanState.connection?.funderAddress as `0x${string}`,
      usdcE: 0,
      pusd: 0,
      pol: 0,
      errors: [],
    });
  });

  it("is idempotent when there is no active connection", async () => {
    inspect.mockResolvedValue({ ...cleanState, connection: null });

    const result = await resetWalletConnection(deps, input);

    expect(result.outcome).toBe("no_active_connection");
    expect(getBalances).not.toHaveBeenCalled();
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["unsettled_orders", { unsettledOrderCount: 1 }],
    ["open_positions", { openPositionCount: 1 }],
  ] as const)("blocks on %s", async (blockedReason, statePatch) => {
    inspect.mockResolvedValue({ ...cleanState, ...statePatch });

    const result = await resetWalletConnection(deps, input);

    expect(result).toMatchObject({ outcome: "blocked", blockedReason });
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it("fails closed when any balance read is unavailable", async () => {
    getBalances.mockResolvedValue({
      address: "0x2222222222222222222222222222222222222222",
      usdcE: null,
      pusd: 0,
      pol: 0,
      errors: ["polygon_rpc:timeout"],
    });

    const result = await resetWalletConnection(deps, input);

    expect(result).toMatchObject({
      outcome: "blocked",
      blockedReason: "balance_read_failed",
    });
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it.each(["usdcE", "pusd", "pol"] as const)(
    "blocks when %s has a residual balance",
    async (asset) => {
      getBalances.mockResolvedValue({
        address: "0x2222222222222222222222222222222222222222",
        usdcE: 0,
        pusd: 0,
        pol: 0,
        errors: [],
        [asset]: 0.01,
      });

      const result = await resetWalletConnection(deps, input);

      expect(result).toMatchObject({
        outcome: "blocked",
        blockedReason: "residual_balance",
      });
      expect(revokeConnection).not.toHaveBeenCalled();
    }
  );

  it("disables active targets and requires a later retry", async () => {
    inspect.mockResolvedValue({ ...cleanState, activeTargetCount: 2 });
    disableActiveTargets.mockResolvedValue(2);

    const result = await resetWalletConnection(deps, input);

    expect(disableActiveTargets).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      outcome: "blocked",
      blockedReason: "copy_targets_disabled",
      targetsDisabledCount: 2,
    });
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it("enforces one poll window after the latest target shutdown", async () => {
    inspect.mockResolvedValue({
      ...cleanState,
      latestTargetDisabledAt: new Date(NOW.getTime() - TARGET_QUIESCE_MS + 1),
    });

    const result = await resetWalletConnection(deps, input);

    expect(result).toMatchObject({
      outcome: "blocked",
      blockedReason: "copy_targets_disabled",
    });
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it("revokes only after every safety precondition passes", async () => {
    const result = await resetWalletConnection(deps, input);

    expect(revokeConnection).toHaveBeenCalledWith({
      actorId: input.actorId,
      billingAccountId: BILLING_ACCOUNT_ID,
      revokedByUserId: USER_ID,
      revokedAt: NOW,
    });
    expect(result).toMatchObject({
      outcome: "reset",
      blockedReason: null,
      grantsRevokedCount: 2,
      connection: { revokedAt: NOW },
      reprovisionAvailableInSeconds: 300,
    });
  });
});
