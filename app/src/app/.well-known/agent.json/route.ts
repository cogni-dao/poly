// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/.well-known/agent.json`
 * Purpose: Discovery document for machine agents — publishes the register,
 *   runs, runStream, and completions URLs plus the auth scheme so external
 *   clients can bootstrap without hard-coding paths or reading docs.
 * Scope: Single GET handler. Honors `x-forwarded-host`/`x-forwarded-proto`
 *   from Caddy / k8s ingress so the published URLs are externally reachable
 *   (falling back to the raw Host header then request.url for local dev).
 *   Public endpoint — no auth.
 * Invariants:
 *   - NO_INTERNAL_BIND_ADDR: URLs must never expose `0.0.0.0:3000` or other
 *     in-pod addresses. Always derive origin from forwarded headers first.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/prove-node-agent-api
 * @public
 */

import {
	APPROVAL_FRAGMENT_KEY,
	APPROVAL_PAGE,
	resourceOfKind,
} from "@cogni/agent-grants";
import {
	GoalsProgressSchema,
	MetricComputeInputSchema,
	MetricHistoryInputSchema,
	MetricHistorySchema,
	MetricListInputSchema,
	MetricListResponseSchema,
	MetricObservationSchema,
	MetricSnapshotSchema,
	MetricViewSchema,
} from "@cogni-dao/metrics/contracts";
import {
	agentAccessRequestCreateOperation,
	agentAccessRequestListOperation,
	confirmAgentCredentialOperation,
	creditsSummaryOperation,
	knowledgeHistoryOperation,
	revokeAgentCredentialOperation,
	rotateAgentCredentialOperation,
	upgradeAgentCredentialOperation,
	workItemsClaimOperation,
	workItemsCoordinationOperation,
	workItemsCreateOperation,
	workItemsDeleteOperation,
	workItemsGetOperation,
	workItemsHeartbeatOperation,
	workItemsHistoryOperation,
	workItemsListOperation,
	workItemsPatchOperation,
	workItemsReleaseOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
// Imported from the discovery module directly, not the feature barrel: this
// public endpoint must stay a pure projection and never pull the executor (and
// therefore a DB client) into its module graph.
import {
	accountReadDiscoveryActions,
	accountReadDiscoveryEndpoints,
} from "@/features/capability-plane/discovery";
import {
	getNodeBrandColor,
	getNodeBrandIcon,
	getNodeHook,
	getNodeMission,
	getNodeName,
	getNodeThumbnail,
} from "@/shared/config/repoSpec.server";
import {
	buildPermissionCatalog,
	buildRequiresById,
} from "@/bootstrap/agent-permissions";
import { POLY_PERMISSION_TOOLS } from "@/bootstrap/ai/permission-tools";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";

/**
 * Resolve the public origin this request reached us through. In prod the app
 * runs behind Caddy / k8s ingress, so Next.js's `request.url` exposes the
 * in-pod bind address (e.g. `http://0.0.0.0:3000`) rather than the external
 * host clients are using. Prefer the forwarded headers the proxy injects,
 * falling back to the raw `host` and `request.url` for local/dev usage.
 */
function publicOrigin(request: Request): string {
	const url = new URL(request.url);
	const host =
		request.headers.get("x-forwarded-host") ??
		request.headers.get("host") ??
		url.host;
	const proto =
		request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${proto}://${host}`;
}

export async function GET(request: Request) {
	const env = serverEnv();
	const origin = publicOrigin(request);
	// DECLARED_ONCE_SHOWN_EVERYWHERE: rendered from the grant declarations on every read, never a copy table.
	const { permissions: askable } = buildPermissionCatalog(
		buildRequiresById(POLY_PERMISSION_TOOLS),
	);
	// Each askable permission says where its approval link opens, from its declared kind (an account permission: the person's profile; any
	// other: the node-admin page). The ask returns the link itself (`approvalUrl`); this is its shape, so an agent can plan before it asks.
	const permissions = askable.map((p) => ({
		...p,
		approvalLink: {
			page: `${origin}${APPROVAL_PAGE[resourceOfKind(p.kind)]}`,
			fragment: `#${APPROVAL_FRAGMENT_KEY}=<one-time token>`,
			decidedBy:
				resourceOfKind(p.kind) === "account"
					? "the account owner"
					: "a node admin",
		},
	}));
	return NextResponse.json({
		name: "Cogni Node API",
		version: "v1",
		buildSha: env.APP_BUILD_SHA,
		// IDENTITY_IS_REPO_SPEC_PROJECTION: the node's display identity, projected from its own repo-spec
		// `intent` (never hardcoded). The operator reads THIS to render gallery cards — no operator-side
		// per-node literals. A node customizes itself by editing repo-spec, not operator code.
		identity: {
			name: getNodeName(),
			hook: getNodeHook(),
			mission: getNodeMission(),
			brand: {
				icon: getNodeBrandIcon(),
				color: getNodeBrandColor(),
				thumbnail: getNodeThumbnail(),
			},
		},
		registrationUrl: `${origin}/api/v1/agent/register`,
		auth: { type: "bearer", keyPrefix: "cogni_ag_sk_v1_" },
		endpoints: {
			openapi: `${origin}/openapi.json`,
			completions: `${origin}/api/v1/chat/completions`,
			graphs: `${origin}/api/v1/ai/agents`,
			runs: `${origin}/api/v1/agent/runs`,
			runStream: `${origin}/api/v1/agent/runs/{runId}/stream`,
			// Cognition substrate: session-start bundle (invariants + live skills
			// index + domain pointers). A SessionStart hook fetches + injects it.
			cognition: `${origin}/api/v1/cognition`,
			workItems: `${origin}/api/v1/work/items`,
			workItemClaims: `${origin}/api/v1/work/items/{id}/claims`,
			workItemHeartbeat: `${origin}/api/v1/work/items/{id}/heartbeat`,
			workItemCoordination: `${origin}/api/v1/work/items/{id}/coordination`,
			agentAccessRequests: `${origin}/api/v1/agent/access-requests`,
			accountCredits: `${origin}/api/v1/accounts/{accountId}/credits`,
			// GENERATED_DISCOVERY: one entry per account-read descriptor.
			...accountReadDiscoveryEndpoints(origin),
		},
		// Scopes an outside agent can ask for (requestPermission). Derived from the declarations, not listed here.
		permissions,
		permissionsHow:
			"Ask with requestPermission. The answer carries approvalUrl: one link, one-time, 24 hours. Give it to the person who decides: a node admin for a node permission, the account owner for an account permission (signed in, on their profile). A person who is signed out signs in first, then opens the link again (the link is a URL fragment and does not survive the sign-in redirect). Poll listMyPermissions for the state.",
		actions: {
			readGoalsProgress: {
				method: "GET",
				endpoint: `${origin}/api/v1/metrics/goals`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.strictObject({})),
				outputSchema: z.toJSONSchema(GoalsProgressSchema),
			},
			readMetricHistory: {
				method: "GET",
				endpoint: `${origin}/api/v1/metrics/{id}/history?from={from}&to={to}&step={step}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(
					MetricHistoryInputSchema.extend({ id: z.string() }),
				),
				outputSchema: z.toJSONSchema(MetricHistorySchema),
			},
			listMetrics: {
				method: "GET",
				endpoint: `${origin}/api/v1/metrics`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(MetricListInputSchema),
				outputSchema: z.toJSONSchema(MetricListResponseSchema),
			},
			readMetric: {
				method: "GET",
				endpoint: `${origin}/api/v1/metrics/{id}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.object({ id: z.string() })),
				outputSchema: z.toJSONSchema(
					MetricViewSchema.extend({
						history: z.array(MetricObservationSchema),
					}),
				),
			},
			readMetricObservation: {
				method: "GET",
				endpoint: `${origin}/api/v1/metrics/{id}/observations/{observationId}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(
					z.object({ id: z.string(), observationId: z.uuid() }),
				),
				outputSchema: z.toJSONSchema(MetricSnapshotSchema),
			},
			computeMetric: {
				method: "POST",
				endpoint: `${origin}/api/v1/metrics/{id}/compute`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(
					MetricComputeInputSchema.extend({ id: z.string() }),
				),
				outputSchema: z.toJSONSchema(MetricObservationSchema),
			},
			upgradeCredential: {
				method: "POST",
				endpoint: `${origin}/api/v1/agent/credentials/upgrade`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.strictObject({})),
				outputSchema: z.toJSONSchema(upgradeAgentCredentialOperation.output),
			},
			confirmCredential: {
				method: "POST",
				endpoint: `${origin}/api/v1/agent/credentials/confirm`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.strictObject({})),
				outputSchema: z.toJSONSchema(confirmAgentCredentialOperation.output),
			},
			rotateCredential: {
				method: "POST",
				endpoint: `${origin}/api/v1/agent/credentials/rotate`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.strictObject({})),
				outputSchema: z.toJSONSchema(rotateAgentCredentialOperation.output),
			},
			revokeCredential: {
				method: "POST",
				endpoint: `${origin}/api/v1/agent/credentials/revoke`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.strictObject({})),
				outputSchema: z.toJSONSchema(revokeAgentCredentialOperation.output),
			},
			requestPermission: {
				method: "POST",
				endpoint: `${origin}/api/v1/agent/access-requests`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(agentAccessRequestCreateOperation.input),
				outputSchema: z.toJSONSchema(agentAccessRequestCreateOperation.output),
			},
			listMyPermissions: {
				method: "GET",
				endpoint: `${origin}/api/v1/agent/access-requests`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(z.strictObject({})),
				outputSchema: z.toJSONSchema(agentAccessRequestListOperation.output),
			},
			readAccountCredits: {
				method: "GET",
				// Needs a live `account:read` grant from the account's owner (ask for it with requestPermission). Without one, or after it ends or
				// is turned Off, the answer is 404, the same as for an account that does not exist.
				endpoint: `${origin}/api/v1/accounts/{accountId}/credits`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(
					creditsSummaryOperation.input.extend({ accountId: z.string() }),
				),
				outputSchema: z.toJSONSchema(creditsSummaryOperation.output),
			},
			// GENERATED_DISCOVERY: method, path, required scope and both JSON
			// schemas are projected from the pure account-read descriptors, so an
			// agent can never read a shape the executor does not enforce.
			...accountReadDiscoveryActions(origin),
			listWorkItems: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsListOperation.input),
				outputSchema: z.toJSONSchema(workItemsListOperation.output),
			},
			createWorkItem: {
				method: "POST",
				endpoint: `${origin}/api/v1/work/items`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsCreateOperation.input),
				outputSchema: z.toJSONSchema(workItemsCreateOperation.output),
			},
			getWorkItem: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items/{id}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsGetOperation.input),
				outputSchema: z.toJSONSchema(workItemsGetOperation.output),
			},
			updateWorkItem: {
				method: "PATCH",
				endpoint: `${origin}/api/v1/work/items/{id}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsPatchOperation.input),
				outputSchema: z.toJSONSchema(workItemsPatchOperation.output),
			},
			deleteWorkItem: {
				method: "DELETE",
				endpoint: `${origin}/api/v1/work/items/{id}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsDeleteOperation.input),
				outputSchema: z.toJSONSchema(workItemsDeleteOperation.output),
			},
			claimWorkItem: {
				method: "POST",
				endpoint: `${origin}/api/v1/work/items/{id}/claims`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsClaimOperation.input),
				outputSchema: z.toJSONSchema(workItemsClaimOperation.output),
			},
			heartbeatWorkItem: {
				method: "POST",
				endpoint: `${origin}/api/v1/work/items/{id}/heartbeat`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsHeartbeatOperation.input),
				outputSchema: z.toJSONSchema(workItemsHeartbeatOperation.output),
			},
			releaseWorkItem: {
				method: "DELETE",
				endpoint: `${origin}/api/v1/work/items/{id}/claims?runId={runId}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsReleaseOperation.input),
				outputSchema: z.toJSONSchema(workItemsReleaseOperation.output),
			},
			getWorkItemHistory: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items/{id}/history`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsHistoryOperation.input),
				outputSchema: z.toJSONSchema(workItemsHistoryOperation.output),
			},
			getKnowledgeHistory: {
				method: "GET",
				endpoint: `${origin}/api/v1/knowledge/{id}/history`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(knowledgeHistoryOperation.input),
				outputSchema: z.toJSONSchema(knowledgeHistoryOperation.output),
			},
			getWorkItemCoordination: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items/{id}/coordination`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsCoordinationOperation.input),
				outputSchema: z.toJSONSchema(workItemsCoordinationOperation.output),
			},
		},
		cognition: {
			bootstrapUrl: `${origin}/api/v1/cognition`,
			sessionStartHook: `curl -fsS ${origin}/api/v1/cognition | jq -r .markdown`,
		},
		defaults: {
			model: "gpt-4o-mini",
			graph_name: "cogni",
		},
		usage: {
			note: "completions requires graph_name for newly registered agents",
			example: {
				model: "gpt-4o-mini",
				graph_name: "cogni",
				messages: [{ role: "user", content: "Hello" }],
			},
		},
	});
}
