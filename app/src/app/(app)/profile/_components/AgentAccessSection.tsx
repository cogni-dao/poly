// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/_components/AgentAccessSection`
 * Purpose: Human-only review and lifecycle controls for AI access requests.
 * Scope: Profile-local client UI; reads owner-safe request DTOs and submits approve, deny, and revoke actions.
 * Invariants: Never renders approval tokens, API keys, account ids, principal ids, CLI commands, or raw API instructions.
 * Side-effects: IO through the agent-access request and grant routes; removes approval fragments from browser history.
 * Links: packages/poly-node-contracts/src/poly.agent-access-requests.v1.contract.ts
 * @public
 */

"use client";

import type { AgentAccessRequestOwner } from "@cogni/poly-node-contracts";
import { Bot, Loader2, ShieldCheck } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button } from "@/components";

type AccessStatus = AgentAccessRequestOwner["status"];

const STATUS_LABEL: Record<AccessStatus, string> = {
	pending: "Pending",
	active: "Active",
	expired: "Expired",
	denied: "Denied",
	revoked: "Revoked",
};

const STATUS_INTENT: Record<
	AccessStatus,
	"default" | "secondary" | "destructive" | "outline"
> = {
	pending: "secondary",
	active: "default",
	expired: "outline",
	denied: "outline",
	revoked: "outline",
};

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

function scopeLabel(scope: AgentAccessRequestOwner["scope"]): string {
	switch (scope) {
		case "performance:read":
			return "Read performance";
	}
}

function AgentIdentity({ name }: { name: string }): ReactElement {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
				<Bot className="size-4" aria-hidden="true" />
			</div>
			<div className="min-w-0">
				<p className="truncate font-semibold text-foreground text-sm">{name}</p>
				<p className="text-muted-foreground text-xs">AI agent</p>
			</div>
		</div>
	);
}

function AccessDetails({
	request,
}: {
	request: AgentAccessRequestOwner;
}): ReactElement {
	return (
		<dl className="grid gap-3 text-sm sm:grid-cols-2">
			<div>
				<dt className="text-muted-foreground text-xs">Access</dt>
				<dd className="font-medium text-foreground">
					{scopeLabel(request.scope)}
				</dd>
			</div>
			<div>
				<dt className="text-muted-foreground text-xs">Expires</dt>
				<dd className="font-medium text-foreground">
					{formatDate(request.expires_at)}
				</dd>
			</div>
		</dl>
	);
}

function RequestPreview({
	request,
	approvalToken,
	onComplete,
}: {
	request: AgentAccessRequestOwner;
	approvalToken: string;
	onComplete: () => Promise<void>;
}): ReactElement {
	const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const decide = useCallback(
		async (decision: "approve" | "deny"): Promise<void> => {
			setSubmitting(decision);
			setError(null);
			try {
				const response = await fetch(
					`/api/v1/poly/agent-access-requests/${encodeURIComponent(request.id)}/decision`,
					{
						method: "POST",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							approval_token: approvalToken,
							decision,
						}),
					},
				);
				if (!response.ok) {
					setError("This request could not be updated. Refresh and try again.");
					setSubmitting(null);
					return;
				}
				await onComplete();
			} catch {
				setError("This request could not be updated. Refresh and try again.");
				setSubmitting(null);
			}
		},
		[approvalToken, onComplete, request.id],
	);

	return (
		<section
			aria-labelledby="agent-request-heading"
			className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="space-y-1">
					<p className="font-medium text-primary text-xs uppercase tracking-wide">
						Approval requested
					</p>
					<h3
						id="agent-request-heading"
						className="font-semibold text-foreground text-base"
					>
						Review AI access
					</h3>
				</div>
				<Badge intent="secondary" size="sm">
					Pending
				</Badge>
			</div>

			<AgentIdentity name={request.agent_display_name} />
			<AccessDetails request={request} />
			<p className="text-muted-foreground text-sm">
				This AI can read saved copy-trading performance for your account. It
				cannot place trades or change settings.
			</p>

			{error ? (
				<p className="text-destructive text-sm" role="alert">
					{error}
				</p>
			) : null}

			<div className="flex flex-col gap-2 sm:flex-row">
				<Button
					size="sm"
					disabled={submitting !== null}
					onClick={() => void decide("approve")}
				>
					{submitting === "approve" ? (
						<>
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
							Approving…
						</>
					) : (
						"Approve access"
					)}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={submitting !== null}
					onClick={() => void decide("deny")}
				>
					{submitting === "deny" ? (
						<>
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
							Denying…
						</>
					) : (
						"Deny"
					)}
				</Button>
			</div>
		</section>
	);
}

