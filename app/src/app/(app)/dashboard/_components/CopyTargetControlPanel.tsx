// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_components/CopyTargetControlPanel`
 * Purpose: Dashboard-first copy-trading controls for the two curated target
 *          wallets, plus the global wallet-grant policy and wallet quick jump.
 * Scope: Client component. Owns React Query wiring for copy targets and grants;
 *        delegates shared visual controls to kit components.
 * Side-effects: IO (fetch copy targets, mutate target rows, read/write grants).
 * Links: docs/spec/poly-copy-trade-execution.md,
 *        nodes/poly/packages/node-contracts/src/poly.copy-trade.targets.v1.contract.ts
 * @public
 */

"use client";

import type {
  PolyCopyTradeTargetUpdateInput,
  PolyTrackedTarget,
  PolyWalletGrantsPutInput,
  SizingPolicyKind,
} from "@cogni/poly-node-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Radio } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import {
  AddressChip,
  Button,
  Card,
  CardContent,
  formatShortWallet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { PolicyControls } from "@/components/kit/policy/PolicyControls";
import { WalletQuickJump } from "@/features/wallet-analysis";
import { cn } from "@/shared/util/cn";

import {
  CopyTargetUpdateError,
  createCopyTarget,
  deleteCopyTarget,
  fetchCopyTargets,
  updateCopyTargetPolicy,
} from "../_api/fetchCopyTargets";
import {
  fetchWalletGrants,
  POLY_WALLET_GRANTS_QUERY_KEY,
  putWalletGrants,
} from "../_api/fetchWalletGrants";

export const COPY_TARGETS_QUERY_KEY = ["dashboard-copy-targets"] as const;

const CURATED_TARGETS = [
  {
    label: "RN1",
    wallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
  },
  {
    label: "swisstony",
    wallet: "0x204f72f35326db932158cba6adff0b9a1da95e14",
  },
] as const;

const ALGORITHM_GUIDE_URL =
  "https://poly.cognidao.org/knowledge/mirror-algorithm-rankings";

