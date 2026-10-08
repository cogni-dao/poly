// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.account.copy-operations.v1.contract`
 * Purpose: The two delegable copy-operations reads, defined once as pure wire
 *   contracts. TWO cohesive capabilities, deliberately not one giant response:
 *     1. `copy-setup`      — what this account is configured to mirror RIGHT NOW:
 *                            tracked targets, effective sizing policy per target,
 *                            and the active wallet safety caps.
 *     2. `recent-attempts` — a frozen, cursor-paginated, account-wide latest-N
 *                            cross-market tape of mirror ATTEMPTS, carrying the
 *                            decision reason, the placement/fill result,
 *                            intended vs executed size, mode, mark/outcome
 *                            availability, freshness, completeness, and explicit
 *                            truncation.
 * Scope: Pure metadata — zod schemas and plain literals. No handler, no DB, no
 *   env, no container. Transport coordinates and `requiredScope` are attached in
 *   `poly.capability-plane.v1.contract` so this module stays scope-agnostic.
 * Invariants:
 *   - TWO_COHESIVE_CAPABILITIES — setup (slow-moving config) and attempts
 *     (high-cardinality event tape) are separate operations. They have different
 *     cardinality, different freshness, and different cache lifetimes; fusing
 *     them would force every config read to pay for a page of tape.
 *   - ATTEMPT_IS_THE_DECISION_ROW — the tape's spine is
 *     `poly_copy_trade_decisions`, NOT the fills ledger. An attempt exists the
 *     moment the mirror decides, so `outcome='skipped'` rows — the MAJORITY of
 *     mirror activity — are first-class here. The legacy dashboard card reads
 *     the fills ledger and therefore cannot see a single skip or its reason.
 *   - INTENDED_VS_EXECUTED_ARE_SEPARATE_OBJECTS — `intended` comes from the
 *     decision's `intent`, `executed` from the correlated fills row. They are
 *     never merged or coalesced, because the entire diagnostic value is in the
 *     gap between them.
 *   - NO_FABRICATED_VALUES — every absent fact is a typed `unavailable` variant
 *     or an explicit `null`, never `0` and never invented. `wallet_safety` is a
 *     discriminated union precisely so a missing grant CANNOT be rendered as
 *     zero caps, which would read as "no limits" instead of "cannot trade".
 *   - EFFECTIVE_POLICY_IS_DERIVED — `poly_copy_trade_config` was DROPPED in
 *     migration 0036. There is no config table and no per-tenant kill switch.
 *     Policy is derived per target row; caps come from `poly_wallet_grants`.
 *     The capability joins those two sources and says which is which.
 *   - EFFECTIVE_KIND_MATCHES_RUNTIME — the app injects the exact runtime
 *     resolver used by the mirror job. `auto` and the explicit percentile
 *     fallback are therefore readable without duplicating policy logic.
 *   - SNAPSHOT_CUTOFF — `captured_at` freezes tape membership across pages. It
 *     is optional on the first request (the server freezes and returns it) and
 *     MUST be echoed back with the cursor for every subsequent page.
 *   - BOUNDED_PAGES — hard max 200 attempts per page, hard max tracked targets,
 *     and an explicit `truncated` flag. No exhaustive per-market paging.
 *   - SAVED_FACTS_ONLY — every field is a persisted Postgres fact. This is not a
 *     proxy to Polymarket.
 * Side-effects: none
 * Links: story.5004, story.5006, story.5051, task.1791070959,
 *   docs/spec/capability-plane.md, docs/spec/dashboard-agent-parity-inventory.md
 * @public
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const IsoTimestampSchema = z.string().datetime({ offset: true });
const OptionalIsoTimestampSchema = IsoTimestampSchema.optional();

/**
 * Execution mode. Re-declared rather than imported from the frozen P/L contract
 * so this module adds no coupling to a port-frozen file, and so `"all"` can
 * mean "both modes" on the tape without widening the frozen enum.
 */
export const PolyCopyOperationsModeSchema = z.enum(["live", "paper"]);
export type PolyCopyOperationsMode = z.infer<
  typeof PolyCopyOperationsModeSchema
>;

export const PolyCopyOperationsModeFilterSchema = z.enum([
  "live",
  "paper",
  "all",
]);

/** Hard page/collection bounds. Clients cannot raise these. */
export const POLY_COPY_ATTEMPTS_DEFAULT_LIMIT = 50;
export const POLY_COPY_ATTEMPTS_MAX_LIMIT = 200;
export const POLY_COPY_SETUP_MAX_TARGETS = 50;

