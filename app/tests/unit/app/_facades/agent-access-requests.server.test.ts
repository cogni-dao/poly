// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/agent-access-requests.server`
 * Purpose: Prove approval links use canonical config and fail before DB writes.
 * Scope: Facade orchestration with transaction/service dependencies mocked.
 * Invariants: hostile request hosts are not an input; missing APP_BASE_URL
 *   cannot leave an unrecoverable pending request.
 * Side-effects: none
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createRequest, env, withTenantScope } = vi.hoisted(() => ({
  createRequest: vi.fn(),
  env: { APP_BASE_URL: "https://poly.example.test" as string | undefined },
  withTenantScope: vi.fn(),
}));

vi.mock("@/shared/env/server", () => ({
  serverEnv: () => env,
}));
vi.mock("@cogni/db-client", () => ({
  withTenantScope: (...args: unknown[]) => withTenantScope(...args),
}));
vi.mock("@/bootstrap/container", () => ({ resolveAppDb: () => ({}) }));
vi.mock("@/features/agent-grants/agent-access-request-service", () => ({
  AgentAccessRequestConflictError: class AgentAccessRequestConflictError extends Error {},
  AgentAccessRequestInvalidError: class AgentAccessRequestInvalidError extends Error {},
  createAgentAccessRequest: (...args: unknown[]) => createRequest(...args),
  decideAgentAccessRequest: vi.fn(),
  listOwnerAgentAccessRequests: vi.fn(),
  pollAgentAccessRequest: vi.fn(),
  previewAgentAccessRequest: vi.fn(),
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    POLY_AGENT_ACCESS_REQUEST_CREATED:
      "feature.poly_agent_access_request.created",
  },
}));

import { createAgentAccessRequestFacade } from "@/app/_facades/poly/agent-access-requests.server";

const sessionUser = {
  id: "10000000-0000-4000-a000-000000000001",
  walletAddress: null,
  displayName: "Research agent",
  avatarColor: null,
};
const requestDto = {
  id: "30000000-0000-4000-b000-000000000001",
  scope: "performance:read" as const,
  expires_at: "2026-10-20T00:00:00.000Z",
  requested_at: "2026-10-04T00:00:00.000Z",
  decided_at: null,
  status: "pending" as const,
  billing_account_id: null,
};
const logger = { info: vi.fn() };

describe("agent access request facade approval URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.APP_BASE_URL = "https://poly.example.test";
    createRequest.mockResolvedValue(requestDto);
    withTenantScope.mockImplementation(
      async (_db: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
        fn({})
    );
  });

  it("uses only APP_BASE_URL for the cross-party approval link", async () => {
    const result = await createAgentAccessRequestFacade(
      sessionUser,
      { expires_at: requestDto.expires_at },
      logger as never
    );

    expect(result.approval_url).toMatch(
      /^https:\/\/poly\.example\.test\/profile#agent-request=/
    );
    expect(result.approval_url).not.toContain("attacker.example");
    expect(withTenantScope).toHaveBeenCalledTimes(1);
  });

  it("fails before opening a DB transaction when APP_BASE_URL is absent", async () => {
    env.APP_BASE_URL = undefined;

    await expect(
      createAgentAccessRequestFacade(
        sessionUser,
        { expires_at: requestDto.expires_at },
        logger as never
      )
    ).rejects.toThrow("APP_BASE_URL is required");
    expect(withTenantScope).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
  });
});
