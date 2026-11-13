// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/types`
 * Purpose: Core type definitions for tool contracts and implementations.
 * Scope: Defines ToolContract, ToolImplementation, BoundTool. Does NOT import @langchain.
 * Invariants:
 *   - Pure types only, no runtime logic
 *   - EFFECT_TYPED: ToolContract includes `effect: ToolEffect` for policy decisions
 *   - NO LangChain imports (LangChain wrapping lives in langgraph-graphs)
 *   - Tools are pure functions with Zod validation
 *   - inputSchema is the source of truth; validateInput derives from it
 * Side-effects: none (types only)
 * Links: LANGGRAPH_AI.md, TOOL_USE_SPEC.md
 * @public
 */

import type { ToolEffect } from "@cogni/ai-core";
import type { ToolContract as SharedToolContract } from "@cogni/shared-ai-tools";
import type { z } from "zod";

/**
 * Tool implementation result shape (pre-redaction).
 *
 * NOTE: Intentionally separate from `ToolExecResult` in @cogni/ai-core.
 * - `ToolResult<T>` (here): Raw result from tool implementation, before redaction
 * - `ToolExecResult<T>` (ai-core): Result after toolRunner pipeline (validated, redacted)
 *
 * The types are structurally identical but semantically distinct layers.
 * Do not unify — this separation enables future divergence if needed.
 */
export type ToolResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errorCode: ToolErrorCode;
      readonly safeMessage: string;
    };

/**
 * Tool error codes.
 * Per TOOLRUNNER_RESULT_SHAPE: standardized error classification.
 */
export type ToolErrorCode =
  | "validation"
  | "execution"
  | "unavailable"
  | "redaction_failed"
  | "policy_denied";

/**
 * What a non-read_only tool needs before it may run (enforced by @cogni-dao/agent-grants guardTools).
 * Structurally identical to agent-grants' `ToolRequires`; ai-tools does not import it.
 *
 * - `kind`: `node` = a node-wide role; `own` = the human subject's own data (needs a subject);
 *   `account` = a billing account the owner granted.
 * - `subject`: `member` = any signed-in human; `admin` = a DAO admin. A subject only narrows access.
 */
export interface ToolRequires {
  readonly scope: string;
  readonly kind: "node" | "own" | "account";
  readonly subject: "member" | "admin";
  /** Plain-language permission name an admin reads on the profile page (no scope string, id or path). */
  readonly label: string;
  /** One plain line on what the permission lets an AI do. Shown beside the label; declared here once and nowhere else. */
  readonly description: string;
}

/**
 * Tool contract definition.
 * Defines schema and interface for a tool without implementation.
 *
 * inputSchema is the source of truth for tool input validation.
 * This enables:
 * - LangChain tool wrapping (needs Zod schema)
 * - Wire format compilation via toToolSpec() (compiles to JSONSchema7)
 * - Consistent validation across all execution paths
 */
export interface ToolContract<
  TName extends string,
  TInput,
  TOutput,
  TRedacted,
> {
  /** Stable tool name (snake_case, namespaced: core:tool_name) */
  readonly name: TName;
  /** Human-readable description for LLM */
  readonly description: string;
  /** Side-effect level for policy decisions */
  readonly effect: ToolEffect;
  /**
   * Authority the tool needs. REQUIRED for every non-read_only contract
   * (CI: tests/requires-guard.test.ts); a read_only tool needs only the graph lock.
   */
  readonly requires?: ToolRequires;
  /**
   * Zod schema for input validation.
   * Source of truth — used by LangChain wrappers and compiled to JSONSchema7.
   */
  readonly inputSchema:
    | z.ZodType<TInput>
    | SharedToolContract<TName, TInput, TOutput, TRedacted>["inputSchema"];
  /**
   * Zod schema for output validation.
   */
  readonly outputSchema:
    | z.ZodType<TOutput>
    | SharedToolContract<TName, TInput, TOutput, TRedacted>["outputSchema"];
  /** Redact output to UI-safe fields */
  readonly redact: (output: TOutput) => TRedacted;
  /** Allowlisted fields that appear in redacted output */
  readonly allowlist: ReadonlyArray<keyof TOutput>;
}

/**
 * Tool implementation interface.
 * Adapters implement this; receives validated input, returns raw output.
 */
export interface ToolImplementation<TInput, TOutput> {
  /** Execute the tool with validated input */
  readonly execute: (input: TInput) => Promise<TOutput>;
}

/**
 * Bound tool: contract + implementation together.
 * Created by package, consumed by tool-runner.
 */
export interface BoundTool<TName extends string, TInput, TOutput, TRedacted> {
  readonly contract: ToolContract<TName, TInput, TOutput, TRedacted>;
  readonly implementation: ToolImplementation<TInput, TOutput>;
}
