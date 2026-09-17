// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_lib/ai/ui-message-event-mapper`
 * Purpose: Prove live delivery and replay share exact ordered UI chunk mapping.
 * Scope: Pure stateful AiEvent-to-UIMessageChunk mapper.
 * Invariants: Same events and run ID produce byte-equivalent ordered chunks.
 * Side-effects: none
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { UiMessageEventMapper } from "@/app/_lib/ai/ui-message-event-mapper";

function mapSequence(events: AiEvent[]): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  const mapper = new UiMessageEventMapper(
    { write: (chunk) => chunks.push(chunk) },
    "run-test"
  );
  for (const event of events) mapper.consume(event);
  mapper.finish("tool_calls");
  return chunks;
}

describe("UiMessageEventMapper", () => {
  it("normalizes content_filter to the AI SDK finish reason", () => {
    const chunks: UIMessageChunk[] = [];
    const mapper = new UiMessageEventMapper(
      { write: (chunk) => chunks.push(chunk) },
      "run-filtered"
    );

    mapper.finish("content_filter");

    expect(chunks).toEqual([
      { type: "finish", finishReason: "content-filter" },
    ]);
  });

  it("maps a live and replay sequence with exact ordered parity", () => {
    const events: AiEvent[] = [
      { type: "status", phase: "thinking", label: "Planning" },
      {
        type: "tool_call_start",
        toolCallId: "call-1",
        toolName: "search",
        args: { query: "Cogni" },
      },
      {
        type: "tool_call_result",
        toolCallId: "call-1",
        result: { hits: 1 },
      },
      { type: "text_delta", delta: "Hello" },
      { type: "assistant_final", content: "Hello world" },
    ];

    const liveChunks = mapSequence(events);
    const replayChunks = mapSequence(events);

    expect(replayChunks).toEqual(liveChunks);
    expect(liveChunks).toEqual([
      {
        type: "data-status",
        data: { phase: "thinking", label: "Planning" },
        transient: true,
      },
      { type: "tool-input-start", toolCallId: "call-1", toolName: "search" },
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "search",
        input: { query: "Cogni" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { hits: 1 },
      },
      { type: "text-start", id: "run-test" },
      { type: "text-delta", id: "run-test", delta: "Hello" },
      { type: "text-delta", id: "run-test", delta: " world" },
      { type: "text-end", id: "run-test" },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });
});
