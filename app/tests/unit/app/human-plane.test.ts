// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/human-plane`
 * Purpose: The human-plane guard refuses any Authorization header with 403 human_session_required, and its log line never
 *   carries credential text (task.5456 review H1).
 * Invariants: HUMAN_ROUTES_SESSION_ONLY; NO_SECRETS_IN_LOGS (the scheme field comes from a fixed allowlist).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";

import { refusedScheme, refuseNonSession } from "@/app/_lib/auth/human-plane";

const req = (authorization?: string) =>
  new Request("http://localhost/api/v1/agent-access/roles", {
    headers: authorization === undefined ? {} : { authorization },
  });

const SECRETS = [
  "cogni_ag_sk_v1_SECRETPAYLOAD.signature",
  "ghp_SECRETTOKENVALUE0123456789abcdef",
  "sk-or-v1-SECRETKEY",
  "abcdefghijklmnopqrstuvwxyz0123456789SECRET",
  "Bearer cogni_ag_sk_v1_SECRETPAYLOAD.signature",
  "Basic c2VjcmV0OnBhc3N3b3Jk",
  "Token ghp_SECRETTOKENVALUE0123456789abcdef",
  "Digest username=\"SECRETUSER\", response=\"SECRETRESP\"",
  "  Bearer   cogni_ag_sk_v1_SECRET ",
];

describe("refuseNonSession", () => {
  it("lets a request with no Authorization header through", () => {
    expect(refuseNonSession(req())).toBeNull();
  });

  it.each(SECRETS)("refuses %#: 403 human_session_required, no-store, nothing from the header in the body", async (header) => {
    const res = refuseNonSession(req(header));
    expect(res?.status).toBe(403);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await res?.json());
    expect(JSON.parse(text)).toEqual({ error: "human_session_required", code: "human_session_required" });
    expect(text).not.toContain("SECRET");
  });

  it("refuses an empty Authorization value too", () => {
    expect(refuseNonSession(req(""))?.status).toBe(403);
  });

  it("logs one allowlisted scheme and never any credential text, in any captured field", () => {
    for (const header of SECRETS) {
      const captured: Array<{ fields: Record<string, unknown>; msg: string }> = [];
      refuseNonSession(req(header), { warn: (fields, msg) => captured.push({ fields, msg }) });
      expect(captured).toHaveLength(1);
      const dump = JSON.stringify(captured);
      for (const fragment of ["SECRET", "cogni_ag_sk", "ghp_", "sk-or", "c2VjcmV0", "abcdefghijklmnop"])
        expect(dump, `${header} leaked ${fragment}`).not.toContain(fragment);
      expect(["bearer", "basic", "digest", "negotiate", "other"]).toContain(captured[0]?.fields.scheme);
      expect(captured[0]?.fields.code).toBe("human_session_required");
    }
  });

  it("names the scheme only when it is one of the four known ones, case-insensitively", () => {
    expect(refusedScheme("Bearer x")).toBe("bearer");
    expect(refusedScheme("BASIC x")).toBe("basic");
    expect(refusedScheme("digest x")).toBe("digest");
    expect(refusedScheme("Negotiate x")).toBe("negotiate");
    expect(refusedScheme("Token x")).toBe("other");
    expect(refusedScheme("Bearerx")).toBe("other");
    expect(refusedScheme("cogni_ag_sk_v1_abc")).toBe("other");
    expect(refusedScheme("")).toBe("other");
  });
});