// ---------------------------------------------------------------------------
// Capability 1 — copy setup
// ---------------------------------------------------------------------------

export const PolyAccountCopySetupQuerySchema = z.object({
  billing_account_id: z.string().uuid(),
});
export type PolyAccountCopySetupQuery = z.infer<
  typeof PolyAccountCopySetupQuerySchema
>;

/** Owner-session alias of the same capability; the account comes from auth. */
export const PolyAccountCopySetupOwnerQuerySchema = z.object({});

/**
 * The five sizing-policy kinds a target row may declare, mirroring the
 * `poly_copy_trade_targets_sizing_policy_kind_check` DB constraint. Kept as a
 * closed enum so a new DB kind cannot silently reach the wire untyped.
 */
export const PolySizingPolicyKindSchema = z.enum([
  "auto",
  "min_bet",
  "target_percentile_scaled",
  "position_gap",
  "mirror_fill_exact",
]);

export const PolyEffectiveSizingPolicyKindSchema = z.enum([
  "min_bet",
  "target_percentile_scaled",
  "position_gap",
  "mirror_fill_exact",
]);

/** Exact deployed code revision, or an honest typed absence in local dev. */
export const PolyAlgorithmImplementationRevisionSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("available"),
      build_sha: z.string().min(7),
    }),
    z.object({
      status: z.literal("unavailable"),
      reason: z.literal("app_build_sha_not_set"),
    }),
  ],
);
export type PolyAlgorithmImplementationRevision = z.infer<
  typeof PolyAlgorithmImplementationRevisionSchema
>;

/**
 * Effective sizing policy for ONE target, derived from its saved row by the
 * mirror runtime's exact wallet-snapshot resolver.
 *
 * `declared_kind` is the saved fact. `effective_kind` is the concrete policy
 * the mirror runtime will run for this wallet at this deployed revision.
 */
export const PolyEffectiveSizingPolicySchema = z.object({
  /** Exactly what the target row stores. */
  declared_kind: PolySizingPolicyKindSchema,
  /** The concrete policy selected by the exact runtime resolver. */
  effective_kind: PolyEffectiveSizingPolicyKindSchema,
  resolution: z.enum([
    "explicit",
    "auto_snapshot",
    "auto_no_snapshot",
    "explicit_fallback_no_snapshot",
  ]),
  /** Immutable code identity shared with `/version.buildSha`. */
  implementation_revision: PolyAlgorithmImplementationRevisionSchema,
  /** Target-wallet percentile floor below which fills are not mirrored. */
  mirror_filter_percentile: z.number().int(),
  /** Legacy policy ceiling; ignored by position_gap v2. */
  mirror_max_usdc_per_trade: z.number().nonnegative(),
  /** Legacy position_gap v1 range; ignored by v2. */
  target_range_max_usdc: z.number().nonnegative().nullable(),
  /** Legacy position_gap v1 allocation cap; ignored by v2. */
  mirror_max_alloc_per_condition_usdc: z.number().nonnegative().nullable(),
  /**
   * Deprecated v1 compatibility flag. Always false because position_gap v2
   * derives its scale from live portfolio NAV and requires no range knobs.
   */
  range_knobs_incomplete: z.boolean(),
  /** Saved and last-observed runtime budget facts; never recomputed by clients. */
  portfolio_budget: z.object({
    configured_budget_usdc: z.number().positive().nullable(),
    effective_budget_usdc: z.number().nonnegative().nullable(),
    allocation_status: z
      .enum(["full", "reserved", "prorated", "blocked_multi_target"])
      .nullable(),
    effective_budget_observed_at: IsoTimestampSchema.nullable(),
    observation_status: z.enum([
      "not_applicable",
      "pending",
      "stale",
      "observed",
      "blocked_multi_target",
    ]),
  }),
});

/**
 * Whether this target can actually produce a mirror order right now, derived
 * purely from saved facts.
 *
 * This exists because of `EXCLUSION_IS_EXPLAINED` (bug.5288): the mirror
 * enumerator INNER-joins targets against an active wallet grant, so when a grant
 * expires a tenant simply STOPS being enumerated. Trading halts and looks
 * byte-identical to "idle", with no log line and no error. Naming the blocked
 * state is the whole point of surfacing it here.
 *
 * `blocked_no_active_wallet_grant` relies on REVOKE_CASCADES_FROM_CONNECTION
 * (migration 0031): revoking a wallet connection revokes every grant on it in
 * the same transaction, so an active grant implies a live connection. That
 * cascade is enforced app-side rather than by a DB trigger, which is why
 * `poly_wallet_connections` is deliberately NOT read here — it holds encrypted
 * CLOB credentials and must never be exposed to a delegated principal.
 */
