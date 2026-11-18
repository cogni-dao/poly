// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@types/ai-events`
 * Purpose: Re-export AI event types from @cogni/ai-core.
 * Scope: Shim layer for backwards compatibility. Does NOT define types.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: Canonical definitions in @cogni/ai-core
 *   - This file only re-exports; no local type definitions allowed
 * Side-effects: none (re-exports only)
 * Links: packages/ai-core/src/events/ai-events.ts, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/langgraph-server.md
 * @public
 */

// Re-export from canonical source (per SINGLE_SOURCE_OF_TRUTH invariant)
export type {
  AiEvent,
  AssistantFinalEvent,
  DoneEvent,
  ErrorEvent,
  TextDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageReportEvent,
} from "@cogni/ai-core";
