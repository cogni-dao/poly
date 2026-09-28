// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/ai/ui-message-event-mapper`
 * Purpose: Map live and replayed AiEvents through one stateful UIMessageChunk machine.
 * Scope: Text/tool/status/error mapping and assistant_final reconciliation only.
 * Invariants: Live and replay use identical part IDs, ordering, and reconciliation.
 * Side-effects: Writes UIMessageChunks through the caller-provided writer.
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import type { UIMessageChunk } from "ai";

type UiWriter = { write: (chunk: UIMessageChunk) => void };
type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "other"
  | "error";

interface MapperHooks {
  readonly onFirstTextDelta?: () => void;
  readonly onAssistantFinal?: (state: {
    accumulatedLength: number;
    finalLength: number;
  }) => void;
  readonly onContentDiverged?: (state: {
    accumulatedText: string;
    finalText: string;
  }) => void;
}

export type UiEventMapResult = "written" | "buffered" | "ignored";

export class UiMessageEventMapper {
  private textOpen = false;
  private accumulatedText = "";
  private assistantFinal: string | undefined;
  private firstDeltaSeen = false;
  private terminalWritten = false;

  constructor(
    private readonly writer: UiWriter,
    private readonly textPartId: string,
    private readonly hooks: MapperHooks = {}
  ) {}

  consume(event: AiEvent): UiEventMapResult {
    if (event.type === "usage_report" || event.type === "done") return "ignored";
    if (event.type === "text_delta") {
      if (!this.firstDeltaSeen) {
        this.firstDeltaSeen = true;
        this.hooks.onFirstTextDelta?.();
      }
      this.openText();
      this.accumulatedText += event.delta;
      this.writer.write({
        type: "text-delta",
        id: this.textPartId,
        delta: event.delta,
      });
      return "written";
    }
    if (event.type === "assistant_final") {
      this.assistantFinal = event.content;
      this.hooks.onAssistantFinal?.({
        accumulatedLength: this.accumulatedText.length,
        finalLength: event.content.length,
      });
      return "buffered";
    }
    if (event.type === "tool_call_start") {
      this.closeText();
      this.writer.write({
        type: "tool-input-start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      } as UIMessageChunk);
      if (event.args != null) {
        this.writer.write({
          type: "tool-input-available",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
        } as UIMessageChunk);
      }
      return "written";
    }
    if (event.type === "tool_call_result") {
      this.writer.write({
        type: "tool-output-available",
        toolCallId: event.toolCallId,
        output: event.result,
      } as UIMessageChunk);
      return "written";
    }
    if (event.type === "status") {
      this.writer.write({
        type: "data-status",
        data: {
          phase: event.phase,
          ...(event.label ? { label: event.label } : {}),
        },
        transient: true,
      } as UIMessageChunk);
      return "written";
    }
    if (event.type === "error") {
      this.writeError(event.error);
      return "written";
    }
    return "ignored";
  }

  finish(finishReason = "stop"): void {
    if (this.terminalWritten) return;
    this.reconcile();
    this.closeText();
    this.writer.write({
      type: "finish",
      finishReason: normalizeFinishReason(finishReason),
    });
    this.terminalWritten = true;
  }

  writeError(errorText: string): void {
    if (this.terminalWritten) return;
    this.closeText();
    this.writer.write({ type: "error", errorText });
    this.terminalWritten = true;
  }

  close(): void {
    this.closeText();
  }

  private openText(): void {
    if (this.textOpen) return;
    this.writer.write({ type: "text-start", id: this.textPartId });
    this.textOpen = true;
  }

  private closeText(): void {
    if (!this.textOpen) return;
    this.writer.write({ type: "text-end", id: this.textPartId });
    this.textOpen = false;
  }

  private reconcile(): void {
    if (this.assistantFinal === undefined) return;
    if (
      this.assistantFinal.startsWith(this.accumulatedText) &&
      this.assistantFinal.length > this.accumulatedText.length
    ) {
      this.openText();
      this.writer.write({
        type: "text-delta",
        id: this.textPartId,
        delta: this.assistantFinal.slice(this.accumulatedText.length),
      });
      this.accumulatedText = this.assistantFinal;
      return;
    }
    if (this.assistantFinal !== this.accumulatedText) {
      this.hooks.onContentDiverged?.({
        accumulatedText: this.accumulatedText,
        finalText: this.assistantFinal,
      });
    }
  }
}

function normalizeFinishReason(finishReason: string): FinishReason {
  if (finishReason === "tool_calls") return "tool-calls";
  if (finishReason === "content_filter") return "content-filter";
  if (
    finishReason === "stop" ||
    finishReason === "length" ||
    finishReason === "tool-calls" ||
    finishReason === "content-filter" ||
    finishReason === "other" ||
    finishReason === "error"
  ) {
    return finishReason;
  }
  return "stop";
}
