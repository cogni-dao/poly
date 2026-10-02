// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Owner-only escape hatch for a broken, empty trading-wallet connection. */

"use client";

import type { PolyWalletResetConnectionOutput } from "@cogni/poly-node-contracts";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { type ReactElement, useState } from "react";

const RESET_CONFIRMATION = "RESET_WALLET_CONNECTION" as const;

function blockedMessage(
  reason: PolyWalletResetConnectionOutput["blocked_reason"]
): string {
  switch (reason) {
    case "residual_balance":
      return "Withdraw every USDC.e, pUSD, and POL balance before resetting.";
    case "balance_read_failed":
      return "Balances could not be verified. Reset is blocked to protect your funds; retry shortly.";
    case "unsettled_orders":
      return "Open or pending orders still exist. Cancel or settle them before resetting.";
    default:
      return "The wallet connection could not be reset.";
  }
}

export function TradingWalletResetButton({
  onReset,
}: {
  onReset: (retryAfterSeconds: number) => void;
}): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = async (): Promise<void> => {
    const confirmed = window.confirm(
      "Reset this trading-wallet connection? This disables copy targets and revokes trading access. It never moves funds and will proceed only when balances are verified empty and no orders are unsettled."
    );
    if (!confirmed) return;

    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/poly/wallet/reset-connection", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: RESET_CONFIRMATION }),
      });
      const payload = (await response.json()) as
        | PolyWalletResetConnectionOutput
        | { error?: string };
      if (!response.ok) {
        if ("blocked_reason" in payload) {
          setError(blockedMessage(payload.blocked_reason));
        } else {
          setError("The wallet connection could not be reset. Please retry.");
        }
        return;
      }
      if (!("outcome" in payload)) {
        setError("The wallet connection returned an unexpected response.");
        return;
      }
      onReset(payload.reprovision_available_in_seconds);
    } catch {
      setError("The wallet connection could not be reset. Please retry.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-start gap-2 text-xs">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-destructive"
          size={15}
        />
        <p className="text-muted-foreground leading-snug">
          Wallet credentials broken? Reset only after withdrawing all funds and
          settling every order. Your wallet history is preserved.
        </p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => void reset()}
        className="inline-flex items-center justify-center gap-2 rounded-md border border-destructive/40 px-3 py-2 font-medium text-destructive text-sm transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RotateCcw aria-hidden="true" size={15} />
        {pending ? "Checking wallet…" : "Reset wallet connection"}
      </button>
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
