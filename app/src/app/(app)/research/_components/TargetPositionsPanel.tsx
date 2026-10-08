// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/research/_components/TargetPositionsPanel`
 * Purpose: Minimal human view of the same saved target-position capability agents read.
 * Scope: Fetch + render only. No portfolio math or upstream calls.
 */

"use client";

import type {
	PolyAccountTargetPositionsResponse,
	PolyTargetPositionsSort,
	PolyTrackedTarget,
} from "@cogni/poly-node-contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import {
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components";
import { cn } from "@/shared/util/cn";

import { fetchCopyTargets } from "../../dashboard/_api/fetchCopyTargets";

const ALL_TARGETS = "all";

async function fetchTargetPositions(args: {
	targetWallet: string;
	sort: PolyTargetPositionsSort;
	cursor: string | null;
}): Promise<PolyAccountTargetPositionsResponse> {
	const query = new URLSearchParams({ sort: args.sort, limit: "25" });
	if (args.targetWallet !== ALL_TARGETS) {
		query.set("target_wallet", args.targetWallet);
	}
	if (args.cursor) query.set("cursor", args.cursor);
	const response = await fetch(
		`/api/v1/poly/research/target-positions?${query.toString()}`,
		{ credentials: "include" },
	);
	if (!response.ok) {
		throw new Error(`target positions failed: ${response.status}`);
	}
	return (await response.json()) as PolyAccountTargetPositionsResponse;
}

