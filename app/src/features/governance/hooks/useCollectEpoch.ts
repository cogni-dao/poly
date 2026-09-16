// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useCollectEpoch`
 * Purpose: Trigger contribution collection on demand and refresh the epoch overview.
 * Scope: Client-side request state for the existing collect schedule trigger. Does not run collection logic.
 * Invariants: SAME_TEMPORAL_SCHEDULE_PATH, SERVER_COOLDOWN_AUTHORITATIVE, ACTIVE_EPOCHS_REFETCHED.
 * Side-effects: IO (HTTP POST, React Query refetch)
 * Links: src/app/api/v1/attribution/epochs/collect/route.ts
 * @public
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_COOLDOWN_SECONDS = 300;

interface ErrorResponse {
  readonly error?: unknown;
  readonly retryAfterSeconds?: unknown;
}

async function readErrorResponse(response: Response): Promise<ErrorResponse> {
  return response
    .json()
    .catch(() => ({ error: response.statusText })) as Promise<ErrorResponse>;
}

function errorMessage(body: ErrorResponse, fallback: string): string {
  return typeof body.error === "string" ? body.error : fallback;
}

function retryDelay(body: ErrorResponse): number {
  return typeof body.retryAfterSeconds === "number" &&
    Number.isFinite(body.retryAfterSeconds) &&
    body.retryAfterSeconds > 0
    ? Math.ceil(body.retryAfterSeconds)
    : DEFAULT_COOLDOWN_SECONDS;
}

export function useCollectEpoch() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState<number | null>(null);
  const requestInFlight = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (cooldownSeconds === null) return;
    const timeout = window.setTimeout(() => {
      setCooldownSeconds(null);
      setSuccessMessage(null);
    }, cooldownSeconds * 1000);
    return () => window.clearTimeout(timeout);
  }, [cooldownSeconds]);

  const trigger = useCallback(async () => {
    if (requestInFlight.current || cooldownSeconds !== null) return;

    requestInFlight.current = true;
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch("/api/v1/attribution/epochs/collect", {
        method: "POST",
        credentials: "same-origin",
      });

      if (response.status === 429) {
        const body = await readErrorResponse(response);
        setCooldownSeconds(retryDelay(body));
        return;
      }

      if (!response.ok) {
        const body = await readErrorResponse(response);
        setError(errorMessage(body, `HTTP ${response.status}`));
        return;
      }

      await queryClient.refetchQueries({
        queryKey: ["governance"],
        type: "active",
      });
      setSuccessMessage(
        "Sync started. Epoch data refreshed; new contributions may take a moment to appear."
      );
      setCooldownSeconds(DEFAULT_COOLDOWN_SECONDS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unknown error");
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, [cooldownSeconds, queryClient]);

  return {
    loading,
    error,
    successMessage,
    cooldownSeconds,
    trigger,
  };
}
