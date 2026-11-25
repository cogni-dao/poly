// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/logging/events`
 * Purpose: Event name registry for structured logging - prevents ad-hoc strings and schema drift.
 * Scope: Define valid event names as const registry. Does not define full payload schemas (for now).
 * Invariants: All event names registered here; logEvent() enforces base fields (reqId always).
 * Side-effects: none
 * Notes: Use EVENT_NAMES.* constants when logging. Later: add strict payload types if needed.
 * Links: Used by logEvent() in logger.ts; consumed by all logging callsites.
 * @public
 */

// ============================================================================
// Event Name Registry (as const)
// ============================================================================

export const WORK_ITEMS_LIST_ERROR_CODES = {
	INVALID_INPUT: "invalid_input",
	INVALID_CURSOR: "invalid_cursor",
	BACKEND_UNAVAILABLE: "backend_unavailable",
	INTERNAL_ERROR: "internal_error",
	CLIENT_ABORTED: "client_aborted",
} as const;

export const EVENT_NAMES = {
	METRIC_REFRESH_COMPLETE: "metric.refresh_complete",
	GOALS_PROGRESS_READ: "goals.progress_read",
	WORK_ITEMS_LIST_COMPLETE: "work.items.list_complete",
	// Row history reads (task.0052): one terminal event per read, counts only.
	WORK_ITEMS_HISTORY_READ: "work.items.history_read",
	// The classifier could not name a history actor's kind (task.0133): the read is served without it. One warn per actor; the error class only, never an id.
	WORK_ITEMS_HISTORY_ACTOR_KIND_UNAVAILABLE: "work.items.history_actor_kind_unavailable",
	// Every history read the host labels with actor kinds (task.0133): route, item envelope and core__work_item_read alike. Counts only, never an id.
	WORK_ITEMS_HISTORY_ACTOR_KINDS: "work.items.history_actor_kinds",
	// Review and validation artifacts (task.0028): a write, a refusal (400, 404, 409) and a read, each one terminal event; codes and counts only, never a body, a row or a url.
	WORK_ITEMS_ARTIFACT_RECORDED: "work.items.artifact_recorded",
	WORK_ITEMS_ARTIFACT_REFUSED: "work.items.artifact_refused",
	WORK_ITEMS_ARTIFACTS_READ: "work.items.artifacts_read",
	// A refused work item write (task.0122): one terminal event per refusal with its errorCode (invalid_input, gate_unmet, revision_conflict, ...); codes and ids only, never a body.
	// An item envelope part (links, artifacts, readings) that could not be read in time or failed: the envelope is served without it and marked unavailable. One warn per degraded part.
	WORK_ITEMS_ENVELOPE_DEGRADED: "work.items.envelope_degraded",
	// A work-item store answered busy with no terminal event of its own (task.0162): one 503 line with its closed `reason`, never the error text.
	WORK_ITEMS_BACKEND_UNAVAILABLE: "work.items.backend_unavailable",
	WORK_ITEMS_CREATE_REFUSED: "work.items.create_refused",
	WORK_ITEMS_PATCH_REFUSED: "work.items.patch_refused",
	// The success twins: one terminal event per accepted create or patch (route or agent tool), ids and counts only.
	WORK_ITEMS_CREATE_SUCCESS: "work.items.create_success",
	WORK_ITEMS_PATCH_SUCCESS: "work.items.patch_success",
	// The single-item read (story.0085): one terminal event per GET from the package route core; ids, parts and codes only.
	WORK_ITEMS_GET_SUCCESS: "work.items.get_success",
	WORK_ITEMS_GET_REFUSED: "work.items.get_refused",
	// A node run wrote with no run record to name (the record was missing, had no kind, or could not be read; task.0133): the write still happens as the principal, with no Run line. One warn per such write, with runId when known.
	WORK_ITEMS_ATTRIBUTION_RUN_MISSING: "work.items.attribution_run_missing",
	// The work-items store's own signals (task.0122): a stage that ran slow or failed (a stage that was fast is a debug line, never info), the status gate's PR read failing, a retired flag written.
	ADAPTER_WORK_ITEMS_STAGE_START: "adapter.work_items.stage_start",
	ADAPTER_WORK_ITEMS_STAGE_COMPLETE: "adapter.work_items.stage_complete",
	ADAPTER_WORK_ITEMS_STAGE_ERROR: "adapter.work_items.stage_error",
	ADAPTER_WORK_ITEMS_GATE_PR_READ_FAILED: "adapter.work_items.gate_pr_read_failed",
	ADAPTER_WORK_ITEMS_DEPLOY_VERIFIED_WRITE: "adapter.work_items.deploy_verified_write",
	// The same-door check refused a route call (a bearer without the grant, or the grant store unreachable): one terminal event with routeId and errorCode (policy_denied | authz_unavailable).
	AGENT_ROUTE_DENIED: "agent.route_denied",
	// Work-item PR repo pin at boot (task.0122): unset or malformed leaves it unpinned; entries that are not owner/repo are ignored. Once at boot, never per request.
	ADAPTER_WORK_ITEMS_PR_REPO_UNPINNED: "adapter.work_items.pr_repo_unpinned",
	ADAPTER_WORK_ITEMS_PR_REPO_IGNORED: "adapter.work_items.pr_repo_ignored",
	KNOWLEDGE_HISTORY_READ: "knowledge.history_read",
	// Whole-graph read (task.0059): one terminal event per read, counts and bytes only.
	KNOWLEDGE_GRAPH_READ: "knowledge.graph_read",
	// Agent atom read counters (story.0061): one line per flush with key and read counts; a drop or a failed flush with its count. Never ids.
	KNOWLEDGE_READ_COUNTS_FLUSHED: "knowledge.read_counts_flushed",
	KNOWLEDGE_READ_COUNT_WRITE_FAILED: "knowledge.read_count_write_failed",
	// A citing patch whose (atom, item) pairs could not be recorded (story.0061): reason and pair count only.
	KNOWLEDGE_CITE_PAIRS_RECORDED: "knowledge.cite_pairs_recorded",
	KNOWLEDGE_CITE_PAIRS_WRITE_FAILED: "knowledge.cite_pairs_write_failed",
	// AI Domain - Server
	AI_COMPLETION: "ai.completion",
	AI_LLM_CALL: "ai.llm_call",
	AI_LLM_CALL_COMPLETED: "ai.llm_call_completed",
	AI_TOOL_CALL_ERROR: "ai.tool_call.error",
	/** One decision per scoped tool call (task.5456): principal, subject, payer, tool, decision, code. No tokens. */
	AGENT_TOOL_AUTHZ: "agent_tool.authz",
	/** A run ended cleanly because a tool was denied or every write tool was withheld (DENIAL_IS_TERMINAL): principal, tool, code, reason, modelCalls, modelCallsAfterDenial. */
	AGENT_RUN_DENIED: "agent_run.denied",
	/** A DAO admin granted / revoked an agent role (task.5456): principal, scope, approvedBy. */
	AGENT_ROLE_GRANTED: "agent_role.granted",
	AGENT_ROLE_REVOKED: "agent_role.revoked",
	/** An agent asked for a permission for itself (a pending row): principalUserId, scope. */
	AGENT_ROLE_REQUESTED: "agent_role.requested",
	/** A DAO admin dismissed a pending ask: principalUserId, scope, deniedBy. */
	AGENT_ROLE_DENIED: "agent_role.denied",
	/** A service assertion verified (story.0038): issuer, service. Never the token. */
	SERVICE_AUTH_VERIFIED: "service_auth.verified",
	/** A service assertion was refused (story.0038): code, and issuer and service when the claims named them. Never the token. */
	SERVICE_AUTH_REJECTED: "service_auth.rejected",
	/** The signing key could not be used (partly configured, unusable, or a public key that is not the private key's): reason only, never the key. */
	SERVICE_AUTH_SIGNER_UNAVAILABLE: "service_auth.signer_unavailable",
	/** An org was created or found for an owner source (story.0038): orgUserId, sourceRef. */
	ORG_ENSURED: "org.ensured",
	/** A payer binding was turned On by an owner of the account (story.0038): subject, billingAccountId, approvedBy. */
	PAYER_BOUND: "payer.bound",
	/** A payer binding ended, Off or dismissed (story.0038): subject, billingAccountId, revokedBy. */
	PAYER_REVOKED: "payer.revoked",
	/** A run was billed to a bound account instead of the caller's own (story.0038): subject, billingAccountId. */
	PAYER_SELECTED: "payer.selected",
	/** This node's AI asked a configured remote node for one permission (story.0038): alias, scope, httpStatus. Never a token. */
	SERVICE_LINK_ASKED: "service_link.asked",
	/** A remote knowledge read was signed and sent (story.0038): alias, op, outcome. Never a token or a body. */
	REMOTE_KNOWLEDGE_READ: "remote_knowledge.read",
	/** revocable agent keys (task.0070): upgraded / rotated (a pending key issued), confirmed, revoked, refused. Carry userId and credentialId, never a key or hash. */
	AGENT_CREDENTIAL_UPGRADED: "agent.credential.upgraded",
	AGENT_CREDENTIAL_ROTATED: "agent.credential.rotated",
	AGENT_CREDENTIAL_CONFIRMED: "agent.credential.confirmed",
	AGENT_CREDENTIAL_REVOKED: "agent.credential.revoked",
	AGENT_CREDENTIAL_REFUSED: "agent.credential.refused",
	/** A revocable key could not be verified because the credential store failed; the request got 503, not 401. Carries routeId, plus the cause's errorClass and sqlState when known (never its message). */
	AGENT_CREDENTIAL_STORE_UNAVAILABLE: "agent.credential.store_unavailable",
	/** A signed (v1) key was used after its user confirmed a revocable key: 401 `v1_superseded`. The best replay signal for a leaked signed key. Carries routeId and userId only. */
	AGENT_CREDENTIAL_V1_SUPERSEDED_DENIED: "agent.credential.v1_superseded_denied",
	/** A revocable key was refused as invalid (unknown, revoked, expired or wrong state): 401. Carries routeId only: no key, hash or prefix. */
	AGENT_CREDENTIAL_INVALID_DENIED: "agent.credential.invalid_denied",
	/** A client went over the per-IP limit on credential lookups: 429, no store read. Carries routeId only. */
	AGENT_CREDENTIAL_RATE_LIMITED: "agent.credential.rate_limited",
	/**
	 * An agent-grants route or the grant authority failed and answered 503 `authz_unavailable` (store down, a SQL error, a bad response shape). Carries routeId and
	 * the failure fields `errorName`, `errorCode` (SQLSTATE or Node code), `constraint`, `table`, `column`: never a message, detail, token, hash or key.
	 */
	AGENT_ROLES_UNAVAILABLE: "agent.roles.unavailable",
	AGENT_ROLES_LIST_FAILED: "agent.roles.list_failed",
	AGENT_ROLES_REFUSED: "agent.roles.refused",
	/** A node-admin action passed `requireAdminSession()` (ADMIN_ACTS_IN_ADMIN): the action name and the admin's user id. Never a credential. */
	ADMIN_ACTION: "admin.action",
	/** A human route refused a request that carried an Authorization header; carries one of five fixed scheme names. */
	HUMAN_PLANE_REFUSED: "human_plane.refused",
	/** One structured summary per mission-loop cycle on the work-prioritizer slot (story.5108; CatalogEntry.report). */
	AI_WORK_PRIORITIZER_CYCLE: "ai.work_prioritizer.cycle",
	/** One structured summary per work-closeout run (story.0035; CatalogEntry.report): changedItemIds, changeCount, refusedCount, toolErrorCount, aborted. */
	AI_WORK_CLOSEOUT_CYCLE: "ai.work_closeout.cycle",
	/** One structured summary per scheduled DECIDE tick (task.5377; CatalogEntry.report): scoresWritten, writeAttempts, skipped(reason), revisionConflicts, guardRejected. */
	AI_COGNI_DECIDE_CYCLE: "ai.cogni_decide.cycle",
	AI_CHAT_RECEIVED: "ai.chat_received",
	AI_CHAT_RESPONSE_STARTED: "ai.chat_response_started",
	AI_CHAT_STREAM_CLOSED: "ai.chat_stream_closed",
	AI_CHAT_CLIENT_ABORTED: "ai.chat_client_aborted",
	AI_MODELS_LIST_SUCCESS: "ai.models_list_success",
	AI_ACTIVITY_QUERY_COMPLETED: "ai.activity.query_completed",
	AI_BILLING_COMMIT_COMPLETE: "ai.billing.commit_complete",
	AI_RELAY_PUMP_ERROR: "ai.relay.pump_error",

	// AI Domain - Client
	CLIENT_CHAT_MODEL_INVALID_RETRY: "client.chat.model_invalid_retry",
	CLIENT_CHAT_STREAM_ERROR: "client.chat.stream_error",
	CLIENT_CHAT_STREAM_CHUNK_PARSE_FAIL: "client.chat.stream_chunk_parse_fail",
	CLIENT_AI_MODEL_PREF_READ_FAIL: "client.ai.model_pref_read_fail",
	CLIENT_AI_MODEL_PREF_WRITE_FAIL: "client.ai.model_pref_write_fail",
	CLIENT_AI_MODEL_PREF_CLEAR_FAIL: "client.ai.model_pref_clear_fail",
	CLIENT_AI_MODEL_PREF_INVALID: "client.ai.model_pref_invalid",

	// Payments Domain - Server
	PAYMENTS_INTENT_CREATED: "payments.intent_created",
	PAYMENTS_STATE_TRANSITION: "payments.state_transition",
	PAYMENTS_VERIFIED: "payments.verified",
	PAYMENTS_CONFIRMED: "payments.confirmed",
	PAYMENTS_STATUS_READ: "payments.status_read",
	PAYMENTS_FUNDING_COMPLETE: "payments.funding_complete",
	PAYMENTS_STEWARD_WITHDRAWAL: "payments.steward_withdrawal",

	// Payments Domain - Client
	CLIENT_PAYMENTS_CREDITS_SUMMARY_HTTP_ERROR:
		"client.payments.credits_summary_http_error",
	CLIENT_PAYMENTS_CREDITS_SUMMARY_NETWORK_ERROR:
		"client.payments.credits_summary_network_error",
	CLIENT_PAYMENTS_HTTP_ERROR: "client.payments.http_error",
	CLIENT_PAYMENTS_FLOW_WALLET_WRITE_ERROR:
		"client.payments.flow_wallet_write_error",
	CLIENT_PAYMENTS_FLOW_SIMULATION_FAILED:
		"client.payments.flow_simulation_failed",
	CLIENT_PAYMENTS_FLOW_RECEIPT_ERROR: "client.payments.flow_receipt_error",

	// Setup Domain - Server
	SETUP_DAO_VERIFY_COMPLETE: "setup.dao_verify_complete",

	// Node Formation Domain - Server (wizard)
	NODE_FORMATION_CREATE_COMPLETE: "feature.node_formation.create_complete",
	NODE_PUBLISH_COMPLETE: "feature.node_publish.complete",

	// Adapter Events
	ADAPTER_LITELLM_COMPLETION_RESULT: "adapter.litellm.completion_result",
	ADAPTER_LITELLM_STREAM_RESULT: "adapter.litellm.stream_result",
	ADAPTER_LITELLM_USAGE_ERROR: "adapter.litellm.usage_error",
	ADAPTER_MIMIR_ERROR: "adapter.mimir.error",
	ADAPTER_TAVILY_ERROR: "adapter.tavily.error",
	ADAPTER_LANGGRAPH_INPROC_ERROR: "adapter.langgraph_inproc.error",
	ADAPTER_GIT_LS_FILES_ERROR: "adapter.git_ls_files.error",
	ADAPTER_GIT_LS_FILES_LIST: "adapter.git_ls_files.list",
	ADAPTER_RIPGREP_ERROR: "adapter.ripgrep.error",
	ADAPTER_RIPGREP_SEARCH: "adapter.ripgrep.search",
	ADAPTER_RIPGREP_OPEN: "adapter.ripgrep.open",
	ADAPTER_TIGERBEETLE_ERROR: "adapter.tigerbeetle.error",

	// Ledger Domain
	LEDGER_ALLOCATIONS_UPDATED: "ledger.allocations_updated",
	LEDGER_REVIEW_SUBJECT_OVERRIDES_UPDATED:
		"ledger.review_subject_overrides_updated",
	LEDGER_POOL_COMPONENT_RECORDED: "ledger.pool_component_recorded",
	LEDGER_IDENTITY_RESOLVED_AT_READ: "ledger.identity_resolved_at_read",
	LEDGER_FINALIZE_SUBMITTED: "ledger.finalize_submitted",
	LEDGER_FINALIZE_NO_POLLERS: "ledger.finalize_no_pollers",
	LEDGER_COLLECT_TRIGGERED: "ledger.collect_triggered",

	// BYO-AI Auth Domain
	BYO_AUTH_DEVICE_CODE_COMPLETE: "byo_auth.device_code.complete",
	BYO_AUTH_EXCHANGE_COMPLETE: "byo_auth.exchange.complete",
	ADAPTER_OPENAI_DEVICE_AUTH_ERROR: "adapter.openai_device_auth.error",

	// Saved conversation reads (metadata only)
	AI_THREAD_READ: "ai.thread_read",

	// Scheduling Domain
	SCHEDULE_DETAIL_READ: "schedules.detail_read",
	SCHEDULE_HISTORY_READ: "schedules.history_read",
	SCHEDULE_CREDIT_GATE_REJECTED: "schedules.credit_gate_rejected",

	// Governance Domain
	GOVERNANCE_SYNC_COMPLETE: "governance.sync.complete",

	// Treasury Domain
	TREASURY_SNAPSHOT_COMPLETE: "feature.treasury_snapshot.complete",
	TREASURY_CONFIG_MISSING: "feature.treasury_snapshot.config_missing",

	// Signal Execution Domain
	SIGNAL_EXECUTION_COMPLETE: "feature.signal_execution.complete",
	SIGNAL_DISPATCH_SKIPPED: "feature.signal_dispatch.skipped",
	ADAPTER_EVM_RPC_ERROR: "adapter.evm_rpc.error",

	// Review Domain
	REVIEW_COMPLETE: "feature.review.complete",
	ADAPTER_GITHUB_REVIEW_ERROR: "adapter.github_review.error",

	// Invariant Warnings
	INV_PROVIDER_META_MODEL_MISSING: "inv_provider_meta_model_missing",
	INV_MODELS_CONTRACT_VALIDATION_FAILED:
		"inv_models_contract_validation_failed",

	// Error Codes
	AI_MODELS_CACHE_FETCH_FAILED: "ai.models_cache_fetch_failed",
	AI_CHAT_STREAM_FINALIZATION_LOST: "ai.chat_stream_finalization_lost",
	MODEL_VALIDATION_FAILED: "model_validation_failed",

	// Test Events
	TEST_EVENT: "TEST_EVENT",

	// Langfuse Lifecycle (per OBSERVABILITY.md#langfuse-integration)
	LANGFUSE_TRACE_CREATED: "langfuse.trace_created",
	LANGFUSE_TRACE_COMPLETED: "langfuse.trace_completed",

	// Poly trade capability lifecycle (shipped PR #900 CP4.25, pre-existing
	// inline strings migrated to the registry in CP4.3e observability pass)
	POLY_TRADE_CAPABILITY_TEST_MODE: "poly.trade.capability.test_mode",
	POLY_TRADE_CAPABILITY_UNAVAILABLE: "poly.trade.capability.unavailable",
	POLY_TRADE_CAPABILITY_ENV_OK: "poly.trade.capability.env_ok",
	POLY_TRADE_CAPABILITY_READY: "poly.trade.capability.ready",
	POLY_COPY_TRADE_EXECUTE: "poly.copy_trade.execute",

	// Poly copy-trade mirror (task.0315 Phase 1 — emitted only on poly node)
	POLY_MIRROR_POLL_SINGLETON_CLAIM: "poly.mirror.poll.singleton_claim",
	POLY_MIRROR_POLL_STOPPED: "poly.mirror.poll.stopped",
	POLY_MIRROR_POLL_TICK_ERROR: "poly.mirror.poll.tick_error",
	POLY_MIRROR_POLL_SKIPPED: "poly.mirror.poll.skipped",
	POLY_MIRROR_POLL_BOOT_FAILED: "poly.mirror.poll.boot_failed",
	// Target-set reconciler (bug.0338 fix — separate from the ledger reconciler
	// below which walks CLOB order status). Ticks every 30s, diffs the active
	// target set against running per-target polls, starts/stops as needed.
	POLY_MIRROR_TARGETS_RECONCILE_TICK: "poly.mirror.targets.reconcile.tick",
	POLY_MIRROR_TARGETS_RECONCILE_TICK_ERROR:
		"poly.mirror.targets.reconcile.tick_error",
	POLY_MIRROR_TARGETS_RECONCILE_STOPPED:
		"poly.mirror.targets.reconcile.stopped",
	// Ledger reconciler (task.0323 §2)
	POLY_MIRROR_RECONCILE_SINGLETON_CLAIM:
		"poly.mirror.reconcile.singleton_claim",
	POLY_MIRROR_RECONCILE_STOPPED: "poly.mirror.reconcile.stopped",
	POLY_MIRROR_RECONCILE_TICK_ERROR: "poly.mirror.reconcile.tick_error",
	POLY_MIRROR_SOURCE_ERROR: "poly.mirror.source_error",
	POLY_MIRROR_DECISION: "poly.mirror.decision",
	POLY_WALLET_WATCH_FETCH: "poly.wallet_watch.fetch",
	POLY_WALLET_WATCH_NORMALIZE_ERROR: "poly.wallet_watch.normalize_error",
	POLY_WALLET_WATCH_WS_HEARTBEAT: "poly.wallet_watch.ws.heartbeat",
	POLY_WALLET_BALANCE_POLYGON_READ_FAILED:
		"poly.wallet.balance.polygon_read_failed",
	POLY_WALLET_BALANCE_OPEN_ORDERS_FAILED:
		"poly.wallet.balance.open_orders_failed",
	POLY_WALLET_OVERVIEW_COMPLETE: "feature.poly_wallet_overview.complete",
	POLY_WALLET_EXECUTION_COMPLETE: "feature.poly_wallet_execution.complete",
	POLY_WALLET_ROTATE_CLOB_CREDS_COMPLETE:
		"poly.wallet.rotate_clob_creds.complete",
	ADAPTER_ORDER_LEDGER_SNAPSHOT_ERROR: "adapter.order_ledger.snapshot_error",

	// Poly reconciler not-found branch (task.0328 CP2)
	// Emitted at debug when a row is within the grace window.
	POLY_RECONCILER_NOT_FOUND: "poly.reconciler.not_found",
	// Emitted at info when a stale row is promoted to canceled.
	POLY_RECONCILER_NOT_FOUND_UPGRADE: "poly.reconciler.not_found_upgrade",
	ADAPTER_SANDBOX_TICK: "adapter.sandbox.tick",
	// TODO: remove once all node openclaw-gateway-clients are deleted (per-node PRs)
	ADAPTER_OPENCLAW_GATEWAY_ERROR: "adapter.openclaw_gateway.error",
	// Sandbox Execution Events
	SANDBOX_EXECUTION_STARTED: "sandbox.execution.started",
	SANDBOX_EXECUTION_COMPLETE: "sandbox.execution.complete",
	POLY_WALLET_RESET_CONNECTION_COMPLETE:
		"poly.wallet.reset_connection.complete",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// ============================================================================
// Base Field Enforcement (for logEvent() helper)
// ============================================================================

/**
 * Required base fields for all events.
 * reqId is ALWAYS required; routeId required for HTTP request events.
 */
export interface EventBase {
	reqId: string;
	routeId?: string;
}