export const PolyTargetActivationSchema = z.object({
  status: z.enum([
    /** Active target row AND an active wallet grant on the account. */
    "eligible",
    /** `disabled_at IS NOT NULL` — soft-deleted by the owner. */
    "disabled",
    /** Active target row, but no active grant: the silent-halt case. */
    "blocked_no_active_wallet_grant",
  ]),
  /** Human/agent-readable statement of the derivation above. */
  explanation: z.string(),
});

export const PolyPositionGapDecisionReasonSchema = z.enum([
  "allocated",
  "allocation_headroom",
  "below_market_floor",
  "blocked_by_opposite_hold",
  "cohort_waiting",
  "condition_closed",
  "invalid_target_mark",
  "invalid_cohort",
  "invalid_quote",
  "missing_cohort",
  "no_gap",
  "per_order_cap",
  "venue_unknown",
]);

/** Realized fill economics are public only after associated CLOB trades verify them. */
export const PolyPositionGapFillAccountingSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("pending"),
        source: z.literal("clob_order_receipt"),
      })
      .strict(),
    z
      .object({
        status: z.literal("verified"),
        source: z.literal("clob_associated_trades"),
        matched_order_count: z.number().int().positive(),
        realized_shares: z.number().positive(),
        /** Gross entry notional at execution VWAP; authoritative fees are excluded. */
        realized_entry_notional_usdc: z.number().positive(),
      })
      .strict(),
  ],
);

export const PolyPositionGapRuntimeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_applicable") }),
  z.object({
    status: z.literal("pending"),
    reason: z.literal("no_reconciliation_run"),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.literal("invalid_reconciliation_record"),
  }),
  z.object({
    status: z.literal("observed"),
    run: z.object({
      run_id: z.string().uuid(),
      status: z.enum(["running", "completed", "skipped", "halted", "failed"]),
      planner_version: z.string().nullable(),
      started_at: IsoTimestampSchema,
      completed_at: IsoTimestampSchema.nullable(),
      trigger_reasons: z.array(z.string()),
      error_code: z.string().nullable(),
    }),
    snapshot: z.object({
      snapshot_id: z.string().min(1).nullable(),
      as_of: IsoTimestampSchema.nullable(),
      expires_at: IsoTimestampSchema.nullable(),
      completeness: z.enum(["complete", "incomplete"]),
      freshness: z.enum(["fresh", "stale", "unknown"]),
    }),
    plan: z.object({
      status: z.enum(["ready", "no_feasible_position", "blocked"]),
      block_reason: z.enum(["invalid_input", "stale_snapshot"]).nullable(),
      eligible_net_nav_usdc: z.number().nonnegative(),
      scale: z.number().nonnegative(),
      sleeve_budget_usdc: z.number().positive(),
      reserved_budget_usdc: z.number().nonnegative(),
      free_sleeve_budget_usdc: z.number().nonnegative(),
      reserved_cash_guard_usdc: z.number().nonnegative(),
      free_wallet_cash_after_guards_usdc: z.number().nonnegative(),
      minimum_feasible_sleeve_usdc: z.number().nonnegative().nullable(),
      planned_order_count: z.number().int().nonnegative(),
      locked_overweight_count: z.number().int().nonnegative(),
    }),
    execution: z.object({
      scope: z.literal("target_lifetime"),
      submitted_order_count: z.number().int().nonnegative(),
      fill_accounting: PolyPositionGapFillAccountingSchema,
    }),
    position_count: z.number().int().nonnegative(),
    positions_truncated: z.boolean(),
    positions: z.array(z.object({
      condition_id: z.string().min(1),
      token_id: z.string().min(1),
      cohort_id: z.string().min(1).nullable(),
      decision_reason: PolyPositionGapDecisionReasonSchema,
      desired_shares: z.number().nonnegative(),
      held_shares: z.number().nonnegative(),
      open_shares: z.number().nonnegative(),
      gap_shares: z.number().nonnegative(),
      target_weight: z.number().nonnegative(),
      price_cap: z.number().positive().lt(1).nullable(),
      market_floor_usdc: z.number().nonnegative().nullable(),
      minimum_sleeve_usdc: z.number().nonnegative().nullable(),
      locked_overweight_shares: z.number().nonnegative(),
    })).max(2_000),
  }),
]);
export type PolyPositionGapRuntime = z.infer<typeof PolyPositionGapRuntimeSchema>;