function AccessRow({
	request,
	onChanged,
}: {
	request: AgentAccessRequestOwner;
	onChanged: () => Promise<void>;
}): ReactElement {
	const [revoking, setRevoking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const revoke = useCallback(async (): Promise<void> => {
		if (!request.grant_id) return;
		setRevoking(true);
		setError(null);
		try {
			const response = await fetch(
				`/api/v1/poly/agent-grants/${encodeURIComponent(request.grant_id)}`,
				{ method: "DELETE", credentials: "include" },
			);
			if (!response.ok) {
				setError("Could not revoke access. Try again.");
				setRevoking(false);
				return;
			}
			await onChanged();
		} catch {
			setError("Could not revoke access. Try again.");
			setRevoking(false);
		}
	}, [onChanged, request.grant_id]);

	return (
		<li className="space-y-4 rounded-lg border border-border p-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<AgentIdentity name={request.agent_display_name} />
				<Badge intent={STATUS_INTENT[request.status]} size="sm">
					{STATUS_LABEL[request.status]}
				</Badge>
			</div>
			<AccessDetails request={request} />
			<div className="flex flex-col gap-2 border-border border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-muted-foreground text-xs">
					Requested {formatDate(request.requested_at)}
				</p>
				{request.status === "active" && request.grant_id ? (
					<Button
						variant="destructive"
						size="sm"
						disabled={revoking}
						onClick={() => void revoke()}
					>
						{revoking ? (
							<>
								<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								Revoking…
							</>
						) : (
							"Revoke access"
						)}
					</Button>
				) : null}
			</div>
			{error ? (
				<p className="text-destructive text-sm" role="alert">
					{error}
				</p>
			) : null}
		</li>
	);
}

export function AgentAccessSection(): ReactElement {
	const [requests, setRequests] = useState<AgentAccessRequestOwner[]>([]);
	const [approvalToken, setApprovalToken] = useState<string | null>(null);
	const [preview, setPreview] = useState<AgentAccessRequestOwner | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [previewError, setPreviewError] = useState(false);

	const loadRequests = useCallback(async (): Promise<void> => {
		setLoading(true);
		setLoadError(false);
		try {
			const response = await fetch("/api/v1/poly/agent-access-requests", {
				credentials: "include",
			});
			if (!response.ok) {
				setLoadError(true);
				return;
			}
			const body = (await response.json()) as {
				requests: AgentAccessRequestOwner[];
			};
			setRequests(body.requests);
		} catch {
			setLoadError(true);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadRequests();

		let disposed = false;
		let previewSequence = 0;
		const readApprovalFragment = (): void => {
			const prefix = "#agent-request=";
			if (!window.location.hash.startsWith(prefix)) return;
			const token = window.location.hash.slice(prefix.length);
			window.history.replaceState(
				null,
				"",
				`${window.location.pathname}${window.location.search}`,
			);
			setPreview(null);
			setPreviewError(false);
			if (!token) {
				setApprovalToken(null);
				setPreviewError(true);
				return;
			}
			setApprovalToken(token);
			const sequence = ++previewSequence;
			void (async (): Promise<void> => {
				try {
					const response = await fetch(
						"/api/v1/poly/agent-access-requests/preview",
						{
							method: "POST",
							credentials: "include",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ approval_token: token }),
						},
					);
					if (disposed || sequence !== previewSequence) return;
					if (!response.ok) {
						setPreviewError(true);
						return;
					}
					const body = (await response.json()) as {
						request: AgentAccessRequestOwner;
					};
					setPreview(body.request);
				} catch {
					if (!disposed && sequence === previewSequence) {
						setPreviewError(true);
					}
				}
			})();
		};

		readApprovalFragment();
		window.addEventListener("hashchange", readApprovalFragment);
		return () => {
			disposed = true;
			window.removeEventListener("hashchange", readApprovalFragment);
		};
	}, [loadRequests]);

	const orderedRequests = useMemo(
		() =>
			[...requests].sort((left, right) => {
				const rank: Record<AccessStatus, number> = {
					pending: 0,
					active: 1,
					expired: 2,
					revoked: 3,
					denied: 4,
				};
				return (
					rank[left.status] - rank[right.status] ||
					right.requested_at.localeCompare(left.requested_at)
				);
			}),
		[requests],
	);

	const completeDecision = useCallback(async (): Promise<void> => {
		setPreview(null);
		setApprovalToken(null);
		await loadRequests();
	}, [loadRequests]);

	return (
		<div className="space-y-4 py-5">
			<div className="flex items-start gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<ShieldCheck className="size-4" aria-hidden="true" />
				</div>
				<div className="space-y-1">
					<p className="font-medium text-foreground text-sm">
						Control who can read your performance
					</p>
					<p className="text-muted-foreground text-sm">
						Your AI provides a secure approval link. Review its access here,
						then revoke it at any time.
					</p>
				</div>
			</div>

			{preview && approvalToken ? (
				<RequestPreview
					request={preview}
					approvalToken={approvalToken}
					onComplete={completeDecision}
				/>
			) : null}

			{previewError ? (
				<div
					className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
					role="alert"
				>
					<p className="font-medium text-foreground">
						This approval link is invalid, expired, or already used.
					</p>
					<p className="mt-1 text-muted-foreground">
						Ask your AI for a new approval link.
					</p>
				</div>
			) : null}

			{loading ? (
				<div className="flex items-center gap-2 py-3 text-muted-foreground text-sm">
					<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					Loading AI access…
				</div>
			) : null}

			{!loading && loadError ? (
				<div className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
					<p className="text-muted-foreground text-sm" role="alert">
						Couldn’t load AI access.
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void loadRequests()}
					>
						Try again
					</Button>
				</div>
			) : null}

			{!loading && !loadError && orderedRequests.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border p-4">
					<p className="font-medium text-foreground text-sm">
						No AI access yet
					</p>
					<p className="mt-1 text-muted-foreground text-sm">
						When an AI asks to connect, open its approval link while signed in.
					</p>
				</div>
			) : null}

			{!loading && !loadError && orderedRequests.length > 0 ? (
				<ul className="space-y-3" aria-label="AI access">
					{orderedRequests.map((request) => (
						<AccessRow
							key={request.id}
							request={request}
							onChanged={loadRequests}
						/>
					))}
				</ul>
			) : null}
		</div>
	);
}
