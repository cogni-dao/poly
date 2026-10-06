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
 *   - DELTA_COVERAGE_FAILS_CLOSED: the container renders backend-owned
 *     population/sample coverage and invokes legacy charts only for a trusted,
 *     internally consistent sample.
 * Side-effects: IO (React Query), clipboard (user-triggered).
 * Links: [fetchExecution](../_api/fetchExecution.ts)
 * @public
 */

"use client";

import type {
  WalletDashboardComparisonCoverage,
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
import type { WalletPosition } from "@/features/wallet-analysis";
import {
  postClosePosition,
  postRedeemPosition,
} from "../_api/fetchPositionActions";
import {
  useWalletDashboard,
  invalidateWalletDashboardSnapshot,
} from "../_hooks/useWalletDashboard";
import {
  comparisonCoverageReasonText,
  type DeltaCoverageCounts,
  projectMarketDeltaInput,
  projectPositionDeltaInput,
  resolveDeltaCoverageState,
} from "./dashboard-delta-coverage";

type ExecutionView = "positions" | "markets";

const LIVE_POSITION_UNAVAILABLE_CODES = new Set([
  "current_positions_wallet_missing",
  "current_positions_never_observed",
  "current_positions_read_model_unavailable",
]);

const CLOSED_POSITION_UNAVAILABLE_CODES = new Set([
  "history_unavailable",
]);

const COMPARISON_COVERAGE_ROW_CLASS =
  "flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs";
const COMPARISON_COVERAGE_VALUE_CLASS =
  "font-mono text-foreground tabular-nums";
const COMPARISON_WARNING_CLASS =
  "rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-300";
const COMPARISON_UNAVAILABLE_CLASS =
  "rounded border border-border bg-muted/40 px-2 py-2 text-muted-foreground text-xs";

function comparisonCoverageText(
  counts: DeltaCoverageCounts,
  entityLabel: "markets" | "positions"
): string {
  return `Compared ${counts.comparable} of ${counts.eligible} ${entityLabel} · ${counts.dropped} excluded`;
}

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
    dashboard.data?.overview.configured === false
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
    <Card>
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
            comparisonCoverage={executionData?.comparisonCoverage}
            warnings={executionData?.warnings ?? []}
            isLoading={isExecutionLoading}
            isError={isExecutionError}
            onPositionAction={actionsAllowed ? handlePositionAction : undefined}
            actionsAllowed={actionsAllowed}
            pendingActionPositionId={pendingActionPositionId}
            positionActionError={positionActionError}
          />
        ) : (
          <MarketGroupsPanel
            groups={executionData?.market_groups ?? []}
            comparisonCoverage={executionData?.comparisonCoverage}
            warnings={executionData?.warnings ?? []}
            isLoading={isExecutionLoading}
            isError={isExecutionError}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MarketGroupsPanel({
  groups,
  comparisonCoverage,
  warnings,
  isLoading,
  isError,
}: {
  groups: readonly WalletExecutionMarketGroup[];
  comparisonCoverage?: WalletDashboardComparisonCoverage | undefined;
  warnings: readonly { code: string; message: string }[];
  isLoading: boolean;
  isError: boolean;
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
  const exposureTruncated = warnings.some(
    (warning) => warning.code === "market_exposure_preview_truncated"
  );
  const marketDeltaInput = projectMarketDeltaInput(groups, statusFilter);
  const marketCoverageState = resolveDeltaCoverageState({
    coverage: comparisonCoverage?.markets[statusFilter],
    sampleCount: marketDeltaInput.sampleCount,
    identityAmbiguous: marketDeltaInput.identityAmbiguous,
    inputInvalid: marketDeltaInput.inputInvalid,
  });
  const marketCoverageReasons = comparisonCoverageReasonText(
    marketCoverageState.reasons
  );

  return (
    <div className="space-y-3 px-5 pb-4">
      <div className="space-y-2">
        <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Markets
        </h3>
        {exposureUnavailable ? (
          <p
            className="py-6 text-center text-muted-foreground text-sm"
            role="status"
          >
            Market exposure temporarily unavailable.
          </p>
        ) : (
          <>
            {exposureTruncated ? (
              <p className="text-muted-foreground text-xs" role="status">
                Showing a bounded market-comparison preview.
              </p>
            ) : null}
            {!isLoading ? (
              marketCoverageState.kind === "empty" ? (
                <div className="space-y-1">
                  <div className={COMPARISON_COVERAGE_ROW_CLASS}>
                    <span>
                      {comparisonCoverageText(
                        marketCoverageState.counts,
                        "markets"
                      )}
                    </span>
                    <span>
                      Chart sample{" "}
                      <span className={COMPARISON_COVERAGE_VALUE_CLASS}>
                        {marketCoverageState.counts.sampled} of{" "}
                        {marketCoverageState.counts.comparable}
                      </span>
                    </span>
                  </div>
                  <p className={COMPARISON_UNAVAILABLE_CLASS}>
                    No eligible {statusFilter} markets.
                  </p>
                </div>
              ) : marketCoverageState.kind === "unavailable" ? (
                <p className={COMPARISON_UNAVAILABLE_CLASS} role="status">
                  Delta comparison unavailable. {marketCoverageState.counts
                    ? `${comparisonCoverageText(marketCoverageState.counts, "markets")}. Chart sample ${marketCoverageState.counts.sampled} of ${marketCoverageState.counts.comparable}.`
                    : "Comparison coverage unavailable."}
                  {marketCoverageState.invalid
                    ? " Reported coverage is inconsistent."
                    : ""}
                  {marketCoverageReasons
                    ? ` ${marketCoverageReasons}`
                    : ""}
                </p>
              ) : (
                <div className="space-y-2">
                  <div className={COMPARISON_COVERAGE_ROW_CLASS}>
                    <span>
                      {comparisonCoverageText(
                        marketCoverageState.counts,
                        "markets"
                      )}
                    </span>
                    <span>
                      Chart sample{" "}
                      <span className={COMPARISON_COVERAGE_VALUE_CLASS}>
                        {marketCoverageState.counts.sampled} of{" "}
                        {marketCoverageState.counts.comparable}
                      </span>
                    </span>
                  </div>
                  {marketCoverageState.kind === "partial" ? (
                    <p className={COMPARISON_WARNING_CLASS} role="status">
                      Partial comparison.
                      {marketCoverageState.suppressChart
                        ? " The histogram is withheld."
                        : ""}
                      {marketCoverageReasons
                        ? ` ${marketCoverageReasons}`
                        : ""}
                    </p>
                  ) : null}
                  {!marketCoverageState.suppressChart &&
                  marketCoverageState.counts.sampled > 0 ? (
                    <MarketsDeltaDistribution
                      groups={marketDeltaInput.groups}
                      statusFilter={statusFilter}
                    />
                  ) : null}
                </div>
              )
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
  comparisonCoverage,
  warnings,
  isLoading,
  isError,
  onPositionAction,
  actionsAllowed,
  pendingActionPositionId,
  positionActionError,
}: {
  openPositions: readonly WalletPosition[];
  livePositionCount?: number | null | undefined;
  closedPositionCount?: number | null | undefined;
  closedPositions: readonly WalletPosition[];
  groups: readonly WalletExecutionMarketGroup[];
  comparisonCoverage?: WalletDashboardComparisonCoverage | undefined;
  warnings: readonly { code: string; message: string }[];
  isLoading: boolean;
  isError: boolean;
  onPositionAction?:
    | ((position: WalletPosition, action: "close" | "redeem") => void)
    | undefined;
  actionsAllowed: boolean;
  pendingActionPositionId: string | null;
  positionActionError: string | null;
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
  const positionDeltaInput = projectPositionDeltaInput(
    positions,
    groups,
    statusFilter
  );
  const positionCoverageState = resolveDeltaCoverageState({
    coverage: comparisonCoverage?.positions[statusFilter],
    sampleCount: positionDeltaInput.sampleCount,
    identityAmbiguous: positionDeltaInput.identityAmbiguous,
    inputInvalid: positionDeltaInput.inputInvalid,
  });
  const positionCoverageReasons = comparisonCoverageReasonText(
    positionCoverageState.reasons
  );
  const liveInventoryUnavailable = warnings.some((warning) =>
    LIVE_POSITION_UNAVAILABLE_CODES.has(warning.code)
  );
  const closedInventoryUnavailable = warnings.some((warning) =>
    CLOSED_POSITION_UNAVAILABLE_CODES.has(warning.code)
  );
  const selectedInventoryUnavailable = isLive
    ? liveInventoryUnavailable
    : closedInventoryUnavailable;
  const previewTruncated = warnings.some(
    (warning) => warning.code === "positions_preview_truncated"
  );
  const otherWarnings = warnings.some(
    (warning) =>
      ![
        "positions_preview_truncated",
        "market_exposure_unavailable",
        "daily_trade_counts_unavailable",
      ].includes(warning.code) &&
      !(isLive
        ? LIVE_POSITION_UNAVAILABLE_CODES
        : CLOSED_POSITION_UNAVAILABLE_CODES
      ).has(warning.code)
  );

  return (
    <div className="space-y-3 px-5 pb-4">
      <div className="space-y-2">
        <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Positions
        </h3>
        {isLive && previewTruncated ? (
          <p className="text-muted-foreground text-xs">
            Showing a bounded preview; the Live count is the exact full inventory.
          </p>
        ) : otherWarnings ? (
          <p className="text-muted-foreground text-xs">
            Some upstream data is temporarily unavailable, so a few rows may
            render with a shorter trace.
          </p>
        ) : null}
        {isLive && !actionsAllowed && !liveInventoryUnavailable ? (
          <p className="text-muted-foreground text-xs" role="status">
            Position actions are paused until the inventory snapshot is fresh.
          </p>
        ) : null}
        {isLive && positionActionError ? (
          <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {positionActionError}
          </p>
        ) : null}
        {!selectedInventoryUnavailable && !isLoading ? (
          positionCoverageState.kind === "empty" ? (
            <div className="space-y-1">
              <div className={COMPARISON_COVERAGE_ROW_CLASS}>
                <span>
                  {comparisonCoverageText(
                    positionCoverageState.counts,
                    "positions"
                  )}
                </span>
                <span>
                  Chart sample{" "}
                  <span className={COMPARISON_COVERAGE_VALUE_CLASS}>
                    {positionCoverageState.counts.sampled} of{" "}
                    {positionCoverageState.counts.comparable}
                  </span>
                </span>
              </div>
              <p className={COMPARISON_UNAVAILABLE_CLASS}>
                No eligible {statusFilter} positions.
              </p>
            </div>
          ) : positionCoverageState.kind === "unavailable" ? (
            <p className={COMPARISON_UNAVAILABLE_CLASS} role="status">
              Delta comparison unavailable. {positionCoverageState.counts
                ? `${comparisonCoverageText(positionCoverageState.counts, "positions")}. Chart sample ${positionCoverageState.counts.sampled} of ${positionCoverageState.counts.comparable}.`
                : "Comparison coverage unavailable."}
              {positionCoverageState.invalid
                ? " Reported coverage is inconsistent."
                : ""}
              {positionCoverageReasons ? ` ${positionCoverageReasons}` : ""}
            </p>
          ) : (
            <div className="space-y-2">
              <div className={COMPARISON_COVERAGE_ROW_CLASS}>
                <span>
                  {comparisonCoverageText(
                    positionCoverageState.counts,
                    "positions"
                  )}
                </span>
                <span>
                  Chart sample{" "}
                  <span className={COMPARISON_COVERAGE_VALUE_CLASS}>
                    {positionCoverageState.counts.sampled} of{" "}
                    {positionCoverageState.counts.comparable}
                  </span>
                </span>
              </div>
              {positionCoverageState.kind === "partial" ? (
                <p className={COMPARISON_WARNING_CLASS} role="status">
                  Partial comparison.
                  {positionCoverageState.suppressChart
                    ? " The histogram is withheld."
                    : ""}
                  {positionCoverageReasons
                    ? ` ${positionCoverageReasons}`
                    : ""}
                </p>
              ) : null}
              {!positionCoverageState.suppressChart &&
              positionCoverageState.counts.sampled > 0 ? (
                <PositionsDeltaDistribution
                  positions={positionDeltaInput.positions}
                  groups={positionDeltaInput.groups}
                  statusFilter={statusFilter}
                />
              ) : null}
            </div>
          )
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
