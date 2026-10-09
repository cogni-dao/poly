// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_components/ExecutionActivityCard`
 * Purpose: Unified Polymarket execution surface for the dashboard — two
 * sibling tabs (`Positions`, `Markets`), each with an internal Live/Closed
 * filter. Mirrors the structural symmetry between per-position and
 * per-market-group views.
 * Scope: Client component. Read-only. Live rows sourced from
 * live_positions; closed rows from closed_positions.
 * Invariants:
 *   - LIVE_POSITIONS_ONLY_IN_LIVE_FILTER: the Positions tab renders only
 *     live_positions rows when statusFilter==="live".
 *   - CLOSE_BUTTON_ONLY_ON_LIVE_FILTER: closed filter is read-only
 *     (PositionsTable variant="history").
 *   - NO_STALE_OPEN_ROW_AFTER_CLOSE: recentlyClosedIds suppresses closed
 *     rows until the next live_positions refetch confirms they are gone.
 *     Applies only when statusFilter==="live"; closed rows are sourced
 *     from closed_positions which is unaffected by close-action latency.
 *   - MISSING_MODEL_IS_NOT_EMPTY: when the current-position read model is
 *     unavailable, the Live count and empty state render as unavailable rather
 *     than claiming there are zero open positions.
 *   - DELTA_HISTOGRAM_ALWAYS_VISIBLE: each execution tab always mounts its
 *     bounded histogram from the finite deltas in the shared portfolio
 *     snapshot. Freshness and coverage metadata never suppress the chart.
 *   - SHARED_ACCOUNT_READ: the owner dashboard and approved account-read tools
 *     receive this same snapshot through `portfolioSnapshotAccountReadHandler`.
 * Side-effects: IO (React Query), clipboard (user-triggered).
 * Links: [fetchExecution](../_api/fetchExecution.ts)
 * @public
 */

"use client";

import type {
  PolyWalletOverviewInterval,
  WalletExecutionMarketGroup,
} from "@cogni/poly-node-contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  MarketsDeltaDistribution,
  MarketsTable,
  PositionsDeltaDistribution,
  type StatusFilter,
} from "@/app/(app)/_components/markets-table";
import { PositionsTable } from "@/app/(app)/_components/positions-table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ToggleGroup,
  ToggleGroupItem,
} from "@/components";
import {
  TimeWindowHeader,
  type WalletPosition,
} from "@/features/wallet-analysis";
import {
  postClosePosition,
  postRedeemPosition,
} from "../_api/fetchPositionActions";
import {
  invalidateWalletDashboardSnapshot,
  useWalletDashboard,
} from "../_hooks/useWalletDashboard";

type ExecutionView = "positions" | "markets";

const LIVE_POSITION_UNAVAILABLE_CODES = new Set([
  "current_positions_wallet_missing",
  "current_positions_never_observed",
  "current_positions_read_model_unavailable",
]);

const CLOSED_POSITION_UNAVAILABLE_CODES = new Set([
  "history_unavailable",
]);

