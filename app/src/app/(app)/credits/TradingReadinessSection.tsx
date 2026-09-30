// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/credits/TradingReadinessSection`
 * Purpose: "Enable Trading" surface on the Money page — renders the 8-step
 *   Polymarket approvals ceremony as visible per-step progress.
 * Scope: Client component. POSTs /api/v1/poly/wallet/enable-trading via
 *   React Query mutation; invalidates `poly-wallet-status` on success.
 * Invariants:
 *   - IDEMPOTENT_CTA: POSTing is safe at any time — backend skips satisfied
 *     targets. No client-side lockout beyond React Query's inflight flag.
 *   - PARTIAL_FAILURE_VISIBLE: per-step `state` surfaces as colored pills
 *     even when the overall outcome is `ready: false` — user sees which
 *     approval failed and retries.
 *   - CEREMONY_VISIBLE_ON_CLICK (bug.5311): clicking Enable trading renders
 *     the step list immediately in `pending`, before the response lands, so
 *     the ceremony is never an opaque spinner. `CEREMONY_STEP_LABELS` mirrors
 *     the adapter's pinned step order; it carries labels only, never
 *     addresses (APPROVAL_TARGETS_PINNED stays server-side).
 *   - RESULT_PERSISTS (bug.5311): a successful run keeps its returned
 *     checkmarks on screen instead of collapsing straight to a one-line
 *     badge. The compact badge is for steady state only — readiness that came
 *     from `/status` with no fresh mutation in this session.
 *   - NO_GAS_PREFLIGHT (bug.5310): canonical V2 approvals are relayer-paid
 *     gasless from the Deposit Wallet, so there is NO client-side POL
 *     balance gate. A pUSD-funded Deposit Wallet holding 0 POL must still be
 *     able to click Enable trading.
 *   - FUNDED_RECOLOR (task.0365): the compact badge swaps green for warning
 *     tokens when `isFunded=false` — "approvals on-chain, but $0 to trade".
 * Side-effects: IO (POST enable-trading; React Query cache invalidation).
 * Links: nodes/poly/packages/node-contracts/src/poly.wallet.enable-trading.v1.contract.ts,
 *        work/items/bug.5310, work/items/bug.5311
 * @public
 */

"use client";

import type {
  PolyWalletEnableTradingOutput,
  PolyWalletEnableTradingStep,
} from "@cogni/poly-node-contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";

export interface TradingReadinessSectionProps {
  /** From `poly.wallet.status.v1` — drives the initial view. */
  readonly tradingReady: boolean;
  /**
   * Whether the wallet holds any collateral (USDC.e + pUSD `> 0`). When
   * `tradingReady && !isFunded` the badge recolors to warning (FUNDED_RECOLOR).
   */
  readonly isFunded: boolean;
}

/**
 * Display-only mirror of the adapter's pinned ceremony order, used to render
 * `pending` rows the instant the user clicks — the server returns all 8 steps
 * at once, so without this the ceremony would be invisible while in flight.
 * Labels only: the pinned spender/operator addresses stay server-side.
 */
const CEREMONY_STEP_LABELS: readonly string[] = [
  "USDC.e → Onramp",
  "Move existing pUSD into Deposit Wallet",
  "pUSD → Exchange (V2)",
  "pUSD → Neg-Risk Exchange (V2)",
  "pUSD → Neg-Risk Adapter",
  "CTF → Exchange (V2)",
  "CTF → Neg-Risk Exchange (V2)",
  "CTF → Neg-Risk Adapter",
];

/** Client-side render state: the wire contract has no `pending`. */
type DisplayStepState = PolyWalletEnableTradingStep["state"] | "pending";

type DisplayStep = {
  readonly key: string;
  readonly label: string;
  readonly state: DisplayStepState;
  readonly txHash: string | null;
  readonly error: string | null;
};

const PENDING_STEPS: readonly DisplayStep[] = CEREMONY_STEP_LABELS.map(
  (label, i) => ({
    key: `pending:${i}`,
    label,
    state: "pending" as const,
    txHash: null,
    error: null,
  })
);

function toDisplaySteps(
  steps: PolyWalletEnableTradingOutput["steps"]
): readonly DisplayStep[] {
  return steps.map((step, i) => ({
    key: `${step.kind}:${step.operator}:${i}`,
    label: step.label,
    state: step.state,
    txHash: step.tx_hash,
    error: step.error,
  }));
}

