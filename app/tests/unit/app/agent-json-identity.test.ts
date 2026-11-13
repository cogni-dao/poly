// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-json-identity`
 * Purpose: The agent manifest lists the identity actions and the permissions an outside agent can ask for (task.0111).
 * Scope: `GET /.well-known/agent.json` over the typed contracts and the grant declarations. No database.
 * Invariants:
 *   - DECLARED_ONCE_SHOWN_EVERYWHERE: `permissions` is derived from the declarations; a new declaration shows with no discovery edit.
 * Side-effects: none
 */

import { ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "test-sha" }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeBrandColor: () => "#000000",
  getNodeBrandIcon: () => "circle",
  getNodeHook: () => "Test hook",
  getNodeMission: () => "Test mission",
  getNodeName: () => "Test node",
  getNodeThumbnail: () => null,
}));

const read = async () => {
  const { GET } = await import("@/app/.well-known/agent.json/route");
  return (
    await GET(new Request("https://node.example/.well-known/agent.json"))
  ).json();
};

describe("agent.json identity", () => {
  afterEach(() => {
    delete (ROUTE_ONLY_CAPABILITIES as Record<string, unknown>)["test.cap"];
  });

  it("lists the identity actions with their method and path", async () => {
    const { actions } = await read();
    const base = "https://node.example/api/v1/agent";
    expect(
      Object.fromEntries(
        [
          "register",
          "upgradeCredential",
          "confirmCredential",
          "rotateCredential",
          "revokeCredential",
          "requestPermission",
          "listMyPermissions",
        ].map((k) => [k, `${actions[k]?.method} ${actions[k]?.endpoint}`])
      )
    ).toEqual({
      register: `POST ${base}/register`,
      upgradeCredential: `POST ${base}/credentials/upgrade`,
      confirmCredential: `POST ${base}/credentials/confirm`,
      rotateCredential: `POST ${base}/credentials/rotate`,
      revokeCredential: `POST ${base}/credentials/revoke`,
      requestPermission: `POST ${base}/access-requests`,
      listMyPermissions: `GET ${base}/access-requests`,
    });
    expect(actions.requestPermission.inputSchema.required).toEqual(["scope"]);
    expect(actions.register.inputSchema.required).toEqual(["name"]);
  });

  it("lists the grantable permissions from the declarations", async () => {
    const { permissions, permissionsHow } = await read();
    expect(permissionsHow).toContain("requestPermission");
    const scopes = permissions.map((p: { scope: string }) => p.scope);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(permissions).toContainEqual({
      scope: "knowledge:contribute",
      kind: "node",
      label: ROUTE_ONLY_CAPABILITIES["knowledge.contribute"]?.requires.label,
      description:
        ROUTE_ONLY_CAPABILITIES["knowledge.contribute"]?.requires.description,
    });
    expect(scopes).toContain("work_item:transition");
    // A scope no outside route uses (the tool has no route twin) is not offered.
    expect(scopes).not.toContain("knowledge:write");
  });

  it("shows a new declaration with no discovery edit", async () => {
    (ROUTE_ONLY_CAPABILITIES as Record<string, unknown>)["test.cap"] = {
      requires: {
        scope: "test:cap",
        kind: "node",
        subject: "member",
        label: "Try a test capability",
        description: "Only a test declares this.",
      },
      routes: ["test.cap"],
    };
    const { permissions } = await read();
    expect(permissions).toContainEqual({
      scope: "test:cap",
      kind: "node",
      label: "Try a test capability",
      description: "Only a test declares this.",
    });
  });
});
