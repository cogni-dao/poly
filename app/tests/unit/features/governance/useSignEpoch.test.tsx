// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `useSignEpoch.test`
 * Purpose: Prove review snapshot sealing precedes every downstream signing side effect.
 * Scope: Hook orchestration with mocked HTTP and wallet signing only.
 * Invariants: REVIEW_SEAL_BEFORE_SIGN_DATA, REVIEW_FAILURE_STOPS_SIGNING.
 * Side-effects: mocked HTTP and wallet signing
 * Links: src/features/governance/hooks/useSignEpoch.ts, work/items/bug.5044.md
 * @public
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSignEpoch } from "@/features/governance/hooks/useSignEpoch";

const wallet = vi.hoisted(() => ({
  signTypedDataAsync: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useSignTypedData: () => ({
    signTypedDataAsync: wallet.signTypedDataAsync,
  }),
}));

const EPOCH_ID = "2";
const SIGNATURE = `0x${"ab".repeat(65)}`;

const signData = {
  domain: { name: "Cogni Attribution", version: "2", chainId: 11155111 },
  types: {
    AttributionStatement: [
      { name: "nodeId", type: "string" },
      { name: "scopeId", type: "string" },
      { name: "epochId", type: "uint256" },
      { name: "deploymentEnvironment", type: "string" },
      { name: "finalAllocationSetHash", type: "bytes32" },
      { name: "poolTotalCredits", type: "uint256" },
    ],
  },
  primaryType: "AttributionStatement",
  message: {
    nodeId: "00000000-0000-4000-8000-000000000001",
    scopeId: "00000000-0000-4000-8000-000000000002",
    epochId: EPOCH_ID,
    deploymentEnvironment: "candidate-a",
    finalAllocationSetHash: `0x${"12".repeat(32)}`,
    poolTotalCredits: "10000",
  },
} as const;

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useSignEpoch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seals review before sign-data, wallet signing, and finalization", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith(`/${EPOCH_ID}/review`)) {
          events.push("review:complete");
          return response({ epoch: { id: EPOCH_ID, status: "review" } });
        }
        if (url.endsWith(`/${EPOCH_ID}/sign-data`)) {
          events.push("sign-data");
          return response(signData);
        }
        if (url.endsWith(`/${EPOCH_ID}/finalize`)) {
          events.push("finalize");
          expect(init?.body).toBe(JSON.stringify({ signature: SIGNATURE }));
          return response({ workflowId: "finalize-2" });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    wallet.signTypedDataAsync.mockImplementationOnce(async () => {
      events.push("wallet");
      return SIGNATURE;
    });
    const { result } = renderHook(() => useSignEpoch(EPOCH_ID), { wrapper });

    await act(async () => {
      await result.current.sign();
    });

    expect(events).toEqual([
      "review:complete",
      "sign-data",
      "wallet",
      "finalize",
    ]);
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.method])
    ).toEqual([
      [`/api/v1/attribution/epochs/${EPOCH_ID}/review`, "POST"],
      [`/api/v1/attribution/epochs/${EPOCH_ID}/sign-data`, "GET"],
      [`/api/v1/attribution/epochs/${EPOCH_ID}/finalize`, "POST"],
    ]);
    expect(result.current.state.phase).toBe("SUCCESS");
  });

  it("stops before signing when review sealing fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ error: "review snapshot mismatch" }, false, 409)
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSignEpoch(EPOCH_ID), { wrapper });

    await act(async () => {
      await result.current.sign();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/attribution/epochs/${EPOCH_ID}/review`,
      expect.objectContaining({ method: "POST" })
    );
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("ERROR");
    expect(result.current.state.errorMessage).toContain("409");
  });
});
