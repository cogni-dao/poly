// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/package-event-names.contract`
 * Purpose: The node's event registry and the packages name the same agent-authority and sandbox events, so a Loki query written against the
 *   registry finds what the packages emit (task.0175).
 * Scope: Constant parity only.
 * Invariants: EVENT_NAMES_HERE (the package owns the names; the registry repeats them).
 * Side-effects: none
 * @internal
 */

import { AGENT_HOST_EVENTS } from "@cogni/agent-grants/host";
import { SANDBOX_PUSH_TOKEN_EVENT } from "@cogni/sandbox";
import { describe, expect, it } from "vitest";

import { EVENT_NAMES } from "@/shared/observability";

describe("package event names", () => {
  it("the registry names equal the agent-grants host's", () => {
    expect({
      toolAuthz: EVENT_NAMES.AGENT_TOOL_AUTHZ,
      roleGranted: EVENT_NAMES.AGENT_ROLE_GRANTED,
      roleRevoked: EVENT_NAMES.AGENT_ROLE_REVOKED,
      roleRequested: EVENT_NAMES.AGENT_ROLE_REQUESTED,
      roleDenied: EVENT_NAMES.AGENT_ROLE_DENIED,
      rolesUnavailable: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE,
    }).toEqual(AGENT_HOST_EVENTS);
  });

  it("the registry name equals the sandbox push-token event", () => {
    expect(EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN).toBe(SANDBOX_PUSH_TOKEN_EVENT);
  });
});