export function CopyTargetControlPanel(): ReactElement {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(true);

  const targetsQuery = useQuery({
    queryKey: COPY_TARGETS_QUERY_KEY,
    queryFn: fetchCopyTargets,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });
  const grantsQuery = useQuery({
    queryKey: POLY_WALLET_GRANTS_QUERY_KEY,
    queryFn: fetchWalletGrants,
    staleTime: 10_000,
    gcTime: 60_000,
    retry: 1,
  });

  const targetsByWallet = useMemo(() => {
    const map = new Map<string, PolyTrackedTarget>();
    for (const target of targetsQuery.data?.targets ?? []) {
      if (target.active) {
        map.set(target.target_wallet.toLowerCase(), target);
      }
    }
    return map;
  }, [targetsQuery.data]);
  const targetCards = useMemo(() => {
    const curatedWallets = new Set(
      CURATED_TARGETS.map((target) => target.wallet.toLowerCase()),
    );
    const additionalTargets = (targetsQuery.data?.targets ?? [])
      .filter(
        (target) =>
          target.active &&
          !curatedWallets.has(target.target_wallet.toLowerCase()),
      )
      .map((target) => ({
        label: formatShortWallet(target.target_wallet),
        wallet: target.target_wallet,
      }));
    return [...CURATED_TARGETS, ...additionalTargets];
  }, [targetsQuery.data]);

  const createMutation = useMutation({
    mutationFn: (target_wallet: string) => createCopyTarget({ target_wallet }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: COPY_TARGETS_QUERY_KEY }),
  });
  const deleteMutation = useMutation({
    mutationFn: (targetId: string) => deleteCopyTarget(targetId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: COPY_TARGETS_QUERY_KEY }),
  });
  const policyMutation = useMutation({
    mutationFn: ({
      targetId,
      next,
    }: {
      targetId: string;
      next: Omit<PolyCopyTradeTargetUpdateInput, "id">;
    }) => updateCopyTargetPolicy(targetId, next),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: COPY_TARGETS_QUERY_KEY }),
    onError: (error) => {
      if (error instanceof CopyTargetUpdateError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: COPY_TARGETS_QUERY_KEY,
        });
      }
    },
  });
  const grantsMutation = useMutation({
    mutationFn: (next: PolyWalletGrantsPutInput) => putWalletGrants(next),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: POLY_WALLET_GRANTS_QUERY_KEY }),
  });

  const grant = grantsQuery.data?.connected ? grantsQuery.data.grant : null;
  const targetStates = targetCards.map((curated) => ({
    label: curated.label,
    target: targetsByWallet.get(curated.wallet),
  }));

  if (collapsed) {
    return (
      <Card>
        <CardContent className="p-2">
          <button
            type="button"
            aria-label="Expand copy controls"
            onClick={() => setCollapsed(false)}
            className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[var(--ring-width-sm)] focus-visible:ring-ring"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {targetStates.map((targetState) => (
                <CollapsedTargetSignal
                  key={targetState.label}
                  label={targetState.label}
                  target={targetState.target}
                />
              ))}
            </div>
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {grant ? (
              <PolicyControls
                label="Global policy"
                values={{
                  per_order_usdc_cap: grant.per_order_usdc_cap,
                  daily_usdc_cap: grant.daily_usdc_cap,
                }}
                onSave={async (next) => {
                  await grantsMutation.mutateAsync(next);
                }}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <span className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
                  Global policy
                </span>
                <div className="rounded-md bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
                  Policy unlocks after the trading wallet is enabled.
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Collapse copy controls"
            onClick={() => setCollapsed(true)}
            className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-[var(--ring-width-sm)] focus-visible:ring-ring"
          >
            <ChevronUp className="size-4" aria-hidden />
          </button>
        </div>

        <h2 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Copy targets
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {targetCards.map((curated) => {
            const target = targetsByWallet.get(curated.wallet);
            return (
              <CopyTargetCard
                key={curated.wallet}
                label={curated.label}
                wallet={curated.wallet}
                target={target}
                perOrderCap={grant?.per_order_usdc_cap ?? null}
                loading={targetsQuery.isLoading}
                mutating={
                  createMutation.isPending ||
                  deleteMutation.isPending ||
                  policyMutation.isPending
                }
                onCreate={() => createMutation.mutate(curated.wallet)}
                onDelete={() => {
                  if (target) deleteMutation.mutate(target.target_id);
                }}
                onSave={async (next) => {
                  if (!target) return;
                  await policyMutation.mutateAsync({
                    targetId: target.target_id,
                    next,
                  });
                }}
              />
            );
          })}
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="font-semibold text-muted-foreground text-xs uppercase tracking-widest">
            Open any wallet
          </h2>
          <WalletQuickJump />
        </div>
      </CardContent>
    </Card>
  );
}

function CollapsedTargetSignal({
  label,
  target,
}: {
  label: string;
  target: PolyTrackedTarget | undefined;
}): ReactElement {
  const active = Boolean(target);
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-xs uppercase tracking-wide",
        active
          ? "border-success/30 bg-success/10 text-success"
          : "border-border/60 bg-background/40 text-muted-foreground",
      )}
    >
      <Radio
        className={cn("size-3", active ? "animate-pulse" : "opacity-35")}
        aria-hidden
      />
      {label} {target ? algorithmLabel(target.policy.effective_kind) : "off"}
    </span>
  );
}

function CopyTargetCard({
  label,
  wallet,
  target,
  perOrderCap,
  loading,
  mutating,
  onCreate,
  onDelete,
  onSave,
}: {
  label: string;
  wallet: string;
  target: PolyTrackedTarget | undefined;
  perOrderCap: number | null;
  loading: boolean;
  mutating: boolean;
  onCreate: () => void;
  onDelete: () => void;
  onSave: (next: Omit<PolyCopyTradeTargetUpdateInput, "id">) => Promise<void>;
}): ReactElement {
  const active = Boolean(target);

  return (
    <div className="flex min-h-48 min-w-0 flex-col gap-3 rounded-md border bg-background/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-base leading-none">{label}</h3>
            <TargetSignal active={active} />
          </div>
          <AddressChip address={wallet} className="mt-2 text-xs" />
        </div>
        <TargetActiveSwitch
          label={label}
          active={active}
          disabled={loading || mutating}
          onToggle={active ? onDelete : onCreate}
        />
      </div>

      <TargetPolicyEditor
        target={target}
        perOrderCap={perOrderCap}
        disabled={!active || mutating}
        onSave={onSave}
      />
    </div>
  );
}

