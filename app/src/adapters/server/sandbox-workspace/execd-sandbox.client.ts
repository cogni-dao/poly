// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox-workspace/execd-sandbox.client`
 * Purpose: Minimal server-only client for Red's remote sandbox (OpenSandbox execd behind Caddy).
 * Scope: Runs one shell command via `POST /command` and folds the streamed events into a bounded result.
 *   Does not manage sessions, files, PTY, or expose a model-facing tool.
 * Invariants:
 *   - TOKEN_VIA_CONFIG: the execd access token comes from constructor config, never from call params,
 *     and is sent only as the `X-EXECD-ACCESS-TOKEN` header.
 *   - BOUNDED_OUTPUT: stdout/stderr are truncated to `maxOutputChars` each.
 *   - BOUNDED_TIME: the HTTP request aborts `requestGraceMs` after the command's own timeout.
 * Side-effects: IO (HTTPS to the node's sandbox lease)
 * Links: services/sandbox/, https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/execd-api.yaml
 * @internal
 */

export const EXECD_ACCESS_TOKEN_HEADER = "X-EXECD-ACCESS-TOKEN";

export interface ExecdSandboxClientConfig {
  /** Sandbox origin, e.g. `https://red-sandbox-test.cognidao.org`. */
  readonly baseUrl: string;
  /** Shared execd access token (SANDBOX_EXECD_TOKEN). */
  readonly accessToken: string;
  /** Per-stream output cap in characters (default 65536). */
  readonly maxOutputChars?: number;
  /** Extra wall-clock allowed beyond the command timeout before aborting (default 10s). */
  readonly requestGraceMs?: number;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
}

export interface SandboxCommandRequest {
  readonly command: string;
  /** Working directory inside the sandbox (default: image WORKDIR `/workspace`). */
  readonly cwd?: string;
  /** Command timeout enforced by execd (default 60s, max 15m). */
  readonly timeoutMs?: number;
  readonly envs?: Readonly<Record<string, string>>;
}

export interface SandboxCommandResult {
  /** execd command id from the `init` event, when present. */
  readonly commandId: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 0 on success; the process exit status on failure; -1 when execd reports a non-numeric error. */
  readonly exitCode: number;
  /** execd error name (e.g. `CommandExecError`) when the command failed. */
  readonly errorName: string | null;
  readonly truncated: boolean;
  readonly executionTimeMs: number | null;
}

export class SandboxRequestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SandboxRequestError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 65_536;
const DEFAULT_REQUEST_GRACE_MS = 10_000;

interface ExecdStreamEvent {
  type?: string;
  text?: string;
  execution_time?: number;
  error?: { ename?: string; evalue?: string };
}

export class ExecdSandboxClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly maxOutputChars: number;
  private readonly requestGraceMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ExecdSandboxClientConfig) {
    if (!config.accessToken) {
      throw new Error("ExecdSandboxClient requires an access token");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.accessToken = config.accessToken;
    this.maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.requestGraceMs = config.requestGraceMs ?? DEFAULT_REQUEST_GRACE_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Run one shell command to completion and return its bounded output. */
  async runCommand(
    request: SandboxCommandRequest
  ): Promise<SandboxCommandResult> {
    const timeoutMs = Math.min(
      Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1),
      MAX_TIMEOUT_MS
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs + this.requestGraceMs
    );

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          [EXECD_ACCESS_TOKEN_HEADER]: this.accessToken,
        },
        body: JSON.stringify({
          command: request.command,
          background: false,
          timeout: timeoutMs,
          ...(request.cwd !== undefined && { cwd: request.cwd }),
          ...(request.envs !== undefined && { envs: request.envs }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Never echo the body: it may reflect request headers.
        throw new SandboxRequestError(
          `sandbox /command failed with HTTP ${response.status}`,
          response.status
        );
      }
      if (!response.body) {
        throw new SandboxRequestError("sandbox /command returned no body", null);
      }
      return await this.collect(response.body);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SandboxRequestError(
          `sandbox /command exceeded ${timeoutMs + this.requestGraceMs}ms`,
          null
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async collect(
    body: ReadableStream<Uint8Array>
  ): Promise<SandboxCommandResult> {
    const out = { stdout: "", stderr: "" };
    let truncated = false;
    let commandId: string | null = null;
    let exitCode: number | null = null;
    let errorName: string | null = null;
    let executionTimeMs: number | null = null;
    let completed = false;

    const append = (stream: "stdout" | "stderr", text: string) => {
      const line = out[stream] ? `\n${text}` : text;
      const room = this.maxOutputChars - out[stream].length;
      if (line.length > room) {
        truncated = true;
        out[stream] += line.slice(0, Math.max(room, 0));
      } else {
        out[stream] += line;
      }
    };

    const handle = (event: ExecdStreamEvent) => {
      switch (event.type) {
        case "init":
          commandId = event.text ?? null;
          break;
        case "stdout":
        case "stderr":
          append(event.type, event.text ?? "");
          break;
        case "error": {
          errorName = event.error?.ename ?? "Error";
          const parsed = Number.parseInt(event.error?.evalue ?? "", 10);
          exitCode = Number.isInteger(parsed) ? parsed : -1;
          completed = true;
          break;
        }
        case "execution_complete":
          executionTimeMs = event.execution_time ?? null;
          completed = true;
          break;
        default:
          break;
      }
    };

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const raw of lines) {
        const event = parseEventLine(raw);
        if (event) handle(event);
      }
      if (done) break;
    }

    if (!completed) {
      throw new SandboxRequestError(
        "sandbox /command stream ended before completion",
        null
      );
    }
    return {
      commandId,
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: exitCode ?? 0,
      errorName,
      truncated,
      executionTimeMs,
    };
  }
}

/** execd streams one JSON object per line; tolerate an SSE `data:` prefix. */
function parseEventLine(raw: string): ExecdStreamEvent | null {
  let line = raw.trim();
  if (line.startsWith("data:")) line = line.slice(5).trim();
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as ExecdStreamEvent;
  } catch {
    return null;
  }
}