export const PolyTrackedTargetSchema = z.object({
  target_id: z.string().uuid(),
  target_wallet: z.string(),
  active: z.boolean(),
  created_at: IsoTimestampSchema,
  /** Cold-start fence defining "first post-activation fill". */
  mirror_activated_at: IsoTimestampSchema,
  disabled_at: IsoTimestampSchema.nullable(),
  policy: PolyEffectiveSizingPolicySchema,
  activation: PolyTargetActivationSchema,
  position_gap_runtime: PolyPositionGapRuntimeSchema,
});
export type PolyTrackedTarget = z.infer<typeof PolyTrackedTargetSchema>;

/**
 * Active wallet safety caps — a DISCRIMINATED UNION, not a nullable object.
 *
 * NO_FABRICATED_VALUES is load-bearing here. Rendering an absent grant as
 * `{per_order_usdc_cap: 0, daily_usdc_cap: 0}` would be read by an agent as
 * "limits are zero / unlimited" when the truth is "this account cannot place a
 * live order at all". The `status` tag forces the caller to handle that.
 */
export const PolyWalletSafetyCapsSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("active"),
    grant_id: z.string().uuid(),
    /** Post-sizing ceiling for one order. A ceiling, never a target. */
    per_order_usdc_cap: z.number().positive(),
    daily_usdc_cap: z.number().positive(),
    hourly_fills_cap: z.number().int().positive(),
    scopes: z.array(z.string()),
    /** `null` means the grant does not expire. */
    expires_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
  }),
  z.object({
    status: z.literal("expired"),
    grant_id: z.string().uuid(),
    expires_at: IsoTimestampSchema,
    reason: z.literal("wallet_grant_expired"),
  }),
  z.object({
    status: z.literal("revoked"),
    grant_id: z.string().uuid(),
    revoked_at: IsoTimestampSchema,
    reason: z.literal("wallet_grant_revoked"),
  }),
  z.object({
    status: z.literal("absent"),
    reason: z.literal("no_wallet_grant_on_file"),
  }),
]);
export type PolyWalletSafetyCaps = z.infer<typeof PolyWalletSafetyCapsSchema>;

export const PolyAccountCopySetupResponseSchema = z.object({
  billing_account_id: z.string().uuid(),
  /** Server-frozen read time. Both source reads share this snapshot. */
  captured_at: IsoTimestampSchema,
  targets: z.array(PolyTrackedTargetSchema).max(POLY_COPY_SETUP_MAX_TARGETS),
  /** Count of ACTIVE targets, independent of the page bound. */
  active_target_count: z.number().int().nonnegative(),
  /** True when the account has more target rows than the hard bound returns. */
  targets_truncated: z.boolean(),
  wallet_safety: PolyWalletSafetyCapsSchema,
  /** Account-wide position-gap allocation from the same saved runtime observation. */
  budget_allocation: z.object({
    position_gap_target_count: z.number().int().nonnegative(),
    automatic_target_count: z.number().int().nonnegative(),
    explicit_budget_total_usdc: z.number().nonnegative(),
    unbudgeted_active_target_count: z.number().int().nonnegative(),
    shared_wallet_risk: z.boolean(),
    mirror_nav_usdc: z.number().nonnegative().nullable(),
    effective_budget_total_usdc: z.number().nonnegative().nullable(),
    overallocated: z.boolean().nullable(),
    observed_at: IsoTimestampSchema.nullable(),
    observation_status: z.enum([
      "pending",
      "stale",
      "observed",
      "blocked_multi_target",
    ]),
  }),
  /**
   * Names the two sources this capability joins, so a caller can tell which
   * half is which. `poly_copy_trade_config` is absent BY DESIGN — see
   * EFFECTIVE_POLICY_IS_DERIVED.
   */
  sources: z.object({
    targets: z.literal("poly_copy_trade_targets"),
    caps: z.literal("poly_wallet_grants"),
    config_table: z.literal("dropped_in_migration_0036"),
  }),
  completeness: z.object({
    complete: z.boolean(),
    targets_truncated: z.boolean(),
    caps_available: z.boolean(),
  }),
});
export type PolyAccountCopySetupResponse = z.infer<
  typeof PolyAccountCopySetupResponseSchema
>;

// ---------------------------------------------------------------------------
// Capability 2 — recent attempts (the decision tape)
// ---------------------------------------------------------------------------

