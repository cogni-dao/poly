// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/sandbox-workspace/execd-sandbox-client.spec`
 * Purpose: Unit tests for sandbox host derivation and the execd /command client.
 * Scope: Pure host math + stream folding against a fake fetch. Does not reach a real sandbox.
 * Invariants: Host matches the operator isolated-service convention; token only in header; output bounded.
 * Side-effects: none
 * Links: src/adapters/server/sandbox-workspace/
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  deriveIsolatedServiceOrigin,
  ExecdSandboxClient,
  SandboxRequestError,
} from "@/adapters/server/sandbox-workspace";

const TOKEN = "t".repeat(40);

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function fakeFetch(chunks: string[], status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(status === 200 ? streamOf(chunks) : "nope", { status })
  );
}

describe("deriveIsolatedServiceOrigin", () => {
  it.each([
    ["https://red.cognidao.org", "https://red-sandbox.cognidao.org"],
    ["https://red-test.cognidao.org", "https://red-sandbox-test.cognidao.org"],
    [
      "https://red-preview.cognidao.org/",
      "https://red-sandbox-preview.cognidao.org",
    ],
  ])("%s → %s", (appBaseUrl, expected) => {
    expect(
      deriveIsolatedServiceOrigin({
        appBaseUrl,
        nodeSlug: "red",
        service: "sandbox",
      })
    ).toBe(expected);
  });

  it.each([
    "http://localhost:3200",
    "https://localhost",
    "https://blue-test.cognidao.org",
    "not a url",
  ])("returns null for %s", (appBaseUrl) => {
    expect(
      deriveIsolatedServiceOrigin({
        appBaseUrl,
        nodeSlug: "red",
        service: "sandbox",
      })
    ).toBeNull();
  });
});

describe("ExecdSandboxClient.runCommand", () => {
  it("posts to /command with the token header and folds split stream chunks", async () => {
    const fetchImpl = fakeFetch([
      '{"type":"init","text":"cmd-1"}\n\n{"type":"pi',
      'ng","text":"pong"}\n\n{"type":"stdout","text":"hello"}\n\n',
      '{"type":"stdout","text":"world"}\n\n{"type":"execution_complete","execution_time":14}\n\n',
    ]);
    const client = new ExecdSandboxClient({
      baseUrl: "https://red-sandbox-test.cognidao.org/",
      accessToken: TOKEN,
      fetchImpl,
    });

    const result = await client.runCommand({ command: "echo hi", cwd: "/tmp" });

    expect(result).toEqual({
      commandId: "cmd-1",
      stdout: "hello\nworld",
      stderr: "",
      exitCode: 0,
      errorName: null,
      truncated: false,
      executionTimeMs: 14,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://red-sandbox-test.cognidao.org/command");
    expect(
      (init?.headers as Record<string, string>)["X-EXECD-ACCESS-TOKEN"]
    ).toBe(TOKEN);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      command: "echo hi",
      background: false,
      timeout: 60_000,
      cwd: "/tmp",
    });
    expect(String(init?.body)).not.toContain(TOKEN);
  });

  it("maps an execd error event to the process exit code", async () => {
    const client = new ExecdSandboxClient({
      baseUrl: "https://sbx.example.org",
      accessToken: TOKEN,
      fetchImpl: fakeFetch([
        '{"type":"stderr","text":"oops"}\n\n',
        '{"type":"error","error":{"ename":"CommandExecError","evalue":"3","traceback":["exit status 3"]}}\n\n',
      ]),
    });

    const result = await client.runCommand({ command: "exit 3" });

    expect(result.exitCode).toBe(3);
    expect(result.errorName).toBe("CommandExecError");
    expect(result.stderr).toBe("oops");
  });

  it("truncates output beyond maxOutputChars", async () => {
    const client = new ExecdSandboxClient({
      baseUrl: "https://sbx.example.org",
      accessToken: TOKEN,
      maxOutputChars: 4,
      fetchImpl: fakeFetch([
        '{"type":"stdout","text":"abcdefgh"}\n{"type":"execution_complete"}\n',
      ]),
    });

    const result = await client.runCommand({ command: "x" });

    expect(result.stdout).toBe("abcd");
    expect(result.truncated).toBe(true);
  });

  it("throws SandboxRequestError on 401 without echoing the body", async () => {
    const client = new ExecdSandboxClient({
      baseUrl: "https://sbx.example.org",
      accessToken: TOKEN,
      fetchImpl: fakeFetch([], 401),
    });

    await expect(client.runCommand({ command: "id" })).rejects.toMatchObject({
      name: "SandboxRequestError",
      status: 401,
      message: "sandbox /command failed with HTTP 401",
    });
  });

  it("throws when the stream ends before completion", async () => {
    const client = new ExecdSandboxClient({
      baseUrl: "https://sbx.example.org",
      accessToken: TOKEN,
      fetchImpl: fakeFetch(['{"type":"stdout","text":"partial"}\n']),
    });

    await expect(client.runCommand({ command: "id" })).rejects.toBeInstanceOf(
      SandboxRequestError
    );
  });

  it("refuses to construct without a token", () => {
    expect(
      () => new ExecdSandboxClient({ baseUrl: "https://x.org", accessToken: "" })
    ).toThrow();
  });
});