function TargetSignal({ active }: { active: boolean }): ReactElement {
  if (!active) {
    return (
      <span className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
        --
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success text-xs">
      <Radio className="size-3 animate-pulse" aria-hidden />
      active
    </span>
  );
}

function TargetActiveSwitch({
  label,
  active,
  disabled,
  onToggle,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-label={`${active ? "Pause" : "Turn on"} ${label}`}
      aria-checked={active}
      disabled={disabled}
      onClick={onToggle}
      className={[
        "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center",
        "rounded-full border transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:opacity-60",
        active ? "border-primary/60 bg-primary" : "border-border/60 bg-muted",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "pointer-events-none inline-block h-3.5 w-3.5",
          "translate-x-0.5 transform rounded-full bg-background shadow-sm",
          "transition-transform duration-150",
          active ? "translate-x-[1.125rem]" : "",
        ].join(" ")}
      />
    </button>
  );
}

function TargetPolicyEditor({
  target,
  perOrderCap,
  disabled,
  onSave,
}: {
  target: PolyTrackedTarget | undefined;
  perOrderCap: number | null;
  disabled: boolean;
  onSave: (next: Omit<PolyCopyTradeTargetUpdateInput, "id">) => Promise<void>;
}): ReactElement {
  const [kind, setKind] = useState<SizingPolicyKind>(
    target?.policy.declared_kind ?? "auto",
  );
  const [percentile, setPercentile] = useState(
    target?.policy.mirror_filter_percentile ?? 75,
  );
  const [maxBet, setMaxBet] = useState(
    (target?.policy.mirror_max_usdc_per_trade ?? 5).toFixed(2),
  );
  const [rangeMax, setRangeMax] = useState(
    target?.policy.target_range_max_usdc?.toFixed(2) ?? "",
  );
  const [maxAllocation, setMaxAllocation] = useState(
    target?.policy.mirror_max_alloc_per_condition_usdc?.toFixed(2) ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKind(target?.policy.declared_kind ?? "auto");
    setPercentile(target?.policy.mirror_filter_percentile ?? 75);
    setMaxBet((target?.policy.mirror_max_usdc_per_trade ?? 5).toFixed(2));
    setRangeMax(target?.policy.target_range_max_usdc?.toFixed(2) ?? "");
    setMaxAllocation(
      target?.policy.mirror_max_alloc_per_condition_usdc?.toFixed(2) ?? "",
    );
    setError(null);
  }, [target]);

  const parsedMaxBet = Number.parseFloat(maxBet);
  const parsedRangeMax = Number.parseFloat(rangeMax);
  const parsedMaxAllocation = Number.parseFloat(maxAllocation);
  const changed =
    target &&
    (kind !== target.policy.declared_kind ||
      percentile !== target.policy.mirror_filter_percentile ||
      parsedMaxBet !== target.policy.mirror_max_usdc_per_trade ||
      (Number.isFinite(parsedRangeMax) ? parsedRangeMax : null) !==
        target.policy.target_range_max_usdc ||
      (Number.isFinite(parsedMaxAllocation) ? parsedMaxAllocation : null) !==
        target.policy.mirror_max_alloc_per_condition_usdc);
  const percentileSizing =
    kind === "auto" || kind === "target_percentile_scaled";
  const cappedSizing = percentileSizing || kind === "min_bet";
  const positionGapSizing = kind === "position_gap";
  const algorithmExplanation = explanationForAlgorithm(kind, {
    percentile,
    maxBet: parsedMaxBet,
    rangeMax: parsedRangeMax,
    maxAllocation: parsedMaxAllocation,
  });
  const positionGapCapConflict =
    positionGapSizing &&
    perOrderCap !== null &&
    Number.isFinite(parsedMaxAllocation) &&
    parsedMaxAllocation > perOrderCap;
  const buildRevision =
    target?.policy.implementation_revision.status === "available"
      ? target.policy.implementation_revision.build_sha.slice(0, 8)
      : "unavailable";

  async function handleSave() {
    if (!target) return;
    if (!Number.isFinite(parsedMaxBet) || parsedMaxBet <= 0) {
      setError("Max must be greater than 0");
      return;
    }
    if (
      positionGapSizing &&
      (!Number.isFinite(parsedRangeMax) || parsedRangeMax <= 0)
    ) {
      setError("Target range must be greater than 0");
      return;
    }
    if (
      positionGapSizing &&
      (!Number.isFinite(parsedMaxAllocation) || parsedMaxAllocation <= 0)
    ) {
      setError("Max allocation must be greater than 0");
      return;
    }
    if (positionGapSizing && parsedMaxAllocation / parsedRangeMax < 0.05) {
      setError("Max allocation must be at least 5% of target range");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        mirror_filter_percentile: percentile,
        mirror_max_usdc_per_trade: parsedMaxBet,
        sizing_policy_kind: kind,
        expected_mirror_activated_at: target.mirror_activated_at,
        ...(Number.isFinite(parsedRangeMax)
          ? { target_range_max_usdc: parsedRangeMax }
          : {}),
        ...(Number.isFinite(parsedMaxAllocation)
          ? {
              mirror_max_alloc_per_condition_usdc: parsedMaxAllocation,
            }
          : {}),
      });
    } catch (cause) {
      setError(
        cause instanceof CopyTargetUpdateError && cause.status === 409
          ? "Settings changed elsewhere. Reloaded values are required before saving again."
          : "Save failed",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-auto flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            Mirror algorithm
          </span>
          <Select
            value={kind}
            onValueChange={(value) => setKind(value as SizingPolicyKind)}
            disabled={disabled || saving}
          >
            <SelectTrigger aria-label="Mirror algorithm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALGORITHM_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                  {option.recommended ? " — Recommended" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="text-muted-foreground text-xs sm:text-right">
          <div>Active: {target ? algorithmSummary(target) : "--"}</div>
          <div className="font-mono">build {buildRevision}</div>
        </div>
      </div>
      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-foreground">
            {algorithmExplanation.title}
          </span>
          <a
            href={ALGORITHM_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Algorithm guide
          </a>
        </div>
        <p className="mt-1 text-muted-foreground">
          {algorithmExplanation.description}
        </p>
        <p className="mt-1 text-muted-foreground">
          Changes here are drafts. The Active algorithm and build change only
          after Save, then runtime picks them up within 30 seconds.
        </p>
        {changed ? (
          <p className="mt-1 font-medium text-warning">
            Draft only — Active stays {target ? algorithmSummary(target) : "--"}{" "}
            until Save.
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {positionGapSizing ? (
          <>
            <ValueCell label="Target range" value={moneyOrDash(rangeMax)} />
            <ValueCell
              label="Mirror allocation"
              value={moneyOrDash(maxAllocation)}
            />
          </>
        ) : kind === "mirror_fill_exact" ? (
          <>
            <ValueCell label="Sizing" value="Target fill" />
            <ValueCell label="Safety" value="Wallet caps" />
          </>
        ) : (
          <>
            <ValueCell
              label={percentileSizing ? `Threshold p${percentile}` : "Sizing"}
              value={percentileSizing ? "target percentile" : "market minimum"}
            />
            <ValueCell label="Per-token cap" value={moneyOrDash(maxBet)} />
          </>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
        {percentileSizing ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              Threshold p{percentile}
            </span>
            <input
              type="range"
              min={50}
              max={99}
              step={1}
              value={percentile}
              disabled={disabled || saving}
              onChange={(e) => setPercentile(Number(e.target.value))}
              className="h-9 w-full accent-primary"
            />
          </label>
        ) : null}
        {cappedSizing ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              Per-token cap
            </span>
            <span className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2">
              <span className="text-muted-foreground text-sm">$</span>
              <input
                inputMode="decimal"
                value={maxBet}
                disabled={disabled || saving}
                onChange={(event) => setMaxBet(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm tabular-nums outline-none disabled:opacity-50"
              />
            </span>
          </label>
        ) : null}
        {positionGapSizing ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">
                Target range
              </span>
              <span className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2">
                <span className="text-muted-foreground text-sm">$</span>
                <input
                  inputMode="decimal"
                  value={rangeMax}
                  disabled={disabled || saving}
                  onChange={(event) => setRangeMax(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm tabular-nums outline-none disabled:opacity-50"
                />
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">
                Max allocation
              </span>
              <span className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2">
                <span className="text-muted-foreground text-sm">$</span>
                <input
                  inputMode="decimal"
                  value={maxAllocation}
                  disabled={disabled || saving}
                  onChange={(event) => setMaxAllocation(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm tabular-nums outline-none disabled:opacity-50"
                />
              </span>
            </label>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={disabled || saving || !changed}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      {kind === "mirror_fill_exact" ? (
        <div className="rounded-md bg-warning/10 px-3 py-2 text-muted-foreground text-xs">
          Mirrors each target fill notional. Orders below the market minimum are
          skipped; wallet grant caps reject larger orders rather than resizing
          them.
        </div>
      ) : null}
      {positionGapCapConflict ? (
        <div
          className="rounded-md bg-warning/10 px-3 py-2 text-muted-foreground text-xs"
          role="status"
        >
          A catch-up order can reach {formatMoney(parsedMaxAllocation)}, above
          your {formatMoney(perOrderCap)} wallet per-order cap. Larger orders
          are rejected, not resized; raise the wallet cap or lower Max
          allocation.
        </div>
      ) : null}
      {error ? (
        <div className="text-destructive text-xs" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

const ALGORITHM_OPTIONS: ReadonlyArray<{
  value: SizingPolicyKind;
  label: string;
  recommended?: boolean;
}> = [
  { value: "auto", label: "Auto" },
  { value: "target_percentile_scaled", label: "Target percentile" },
  { value: "position_gap", label: "Position gap", recommended: true },
  { value: "min_bet", label: "Minimum bet" },
  { value: "mirror_fill_exact", label: "Exact fill mirror" },
];

function algorithmLabel(kind: SizingPolicyKind): string {
  return (
    ALGORITHM_OPTIONS.find((option) => option.value === kind)?.label ?? kind
  );
}

function algorithmSummary(target: PolyTrackedTarget): string {
  const effective = algorithmLabel(target.policy.effective_kind);
  return target.policy.declared_kind === "auto"
    ? `Auto → ${effective}`
    : effective;
}

function moneyOrDash(value: string): string {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "--";
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function explanationForAlgorithm(
  kind: SizingPolicyKind,
  values: {
    percentile: number;
    maxBet: number;
    rangeMax: number;
    maxAllocation: number;
  },
): { title: string; description: string } {
  switch (kind) {
    case "auto":
      return {
        title: "Operational default",
        description:
          "Uses Target percentile for curated targets with a sizing profile; otherwise Minimum bet. The recommendation does not change this mapping.",
      };
    case "target_percentile_scaled":
      return {
        title: "Selective, fill-triggered sizing",
        description: `Threshold p${values.percentile} ignores smaller target positions. Qualifying exposure scales from the market minimum toward ${moneyOrDash(String(values.maxBet))} per token.`,
      };
    case "position_gap": {
      const valid =
        Number.isFinite(values.rangeMax) &&
        values.rangeMax > 0 &&
        Number.isFinite(values.maxAllocation) &&
        values.maxAllocation > 0;
      const example = valid
        ? ` Example: after the target grows ${formatMoney(values.rangeMax / 4)} from its first post-save baseline, desired exposure is ${formatMoney(values.maxAllocation / 4)}; it buys only the missing shares.`
        : " Enter both values to preview the allocation.";
      return {
        title: "Most promising for position delta · experimental",
        description:
          "Target range is the target's new position growth that reaches 100%. Max allocation is your desired exposure at 100%, before subtracting what you already hold." +
          example,
      };
    }
    case "min_bet":
      return {
        title: "Smallest placeable order",
        description: `Places the market minimum for each eligible target fill, never above the ${moneyOrDash(String(values.maxBet))} per-token cap.`,
      };
    case "mirror_fill_exact":
      return {
        title: "Experimental fidelity baseline",
        description:
          "Copies each eligible target fill's USDC notional at its observed price. It does not compensate for earlier missed fills or position drift.",
      };
  }
}

function ValueCell({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <div className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className="font-semibold text-base tabular-nums tracking-tight">
        {value}
      </div>
    </div>
  );
}