export function ExecutionActivityCard(): ReactElement {
  const queryClient = useQueryClient();
  const [view, setView] = useState<ExecutionView>("positions");
  const [positionActionError, setPositionActionError] = useState<string | null>(
    null
  );

  // Per-item suppression: ids added on close success, removed when refetch
  // confirms the position is gone from live_positions.
  const [recentlyClosedIds, setRecentlyClosedIds] = useState<
    ReadonlySet<string>
  >(new Set());

  useEffect(() => {
    if (window.location.hash === "#markets") setView("markets");
  }, []);

  const positionAction = useMutation({
    mutationFn: async (args: {
      kind: "close" | "redeem";
      position: WalletPosition;
    }) => {
      if (args.kind === "close") {
        return postClosePosition(args.position.asset);
      }
      return postRedeemPosition(args.position.conditionId);
    },
    onSuccess: (result, vars) => {
      setPositionActionError(null);
      const shouldSuppress =
        vars.kind === "redeem"
          ? "tx_hash" in result
          : "kind" in result &&
            (result.kind === "order" || result.kind === "classified");
      if (shouldSuppress) {
        setRecentlyClosedIds(
          (prev) => new Set([...prev, vars.position.positionId])
        );
      }
      void invalidateWalletDashboardSnapshot(queryClient);
    },
    onError: (err: unknown) => {
      setPositionActionError(err instanceof Error ? err.message : String(err));
    },
  });

  const pendingActionPositionId =
    positionAction.isPending && positionAction.variables
      ? positionAction.variables.position.positionId
      : null;

  const handlePositionAction = useCallback(
    (position: WalletPosition, action: "close" | "redeem") => {
      positionAction.mutate({ kind: action, position });
    },
    [positionAction]
  );

  const dashboard = useWalletDashboard();
  const executionData = dashboard.data?.execution;
  const isPaperAccount = dashboard.data?.overview?.account_kind === "paper";
  const actionsAllowed = dashboard.data?.facts.positions.actionsAllowed === true;
  useEffect(() => {
    if (!executionData) return;
    const liveIds = new Set(
      executionData.live_positions.map((position) => position.positionId)
    );
    setRecentlyClosedIds((prev) => {
      const next = new Set([...prev].filter((id) => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [executionData]);
  const isExecutionLoading = dashboard.isLoading;
  const isExecutionError = dashboard.isError;
  const accessWarning =
    dashboard.data?.overview?.configured === false
      ? {
          code: "wallet_adapter_unconfigured",
          message: "Trading-wallet execution is unavailable on this deployment.",
        }
      : executionData?.warnings.find((warning) =>
          ["wallet_adapter_unconfigured", "no_trading_wallet"].includes(
            warning.code
          )
        );

  const openPositions = useMemo<WalletPosition[]>(
    () =>
      (executionData?.live_positions ?? [])
        .filter((p) => !recentlyClosedIds.has(p.positionId))
        .map((position) => ({
          ...position,
          ...(position.marketSlug !== null
            ? { marketSlug: position.marketSlug }
            : {}),
          ...(position.eventSlug !== null
            ? { eventSlug: position.eventSlug }
            : {}),
          ...(position.marketUrl !== null
            ? { marketUrl: position.marketUrl }
            : {}),
          ...(position.closedAt !== null
            ? { closedAt: position.closedAt }
            : {}),
        })),
    [executionData?.live_positions, recentlyClosedIds]
  );

  const closedPositions = useMemo<WalletPosition[]>(
    () =>
      (executionData?.closed_positions ?? []).map((position) => ({
        ...position,
        ...(position.marketSlug !== null
          ? { marketSlug: position.marketSlug }
          : {}),
        ...(position.eventSlug !== null
          ? { eventSlug: position.eventSlug }
          : {}),
        ...(position.marketUrl !== null
          ? { marketUrl: position.marketUrl }
          : {}),
        ...(position.closedAt !== null ? { closedAt: position.closedAt } : {}),
      })),
    [executionData?.closed_positions]
  );

  return (
    <Card id="markets">
      <CardHeader className="px-5 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
              Execution
            </CardTitle>
          </div>

          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value) setView(value as ExecutionView);
            }}
            className="rounded-lg border"
          >
            <ToggleGroupItem value="positions" className="px-3 text-xs">
              Positions
            </ToggleGroupItem>
            <ToggleGroupItem value="markets" className="px-3 text-xs">
              Markets
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {accessWarning ? (
          <p
            className="px-5 py-6 text-center text-muted-foreground text-sm"
            role="status"
          >
            {accessWarning.code === "no_trading_wallet"
              ? "Connect a trading wallet from Money to see execution activity."
              : "Trading-wallet execution is unavailable on this deployment."}
          </p>
        ) : view === "positions" ? (
          <PositionsPanel
            openPositions={openPositions}
            livePositionCount={executionData?.live_position_count}
            closedPositionCount={executionData?.closed_position_count}
            closedPositions={closedPositions}
            groups={executionData?.market_groups ?? []}
            warnings={executionData?.warnings ?? []}
            isLoading={isExecutionLoading}
            isError={isExecutionError}
            onPositionAction={actionsAllowed ? handlePositionAction : undefined}
            actionsAllowed={actionsAllowed}
            isPaperAccount={isPaperAccount}
            pendingActionPositionId={pendingActionPositionId}
            positionActionError={positionActionError}
            interval={dashboard.interval}
            onIntervalChange={dashboard.setInterval}
          />
        ) : (
          <MarketGroupsPanel
            groups={executionData?.market_groups ?? []}
            warnings={executionData?.warnings ?? []}
            isLoading={isExecutionLoading}
            isError={isExecutionError}
            interval={dashboard.interval}
            onIntervalChange={dashboard.setInterval}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MarketGroupsPanel({
  groups,
  warnings,
  isLoading,
  isError,
  interval,
  onIntervalChange,
}: {
  groups: readonly WalletExecutionMarketGroup[];
  warnings: readonly { code: string; message: string }[];
  isLoading: boolean;
  isError: boolean;
  interval: PolyWalletOverviewInterval;
  onIntervalChange: (interval: PolyWalletOverviewInterval) => void;
}): ReactElement {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("live");

  if (isError) {
    return (
      <p className="px-5 py-6 text-center text-muted-foreground text-sm">
        Failed to load market exposure. Try again shortly.
      </p>
    );
  }

  const exposureUnavailable = warnings.some(
    (warning) => warning.code === "market_exposure_unavailable"
  );
  return (
    <div className="space-y-3 px-5 pb-4">
      <div className="space-y-2">
        <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Markets
        </h3>
        <MarketsDeltaDistribution groups={groups} statusFilter={statusFilter} />
        {exposureUnavailable ? (
          <p
            className="py-6 text-center text-muted-foreground text-sm"
            role="status"
          >
            Market exposure temporarily unavailable.
          </p>
        ) : (
          <>
            {statusFilter === "closed" ? (
              <TimeWindowHeader
                interval={interval}
                onIntervalChange={onIntervalChange}
              />
            ) : null}
            <MarketsTable
              groups={groups}
              isLoading={isLoading}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
            />
          </>
        )}
      </div>
    </div>
  );
}

function PositionsPanel({
  openPositions,
  livePositionCount,
  closedPositionCount,
  closedPositions,
  groups,
  warnings,
  isLoading,
  isError,
  onPositionAction,
  actionsAllowed,
  isPaperAccount,
  pendingActionPositionId,
  positionActionError,
  interval,
  onIntervalChange,
}: {
  openPositions: readonly WalletPosition[];
  livePositionCount?: number | null | undefined;
  closedPositionCount?: number | null | undefined;
  closedPositions: readonly WalletPosition[];
  groups: readonly WalletExecutionMarketGroup[];
  warnings: readonly { code: string; message: string }[];
  isLoading: boolean;
  isError: boolean;
  onPositionAction?:
    | ((position: WalletPosition, action: "close" | "redeem") => void)
    | undefined;
  actionsAllowed: boolean;
  isPaperAccount: boolean;
  pendingActionPositionId: string | null;
  positionActionError: string | null;
  interval: PolyWalletOverviewInterval;
  onIntervalChange: (interval: PolyWalletOverviewInterval) => void;
}): ReactElement {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("live");

  if (isError) {
    return (
      <p className="px-5 py-6 text-center text-muted-foreground text-sm">
        Failed to load execution data. Try again shortly.
      </p>
    );
  }

  const isLive = statusFilter === "live";
  const positions = isLive ? openPositions : closedPositions;
  const liveInventoryUnavailable = warnings.some((warning) =>
    LIVE_POSITION_UNAVAILABLE_CODES.has(warning.code)
  );
  const closedInventoryUnavailable = warnings.some((warning) =>
    CLOSED_POSITION_UNAVAILABLE_CODES.has(warning.code)
  );
  return (
    <div className="space-y-3 px-5 pb-4">
      <div className="space-y-2">
        <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Positions
        </h3>
        <PositionsDeltaDistribution
          positions={positions}
          groups={groups}
          statusFilter={statusFilter}
        />
        {isLive && !actionsAllowed && !liveInventoryUnavailable ? (
          <p className="text-muted-foreground text-xs" role="status">
            {isPaperAccount
              ? "Manual position actions are unavailable for paper accounts."
              : "Position actions are paused until the inventory snapshot is fresh."}
          </p>
        ) : null}
        {isLive && positionActionError ? (
          <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {positionActionError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={statusFilter}
            onValueChange={(value) => {
              if (value === "live" || value === "closed")
                setStatusFilter(value);
            }}
            disabled={isLoading}
            aria-label="Filter positions by status"
          >
            <ToggleGroupItem value="live" className="gap-1.5">
              <span className="text-xs">Live</span>
              <span className="font-mono text-muted-foreground text-xs tabular-nums">
                ({liveInventoryUnavailable
                  ? "—"
                  : (livePositionCount ?? openPositions.length)})
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="closed" className="gap-1.5">
              <span className="text-xs">Closed</span>
              <span className="font-mono text-muted-foreground text-xs tabular-nums">
                ({closedInventoryUnavailable
                  ? "—"
                  : (closedPositionCount ?? closedPositions.length)})
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {!isLive ? (
          <TimeWindowHeader
            interval={interval}
            onIntervalChange={onIntervalChange}
          />
        ) : null}
        {isLive ? (
          <PositionsTable
            positions={positions}
            isLoading={isLoading}
            emptyMessage={
              liveInventoryUnavailable
                ? "Open positions unavailable."
                : "No open positions."
            }
            onPositionAction={onPositionAction}
            pendingActionPositionId={pendingActionPositionId}
          />
        ) : (
          <PositionsTable
            positions={positions}
            isLoading={isLoading}
            variant="history"
            emptyMessage={
              closedInventoryUnavailable
                ? "Closed position history unavailable."
                : "No closed positions yet."
            }
          />
        )}
      </div>
    </div>
  );
}