async function postEnableTrading(): Promise<PolyWalletEnableTradingOutput> {
  const res = await fetch("/api/v1/poly/wallet/enable-trading", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `enable-trading failed: ${res.status}`);
  }
  return (await res.json()) as PolyWalletEnableTradingOutput;
}

export function TradingReadinessSection(
  props: TradingReadinessSectionProps
): ReactElement | null {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: postEnableTrading,
    onSuccess: (result) => {
      if (result.ready) {
        // Bust status so the rest of the page reflects readiness. The step
        // rows stay on screen regardless (RESULT_PERSISTS).
        qc.invalidateQueries({ queryKey: ["poly-wallet-status"] });
      }
    },
  });

  const result = mutation.data;
  const inFlight = mutation.isPending;
  const derivedReady = result?.ready ?? props.tradingReady;

  // RESULT_PERSISTS: collapse to the compact badge ONLY in steady state —
  // readiness from `/status` with no mutation attempted in this session. Once
  // the user has clicked, the returned checkmarks stay visible.
  if (props.tradingReady && !result && !inFlight && !mutation.isError) {
    const tone = props.isFunded
      ? "border-success/30 bg-success/10 text-success"
      : "border-warning/40 bg-warning/10 text-warning";
    const sub = props.isFunded
      ? "Approvals signed in-app"
      : "Approvals signed · add pUSD or USDC.e to trade";
    const subTone = props.isFunded ? "text-success/70" : "text-warning/80";
    return (
      <div
        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${tone}`}
      >
        <CheckCircle2 size={16} />
        <span className="font-medium">Trading enabled</span>
        <span className={`text-xs ${subTone}`}>· {sub}</span>
      </div>
    );
  }

  // CEREMONY_VISIBLE_ON_CLICK: pending rows during flight, real rows after.
  const displaySteps: readonly DisplayStep[] | null = inFlight
    ? PENDING_STEPS
    : result
      ? toDisplaySteps(result.steps)
      : null;

  const heading = inFlight
    ? "Authorizing trading…"
    : derivedReady
      ? "Trading enabled"
      : "Authorize trading";

  const subheading = inFlight
    ? "Signing approvals from your trading wallet. No gas needed — Polymarket's relayer pays."
    : derivedReady
      ? "Polymarket approvals are on-chain. We signed them from your trading wallet—no browser wallet."
      : "8 approvals, server-signed from your trading wallet. No extension popup, no gas.";

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-sm">{heading}</span>
          <span className="text-muted-foreground text-xs leading-snug">
            {subheading}
          </span>
        </div>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={inFlight}
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {inFlight ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Authorizing…
            </>
          ) : derivedReady ? (
            "Re-check"
          ) : (
            "Enable trading"
          )}
        </button>
      </div>

      {displaySteps ? <StepRows steps={displaySteps} /> : null}

      {mutation.isError ? (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {(mutation.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}

function StepRows({
  steps,
}: {
  steps: readonly DisplayStep[];
}): ReactElement {
  return (
    <ul className="flex flex-col gap-1.5">
      {steps.map((step) => (
        <li key={step.key} className="flex items-center gap-2 text-xs">
          <StateIcon state={step.state} />
          <span className="flex-1 truncate">{step.label}</span>
          {step.txHash ? (
            <a
              href={`https://polygonscan.com/tx/${step.txHash}`}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate font-mono text-muted-foreground text-xs underline-offset-2 hover:underline"
            >
              {step.txHash.slice(0, 10)}…
            </a>
          ) : null}
          {step.error ? (
            <span className="truncate text-destructive text-xs">
              {step.error}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function StateIcon({ state }: { state: DisplayStepState }): ReactElement {
  if (state === "satisfied" || state === "set") {
    return <CheckCircle2 size={14} className="text-success" />;
  }
  if (state === "failed") {
    return <XCircle size={14} className="text-destructive" />;
  }
  if (state === "pending") {
    return <Loader2 size={14} className="animate-spin text-primary" />;
  }
  // "skipped" — pre-flight gate not met, rendered as dim circle.
  return <Circle size={14} className="text-muted-foreground" />;
}
