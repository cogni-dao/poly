// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/execution-scope`
 * Purpose: AsyncLocalStorage-based execution scope for billing, abort signal, and usage source.
 * Scope: Provides per-run billing context, abort signal, usage source (SourceSystem), and the run identity split (acting principal vs human subject) to static inner providers via Node-native ALS. Does not carry shared contract types — billing is app-local.
 * Invariants:
 *   - ALS_NOT_SHARED: ExecutionScope is app-local, never exported to @cogni/graph-execution-core
 *   - BILLING_SET_BY_LAUNCHER: runInScope is called by the launcher (chat, schedule, webhook)
 *   - ABORT_CHAT_ONLY: abortSignal is temporary tech debt for browser disconnect, not durable cancellation
 *   - THREE_IDENTITIES: a run has an acting principal (`principalId`, the catalog agent's user id), a subject
 *     (`subjectUserId`, the authenticated caller, bearer agents included; absent for a run with no caller) and a payer (`billing`). The launcher
 *     sets the subject; the tool guard binds the principal around each tool call. RLS and user-scoped
 *     capabilities use the subject, else the principal (`scopeUserId`).
 * Side-effects: none (ALS is process-scoped, no I/O)
 * Links: docs/spec/unified-graph-launch.md
 * @public
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { SourceSystem } from "@cogni/ai-core";
import type { BillingContext, LlmService } from "@/ports";

/**
 * Per-run execution scope set by the launcher, read by static inner providers.
 *
 * Contains only billing + optional abort + resolved LlmService. Tracing flows via OTel.
 * Shared ExecutionContext (actorUserId, sessionId, etc.) flows via runGraph(req, ctx).
 */
export interface ExecutionScope {
  readonly billing: BillingContext;
  /** The acting agent principal's user id (agent_principals.user_id). Bound per tool call by the guard. */
  readonly principalId?: string;
  /** The authenticated caller this run serves (human or bearer agent). Absent for a run with no caller; never the system principal. */
  readonly subjectUserId?: string;
  /** Chat-only temporary tech debt — browser disconnect, not durable cancellation. */
  readonly abortSignal?: AbortSignal;
  /** Resolved LlmService for this run (from ModelProviderPort.createLlmService). */
  readonly llmService: LlmService;
  /** Billing source system for usage attribution (from ModelProviderPort.usageSource). */
  readonly usageSource: SourceSystem;
}

/**
 * The user id that user-scoped operations (RLS, schedule CRUD, work-item writes) run as:
 * the subject when there is one, else the principal's own user id. Undefined means no identity.
 */
export function scopeUserId(scope: ExecutionScope): string | undefined {
  return scope.subjectUserId ?? scope.principalId;
}

const executionScopeStorage = new AsyncLocalStorage<ExecutionScope>();

/**
 * Get the current execution scope. Throws if called outside runInScope.
 */
export function getExecutionScope(): ExecutionScope {
  const scope = executionScopeStorage.getStore();
  if (!scope) {
    throw new Error(
      "getExecutionScope() called outside runInScope — billing context not available"
    );
  }
  return scope;
}

/**
 * Run a function within an execution scope.
 * Sets billing + abort for the duration of the call (and all async continuations).
 */
export function runInScope<T>(scope: ExecutionScope, fn: () => T): T {
  return executionScopeStorage.run(scope, fn);
}