export const PolyAttemptOutcomeSchema = z.enum(["placed", "skipped", "error"]);
export const PolyAttemptOutcomeFilterSchema = z.enum([
  "placed",
  "skipped",
  "error",
  "all",
]);

export const PolyAccountRecentAttemptsQuerySchema = z
  .object({
    billing_account_id: z.string().uuid(),
    mode: PolyCopyOperationsModeFilterSchema.default("all"),
    /**
     * Decision outcome filter. Pushed into SQL as a real predicate — NEVER
     * applied in JS after the LIMIT, which is the defect this capability
     * replaces (`copy-trade/orders/route.ts` filters `status` post-LIMIT, so a
     * page can come back short or empty while more matches exist).
     */
    outcome: PolyAttemptOutcomeFilterSchema.default("all"),
    target_id: z.string().uuid().optional(),
    since: OptionalIsoTimestampSchema,
    until: OptionalIsoTimestampSchema,
    /**
     * Frozen snapshot cutoff. OMIT on the first request — the server freezes
     * `clock_timestamp()` and returns it. Echo it back, with `cursor`, on every
     * subsequent page so tape membership cannot shift underneath pagination.
     */
    captured_at: OptionalIsoTimestampSchema,
    /** Opaque keyset cursor. Never parse or construct this client-side. */
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(POLY_COPY_ATTEMPTS_MAX_LIMIT)
      .default(POLY_COPY_ATTEMPTS_DEFAULT_LIMIT),
  })
  .refine(
    (query) =>
      !(query.since && query.until) ||
      Date.parse(query.since) <= Date.parse(query.until),
    { message: "`since` must be ≤ `until`", path: ["since"] },
  );
export type PolyAccountRecentAttemptsQuery = z.infer<
  typeof PolyAccountRecentAttemptsQuerySchema
>;

/**
 * What the mirror MEANT to do, straight from the decision's `intent` JSONB.
 * Present for every attempt including skips — a skip still has a sizing intent,
 * and comparing it against `executed` is the point.
 */
export const PolyAttemptIntendedSchema = z.object({
  side: z.enum(["BUY", "SELL"]).nullable(),
  token_id: z.string().nullable(),
  limit_price: z.number().nonnegative().nullable(),
  /** Intended notional. `null` when the decision recorded no size. */
  size_usdc: z.number().nonnegative().nullable(),
  position_branch: z.string().nullable(),
  target_position_usdc: z.number().nonnegative().nullable(),
});

/**
 * What actually happened on the ledger, correlated from `poly_copy_trade_fills`
 * on `(billing_account_id, target_id, fill_id)`.
 *
 * `availability` is the honest tag. A `skipped` decision has NO ledger row at
 * all, and that is a correct, expected state — not missing data. An absent row
 * is never rendered as zero shares or a zero price.
 */
export const PolyAttemptExecutedSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("observed"),
    status: z.string(),
    order_id: z.string().nullable(),
    observed_at: IsoTimestampSchema,
    position_lifecycle: z.string().nullable(),
    /** Realized VWAP. `null` before any fill is observed. */
    price: z.number().nonnegative().nullable(),
    shares: z.number().nonnegative().nullable(),
    fees_usdc: z.number().nonnegative().nullable(),
    /** Executed notional, `price * shares`. `null` until a fill lands. */
    filled_size_usdc: z.number().nonnegative().nullable(),
    /** Null for legacy/non-PG attempts; PG v3 is pending or trade-verified. */
    fill_accounting: PolyPositionGapFillAccountingSchema.nullable(),
    /** Last reconciler tick that got a typed CLOB response for this row. */
    synced_at: IsoTimestampSchema.nullable(),
  }),
  z.object({
    /** No ledger row — correct and expected for a skip. */
    availability: z.literal("no_order_placed"),
    reason: z.enum(["decision_skipped", "decision_errored"]),
  }),
  z.object({
    /**
     * The decision says `placed`, but no correlated ledger row exists. This is
     * a genuine INCONSISTENCY, not an expected absence, and it is called out
     * separately so it cannot be mistaken for a skip.
     */
    availability: z.literal("ledger_row_missing"),
    reason: z.literal("placed_decision_without_ledger_row"),
  }),
]);

/**
 * Whether a mark price / market resolution is ON FILE for this attempt's token.
 * Availability only — this capability reports whether the fact exists and when
 * it was observed, and never invents a price for an unpriced token.
 */
