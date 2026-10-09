// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/research/_components/TargetPositionsPanel`
 * Purpose: Minimal human view of the same persisted target/runtime capability agents read.
 * Scope: Fetch + render only. No portfolio math or upstream calls.
 */

"use client";

import type {
	PolyAccountTargetPositionsResponse,
	PolyTargetPositionsSort,
} from "@cogni/poly-node-contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
	const searchParams = useSearchParams();
	const requestedTarget = searchParams?.get("target_wallet") ?? null;
	const [targetWallet, setTargetWallet] = useState(
		requestedTarget && /^0x[a-fA-F0-9]{40}$/.test(requestedTarget)
			? requestedTarget.toLowerCase()
			: ALL_TARGETS,
	);
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
	const resetPage = () => setCursorStack([null]);

	return (
		<Card id="target-positions">
			<CardHeader className="gap-3 px-5 py-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
						Target positions
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
								<SelectItem value="portfolio_weight">Target weight</SelectItem>
								<SelectItem value="current_value">Current value</SelectItem>
								<SelectItem value="pnl">P/L</SelectItem>
								<SelectItem value="last_observed">Newest</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
				{query.data ? <TargetFreshness data={query.data} /> : null}
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
						No current positions.
					</p>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Target</TableHead>
									<TableHead className="min-w-56">Market</TableHead>
									<TableHead>Outcome</TableHead>
									<TableHead className="text-right">Target weight</TableHead>
									<TableHead className="text-right">Shares</TableHead>
									<TableHead className="text-right">Cost</TableHead>
									<TableHead className="text-right">Value</TableHead>
									<TableHead className="text-right">Entry</TableHead>
									<TableHead className="text-right">Now</TableHead>
									<TableHead className="text-right">P/L</TableHead>
									<TableHead className="text-right">Mirror shares</TableHead>
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
											{position.row_source === "runtime_only"
												? " · runtime"
												: ""}
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
											{formatPercent(
												position.runtime?.target_weight ??
													position.portfolio_weight,
											)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatMaybe(position.shares, formatNumber)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatMaybe(position.cost_basis_usdc, formatUsd)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatMaybe(position.current_value_usdc, formatUsd)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatMaybe(position.entry_price, formatPrice)}
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
											{mirrorText(position.runtime, "position")}
										</TableCell>
										<TableCell className="text-right text-muted-foreground text-xs tabular-nums">
											{mirrorText(position.runtime, "limits")}
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
}: {
	data: PolyAccountTargetPositionsResponse;
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
			{data.targets
				.filter(
					(target) => target.position_gap_runtime.status !== "not_applicable",
				)
				.flatMap((target) => {
					const runtime = target.position_gap_runtime;
					return [
						<Badge
							key={`mirror:${target.target_id}`}
							intent={runtimeHealthy(runtime) ? "secondary" : "destructive"}
							size="sm"
						>
							Mirror · {runtimeSummary(runtime)}
						</Badge>,
						...(runtime.status === "observed" &&
						runtime.plan.target_total_wealth_usdc !== null
							? [
									<Badge
										key={`wealth:${target.target_id}`}
										intent="secondary"
										size="sm"
									>
										Target wealth{" "}
										{formatUsd(runtime.plan.target_total_wealth_usdc)} · pUSD
										balance{" "}
										{formatNullableUsd(runtime.plan.target_pusd_balance_usdc)} ·
										directional positions{" "}
										{formatUsd(runtime.plan.eligible_net_nav_usdc)} · paired
										sets{" "}
										{formatNullableUsd(
											runtime.plan.target_complete_set_value_usdc,
										)}{" "}
										· block{" "}
										{runtime.plan.target_balance_source_block?.toLocaleString() ??
											"unknown"}
									</Badge>,
								]
							: []),
					];
				})}
		</div>
	);
}

function runtimeSummary(
	runtime: PolyAccountTargetPositionsResponse["targets"][number]["position_gap_runtime"],
): string {
	if (runtime.status === "pending") return "awaiting first plan";
	if (runtime.status === "unavailable") return "plan unavailable";
	if (runtime.status === "not_applicable") return "not running";
	if (runtime.snapshot.completeness !== "complete")
		return "incomplete snapshot";
	if (runtime.snapshot.freshness !== "fresh") return "stale snapshot";
	const minimum = runtime.plan.minimum_feasible_sleeve_usdc;
	const status = runtimeAtRest(runtime)
		? runtime.positions.some((position) => position.open_shares > 1e-9)
			? "orders resting"
			: "matched"
		: runtime.plan.status === "no_feasible_position"
			? "no order"
			: runtime.plan.status.replaceAll("_", " ");
	const fills = runtime.execution.fill_accounting;
	const execution =
		fills.status === "verified"
			? `${runtime.execution.submitted_order_count} submitted · ${fills.matched_order_count} verified`
			: runtime.execution.submitted_order_count === 0
				? "no fills"
				: `${runtime.execution.submitted_order_count} submitted · fills pending`;
	return `${status} · usable budget ${formatUsd(runtime.plan.sleeve_budget_usdc)}${minimum === null ? "" : ` · ${formatUsd(minimum)} needed`} · scale ${runtime.plan.scale.toPrecision(3)} · wallet cash ${formatUsd(runtime.plan.free_wallet_cash_after_guards_usdc)} · used budget ${formatUsd(runtime.plan.reserved_budget_usdc)} · ${execution}`;
}

function runtimeAtRest(
	runtime: PolyAccountTargetPositionsResponse["targets"][number]["position_gap_runtime"],
): boolean {
	return (
		runtime.status === "observed" &&
		(runtime.run.status === "completed" || runtime.run.status === "skipped") &&
		runtime.plan.status === "no_feasible_position" &&
		!runtime.positions_truncated &&
		runtime.positions.length > 0 &&
		runtime.plan.locked_overweight_count === 0 &&
		runtime.positions.every(
			(position) =>
				position.decision_reason === "no_gap" &&
				position.gap_shares <= 1e-9 &&
				position.locked_overweight_shares <= 1e-9,
		)
	);
}

function runtimeHealthy(
	runtime: PolyAccountTargetPositionsResponse["targets"][number]["position_gap_runtime"],
): boolean {
	return (
		runtime.status === "observed" &&
		runtime.snapshot.completeness === "complete" &&
		runtime.snapshot.freshness === "fresh" &&
		(runtime.run.status === "completed" || runtime.run.status === "skipped") &&
		(runtime.plan.status === "ready" ||
			runtime.plan.status === "no_feasible_position")
	);
}

function mirrorText(
	mirror: PolyAccountTargetPositionsResponse["positions"][number]["runtime"],
	kind: "position" | "limits",
): string {
	if (!mirror) return "—";
	if (kind === "limits") {
		return `${mirror.price_cap === null ? "—" : `≤${formatPrice(mirror.price_cap)}`} · ${mirror.market_floor_usdc === null ? "—" : `${formatUsd(mirror.market_floor_usdc)} floor`} · ${mirror.decision_reasons.join(", ")}`;
	}
	return `${formatNumber(mirror.held_shares)}/${formatNumber(mirror.desired_shares)} · open ${formatNumber(mirror.open_shares)} · gap ${formatNumber(mirror.gap_shares)}${mirror.locked_overweight_shares ? ` · ${formatNumber(mirror.locked_overweight_shares)} locked` : ""}`;
}

function formatMaybe(
	value: number | null,
	format: (value: number) => string,
): string {
	return value === null ? "—" : format(value);
}

function formatNullableUsd(value: number | null): string {
	return value === null ? "unknown" : formatUsd(value);
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
