// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/agent-access-requests.server`
 * Purpose: Prove self-list identity binding plus canonical approval origins.
 * Scope: Facade orchestration with transaction/service dependencies mocked.
 * Invariants: hostile request hosts are not an input; explicit APP_BASE_URL
 *   wins; DOMAIN fallback follows the fleet host convention; missing canonical
 *   config cannot leave an unrecoverable pending request.
 * Side-effects: none
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createRequest, env, listRequests, nodeName, withTenantScope } =
  vi.hoisted(() => ({
    createRequest: vi.fn(),
    env: {
      APP_BASE_URL: "https://poly.example.test" as string | undefined,
      DOMAIN: undefined as string | undefined,
    },
    listRequests: vi.fn(),
    nodeName: { value: "poly" },
    withTenantScope: vi.fn(),
  }));

vi.mock("@/shared/env/server", () => ({
  serverEnv: () => env,
}));
vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeName: () => nodeName.value,
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
  listAgentAccessRequests: (...args: unknown[]) => listRequests(...args),
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

import {
  createAgentAccessRequestFacade,
  listAgentAccessRequestsFacade,
} from "@/app/_facades/poly/agent-access-requests.server";

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
    env.DOMAIN = undefined;
    nodeName.value = "poly";
    createRequest.mockResolvedValue(requestDto);
    listRequests.mockResolvedValue([requestDto]);
    withTenantScope.mockImplementation(
      async (_db: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
        fn({})
    );
  });

  it("derives self-list principal only from the authenticated identity", async () => {
    const result = await listAgentAccessRequestsFacade(sessionUser);

    expect(result).toEqual({ requests: [requestDto] });
    expect(listRequests).toHaveBeenCalledWith({}, sessionUser.id);
  });

  it("prefers APP_BASE_URL over DOMAIN for the cross-party approval link", async () => {
    env.DOMAIN = "attacker.example";

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

  it("rejects a non-origin APP_BASE_URL before opening a DB transaction", async () => {
    env.APP_BASE_URL = "https://poly.example.test/untrusted-base?next=phish";

    await expect(
      createAgentAccessRequestFacade(
        sessionUser,
        { expires_at: requestDto.expires_at },
        logger as never
      )
    ).rejects.toThrow("APP_BASE_URL must be a canonical HTTP(S) URL");
    expect(withTenantScope).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("derives the candidate node origin from repo-spec slug and DOMAIN", async () => {
    env.APP_BASE_URL = undefined;
    env.DOMAIN = "test.cognidao.org";

    const result = await createAgentAccessRequestFacade(
      sessionUser,
      { expires_at: requestDto.expires_at },
      logger as never
    );

    expect(result.approval_url).toMatch(
      /^https:\/\/poly-test\.cognidao\.org\/profile#agent-request=/
    );
    expect(withTenantScope).toHaveBeenCalledTimes(1);
  });

  it("derives the production node origin from repo-spec slug and DOMAIN", async () => {
    env.APP_BASE_URL = undefined;
    env.DOMAIN = "cognidao.org";

    const result = await createAgentAccessRequestFacade(
      sessionUser,
      { expires_at: requestDto.expires_at },
      logger as never
    );

    expect(result.approval_url).toMatch(
      /^https:\/\/poly\.cognidao\.org\/profile#agent-request=/
    );
    expect(withTenantScope).toHaveBeenCalledTimes(1);
  });

  it("fails before opening a DB transaction when canonical config is absent", async () => {
    env.APP_BASE_URL = undefined;
    env.DOMAIN = undefined;

    await expect(
      createAgentAccessRequestFacade(
        sessionUser,
        { expires_at: requestDto.expires_at },
        logger as never
      )
    ).rejects.toThrow("APP_BASE_URL or DOMAIN is required");
    expect(withTenantScope).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
  });
});