export function TargetPositionsPanel() {
	const [targetWallet, setTargetWallet] = useState(ALL_TARGETS);
	const [sort, setSort] = useState<PolyTargetPositionsSort>("portfolio_weight");
	const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
	const cursor = cursorStack.at(-1) ?? null;
	const query = useQuery({
		queryKey: ["research-target-positions", targetWallet, sort, cursor],
		queryFn: () => fetchTargetPositions({ targetWallet, sort, cursor }),
		staleTime: 30_000,
		gcTime: 5 * 60_000,
		placeholderData: (previous) => previous,
	});
	const setup = useQuery({
		queryKey: ["dashboard-copy-targets"],
		queryFn: fetchCopyTargets,
		staleTime: 30_000,
	});
	const runtimes = new Map(
		(setup.data?.targets ?? []).map((target) => [
			target.target_wallet.toLowerCase(),
			target,
		]),
	);
	const visibleRuntimes = [...runtimes.values()].filter(
		(target) =>
			targetWallet === ALL_TARGETS ||
			target.target_wallet.toLowerCase() === targetWallet.toLowerCase(),
	);

	const resetPage = () => setCursorStack([null]);

	return (
		<Card id="target-positions">
			<CardHeader className="gap-3 px-5 py-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
						Target positions · live ≤6h
					</CardTitle>
					<div className="flex flex-wrap gap-2">
						<Select
							value={targetWallet}
							onValueChange={(value) => {
								setTargetWallet(value);
								resetPage();
							}}
						>
							<SelectTrigger className="h-8 w-44" aria-label="Copy target">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_TARGETS}>All targets</SelectItem>
								{(query.data?.targets ?? []).map((target) => (
									<SelectItem
										key={target.target_id}
										value={target.target_wallet}
									>
										{target.label || shortAddress(target.target_wallet)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={sort}
							onValueChange={(value) => {
								setSort(value as PolyTargetPositionsSort);
								resetPage();
							}}
						>
							<SelectTrigger className="h-8 w-40" aria-label="Sort positions">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="portfolio_weight">Weight</SelectItem>
								<SelectItem value="current_value">Current value</SelectItem>
								<SelectItem value="pnl">P/L</SelectItem>
								<SelectItem value="last_observed">Newest</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
				{query.data ? (
					<TargetFreshness data={query.data} runtimes={visibleRuntimes} />
				) : null}
			</CardHeader>
			<CardContent className="p-0">
				{query.isError ? (
					<p className="px-5 py-8 text-center text-muted-foreground text-sm">
						Target positions unavailable.
					</p>
				) : query.isLoading && !query.data ? (
					<div className="animate-pulse space-y-px px-5 py-4">
						<div className="h-9 rounded bg-muted" />
						<div className="h-9 rounded bg-muted" />
						<div className="h-9 rounded bg-muted" />
					</div>
				) : (query.data?.positions.length ?? 0) === 0 ? (
					<p className="px-5 py-8 text-center text-muted-foreground text-sm">
						No live saved positions.
					</p>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Target</TableHead>
									<TableHead className="min-w-56">Market</TableHead>
									<TableHead>Outcome</TableHead>
									<TableHead className="text-right">Weight</TableHead>
									<TableHead className="text-right">Shares</TableHead>
									<TableHead className="text-right">Cost</TableHead>
									<TableHead className="text-right">Value</TableHead>
									<TableHead className="text-right">Entry</TableHead>
									<TableHead className="text-right">Now</TableHead>
									<TableHead className="text-right">P/L</TableHead>
									<TableHead className="text-right">Mirror</TableHead>
									<TableHead className="text-right">Limits</TableHead>
									<TableHead className="text-right">Seen</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{query.data?.positions.map((position) => (
									<TableRow
										key={`${position.target_id}:${position.condition_id}:${position.token_id}`}
									>
										<TableCell className="font-medium text-xs">
											{position.target_label ||
												shortAddress(position.target_wallet)}
										</TableCell>
										<TableCell>
											<div className="flex flex-col gap-0.5">
												{position.market_url ? (
													<a
														href={position.market_url}
														target="_blank"
														rel="noreferrer"
														className="font-medium text-sm underline-offset-4 hover:underline"
													>
														{position.market_title ?? "Market"}
													</a>
												) : (
													<span className="font-medium text-sm">
														{position.market_title ?? "Market"}
													</span>
												)}
												<Link
													href="/dashboard#markets"
													className="text-muted-foreground text-xs hover:text-foreground"
												>
													Compare
												</Link>
											</div>
										</TableCell>
										<TableCell className="text-xs">
											{position.outcome ?? "—"}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatPercent(position.portfolio_weight)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatNumber(position.shares)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatUsd(position.cost_basis_usdc)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatUsd(position.current_value_usdc)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatPrice(position.entry_price)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{position.current_price === null
												? "—"
												: formatPrice(position.current_price)}
										</TableCell>
										<TableCell
											className={cn(
												"text-right tabular-nums",
												pnlClass(position.cash_pnl_usdc),
											)}
										>
											{position.cash_pnl_usdc === null
												? "—"
												: formatSignedUsd(position.cash_pnl_usdc)}
										</TableCell>
										<TableCell className="text-right text-xs tabular-nums">
											{mirrorText(
												runtimes.get(position.target_wallet.toLowerCase()),
												position.condition_id,
												position.token_id,
												"position",
											)}
										</TableCell>
										<TableCell className="text-right text-muted-foreground text-xs tabular-nums">
											{mirrorText(
												runtimes.get(position.target_wallet.toLowerCase()),
												position.condition_id,
												position.token_id,
												"limits",
											)}
										</TableCell>
										<TableCell className="text-right text-muted-foreground text-xs">
											{timeAgo(position.last_observed_at)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
				<div className="flex items-center justify-between border-t px-5 py-3">
					<span className="text-muted-foreground text-xs">
						Page {cursorStack.length}
					</span>
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={cursorStack.length === 1 || query.isFetching}
							onClick={() => setCursorStack((current) => current.slice(0, -1))}
						>
							Previous
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!query.data?.next_cursor || query.isFetching}
							onClick={() => {
								if (query.data?.next_cursor) {
									setCursorStack((current) => [
										...current,
										query.data?.next_cursor ?? null,
									]);
								}
							}}
						>
							Next
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function TargetFreshness({
	data,
	runtimes,
}: {
	data: PolyAccountTargetPositionsResponse;
	runtimes: readonly PolyTrackedTarget[];
}) {
	return (
		<div className="flex flex-wrap gap-2">
			{data.targets.map((target) => (
				<Badge
					key={target.target_id}
					intent={
						target.observation.completeness === "complete" &&
						target.observation.freshness === "fresh"
							? "secondary"
							: "destructive"
					}
					size="sm"
				>
					{target.label || shortAddress(target.target_wallet)} ·{" "}
					{target.live_position_count} live ·{" "}
					{target.observation.last_success_at
						? timeAgo(target.observation.last_success_at)
						: "unavailable"}{" "}
					· {target.observation.freshness} · {target.observation.completeness}
				</Badge>
			))}
			{runtimes
				.filter((target) => target.policy.effective_kind === "position_gap")
				.map((target) => (
					<Badge
						key={`mirror:${target.target_id}`}
						intent={
							runtimeHealthy(target.position_gap_runtime)
								? "secondary"
								: "destructive"
						}
						size="sm"
					>
						Mirror · {runtimeSummary(target.position_gap_runtime)}
					</Badge>
				))}
		</div>
	);
}

function runtimeSummary(
	runtime: PolyTrackedTarget["position_gap_runtime"],
): string {
	if (runtime.status === "pending") return "awaiting first plan";
	if (runtime.status === "unavailable") return "plan unavailable";
	if (runtime.status === "not_applicable") return "not running";
	if (runtime.snapshot.completeness !== "complete")
		return "incomplete snapshot";
	if (runtime.snapshot.freshness !== "fresh") return "stale snapshot";
	const minimum = runtime.plan.minimum_feasible_sleeve_usdc;
	return `${runtime.plan.status.replaceAll("_", " ")} · sleeve ${formatUsd(runtime.plan.sleeve_budget_usdc)}${minimum === null ? "" : ` · min ${formatUsd(minimum)}`} · NAV ${formatUsd(runtime.plan.eligible_net_nav_usdc)} · scale ${runtime.plan.scale.toPrecision(3)} · free ${formatUsd(runtime.plan.free_wallet_cash_after_guards_usdc)} · reserved ${formatUsd(runtime.plan.reserved_budget_usdc)} · ${runtime.execution.submitted_order_count}/${runtime.execution.filled_order_count} submitted/filled`;
}

function runtimeHealthy(
	runtime: PolyTrackedTarget["position_gap_runtime"],
): boolean {
	return (
		runtime.status === "observed" &&
		runtime.snapshot.completeness === "complete" &&
		runtime.snapshot.freshness === "fresh" &&
		runtime.plan.status === "ready" &&
		runtime.execution.submitted_order_count > 0
	);
}

function mirrorPosition(
	target: PolyTrackedTarget | undefined,
	conditionId: string,
	tokenId: string,
) {
	const runtime = target?.position_gap_runtime;
	if (runtime?.status !== "observed") return null;
	const rows = runtime.positions.filter(
		(row) => row.condition_id === conditionId && row.token_id === tokenId,
	);
	if (rows.length === 0) return null;
	const finite = (values: Array<number | null>) =>
		values.filter((value): value is number => value !== null);
	const priceCaps = finite(rows.map((row) => row.price_cap));
	const floors = finite(rows.map((row) => row.market_floor_usdc));
	return {
		desired: rows.reduce((sum, row) => sum + row.desired_shares, 0),
		held: rows.reduce((sum, row) => sum + row.held_shares, 0),
		open: rows.reduce((sum, row) => sum + row.open_shares, 0),
		gap: rows.reduce((sum, row) => sum + row.gap_shares, 0),
		locked: Math.max(...rows.map((row) => row.locked_overweight_shares)),
		priceCap: priceCaps.length ? Math.min(...priceCaps) : null,
		floor: floors.length ? Math.min(...floors) : null,
		reason: [...new Set(rows.map((row) => row.decision_reason))].join(", "),
	};
}

function mirrorText(
	target: PolyTrackedTarget | undefined,
	conditionId: string,
	tokenId: string,
	kind: "position" | "limits",
): string {
	const mirror = mirrorPosition(target, conditionId, tokenId);
	if (!mirror) return "—";
	if (kind === "limits") {
		return `${mirror.priceCap === null ? "—" : `≤${formatPrice(mirror.priceCap)}`} · ${mirror.floor === null ? "—" : `${formatUsd(mirror.floor)} floor`} · ${mirror.reason}`;
	}
	return `${formatNumber(mirror.held)}/${formatNumber(mirror.desired)} · open ${formatNumber(mirror.open)} · gap ${formatNumber(mirror.gap)}${mirror.locked ? ` · ${formatNumber(mirror.locked)} locked` : ""}`;
}

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsd(value: number): string {
	return value.toLocaleString(undefined, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	});
}

function formatSignedUsd(value: number): string {
	return `${value > 0 ? "+" : ""}${formatUsd(value)}`;
}

function formatNumber(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatPrice(value: number): string {
	return value.toFixed(3);
}

function pnlClass(value: number | null): string {
	if (value === null || value === 0) return "text-muted-foreground";
	return value > 0 ? "text-success" : "text-destructive";
}

function timeAgo(iso: string): string {
	const seconds = Math.max(
		0,
		Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
	);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