export const PolyAttemptMarkSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    price: z.number().nonnegative(),
    observed_at: IsoTimestampSchema,
  }),
  z.object({
    availability: z.literal("unavailable"),
    reason: z.enum(["no_mark_on_file", "no_token_id_on_attempt"]),
  }),
]);

export const PolyAttemptOutcomeResolutionSchema = z.discriminatedUnion(
  "availability",
  [
    z.object({
      availability: z.literal("resolved"),
      resolution: z.enum(["winner", "loser", "unknown"]),
      payout: z.number().nullable(),
      resolved_at: IsoTimestampSchema.nullable(),
    }),
    z.object({
      availability: z.literal("unavailable"),
      reason: z.enum(["market_unresolved", "no_token_id_on_attempt"]),
    }),
  ],
);

export const PolyCopyTradeAttemptSchema = z.object({
  /** The decision row's uuid. Stable, and half of the keyset cursor. */
  attempt_id: z.string().uuid(),
  decided_at: IsoTimestampSchema,
  target_id: z.string().uuid(),
  target_wallet: z.string().nullable(),
  /** The observed target fill this attempt mirrors. */
  fill_id: z.string(),
  /** Market, from the decision intent; the ledger row is the fallback. */
  market_id: z.string().nullable(),
  mode: PolyCopyOperationsModeSchema,
  /**
   * WHY. `reason` is the single most valuable field on this tape and is
   * invisible in the dashboard today, because that card reads the fills ledger
   * and a skip never reaches it.
   */
  decision: z.object({
    outcome: PolyAttemptOutcomeSchema,
    reason: z.string().nullable(),
  }),
  intended: PolyAttemptIntendedSchema,
  executed: PolyAttemptExecutedSchema,
  mark: PolyAttemptMarkSchema,
  outcome_resolution: PolyAttemptOutcomeResolutionSchema,
});
export type PolyCopyTradeAttempt = z.infer<typeof PolyCopyTradeAttemptSchema>;

export const PolyAccountRecentAttemptsResponseSchema = z.object({
  billing_account_id: z.string().uuid(),
  mode: PolyCopyOperationsModeFilterSchema,
  outcome: PolyAttemptOutcomeFilterSchema,
  target_id: z.string().uuid().nullable(),
  since: IsoTimestampSchema.nullable(),
  until: IsoTimestampSchema.nullable(),
  /** The frozen cutoff. Echo this back with `next_cursor`. */
  captured_at: IsoTimestampSchema,
  limit: z.number().int().positive(),
  attempts: z.array(PolyCopyTradeAttemptSchema),
  /** Opaque. `null` means this is the last page. */
  next_cursor: z.string().nullable(),
  /** True when more attempts match beyond this page. */
  truncated: z.boolean(),
  /**
   * How current the tape is. `most_recent_attempt_at` is the newest decision at
   * or before the cutoff; `null` means this account has never attempted a
   * mirror — a real and distinct state from "stale".
   */
  freshness: z.object({
    most_recent_attempt_at: IsoTimestampSchema.nullable(),
    staleness_seconds: z.number().nonnegative().nullable(),
    status: z.enum(["fresh", "stale", "never_attempted"]),
  }),
  completeness: z.object({
    complete: z.boolean(),
    truncated: z.boolean(),
    /** Attempts on this page whose `placed` decision has no ledger row. */
    attempts_missing_ledger_row: z.number().int().nonnegative(),
    /** Attempts on this page with no mark price on file. */
    attempts_missing_mark: z.number().int().nonnegative(),
    /** Named so nobody mistakes the spine for the fills ledger. */
    spine: z.literal("poly_copy_trade_decisions"),
  }),
});
export type PolyAccountRecentAttemptsResponse = z.infer<
  typeof PolyAccountRecentAttemptsResponseSchema
>;

// ---------------------------------------------------------------------------
// Pure operation descriptors
// ---------------------------------------------------------------------------

export const polyAccountCopySetupOperation = {
  id: "poly.account.copy-setup.v1",
  summary:
    "Current copy-trade setup for one authorized account: tracked targets, effective sizing policy per target, and active wallet safety caps",
  input: PolyAccountCopySetupQuerySchema,
  output: PolyAccountCopySetupResponseSchema,
} as const;

export const polyAccountRecentAttemptsOperation = {
  id: "poly.account.recent-attempts.v1",
  summary:
    "Frozen, cursor-paginated, account-wide tape of recent copy-trade mirror attempts including skip reasons, with intended vs executed size",
  input: PolyAccountRecentAttemptsQuerySchema,
  output: PolyAccountRecentAttemptsResponseSchema,
} as const;
