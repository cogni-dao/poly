// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/container`
 * Purpose: Dependency injection container for application composition root with environment-based adapter selection.
 * Scope: Wire adapters to ports for runtime dependency injection. Provides webhookRegistrations for ingestion route, Temporal WorkflowClient singleton. Does not handle request-scoped lifecycle.
 * Invariants: All ports wired; single container instance per process; config.unhandledErrorPolicy set by env; webhookRegistrations lazy-initialized; Temporal connection singleton with race-safe init.
 * Side-effects: IO (initializes logger and emits startup log on first access)
 * Notes: LLM always uses LiteLlmAdapter; stack tests route to mock-openai-api. ContainerConfig controls wrapper behavior.
 * Links: Used by API routes and other entry points; configure adapters here for DI.
 * @public
 */

import { hostname } from "node:os";
import type { ToolSourcePort } from "@cogni/ai-core";
import type {
	EdoCapability,
	KnowledgeCapability,
	MetricsCapability,
	RepoCapability,
	WebSearchCapability,
} from "@cogni/ai-tools";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { AttributionStore } from "@cogni/attribution-ledger";
import {
	createDefaultRegistries,
	type DefaultRegistries,
	type FinalizeEpochInput,
	type FinalizeEpochOutput,
	type FinalizeLogger,
	type RunFinalizeEpochDeps,
	runFinalizeEpoch,
} from "@cogni/attribution-pipeline-plugins";
import {
	DrizzleAttributionAdapter,
	DrizzleClaimantWalletResolver,
} from "@cogni/db-client";
import type { FinancialLedgerPort } from "@cogni/financial-ledger";
import { createTigerBeetleAdapter } from "@cogni/financial-ledger/adapters";
import type { UserId } from "@cogni/ids";
import { toUserId, userActor } from "@cogni/ids";
import {
	type ContributionService,
	createContributionService,
	createEdoCapability,
	createKnowledgeCapability,
	defaultCanMergeKnowledge,
	type KnowledgeStorePort,
	shapeGate,
} from "@cogni/knowledge-store";
import {
	buildDoltgresClient,
	createDoltgresPusher,
	DoltgresEdoResolverAdapter,
	DoltgresKnowledgeContributionAdapter,
	DoltgresKnowledgeStoreAdapter,
	wrapPushSafe,
} from "@cogni/knowledge-store/adapters/doltgres";
import { parseMcpConfigFromEnv } from "@cogni/langgraph-graphs";
import { initAnalytics, shutdownAnalytics } from "@cogni/node-shared/analytics";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared/constants";
import {
	type NodeStreamPort,
	RedisNodeStreamAdapter,
} from "@cogni/node-streams";
import { numberToPpm } from "@cogni/operator-wallet";
import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
import { noopMetrics as noopMetricsForExecutor } from "@cogni/poly-market-provider";
import type { ScheduleControlPort } from "@cogni/scheduler-core";
import type { WorkItemCommandPort, WorkItemQueryPort } from "@cogni/work-items";
import {
	Client as TemporalClient,
	Connection as TemporalConnection,
	type WorkflowClient,
} from "@temporalio/client";
import Redis from "ioredis";
import type { Logger } from "pino";
import {
	ALCHEMY_ADAPTER_VERSION,
	AlchemyWebhookNormalizer,
	type Database,
	DrizzleAiTelemetryAdapter,
	DrizzleConnectionBrokerAdapter,
	DrizzleExecutionGrantUserAdapter,
	DrizzleExecutionGrantWorkerAdapter,
	DrizzleExecutionRequestAdapter,
	DrizzleGovernanceStatusAdapter,
	DrizzleGraphRunAdapter,
	DrizzleScheduleUserAdapter,
	DrizzleThreadPersistenceAdapter,
	EvmRpcOnChainVerifierAdapter,
	GITHUB_ADAPTER_VERSION,
	GitHubWebhookNormalizer,
	getAppDb,
	LangfuseAdapter,
	LiteLlmAdapter,
	type MimirAdapterConfig,
	MimirMetricsAdapter,
	RedisRunStreamAdapter,
	SystemClock,
	TemporalScheduleControlAdapter,
	UserDrizzleAccountService,
	UserDrizzlePaymentAttemptRepository,
	ViemEvmOnchainClient,
	ViemTreasuryAdapter,
} from "@/adapters/server";
import { ServiceDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import {
	AggregatingModelCatalog,
	ProviderResolver,
} from "@/adapters/server/ai/catalog";
import { mcpServersToCodexConfig } from "@/adapters/server/ai/codex/codex-mcp-config";
import {
	CodexModelProvider,
	OpenAiCompatibleModelProvider,
	PlatformModelProvider,
} from "@/adapters/server/ai/providers";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getServiceReadDb } from "@/adapters/server/db/drizzle.service-read-client";
import { DoltgresPolyWorkItemAdapter } from "@/adapters/server/db/doltgres/work-items-adapter";
import { createJobLeaderLockSession } from "@/adapters/server/db/job-leader-lock.client";
import { ServiceDrizzlePaymentAttemptRepository } from "@/adapters/server/payments/drizzle-payment-attempt.adapter";
import { SplitTreasurySettlementAdapter } from "@/adapters/server/treasury/split-treasury-settlement.adapter";
import {
	FakeMetricsAdapter,
	getTestEvmOnchainClient,
	getTestOnChainVerifier,
	getTestOperatorWallet,
} from "@/adapters/test";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";
import { startGovernanceSyncOnBoot } from "@/bootstrap/startup-reconcile";
import { createBoundToolSource } from "@/bootstrap/ai/tool-source.factory";
import {
	createPolyTradeExecutorFactory,
	type PolyTradeExecutor,
} from "@/bootstrap/capabilities/poly-trade-executor";
import {
	createMetricsCapability,
	derivePrometheusQueryUrl,
} from "@/bootstrap/capabilities/metrics";
import { createRepoCapability } from "@/bootstrap/capabilities/repo";
import { createScheduleCapability } from "@/bootstrap/capabilities/schedule";
import { stubVcsCapability } from "@/bootstrap/capabilities/vcs";
import { createWebSearchCapability } from "@/bootstrap/capabilities/web-search";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import type { RateLimitBypassConfig } from "@/bootstrap/http/wrapPublicRoute";
import {
	type AutoWrapJobHandle,
	startAutoWrap,
} from "@/bootstrap/jobs/auto-wrap.job";
import { startMirrorPoll } from "@/bootstrap/jobs/copy-trade-mirror.job";
import { startJobLeaderElector } from "@/bootstrap/jobs/job-leader-elector";
import {
	type OrderReconcilerHandle,
	startOrderReconciler,
} from "@/bootstrap/jobs/order-reconciler.job";
import {
	getExecutionVenueResolver,
	getPaperPortfolio,
	getPaperVenue,
} from "@/bootstrap/poly-execution-venue";
import {
	getPolyTraderWalletAdapter,
	WalletAdapterUnconfiguredError,
} from "@/bootstrap/poly-trader-wallet";
import { startProcessHealthPublisher } from "@/bootstrap/publishers";
import type { RedeemPipelineHandles } from "@/bootstrap/redeem-pipeline";
import {
	type CopyTradeTargetSource,
	dbTargetSource,
} from "@/features/copy-trade/target-source";
import {
	createOrderLedger,
	type OrderLedger,
} from "@/features/trading";
import type {
	AccountService,
	AiTelemetryPort,
	Clock,
	ConnectionBrokerPort,
	DataSourceRegistration,
	GovernanceStatusPort,
	LangfusePort,
	LlmService,
	MetricsQueryPort,
	ModelCatalogPort,
	ModelProviderResolverPort,
	OnChainVerifier,
	OperatorWalletPort,
	PaymentAttemptServiceRepository,
	PaymentAttemptUserRepository,
	RunStreamPort,
	ServiceAccountService,
	ThreadPersistencePort,
	TreasuryReadPort,
	TreasurySettlementPort,
} from "@/ports";
import type {
	ExecutionGrantUserPort,
	ExecutionGrantWorkerPort,
	ExecutionRequestPort,
	GraphRunRepository,
	ScheduleUserPort,
} from "@/ports/server";
import type { WorkItemsDoltgresPort } from "@/ports/work-items-doltgres.port";
import {
	getDaoTreasuryAddress,
	getEmissionsHolderAddress,
	getLedgerConfig,
	getNodeId,
	getNodeTokenomicsConfig,
	getOperatorWalletConfig,
	getPaymentConfig,
	getScopeId,
	getStewardWalletConfig,
} from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import { makeLogger } from "@/shared/observability";
import { EVENT_NAMES } from "@/shared/observability/events";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

export type UnhandledErrorPolicy = "rethrow" | "respond_500";

export interface ContainerConfig {
	/** How to handle unhandled errors in route wrappers: rethrow for dev/test, respond_500 for production safety */
	unhandledErrorPolicy: UnhandledErrorPolicy;
	/** Rate limit bypass config for stack tests; only enabled when APP_ENV=test */
	rateLimitBypass: RateLimitBypassConfig;
	/** Deploy environment for metrics/logging (e.g., "local", "preview", "production") */
	DEPLOY_ENVIRONMENT: string;
}

export interface Container {
	log: Logger;
	config: ContainerConfig;
	llmService: LlmService;
	accountsForUser(userId: UserId): AccountService;
	serviceAccountService: ServiceAccountService;
	clock: Clock;
	paymentAttemptsForUser(userId: UserId): PaymentAttemptUserRepository;
	paymentAttemptServiceRepository: PaymentAttemptServiceRepository;
	onChainVerifier: OnChainVerifier;
	evmOnchainClient: EvmOnchainClient;
	/** True when repo-spec has payments_in config (receiving address + chain). False for nodes pending activation. */
	paymentRailsActive: boolean;
	metricsQuery: MetricsQueryPort;
	treasuryReadPort: TreasuryReadPort;
	/** AI telemetry DB writer - always wired */
	aiTelemetry: AiTelemetryPort;
	/** Langfuse tracer - undefined when LANGFUSE_SECRET_KEY not set */
	langfuse: LangfusePort | undefined;
	nodeId: string;
	// Scheduling ports (split by trust boundary)
	scheduleControl: ScheduleControlPort;
	executionGrantPort: ExecutionGrantUserPort;
	executionGrantWorkerPort: ExecutionGrantWorkerPort;
	executionRequestPort: ExecutionRequestPort;
	graphRunRepository: GraphRunRepository;
	scheduleManager: ScheduleUserPort;
	/** Metrics capability for AI tools - requires PROMETHEUS_URL to be configured */
	metricsCapability: MetricsCapability;
	/** Web search capability for AI tools - requires TAVILY_API_KEY to be configured */
	webSearchCapability: WebSearchCapability;
	/** Repo capability for AI tools - requires COGNI_REPO_PATH */
	repoCapability: RepoCapability;
	/** Tool source with real implementations for AI tool execution */
	toolSource: ToolSourcePort;
	/** External-agent knowledge contribution service — undefined when DOLTGRES_URL is unset */
	knowledgeContributionService: ContributionService | undefined;
	/** Direct knowledge store port — exposed for the cookie-only browse endpoint. Undefined when DOLTGRES_URL is unset. */
	knowledgeStorePort: KnowledgeStorePort | undefined;
	/** EDO hypothesis-loop capability for the langgraph tool bindings AND the bearer-auth REST routes under /api/v1/edo. Always present (stubs throw when DOLTGRES_URL is unset). */
	edoCapability: EdoCapability;
	/** Thread persistence scoped to a user (RLS enforced) */
	threadPersistenceForUser(userId: UserId): ThreadPersistencePort;
	/** Governance status queries (system tenant scope) */
	governanceStatus: GovernanceStatusPort;
	/** Epoch ledger store — shared by app and scheduler-worker */
	attributionStore: AttributionStore;
	/** Work item queries — deployed source of truth is the node's Doltgres hub. */
	workItemQuery: WorkItemQueryPort;
	/** Work item commands — deployed source of truth is the node's Doltgres hub. */
	workItemCommand: WorkItemCommandPort;
	/** Extended CRUD surface used by the authenticated work-item HTTP API. */
	doltgresWorkItems: WorkItemsDoltgresPort;
	/** Run event streaming — publish/subscribe via Redis Streams */
	runStream: RunStreamPort;
	/** Node-level event streaming — undefined when REDIS_URL not set */
	nodeStream: NodeStreamPort | undefined;
	/** Webhook source registrations — normalizers for webhook ingestion */
	webhookRegistrations: ReadonlyMap<string, DataSourceRegistration>;
	/**
	 * Attribution pipeline registries (selection policies, enrichers, allocators,
	 * profiles) built from repo-spec excludedLogins/sourceRefs. Consumed by the
	 * in-process collect pass (attribution.collect.internal route).
	 */
	registries: DefaultRegistries;
	/**
	 * Source registrations usable by the in-process collect pass. On a node this is
	 * the webhook-only set (no poll adapter) — collect skips polling and runs over
	 * receipts already delivered via the Phase-1 receipt seam.
	 */
	sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
	/** Financial ledger — undefined when TIGERBEETLE_ADDRESS not set */
	financialLedger: FinancialLedgerPort | undefined;
	/** Operator wallet — undefined when PRIVY_APP_ID not set */
	operatorWallet: OperatorWalletPort | undefined;
	/** Treasury settlement — undefined when operator wallet not configured */
	treasurySettlement: TreasurySettlementPort | undefined;
	/** Connection broker — undefined when CONNECTIONS_ENCRYPTION_KEY not set */
	connectionBroker: ConnectionBrokerPort | undefined;
	/** Model catalog — aggregates all providers for model listing */
	modelCatalog: ModelCatalogPort;
	/** Provider resolver — resolves providerKey to ModelProviderPort for runtime dispatch */
	providerResolver: ModelProviderResolverPort;
	/** Service-role DB for explicitly cross-tenant/system Poly read models. */
	serviceDb: Database;
	/** Poly copy-trade/order ledger. Cross-tenant root surface; tenant calls use forTenant(ctx). */
	orderLedger: OrderLedger;
	/** Copy-trade target source (DB-backed). Reads per-user target rows for HTTP routes. */
	copyTradeTargetSource: CopyTradeTargetSource;
	/** Redeem pipeline handles keyed by billing account id; empty when pipelines are not running in this process. */
	redeemPipelineFor(billingAccountId: string): RedeemPipelineHandles | undefined;
	/** Best-effort cache invalidation for per-tenant trade executors. */
	invalidatePolyTradeExecutorFor(billingAccountId: string): void;
}

// Feature-specific dependency types
// AI adapter deps: used internally by createGraphExecutor
export type AiAdapterDeps = {
	llmService: LlmService;
	accountService: AccountService;
	clock: Clock;
	aiTelemetry: AiTelemetryPort;
	langfuse: LangfusePort | undefined;
	nodeId: string;
};

/**
 * Activity dashboard dependencies.
 * Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: charge_receipts is primary data source.
 * LLM detail (model/tokens) fetched via listLlmChargeDetails, merged in facade.
 */
export type ActivityDeps = {
	accountService: AccountService;
};

type RuntimeWorkItemAdapter = WorkItemsDoltgresPort & WorkItemQueryPort;

function createUnavailableWorkItemAdapter(): RuntimeWorkItemAdapter {
	return new Proxy(
		{},
		{
			get: () => async () => {
				const error = new Error(
					"Work-item hub is not configured. Set DOLTGRES_URL."
				);
				error.name = "DoltgresNotConfiguredError";
				throw error;
			},
		}
	) as RuntimeWorkItemAdapter;
}

function createUnavailableWorkItemCommand(): WorkItemCommandPort {
	return new Proxy(
		{},
		{
			get: () => async () => {
				throw new Error(
					"Authenticated work-item mutations must use the HTTP command plane.",
				);
			},
		},
	) as WorkItemCommandPort;
}

// Module-level singleton
let _container: Container | null = null;
let _temporalConnection: TemporalConnection | null = null;
let _workflowClient: WorkflowClient | null = null;
let _workflowClientPromise: Promise<{
	client: WorkflowClient;
	taskQueue: string;
}> | null = null;
// Reconciler handle — set when the reconciler starts (async boot path).
// Null until Polymarket creds are present and the async initialiser fires.
let _reconcilerHandle: OrderReconcilerHandle | null = null;
// Target-set reconciler handle — separate from the ledger-order reconciler
// above. Starts/stops per-target mirror polls to match the active target set
// every 30s (bug.0338 / POLL_RECONCILES_PER_TICK).
let _targetsReconcilerStop: (() => void) | null = null;
// Auto-wrap job handle (task.0429). Set when Privy + AEAD configured.
let _autoWrapHandle: AutoWrapJobHandle | null = null;
// Resting-sweep job stop fn (task.5001). Set after the mirror reconciler boots.
let _restingSweepStop: (() => void) | null = null;
// Live observed-trader job stop fn (task.5005). Public Data API only.
let _traderObservationStop: (() => void) | null = null;
// Condition-iterating market outcome writer (task.5016). CLOB public client.
let _marketOutcomeStop: (() => void) | null = null;
// Paper-account fact projection stop fn (migration 0083). Local SQL projection
// over our own ledger + one CLOB midpoint per open position.
let _paperProjectionStop: (() => void) | null = null;
// Per-asset price-history mirror job stop fn (task.5018). Public CLOB only.
let _priceHistoryStop: (() => void) | null = null;
// Top-wallets leaderboard mirror job stop fn (bug.5017). Public Data API only.
let _topWalletStatsStop: (() => void) | null = null;
// One-shot research prewarm stop fn (fix/research-route-caching). DB only.
let _researchPrewarmStop: (() => void) | null = null;
// One-shot fill-rollup backfill walker (task.research-rollup-read-models). DB only.
let _fillRollupBackfillStop: (() => void) | null = null;

// task.5016 — job-runner leader election. All background-job starts flow
// through ONE seam (`startBackgroundJobs` inside createContainer), wrapped by
// the advisory-lock elector when JOB_LEADER_ELECTION_ENABLED (default ON).
//
// _jobsEpoch makes start/stop idempotent against the fire-and-forget async
// boot IIFEs below: `stopAllJobHandles()` bumps the epoch, and every IIFE
// re-checks its captured epoch before storing a freshly created handle — a
// leadership loss that lands mid-boot stops the newborn job instead of
// leaking it past the stop sweep.
let _jobsEpoch = 0;
// Closure-bound stop for jobs whose handles live inside createContainer
// (redeem pipelines map). Set by createContainer; used by resetContainer.
let _stopBackgroundJobs: (() => void) | null = null;
// Elector handle stop — resolves after the lock connection is released.
let _jobLeaderElectorStop: (() => Promise<void>) | null = null;

/**
 * Stop + clear every module-scoped background-job handle. Bumps `_jobsEpoch`
 * first so in-flight async job boots self-cancel instead of re-registering.
 * Safe to call repeatedly and when nothing is running (LOSS_STOPS_JOBS /
 * IDEMPOTENT_TRANSITIONS — see jobs/job-leader-elector.ts).
 */
function stopAllJobHandles(): void {
	_jobsEpoch += 1;
	if (_reconcilerHandle) {
		try {
			_reconcilerHandle.stop();
		} catch {
			// Best-effort — stop errors must not block the sweep.
		}
		_reconcilerHandle = null;
	}
	if (_targetsReconcilerStop) {
		try {
			_targetsReconcilerStop();
		} catch {
			// Best-effort.
		}
		_targetsReconcilerStop = null;
	}
	if (_autoWrapHandle) {
		try {
			_autoWrapHandle.stop();
		} catch {
			// Best-effort.
		}
		_autoWrapHandle = null;
	}
	if (_restingSweepStop) {
		try {
			_restingSweepStop();
		} catch {
			// Best-effort.
		}
		_restingSweepStop = null;
	}
	if (_traderObservationStop) {
		try {
			_traderObservationStop();
		} catch {
			// Best-effort.
		}
		_traderObservationStop = null;
	}
	if (_marketOutcomeStop) {
		try {
			_marketOutcomeStop();
		} catch {
			// Best-effort.
		}
		_marketOutcomeStop = null;
	}
	if (_paperProjectionStop) {
		try {
			_paperProjectionStop();
		} catch {
			// Best-effort.
		}
		_paperProjectionStop = null;
	}
	if (_priceHistoryStop) {
		try {
			_priceHistoryStop();
		} catch {
			// Best-effort.
		}
		_priceHistoryStop = null;
	}
	if (_topWalletStatsStop) {
		try {
			_topWalletStatsStop();
		} catch {
			// Best-effort.
		}
		_topWalletStatsStop = null;
	}
	if (_researchPrewarmStop) {
		try {
			_researchPrewarmStop();
		} catch {
			// Best-effort.
		}
		_researchPrewarmStop = null;
	}
	if (_fillRollupBackfillStop) {
		try {
			_fillRollupBackfillStop();
		} catch {
			// Best-effort.
		}
		_fillRollupBackfillStop = null;
	}
}

/**
 * Get the singleton container instance.
 * Lazily initializes on first access.
 */
export function getContainer(): Container {
	if (!_container) {
		_container = createContainer();
		startGovernanceSyncOnBoot(_container.log);
	}
	return _container;
}

/**
 * Reset the singleton container.
 * For tests only - allows fresh container between test runs.
 */
export function resetContainer(): void {
	_container = null;
	_webhookRegistrations = null;
	// task.5016 — retire the elector first (releases the advisory lock,
	// fire-and-forget: tests re-create containers; nothing blocks here), then
	// sweep every job. _stopBackgroundJobs also covers the closure-scoped
	// redeem pipelines; the module-level sweep is the fallback when the
	// container was never fully created.
	if (_jobLeaderElectorStop) {
		void _jobLeaderElectorStop().catch(() => {});
		_jobLeaderElectorStop = null;
	}
	if (_stopBackgroundJobs) {
		try {
			_stopBackgroundJobs();
		} catch {
			// Best-effort — tests re-create the container; nothing blocks here.
		}
		_stopBackgroundJobs = null;
	} else {
		stopAllJobHandles();
	}
	if (_temporalConnection) {
		void _temporalConnection.close();
	}
	_temporalConnection = null;
	_workflowClient = null;
	_workflowClientPromise = null;
}

/**
 * Get a process-wide Temporal WorkflowClient singleton + task queue.
 * Avoids per-request Connection.connect() overhead on hot paths.
 * Returns both client and taskQueue so callers never need serverEnv() directly.
 */
export async function getTemporalWorkflowClient(): Promise<{
	client: WorkflowClient;
	taskQueue: string;
}> {
	// Per QUEUE_PER_NODE_ISOLATION (task.0280): submit to a per-node task queue
	// keyed on this node's UUID. The worker runs one Temporal Worker per node,
	// so one node's queue backlog does not starve the others.
	const perNodeTaskQueue = `${serverEnv().TEMPORAL_TASK_QUEUE}-${getNodeId()}`;
	if (_workflowClient) {
		return {
			client: _workflowClient,
			taskQueue: perNodeTaskQueue,
		};
	}
	if (!_workflowClientPromise) {
		_workflowClientPromise = (async () => {
			const env = serverEnv();
			const connection = await TemporalConnection.connect({
				address: env.TEMPORAL_ADDRESS,
			});
			const temporalClient = new TemporalClient({
				connection,
				namespace: env.TEMPORAL_NAMESPACE,
			});
			_temporalConnection = connection;
			_workflowClient = temporalClient.workflow;
			return { client: _workflowClient, taskQueue: perNodeTaskQueue };
		})();
	}
	return _workflowClientPromise;
}

/** Lazy singleton for webhook registrations (avoids import cost at container init). */
let _webhookRegistrations: ReadonlyMap<string, DataSourceRegistration> | null =
	null;

function getWebhookRegistrations(): ReadonlyMap<
	string,
	DataSourceRegistration
> {
	if (!_webhookRegistrations) {
		const registrations = new Map<string, DataSourceRegistration>();
		registrations.set("github", {
			source: "github",
			version: GITHUB_ADAPTER_VERSION,
			webhook: new GitHubWebhookNormalizer(),
		});
		registrations.set("alchemy", {
			source: "alchemy",
			version: ALCHEMY_ADAPTER_VERSION,
			webhook: new AlchemyWebhookNormalizer(),
		});
		_webhookRegistrations = registrations;
	}
	return _webhookRegistrations;
}

/** Lazy singleton for attribution pipeline registries (built from repo-spec). */
let _collectRegistries: DefaultRegistries | null = null;

/**
 * Build the attribution pipeline registries for the in-process collect pass.
 * excludedLogins + sourceRefs are read from repo-spec activity_sources the same
 * way the scheduler-worker does (fail-open: absent ledger config → empty filters).
 */
function getCollectRegistries(): DefaultRegistries {
	if (!_collectRegistries) {
		const ledgerConfig = getLedgerConfig();
		const excludedLogins = ledgerConfig
			? Object.values(ledgerConfig.activitySources).flatMap(
					(s) => s.excludedLogins ?? [],
				)
			: [];
		const sourceRefs = ledgerConfig
			? Object.values(ledgerConfig.activitySources).flatMap(
					(s) => s.sourceRefs ?? [],
				)
			: [];
		_collectRegistries = createDefaultRegistries({
			excludedLogins,
			sourceRefs,
		});
	}
	return _collectRegistries;
}

/**
 * Assemble deps for IN-PROCESS epoch finalization (story.5007 — finalize-in-process).
 * The node runs `runFinalizeEpoch` synchronously in its own finalize route on its OWN
 * service DB + repo-spec, retiring the Temporal FinalizeEpochWorkflow round-trip (no
 * ledger-tasks queue, no cross-scope theft). All adapter/registry wiring lives here —
 * the route boundary forbids adapter imports.
 *
 * - `attributionStore` = service DB (BYPASSRLS) scoped adapter.
 * - `walletResolver` built only when a token is configured; else the R3 fold no-ops.
 * - `distributionConfigClient` = null. A node finalizes only its OWN epochs, so the
 *   baked tokenomics from its OWN repo-spec are already authoritative (no per-node
 *   gateway — that is an operator-only concept). The bug.5020 execute-guard still
 *   fires on the baked emissions-holder / non-production runtime.
 */
function buildFinalizeEpochDeps(logger: FinalizeLogger): RunFinalizeEpochDeps {
	const serviceDb = getServiceDb();
	const tokenomics = getNodeTokenomicsConfig();
	return {
		attributionStore: new DrizzleAttributionAdapter(serviceDb, getScopeId()),
		registries: getCollectRegistries(),
		nodeId: getNodeId(),
		scopeId: getScopeId(),
		chainId: tokenomics.chainId,
		tokenAddress: tokenomics.tokenAddress,
		distributorAddress: tokenomics.distributorAddress,
		emissionsHolderAddress: getEmissionsHolderAddress(),
		walletResolver: tokenomics.tokenAddress
			? new DrizzleClaimantWalletResolver(serviceDb)
			: null,
		distributionConfigClient: null,
		deploymentEnvironment: serverEnv().DEPLOY_ENVIRONMENT,
		logger,
	};
}

/**
 * Run epoch finalization IN-PROCESS (story.5007). Thin composition-root wrapper the
 * finalize route calls instead of dispatching a Temporal FinalizeEpochWorkflow — keeps
 * the route free of adapter/package wiring (route boundary). Idempotent: a re-POST
 * repairs; the fold FREEZE (bug.5022) preserves a published manifest.
 */
export async function finalizeEpochInProcess(
	input: FinalizeEpochInput,
	logger: FinalizeLogger,
): Promise<FinalizeEpochOutput> {
	return runFinalizeEpoch(buildFinalizeEpochDeps(logger), input);
}

function createContainer(): Container {
	const env = serverEnv();
	const nodeId = getNodeId();
	const db = getAppDb();
	const log = makeLogger({ service: "cogni-template", nodeId });

	// Startup log - confirm config in Loki (no URLs/secrets)
	log.info(
		{
			env: env.APP_ENV,
			logLevel: env.PINO_LOG_LEVEL,
			pretty: env.NODE_ENV === "development",
		},
		"container initialized",
	);

	// Initialize PostHog product analytics (required — env validated at boot)
	if (env.POSTHOG_API_KEY && env.POSTHOG_HOST) {
		initAnalytics({
			apiKey: env.POSTHOG_API_KEY,
			host: env.POSTHOG_HOST,
			appVersion: env.COGNI_REPO_SHA ?? "unknown",
			environment: env.DEPLOY_ENVIRONMENT ?? "local",
		});
		log.info("PostHog analytics initialized");
	} else {
		log.info("PostHog not configured — analytics disabled");
	}

	// Flush analytics events on graceful shutdown
	const flushOnExit = () => {
		shutdownAnalytics().catch(() => {});
	};
	process.on("SIGTERM", flushOnExit);
	process.on("SIGINT", flushOnExit);

	// LLM adapter: always LiteLlmAdapter (test stacks use mock-openai-api via litellm.test.config.yaml)
	const llmService = new LiteLlmAdapter();

	// EvmOnchainClient: test uses singleton fake (configurable from tests), production uses viem RPC
	const evmOnchainClient = env.isTestMode
		? getTestEvmOnchainClient()
		: new ViemEvmOnchainClient();

	// OnChainVerifier: test uses singleton fake (configurable from tests), production uses EVM RPC verifier
	const onChainVerifier = env.isTestMode
		? getTestOnChainVerifier()
		: new EvmRpcOnChainVerifierAdapter(evmOnchainClient);

	// MetricsQuery: test uses fake adapter, production uses Prometheus HTTP API
	// Not configured: stub that throws on use (deferred error, doesn't block startup)
	const metricsQuery: MetricsQueryPort = env.isTestMode
		? new FakeMetricsAdapter()
		: (() => {
				const queryUrl = derivePrometheusQueryUrl(env);
				if (
					!queryUrl ||
					!env.PROMETHEUS_READ_USERNAME ||
					!env.PROMETHEUS_READ_PASSWORD
				) {
					// Return stub that throws on use - allows app to start without metrics config
					const notConfiguredError = new Error(
						"MetricsQueryPort not configured. Set PROMETHEUS_QUERY_URL (or PROMETHEUS_REMOTE_WRITE_URL " +
							"ending in /api/prom/push) + PROMETHEUS_READ_USERNAME + PROMETHEUS_READ_PASSWORD.",
					);
					return {
						queryRange: async () => {
							throw notConfiguredError;
						},
						queryInstant: async () => {
							throw notConfiguredError;
						},
						queryTemplate: async () => {
							throw notConfiguredError;
						},
					} satisfies MetricsQueryPort;
				}

				const mimirConfig: MimirAdapterConfig = {
					url: queryUrl,
					username: env.PROMETHEUS_READ_USERNAME,
					password: env.PROMETHEUS_READ_PASSWORD,
					timeoutMs: env.ANALYTICS_QUERY_TIMEOUT_MS,
				};
				return new MimirMetricsAdapter(mimirConfig);
			})();

	// FinancialLedger: optional — only when TIGERBEETLE_ADDRESS is configured
	// @cogni/financial-ledger/adapters is in serverExternalPackages (N-API addon, not bundleable)
	const financialLedger: FinancialLedgerPort | undefined = (() => {
		if (!env.TIGERBEETLE_ADDRESS) return undefined;
		try {
			const adapter = createTigerBeetleAdapter(env.TIGERBEETLE_ADDRESS);
			log.info(
				{ address: env.TIGERBEETLE_ADDRESS },
				"TigerBeetle financial ledger connected",
			);
			return adapter;
		} catch (err) {
			log.warn(
				{ err },
				"TigerBeetle client failed to initialize — financial ledger disabled",
			);
			return undefined;
		}
	})();

	// Always use real database adapters
	// Testing strategy: unit tests mock the port, integration tests use real DB
	const serviceAccountService = new ServiceDrizzleAccountService(
		getServiceDb(),
		financialLedger,
	);
	// TreasuryReadPort: always uses ViemTreasuryAdapter (no test fake needed - mocked at port level in tests)
	const treasuryReadPort = new ViemTreasuryAdapter(evmOnchainClient);

	// AI Telemetry: DrizzleAiTelemetryAdapter always wired (per AI_SETUP_SPEC.md)
	const aiTelemetry = new DrizzleAiTelemetryAdapter(db);

	// Langfuse: only wired when LANGFUSE_SECRET_KEY is set (optional)
	// Environment read by SDK from LANGFUSE_TRACING_ENVIRONMENT env var
	const langfuse: Container["langfuse"] =
		env.LANGFUSE_SECRET_KEY && env.LANGFUSE_PUBLIC_KEY
			? new LangfuseAdapter({
					publicKey: env.LANGFUSE_PUBLIC_KEY,
					secretKey: env.LANGFUSE_SECRET_KEY,
					...(env.LANGFUSE_BASE_URL ? { baseUrl: env.LANGFUSE_BASE_URL } : {}),
				})
			: undefined;

	const clock = new SystemClock();

	// Scheduling adapters (from @cogni/db-client)
	// Per architecture rule: composition root injects loggers via child()

	// ScheduleControlPort: Temporal is required infrastructure
	// Per SCHEDULER_SPEC.md: TEMPORAL_ADDRESS + TEMPORAL_NAMESPACE must be configured
	if (!env.TEMPORAL_ADDRESS || !env.TEMPORAL_NAMESPACE) {
		throw new Error(
			"TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE are required. " +
				"Start Temporal with: pnpm dev:infra",
		);
	}
	// Per QUEUE_PER_NODE_ISOLATION: Schedules submit to this node's per-node
	// queue. Existing schedules on the legacy queue keep firing until their
	// next update (drain Worker in scheduler-worker still polls the base name).
	const scheduleControl: ScheduleControlPort =
		new TemporalScheduleControlAdapter({
			address: env.TEMPORAL_ADDRESS,
			namespace: env.TEMPORAL_NAMESPACE,
			taskQueue: `${env.TEMPORAL_TASK_QUEUE}-${getNodeId()}`,
		});

	// Service DB (BYPASSRLS) for worker adapters
	const serviceDb = getServiceDb();
	const paymentAttemptServiceRepository =
		new ServiceDrizzlePaymentAttemptRepository(serviceDb);
	// ONE_VENUE_RESOLVER_PER_PROCESS — the ledger's `mode` stamp and the executor
	// factory's venue dispatch read the same resolver, so a row can never be
	// labeled `live` while its order went to the paper sidecar.
	const executionVenueResolver = getExecutionVenueResolver();
	const orderLedger = createOrderLedger({
		db: serviceDb,
		appDb: db,
		logger: log.child({ component: "order-ledger" }),
		// MODE_STAMPED_FROM_ACCOUNT — resolved per write from the row's own
		// account's `poly_wallet_connections.kind`, not from a process-wide env.
		resolveExecutionMode: executionVenueResolver,
	});
	// DB-backed copy-trade target source. Candidate/preview always have a real
	// Postgres, so there's no need for an in-memory env fallback here.
	const copyTradeTargetSource: CopyTradeTargetSource = dbTargetSource({
		appDb:
			db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
				Record<string, unknown>
			>,
		serviceDb:
			serviceDb as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
				Record<string, unknown>
			>,
		// bug.5288 — without this the enumerator's activation predicate drops a
		// tenant silently: trading halts and looks identical to idle. Wired so an
		// expired grant names itself in the logs.
		logger: log.child({ component: "copy-trade-target-source" }),
	});
	const redeemPipelines = new Map<string, RedeemPipelineHandles>();

	// The paper venue's read side — executor position seam + the NAV the mirror's
	// position_gap denominator needs. Shared with the wallet-refresh and
	// manual-close routes through `@/bootstrap/poly-execution-venue`, so all three
	// executor construction sites read paper facts the same way.
	const paperPortfolio = getPaperPortfolio();

	// Per-tenant trade-executor factory. Lazily constructs a
	// `PolyTradeExecutor` for a given `billingAccountId` and dispatches it to the
	// venue that account's `poly_wallet_connections.kind` names
	// (VENUE_RESOLVED_FROM_ACCOUNT). Live accounts use the per-user Privy app
	// (`PRIVY_USER_WALLETS_*`) — distinct from the operator-wallet Privy app used
	// by `OperatorWalletPort`. Sole placement path post Stage 4 purge — the
	// former single-operator `polyTradeBundle` is gone and will not come back.
	//
	// The custody port is OPTIONAL here: a deployment that serves only paper
	// accounts legitimately has no Privy / AEAD credentials, and the paper venue
	// does not route through that adapter at all. When the port is missing, a
	// paper account still builds and a LIVE account fails loudly inside
	// `buildExecutor` with `no_connection` — never a silent downgrade to paper.
	// (Pre-0082 this slot held a Proxy whose every property access threw.)
	const polyTradeExecutorFactory: ReturnType<
		typeof createPolyTradeExecutorFactory
	> = (() => {
		const walletPort = (() => {
			try {
				return getPolyTraderWalletAdapter(log);
			} catch (err) {
				if (err instanceof WalletAdapterUnconfiguredError) {
					log.info(
						{ missing: err.message },
						"poly trader wallet adapter not configured (PRIVY_USER_WALLETS_* or POLY_WALLET_AEAD_* missing) — live accounts cannot place on this deployment; paper accounts still can",
					);
					return undefined;
				}
				throw err;
			}
		})();
		return createPolyTradeExecutorFactory({
			...(walletPort ? { walletPort } : {}),
			logger: log,
			metrics: noopMetricsForExecutor,
			polygonRpcUrl: env.POLYGON_RPC_URL,
			paperSidecarUrl: env.PAPER_SIDECAR_URL,
			resolveExecutionVenue: executionVenueResolver,
			paperVenue: getPaperVenue(),
			// The paper venue's position reads, backed by the migration-0083 fact
			// projection. Absent / incomplete / stale facts raise
			// `PaperFactsUnavailableError` from inside the reader — this wiring adds
			// no fallback, so there is still no path on which a paper position read
			// answers 0 without a complete, fresh projection behind it.
			paperPositions: paperPortfolio,
		});
	})();

	// ─── task.5016: THE background-job start seam ────────────────────────────
	// Every in-process background job starts inside startBackgroundJobs() and
	// stops via stopBackgroundJobs() — one leadership domain. When
	// JOB_LEADER_ELECTION_ENABLED (default ON) the advisory-lock elector below
	// decides when these run; when OFF they start unconditionally at boot,
	// exactly the pre-task.5016 behavior. `epoch` is captured at start so the
	// async boot IIFEs can detect a stop that raced them and retire their
	// freshly created handle instead of leaking it (see stopAllJobHandles).
	const startBackgroundJobs = (): void => {
		const epoch = _jobsEpoch;
	// Autonomous 30s mirror poll per target wallet. A target-set reconciler
	// ticks `copyTradeTargetSource.listAllActive()` every 30s and diffs the
	// result against running per-target polls — so a user POSTing a tracked
	// wallet begins copy-trading within one tick, with no pod restart
	// (bug.0338 / POLL_RECONCILES_PER_TICK). One `startMirrorPoll` per active
	// (tenant × wallet); exactly one `startOrderReconciler` process-wide
	// (per-tenant dispatch is internal, routed through the executor factory).
	//
	// The executor factory is always constructed now (a paper-only deployment
	// needs no Privy / AEAD credentials, and per-account venue dispatch decides
	// what each tenant can actually do), so this is no longer a credential gate:
	// the gate is the active-target × active-connection × active-grant predicate
	// inside `listAllActive`. Daily/hourly USDC caps live in each tenant's
	// `poly_wallet_grants` and are enforced on the hot path inside
	// `PolyTradeExecutor.placeIntent` — by `authorizeIntent` for a live account,
	// by the paper venue's authorizer for a paper one.
	// bug.0438: copy-trade has no per-tenant kill-switch. The `!== undefined`
	// guard below is vestigial (the factory is now always defined) and kept only
	// to avoid re-indenting the whole job-start block in this change.
	if (polyTradeExecutorFactory !== undefined) {
		const executorFactory = polyTradeExecutorFactory;
		// Lazy-load the poll wiring so its transitive imports (Data-API HTTP
		// client, Drizzle queries) don't run on pods without Polymarket creds.
		void (async () => {
			try {
				const { createPolymarketChainActivitySource } = await import(
					"@/features/wallet-watch"
				);
				const {
					POLYGON_CONDITIONAL_TOKENS,
					PolymarketDataApiClient,
					createPolymarketTargetBookProviderV1,
				} = await import(
					"@cogni/poly-market-provider/adapters/polymarket"
				);
				// task.5043 / bug.5049 — Polygon `OrderFilled` chain logs are the
				// wallet-watch source. bug.5051: use a WebSocket transport so viem's
				// `watchContractEvent` uses `eth_subscribe` (push, server-side
				// filter). HTTP transport falls back to `eth_newFilter` +
				// `eth_getFilterChanges` polling — Alchemy GCs the filter and viem
				// 2.39 does not recreate it, costing ~98% of events.
				const polygonWssUrl =
					env.POLYGON_RPC_WSS_URL ??
					// `https://…` → `wss://…`, `http://…` → `ws://…`, anything else
					// (already `ws://` or `wss://`) passes through.
					env.POLYGON_RPC_URL?.replace(/^http(s?):\/\//, "ws$1://");
				if (!polygonWssUrl) {
					log.warn(
						{
							event: "poly.mirror.chain_source.disabled",
							reason:
								"POLYGON_RPC_WSS_URL (or derivable POLYGON_RPC_URL) missing",
						},
						"copy-trade mirror not started — Polygon WSS endpoint required for the chain fill source",
					);
					return;
				}
				const { createPublicClient, parseAbi, webSocket } = await import("viem");
				const { polygon } = await import("viem/chains");
				const chainPublicClient = createPublicClient({
					chain: polygon,
					transport: webSocket(polygonWssUrl),
				});
				// noopMetrics for v0 — real prom-client wiring folds into a follow-up
				// once the `poly_mirror_*` series has a Grafana dashboard to back it.
				const { noopMetrics } = await import("@cogni/poly-market-provider");
				const {
					buildMirrorTargetConfig,
					targetConditionPositionFromDataApiPositions,
				} = await import("@/bootstrap/jobs/copy-trade-mirror.job");
				const { startCopyTradeReconciler } = await import(
					"@/bootstrap/copy-trade-reconciler"
				);
				const dataApiClient = new PolymarketDataApiClient();
				const targetBookProvider = createPolymarketTargetBookProviderV1({
					dataSource: dataApiClient,
				});
				const { PositionGapTargetRefreshCoordinator } = await import(
					"@/features/copy-trade/position-gap-target-refresh"
				);
				const { PositionGapRuntimeStore } = await import(
					"@/features/copy-trade/position-gap-runtime-store"
				);
				const { startPositionGapActor } = await import(
					"@/features/copy-trade/position-gap-actor"
				);
				const positionGapRefresh = new PositionGapTargetRefreshCoordinator(
					targetBookProvider,
				);
				const positionGapStore = new PositionGapRuntimeStore(serviceDb);
				const positionGapActors = new Map<
					string,
					ReturnType<typeof startPositionGapActor>
				>();
				const ctfBalanceAbi = parseAbi([
					"function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
				]);
				// Only used for the position_gap NAV denominator (free pUSD on the
				// live trading wallet). A paper-only deployment has no Privy / AEAD
				// config, and since the paper-unusable Proxy stub is gone this throws
				// there — so tolerate its absence rather than taking the whole mirror
				// poll down with it. `getMirrorPortfolioSnapshot` is left unwired in
				// that case, which makes position_gap decline to size instead of
				// sizing against an invented NAV.
				const mirrorWalletPort = (() => {
					try {
						return getPolyTraderWalletAdapter(log);
					} catch (err) {
						if (err instanceof WalletAdapterUnconfiguredError) {
							log.info(
								{ missing: err.message },
								"mirror poll: live wallet adapter unconfigured — position_gap NAV reads disabled on this deployment",
							);
							return undefined;
						}
						throw err;
					}
				})();
				// pino's Logger is structurally compatible with LoggerPort's subset
				// (debug/info/warn/error/child with object + optional msg).
				const mirrorLogger =
					log as unknown as import("@cogni/poly-market-provider").LoggerPort;

				// Ledger reconciler — syncs open/pending rows from CLOB getOrder,
				// dispatched per tenant. Each ledger row carries its
				// `billing_account_id`; the reconciler routes `getOrder` through the
				// per-tenant `PolyTradeExecutor` so we hit the right CLOB API creds
				// (each tenant's creds are derived from their Privy signer). One
				// reconciler runs on the pod; per-tenant dispatch is internal.
				const reconcilerHandle = startOrderReconciler({
					ledger: orderLedger,
					getOrderForTenant: async (billingAccountId, orderId) => {
						const executor =
							await executorFactory.getPolyTradeExecutorFor(billingAccountId);
						return executor.getOrder(orderId);
					},
					logger: mirrorLogger,
					metrics: noopMetrics,
					notFoundGraceMs: env.POLY_CLOB_NOT_FOUND_GRACE_MS,
					onOrderChanged: (row, change) => {
						const actor = positionGapActors.get(
							`${row.billing_account_id}:${row.target_id}`,
						);
						if (
							change.reason === "clob_not_found" ||
							change.reason === "never_placed"
						) {
							actor?.observeLedgerTerminal(
								row.client_order_id,
								change.reason,
							);
						} else {
							actor?.wake("order_event");
						}
					},
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					reconcilerHandle.stop();
					return;
				}
				_reconcilerHandle = reconcilerHandle;

				// Target-set reconciler — ticks listAllActive every 30s, starts/stops
				// per-wallet polls to match. First tick fires immediately. See
				// docs/spec/poly-tenant-and-collateral.md § POLL_RECONCILES_PER_TICK.
				//
				// `listAllActive` requires an active `poly_wallet_connections` row with
				// an active `poly_wallet_grants` row, so the reconciler only hands us
				// tenants that have (a) an active account of either kind and (b) an
				// active grant. Each
				// per-tenant poll routes placements through the per-tenant
				// `PolyTradeExecutor`, which wraps every `placeOrder` with
				// `authorizeIntent` so scope + cap + grant-revoke checks run on the
				// hot path.
				const targetsReconcilerStop = startCopyTradeReconciler({
					targetSource: copyTradeTargetSource,
					startPollForTarget: (enumeratedTarget) => {
						const targetWallet = enumeratedTarget.targetWallet;
						// MODE_STAMPED_FROM_ACCOUNT — the ledger resolves each row's mode
						// from that row's own account. No need to thread mode through
						// `MirrorTargetConfig`; the planner + pipeline stay mode-agnostic,
						// and the decision LOG gets `execution_mode` from
						// `getExecutionMode` below. Pair with VENUE_RESOLVED_FROM_ACCOUNT
						// (poly-trade-executor.ts).
						const target = buildMirrorTargetConfig({
							targetWallet,
							billingAccountId: enumeratedTarget.billingAccountId,
							createdByUserId: enumeratedTarget.createdByUserId,
							mirrorFilterPercentile: enumeratedTarget.mirrorFilterPercentile,
							mirrorMaxUsdcPerTrade: enumeratedTarget.mirrorMaxUsdcPerTrade,
							sizingPolicyKind: enumeratedTarget.sizingPolicyKind,
							...(enumeratedTarget.targetRangeMaxUsdc !== null
								? { targetRangeMaxUsdc: enumeratedTarget.targetRangeMaxUsdc }
								: {}),
							...(enumeratedTarget.mirrorMaxAllocPerConditionUsdc !== null
								? {
										mirrorMaxAllocPerConditionUsdc:
											enumeratedTarget.mirrorMaxAllocPerConditionUsdc,
									}
								: {}),
							mirrorCapitalBudgetUsdc:
								enumeratedTarget.mirrorCapitalBudgetUsdc,
							positionGapBudgetGroup: enumeratedTarget.positionGapBudgetGroup,
						});
						const source = createPolymarketChainActivitySource({
							publicClient: chainPublicClient,
							client: dataApiClient,
							wallet: targetWallet,
							logger: mirrorLogger,
							metrics: noopMetrics,
						});

						// Build once per (tenant × target). Executor is cached across
						// ticks inside the factory keyed on billingAccountId.
						let cachedExecutor: PolyTradeExecutor | null = null;
						const getExecutor = async (): Promise<PolyTradeExecutor> => {
							if (cachedExecutor) return cachedExecutor;
							cachedExecutor = await executorFactory.getPolyTradeExecutorFor(
								enumeratedTarget.billingAccountId,
							);
							return cachedExecutor;
						};

						if (enumeratedTarget.sizingPolicyKind === "position_gap") {
							const actor = startPositionGapActor({
								scope: {
									billingAccountId: enumeratedTarget.billingAccountId,
									createdByUserId: enumeratedTarget.createdByUserId,
									targetId: target.target_id,
								},
								targetWallet,
								configRevision: enumeratedTarget.mirrorActivatedAt.toISOString(),
								configuredBudgetUsdc:
									enumeratedTarget.mirrorCapitalBudgetUsdc,
								positionGapBudgetGroup:
									enumeratedTarget.positionGapBudgetGroup,
								source,
								refresh: positionGapRefresh,
								store: positionGapStore,
								ledger: orderLedger,
								execution: {
									placeBuy: async (intent) =>
										(await getExecutor()).placeIntent(intent),
									cancelBuy: async (orderId) =>
										(await getExecutor()).cancelOrder(orderId),
									getBuy: async (orderId) =>
										(await getExecutor()).getOrder(orderId),
									getMarketConstraints: async (tokenId, placement) =>
										(await getExecutor()).getMarketConstraints(
											tokenId,
											placement,
										),
								},
								fillEvidence: {
									getWalletAddress: async () =>
										(await getExecutor()).funderAddress,
									listActivity: async (wallet, params) =>
										dataApiClient.listActivity(wallet, params),
									listPositions: async (wallet, conditionId) =>
										dataApiClient.listUserPositions(wallet, {
											market: conditionId,
											sizeThreshold: 0,
											limit: 500,
										}),
								},
								getWalletCashUsdc: async () => {
									// VENUE_DECIDES_THE_CASH_SOURCE (NO_FABRICATED_VALUES) — the third
									// and last of v3's wallet-shaped deps, after `getAuthoritativeShares`
									// and the portfolio snapshot. A paper account holds no pUSD, so
									// `mirrorWalletPort.getBalances().pusd` is not merely unavailable
									// for it, it is the wrong question: its cash is the migration-0083
									// projection's NAV (seed − realized cost + marked open value).
									// Asking the live port and throwing would be honest but useless —
									// position_gap would decline to size on every paper tick forever,
									// which is precisely the "paper runs but proves nothing" state this
									// story exists to end. `getNavUsdc` raises a typed unavailable when
									// the projection is absent, incomplete or stale, so a withheld NAV
									// still cannot be read as 0.
									const cashVenue = await executionVenueResolver(
										enumeratedTarget.billingAccountId,
									);
									if (cashVenue === "paper") {
										return paperPortfolio.getNavUsdc(
											enumeratedTarget.billingAccountId,
										);
									}
									// NO_FABRICATED_VALUES: `mirrorWalletPort` is undefined on a
									// deployment with no Privy / AEAD config, so there is no readable
									// pUSD balance to denominate against. Throw — position_gap then
									// declines to size, exactly as it does when the balance read
									// itself comes back empty. Returning 0 here would invent a NAV.
									if (!mirrorWalletPort) {
										throw new Error(
											"mirror pUSD balance unavailable — live wallet adapter unconfigured",
										);
									}
									const balances = await mirrorWalletPort.getBalances(
										enumeratedTarget.billingAccountId,
									);
									if (!balances || balances.pusd === null) {
										throw new Error("mirror pUSD balance unavailable");
									}
									return balances.pusd;
								},
								getAuthoritativeShares: async (tokenIds) => {
									if (tokenIds.length === 0) return [];
									const executor = await getExecutor();
									// VENUE_DECIDES_THE_SHARE_SOURCE (NO_FABRICATED_VALUES). A paper
									// account's funder address is a real, deterministic SHA-256-derived
									// address with NO on-chain presence, so `balanceOfBatch` answers 0
									// for every token. That zero is fabricated: it pins position_gap's
									// gap math at `desired - 0` forever, which is the exact bug the
									// paper fact projection exists to remove. Route paper through the
									// executor instead — its paper build reads the migration-0083
									// projection and raises a typed unavailable when that projection is
									// absent, incomplete or stale.
									//
									// The chain read stays byte-identical for live, including the single
									// batched call. A tenant holding BOTH an active live and an active
									// paper row resolves to `live` (LIVE_WINS in the venue resolver), so
									// only a paper-only tenant takes the projection path.
									const venue = await executionVenueResolver(
										enumeratedTarget.billingAccountId,
									);
									if (venue === "paper") {
										return Promise.all(
											tokenIds.map((tokenId) =>
												executor.getPositionShareBalance(tokenId),
											),
										);
									}
									const balances = await chainPublicClient.readContract({
										address: POLYGON_CONDITIONAL_TOKENS,
										abi: ctfBalanceAbi,
										functionName: "balanceOfBatch",
										args: [
											tokenIds.map(() => executor.funderAddress),
											tokenIds.map((tokenId) => BigInt(tokenId)),
										],
									});
									return balances.map((balance) => Number(balance) / 1_000_000);
								},
								logger: mirrorLogger,
							});
							const actorKey = `${enumeratedTarget.billingAccountId}:${target.target_id}`;
							positionGapActors.set(actorKey, actor);
							return async () => {
								try {
									await actor.stop();
								} finally {
									if (positionGapActors.get(actorKey) === actor) {
										positionGapActors.delete(actorKey);
									}
									source.stop();
								}
							};
						}

						// position_gap v2 evaluates numerator + denominator from one
						// fully-paginated target snapshot. Short caches keep a burst of
						// fills coherent without turning each fill into another API walk.
						type PositionSnapshot = Awaited<
							ReturnType<typeof dataApiClient.listAllUserPositions>
						>;
						let targetPositionsCache:
							| { capturedAt: number; positions: PositionSnapshot }
							| undefined;
						const getTargetPositions = async (): Promise<PositionSnapshot> => {
							if (
								targetPositionsCache &&
								Date.now() - targetPositionsCache.capturedAt < 10_000
							) {
								return targetPositionsCache.positions;
							}
							const positions =
								await dataApiClient.listAllUserPositions(targetWallet);
							targetPositionsCache = { capturedAt: Date.now(), positions };
							return positions;
						};
						// `OperatorPosition`-shaped: exactly `{asset, size, currentValue}`,
						// the only fields position_gap and the SELL branch consume. Both
						// venues can supply all three as facts.
						type MirrorPosition = {
							asset: string;
							size: number;
							currentValue: number;
						};
						let mirrorPortfolioCache:
							| {
									capturedAt: number;
									valueUsdc: number;
									positions: MirrorPosition[];
							  }
							| undefined;
						/**
						 * NAV + open book for THIS tenant's mirror account, per venue
						 * (VENUE_RESOLVED_FROM_ACCOUNT).
						 *
						 * Live: free pUSD on the trading wallet + Data-API position values.
						 * Paper: the migration-0083 projection's published NAV (seed − cost
						 * + marks) and its projected open positions. A paper account has no
						 * pUSD balance to read and a live account has no projection, so this
						 * is a real fork, not a preference — but both branches are
						 * saved/observed facts, and either one THROWS rather than return a
						 * partial total. position_gap treats a throw as "cannot size now"
						 * and skips, which is the behaviour a withheld NAV must produce.
						 */
						const getMirrorPortfolioSnapshot = async (): Promise<{
							currentValueUsdc: number;
							positions: MirrorPosition[];
						}> => {
							if (
								mirrorPortfolioCache &&
								Date.now() - mirrorPortfolioCache.capturedAt < 5_000
							) {
								return {
									currentValueUsdc: mirrorPortfolioCache.valueUsdc,
									positions: mirrorPortfolioCache.positions.map((position) => ({
										...position,
									})),
								};
							}

							const venue = await executionVenueResolver(
								enumeratedTarget.billingAccountId,
							);

							let valueUsdc: number;
							let positions: MirrorPosition[];
							if (venue === "paper") {
								// Both reads throw `PaperFactsUnavailableError` unless the
								// projection is complete and fresh, so a withheld NAV or an
								// unmarked position can never be silently read as 0. They are
								// two reads of one writer: the projection publishes the NAV row
								// and the position cursor in the SAME transaction per tick, so
								// in steady state they carry the same `observedAt`; at worst
								// they straddle a tick, which is bounded by the same freshness
								// gate and cannot invent exposure that was never projected.
								const [navUsdc, open] = await Promise.all([
									paperPortfolio.getNavUsdc(
										enumeratedTarget.billingAccountId,
									),
									paperPortfolio.listOpenPositions(
										enumeratedTarget.billingAccountId,
									),
								]);
								// NAV already includes the marked value of every open position
								// (NAV_IS_CASH_PLUS_MARKS), so it is the whole denominator —
								// unlike the live branch, where `pusd` is cash only and the
								// open value has to be added.
								valueUsdc = navUsdc;
								positions = open.map((position) => ({
									asset: position.tokenId,
									size: position.shares,
									currentValue: position.currentValueUsdc,
								}));
							} else {
								// The live branch is where "no custody port" is a real state:
								// this deployment cannot read a live wallet's cash at all.
								// Throwing here (rather than asserting the port exists) keeps
								// the paper lane working and makes the live lane's missing
								// configuration a named, per-tick failure.
								if (!mirrorWalletPort) {
									throw new Error(
										"mirror NAV unavailable: no trader-wallet adapter is configured on this deployment (live account)",
									);
								}
								const executor = await getExecutor();
								const [balances, livePositions] = await Promise.all([
									mirrorWalletPort.getBalances(
										enumeratedTarget.billingAccountId,
									),
									executor.listPositions(),
								]);
								if (!balances || balances.pusd === null) {
									throw new Error("mirror pUSD balance unavailable");
								}
								positions = livePositions.map((position) => ({
									asset: position.asset,
									size: position.size,
									currentValue: position.currentValue,
								}));
								valueUsdc =
									balances.pusd +
									positions.reduce(
										(sum, position) =>
											sum + Math.max(0, position.currentValue),
										0,
									);
							}

							mirrorPortfolioCache = {
								capturedAt: Date.now(),
								valueUsdc,
								positions,
							};
							return {
								currentValueUsdc: valueUsdc,
								positions: positions.map((position) => ({ ...position })),
							};
						};

						let stopPoll: (() => void) | null = null;
						try {
							stopPoll = startMirrorPoll({
								target,
								source,
								ledger: orderLedger,
								// EXECUTION_MODE_IS_LOG_ONLY — same resolver as dispatch +
								// `mode` stamping, so the decision tape says which venue a
								// row came from without a second source of truth.
								getExecutionMode: () =>
									executionVenueResolver(enumeratedTarget.billingAccountId),
								placeIntent: async (intent) => {
									const executor = await getExecutor();
									return executor.placeIntent(intent);
								},
								cancelOrder: async (orderId) => {
									const executor = await getExecutor();
									return executor.cancelOrder(orderId);
								},
								getMarketConstraints: async (tokenId) => {
									const executor = await getExecutor();
									return executor.getMarketConstraints(tokenId);
								},
								getTargetConditionPosition: async (params) => {
									const positions = await getTargetPositions();
									return targetConditionPositionFromDataApiPositions(
										params.conditionId,
										positions,
									);
								},
								getTargetPortfolioCurrentValue: async () =>
									(await getTargetPositions()).reduce(
										(sum, position) =>
											sum + Math.max(0, position.currentValue),
										0,
									),
								getMirrorPortfolioSnapshot,
								closePosition: async (params) => {
									const executor = await getExecutor();
									return executor.closePosition(params);
								},
								getOperatorPositions: async () => {
									return (await getMirrorPortfolioSnapshot()).positions;
								},
								logger: mirrorLogger,
								metrics: noopMetrics,
							});
						} catch (err) {
							source.stop();
							throw err;
						}
						return () => {
							stopPoll?.();
							source.stop();
						};
					},
					logger: mirrorLogger,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					targetsReconcilerStop();
					return;
				}
				_targetsReconcilerStop = targetsReconcilerStop;
			} catch (err: unknown) {
				log.error(
					{
						event: EVENT_NAMES.POLY_MIRROR_POLL_BOOT_FAILED,
						errorCode: "boot_init_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"mirror poll boot failed — continuing without autonomous mirror",
				);
			}

			// task.5001 — TTL sweep for resting `mirror_limit` orders. One job
			// process-wide. Cancels rows whose `created_at < now() - 20m` and whose
			// `status IN ('pending','open','partial')`. Independent of the mirror
			// tick — covers the case the target never sends a SELL signal.
			try {
				const { startRestingSweep } = await import(
					"@/bootstrap/jobs/poly-mirror-resting-sweep.job"
				);
				const { noopMetrics: noopMetricsForSweep } = await import(
					"@cogni/poly-market-provider"
				);
				const sweepLogger =
					log as unknown as import("@cogni/poly-market-provider").LoggerPort;
				const restingSweepStop = startRestingSweep({
					ledger: orderLedger,
					cancelOrderFor: async (billing_account_id) => {
						const exec =
							await executorFactory.getPolyTradeExecutorFor(billing_account_id);
						return exec.cancelOrder.bind(exec);
					},
					logger: sweepLogger,
					metrics: noopMetricsForSweep,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					restingSweepStop();
					return;
				}
				_restingSweepStop = restingSweepStop;
			} catch (err: unknown) {
				log.error(
					{
						event: EVENT_NAMES.POLY_MIRROR_POLL_BOOT_FAILED,
						errorCode: "resting_sweep_boot_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"mirror resting-sweep boot failed — continuing without TTL cleanup",
				);
			}

			// task.0429 — auto-wrap consent loop. One job process-wide, gated on
			// Privy + AEAD (executor factory existence) AND POLYGON_RPC_URL — the
			// adapter's `wrapIdleUsdcE` needs RPC to read balances and submit txs.
			// Without RPC, every tick would throw; cleaner to skip startup entirely.
			if (!env.POLYGON_RPC_URL) {
				log.info(
					{ reason: "polygon_rpc_unconfigured" },
					"auto-wrap job not started (POLYGON_RPC_URL missing)",
				);
			} else {
				try {
					const { polyWalletConnections } = await import(
						"@cogni/poly-db-schema"
					);
					const { and, eq, isNotNull, isNull } = await import("drizzle-orm");
					const { noopMetrics: noopMetricsForAutoWrap } = await import(
						"@cogni/poly-market-provider"
					);
					// Same pino-as-LoggerPort cast as the mirror block above; that
					// declaration is scoped to its own try/catch so we re-cast here.
					const autoWrapLogger =
						log as unknown as import("@cogni/poly-market-provider").LoggerPort;
					const autoWrapHandle = startAutoWrap({
						walletPort: getPolyTraderWalletAdapter(log),
						listEligible: async (limit) => {
							const rows = await serviceDb
								.select({
									billingAccountId: polyWalletConnections.billingAccountId,
								})
								.from(polyWalletConnections)
								.where(
									and(
										// Auto-wrap is an on-chain USDC.e -> pUSD swap; paper
										// accounts have no chain presence, and a duplicate
										// account would burn the `limit` budget twice.
										eq(polyWalletConnections.kind, "privy_live"),
										isNull(polyWalletConnections.revokedAt),
										isNull(polyWalletConnections.autoWrapRevokedAt),
										isNotNull(polyWalletConnections.autoWrapConsentAt),
									),
								)
								.limit(limit);
							return rows.map((r) => ({
								billingAccountId: r.billingAccountId,
							}));
						},
						logger: autoWrapLogger,
						metrics: noopMetricsForAutoWrap,
					});
					// task.5016 — leadership was lost while this boot was in flight.
					if (epoch !== _jobsEpoch) {
						autoWrapHandle.stop();
						return;
					}
					_autoWrapHandle = autoWrapHandle;
				} catch (err: unknown) {
					log.error(
						{
							errorCode: "auto_wrap_boot_failed",
							err: err instanceof Error ? err.message : String(err),
						},
						"auto-wrap job boot failed — continuing without auto-wrap",
					);
				}
			}
		})();
	} else {
		log.info(
			{
				event: EVENT_NAMES.POLY_MIRROR_POLL_SKIPPED,
				has_executor_factory: false,
			},
			"mirror poll + order reconciler not started (PRIVY_USER_WALLETS_* or POLY_WALLET_AEAD_* missing)",
		);
	}

	// task.5005 — live-forward trader observation. Independent of copy-trade
	// execution credentials: it observes public wallet activity for RN1,
	// swisstony, and Cogni wallets so research query windows have stored facts.
	void (async () => {
		try {
			// bug.5297 — non-prod lanes' DBs live on the PROD VM by custody
			// (bug.5206), so their observation writes consume production IO for
			// zero user value. This lever lets the operator stop that per lane
			// without a code change; prod keeps its default of ON.
			if (!env.POLY_TRADER_OBSERVATION_WRITER_ENABLED) {
				log.warn(
					{
						event: "poly.trader.observe",
						phase: "writer_disabled",
						reason: "POLY_TRADER_OBSERVATION_WRITER_ENABLED=false",
					},
					"trader observation writer DISABLED by env — no observation/snapshot/metadata writes from this lane",
				);
				return;
			}
			const { startTraderObservationJob } = await import(
				"@/bootstrap/jobs/trader-observation.job"
			);
			const { PolymarketDataApiClient, PolymarketUserPnlClient } = await import(
				"@cogni/poly-market-provider/adapters/polymarket"
			);
			const { noopMetrics: noopMetricsForObservation } = await import(
				"@cogni/poly-market-provider"
			);
			const observerLogger =
				log as unknown as import("@cogni/poly-market-provider").LoggerPort;
			// OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM — the wallet port is the single
			// resolver of a tenant's trading address, so the observer enrolls
			// exactly the wallets the executor signs from.
			const observationWalletPort = getPolyTraderWalletAdapter(log);
			const { persistWalletBalanceFact, refreshWalletBalanceFacts } = await import(
				"@/features/wallet-analysis/server/wallet-balance-snapshot-service"
			);
			const traderObservationStop = startTraderObservationJob({
				db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
					Record<string, unknown>
				>,
				client: new PolymarketDataApiClient(),
				userPnlClient: new PolymarketUserPnlClient(),
				listActiveTradingAddresses: () =>
					observationWalletPort.listActiveTradingAddresses(),
				refreshBalanceFacts: async () => {
					const wallets = await observationWalletPort.listActiveTradingWallets();
					await refreshWalletBalanceFacts({
						wallets,
						read: (billingAccountId) =>
							observationWalletPort.getBalances(billingAccountId),
						persist: (fact) => persistWalletBalanceFact(serviceDb, fact),
						concurrency: 3,
					});
				},
				logger: observerLogger,
				metrics: noopMetricsForObservation,
			});
			// task.5016 — leadership was lost while this boot was in flight.
			if (epoch !== _jobsEpoch) {
				traderObservationStop();
				return;
			}
			_traderObservationStop = traderObservationStop;
		} catch (err: unknown) {
			log.error(
				{
					event: "poly.trader.observe",
					phase: "boot_failed",
					err: err instanceof Error ? err.message : String(err),
				},
				"trader observation job boot failed — continuing without observed trader read model",
			);
		}
	})();

	// migration 0083 — paper-account fact projection. Deliberately NOT inside the
	// trader-observation IIFE above, and deliberately NOT gated on
	// POLY_TRADER_OBSERVATION_WRITER_ENABLED. That lever throttles DATA-API
	// observation (paginated /activity + /positions for every target and tenant
	// wallet, plus per-token snapshot rows, every 30s) on non-prod lanes whose DBs
	// live on the prod VM by custody (bug.5297/bug.5206). This job shares none of
	// that shape: a local SQL projection over this node's OWN
	// poly_copy_trade_fills, scoped to the paper accounts that exist, plus one CLOB
	// midpoint per open position. Its gate is the DATA — no active paper account
	// means one indexed SELECT and an `idle_no_paper_accounts` log. Gating it on
	// the observation flag left a paper tenant's dashboard structurally
	// unrenderable on exactly the lanes paper trading runs on.
	void (async () => {
		try {
			const { startPaperProjectionJob } = await import(
				"@/bootstrap/jobs/paper-projection.job"
			);
			const { PolymarketClobPublicClient: PaperClobPublicClient } = await import(
				"@cogni/poly-market-provider/adapters/polymarket"
			);
			const paperLogger =
				log as unknown as import("@cogni/poly-market-provider").LoggerPort;
			const paperClobClient = new PaperClobPublicClient();
			const paperProjectionStop = startPaperProjectionJob({
				db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
					Record<string, unknown>
				>,
				readPaperMidPrice: (tokenId, signal) =>
					paperClobClient.getMidpoint(tokenId, signal),
				logger: paperLogger,
			});
			// task.5016 — leadership was lost while this boot was in flight.
			if (epoch !== _jobsEpoch) {
				paperProjectionStop();
				return;
			}
			_paperProjectionStop = paperProjectionStop;
		} catch (err: unknown) {
			log.error(
				{
					event: "poly.paper.project",
					phase: "boot_failed",
					err: err instanceof Error ? err.message : String(err),
				},
				"paper projection job boot failed — continuing without paper facts",
			);
		}
	})();

	// task.5016 — sibling condition-iterating writer. Polls Polymarket CLOB
	// `/markets/{conditionId}` for resolution outcomes and upserts into
	// `poly_market_outcomes` so CP4 (snapshot/distributions) and CP6
	// (trader-comparison resolution swap) can read from the DB.
	void (async () => {
		try {
			const { startMarketOutcomeJob } = await import(
				"@/bootstrap/jobs/market-outcome.job"
			);
			const { PolymarketClobPublicClient } = await import(
				"@cogni/poly-market-provider/adapters/polymarket"
			);
			const { noopMetrics: noopMetricsForOutcomes } = await import(
				"@cogni/poly-market-provider"
			);
			const outcomeLogger =
				log as unknown as import("@cogni/poly-market-provider").LoggerPort;
			const marketOutcomeStop = startMarketOutcomeJob({
				db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
					Record<string, unknown>
				>,
				clobClient: new PolymarketClobPublicClient(),
				logger: outcomeLogger,
				metrics: noopMetricsForOutcomes,
			});
			// task.5016 — leadership was lost while this boot was in flight.
			if (epoch !== _jobsEpoch) {
				marketOutcomeStop();
				return;
			}
			_marketOutcomeStop = marketOutcomeStop;
		} catch (err: unknown) {
			log.error(
				{
					event: "poly.market-outcome.boot_failed",
					phase: "boot_failed",
					err: err instanceof Error ? err.message : String(err),
				},
				"market outcome job boot failed — continuing without condition-iterating writer",
			);
		}
	})();

	// task.5018 (CP7) — per-asset price-history mirror. Sibling of the
	// trader-observation tick. Polls CLOB `/prices-history` for every asset that
	// appears in `poly_trader_current_positions WHERE active=true` UNION recent
	// fills, two fidelities per asset, every 5 minutes. Closes the
	// PAGE_LOAD_DB_ONLY_EXCEPT_PRICE_HISTORY carve-out from CP5.
	// bug.5172 — price-history writer is gated OFF by default. It ran ungated on
	// every env and OOM-crashlooped prod + preview (full `interval=max` refetch
	// per asset every 5 min). Only boot it where explicitly enabled.
	if (!env.POLY_PRICE_HISTORY_WRITER_ENABLED) {
		log.info(
			{ event: "poly.market-price-history.disabled" },
			"price-history writer disabled (POLY_PRICE_HISTORY_WRITER_ENABLED!=true) — page-load reads serve existing rows",
		);
	} else
		void (async () => {
			try {
				const { startPriceHistoryJob } = await import(
					"@/bootstrap/jobs/price-history.job"
				);
				const { PolymarketClobPublicClient } = await import(
					"@cogni/poly-market-provider/adapters/polymarket"
				);
				const { noopMetrics: noopMetricsForPriceHistory } = await import(
					"@cogni/poly-market-provider"
				);
				const priceHistoryLogger =
					log as unknown as import("@cogni/poly-market-provider").LoggerPort;
				const priceHistoryStop = startPriceHistoryJob({
					db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
						Record<string, unknown>
					>,
					clobClient: new PolymarketClobPublicClient(),
					logger: priceHistoryLogger,
					metrics: noopMetricsForPriceHistory,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					priceHistoryStop();
					return;
				}
				_priceHistoryStop = priceHistoryStop;
			} catch (err: unknown) {
				log.error(
					{
						event: "poly.market-price-history.error",
						phase: "boot_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"price-history job boot failed — continuing without price-history read model",
				);
			}
		})();

	// bug.5017 — top-wallets leaderboard mirror. The Top Wallets card
	// (`GET /api/v1/poly/top-wallets`) reads only `poly_top_wallet_stats`
	// (PAGE_LOAD_DB_ONLY); this every-15-min tick is the sole Polymarket
	// caller for that data. Default ON; the gate exists as an emergency brake.
	if (!env.POLY_TOP_WALLET_STATS_WRITER_ENABLED) {
		log.info(
			{ event: "poly.top-wallet-stats.disabled" },
			"top-wallet-stats writer disabled (POLY_TOP_WALLET_STATS_WRITER_ENABLED=false) — page-load reads serve existing rows",
		);
	} else
		void (async () => {
			try {
				const { startTopWalletStatsJob } = await import(
					"@/bootstrap/jobs/top-wallet-stats.job"
				);
				const { PolymarketDataApiClient: TopWalletsDataApiClient } =
					await import("@cogni/poly-market-provider/adapters/polymarket");
				const { noopMetrics: noopMetricsForTopWallets } = await import(
					"@cogni/poly-market-provider"
				);
				const topWalletsLogger =
					log as unknown as import("@cogni/poly-market-provider").LoggerPort;
				const topWalletStatsStop = startTopWalletStatsJob({
					db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
						Record<string, unknown>
					>,
					dataApiClient: new TopWalletsDataApiClient(),
					logger: topWalletsLogger,
					metrics: noopMetricsForTopWallets,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					topWalletStatsStop();
					return;
				}
				_topWalletStatsStop = topWalletStatsStop;
			} catch (err: unknown) {
				log.error(
					{
						event: "poly.top-wallet-stats.boot_failed",
						phase: "boot_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"top-wallet-stats job boot failed — continuing without leaderboard read model",
				);
			}
		})();

	// fix/research-route-caching — one-shot boot prewarm of the SWR-cached
	// research aggregates (snapshot/benchmark for the two primary research
	// wallets, target-overlap, trader-comparison). Serialized pLimit(1); no
	// recurring loop. Runs through this jobs seam so only the task.5016 job
	// leader prewarms (the coalesce cache is per-replica — prod is
	// single-replica today, so leader == the serving pod).
	if (!env.POLY_RESEARCH_PREWARM_ENABLED) {
		log.info(
			{ event: "poly.research-prewarm.disabled" },
			"research prewarm disabled (POLY_RESEARCH_PREWARM_ENABLED=false) — first research views pay the cold aggregate",
		);
	} else
		void (async () => {
			try {
				const { startResearchPrewarm } = await import(
					"@/bootstrap/jobs/research-prewarm.job"
				);
				const prewarmLogger =
					log as unknown as import("@cogni/poly-market-provider").LoggerPort;
				const researchPrewarmStop = startResearchPrewarm({
					db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
						Record<string, unknown>
					>,
					logger: prewarmLogger,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					researchPrewarmStop();
					return;
				}
				_researchPrewarmStop = researchPrewarmStop;
			} catch (err: unknown) {
				log.error(
					{
						event: "poly.research-prewarm.boot_failed",
						phase: "boot_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"research prewarm boot failed — first research views pay the cold aggregate",
				);
			}
		})();

	// task.research-rollup-read-models — boot walker draining historical
	// `poly_trader_fills` into `poly_trader_fill_rollups_daily`, with a
	// bounded exponential-backoff retry on a failed run (boot-window failures
	// like bug.5293/bug.5314 no longer forfeit the backfill until next deploy).
	// Resumable at the per-wallet watermark; a caught-up run is one bounded
	// probe per wallet. Steady-state freshness is owned by the observation
	// tick's per-wallet accumulate (ROLLUPS_FOLLOW_FILLS), so this job only
	// matters for the initial drain and after long tick outages. DB-only.
	if (!env.POLY_FILL_ROLLUP_BACKFILL_ENABLED) {
		log.info(
			{ event: "poly.fill_rollup.backfill_disabled" },
			"fill-rollup backfill disabled (POLY_FILL_ROLLUP_BACKFILL_ENABLED=false) — rollup readers serve the live tail for unrolled history",
		);
	} else
		void (async () => {
			try {
				const { startFillRollupBackfill } = await import(
					"@/bootstrap/jobs/fill-rollup-backfill.job"
				);
				const backfillLogger =
					log as unknown as import("@cogni/poly-market-provider").LoggerPort;
				const fillRollupBackfillStop = startFillRollupBackfill({
					db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
						Record<string, unknown>
					>,
					logger: backfillLogger,
					// fix/backfill-retry-backoff — re-checked before every retry
					// attempt: env gate still on AND this pod still holds the
					// task.5016 jobs epoch (the elector may have demoted us during
					// the backoff window; stopJobs() also aborts the loop directly).
					shouldRetry: () =>
						env.POLY_FILL_ROLLUP_BACKFILL_ENABLED && epoch === _jobsEpoch,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					fillRollupBackfillStop();
					return;
				}
				_fillRollupBackfillStop = fillRollupBackfillStop;
			} catch (err: unknown) {
				log.error(
					{
						event: "poly.fill_rollup.backfill_boot_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"fill-rollup backfill boot failed — resumable on next boot; readers serve the live tail",
				);
			}
		})();

	// task.0388 + task.0412 — event-driven redeem pipeline. Replaces the
	// deleted `runRedeemSweep` polling loop. One pipeline per active
	// `poly_wallet_connections` row at boot (multi-tenant fan-out); skipped
	// when the trader-wallet adapter is unconfigured. Fire-and-forget like
	// the mirror loop above; the per-tenant map is read via a getter on the
	// container so routes pick up entries once boot completes.
	if (env.POLYGON_RPC_URL) {
		const polygonRpcUrl = env.POLYGON_RPC_URL;
		void (async () => {
			try {
				const walletPort = getPolyTraderWalletAdapter(log);
				const { startRedeemPipelines } = await import("./redeem-pipeline");
				const map = await startRedeemPipelines({
					serviceDb,
					orderLedger,
					walletPort,
					polygonRpcUrl,
					log,
				});
				// task.5016 — leadership was lost while this boot was in flight.
				if (epoch !== _jobsEpoch) {
					for (const handles of map.values()) {
						try {
							handles.stop();
						} catch {
							// Best-effort.
						}
					}
					return;
				}
				for (const [accountId, handles] of map) {
					redeemPipelines.set(accountId, handles);
				}
			} catch (err) {
				if (err instanceof WalletAdapterUnconfiguredError) {
					log.info(
						{ missing: err.message },
						"redeem pipeline not started (PRIVY_USER_WALLETS_* or POLY_WALLET_AEAD_* missing)",
					);
				} else {
					log.error(
						{ err: err instanceof Error ? err.message : String(err) },
						"redeem pipeline boot failed — continuing without autonomous redeems",
					);
				}
			}
		})();
	}
	}; // ─── end startBackgroundJobs ─────────────────────────────────────────

	// Stop everything startBackgroundJobs started, including the per-tenant
	// redeem pipelines whose handles live in this closure. stopAllJobHandles()
	// bumps _jobsEpoch first, so any job boot still in flight self-cancels.
	const stopBackgroundJobs = (): void => {
		stopAllJobHandles();
		for (const handles of redeemPipelines.values()) {
			try {
				handles.stop();
			} catch {
				// Best-effort.
			}
		}
		redeemPipelines.clear();
	};
	_stopBackgroundJobs = stopBackgroundJobs;

	// task.5016 — single-writer gate for the seam above. Default ON: only the
	// pod holding pg_try_advisory_lock(hashtext('poly:job-runner')) — taken on
	// a DEDICATED max:1 connection, never the shared pools — runs background
	// jobs; other pods stand by and retry, promoting automatically when the
	// leader dies (session death releases the lock server-side). OFF is the
	// single-pod kill-switch: jobs start unconditionally, pre-task.5016
	// behavior. NOTE: this elects WRITERS only — the in-process dashboard
	// coalesce caches stay per-replica (perf-only degradation; see
	// dashboard-route-cache.ts).
	if (!env.JOB_LEADER_ELECTION_ENABLED) {
		log.info(
			{ event: "jobs.leader_election.disabled" },
			"JOB_LEADER_ELECTION_ENABLED=false — starting background jobs unconditionally (single-pod mode)",
		);
		startBackgroundJobs();
	} else {
		const elector = startJobLeaderElector({
			createSession: () =>
				createJobLeaderLockSession({
					connectionString: env.DATABASE_SERVICE_URL,
				}),
			startJobs: startBackgroundJobs,
			stopJobs: stopBackgroundJobs,
			logger: log.child({ component: "job-leader-elector" }),
			instanceId: `${hostname()}#${process.pid}`,
		});
		_jobLeaderElectorStop = elector.stop;
		// Release the advisory lock promptly on graceful shutdown so a standby
		// pod promotes immediately instead of waiting for TCP keepalive to
		// notice the dead session.
		const stopElectorOnExit = () => {
			void elector.stop();
		};
		process.on("SIGTERM", stopElectorOnExit);
		process.on("SIGINT", stopElectorOnExit);
	}

	// User-facing scheduling (appDb, RLS enforced)
	const executionGrantPort = new DrizzleExecutionGrantUserAdapter(
		db,
		log.child({ component: "DrizzleExecutionGrantUserAdapter" }),
	);
	const scheduleManager = new DrizzleScheduleUserAdapter(
		db,
		scheduleControl,
		executionGrantPort,
		log.child({ component: "DrizzleScheduleUserAdapter" }),
	);

	// Worker scheduling (serviceDb, BYPASSRLS)
	const executionGrantWorkerPort = new DrizzleExecutionGrantWorkerAdapter(
		serviceDb,
		log.child({ component: "DrizzleExecutionGrantWorkerAdapter" }),
	);
	const graphRunRepository = new DrizzleGraphRunAdapter(
		serviceDb,
		log.child({ component: "DrizzleGraphRunAdapter" }),
	);

	// Execution request port (not user-scoped — exempt from RLS)
	const executionRequestPort = new DrizzleExecutionRequestAdapter(
		db,
		log.child({ component: "DrizzleExecutionRequestAdapter" }),
	);

	// MetricsCapability for AI tools (requires PROMETHEUS_URL)
	const metricsCapability = createMetricsCapability(env);

	// WebSearchCapability for AI tools (requires TAVILY_API_KEY)
	const webSearchCapability = createWebSearchCapability(env);

	// RepoCapability for AI tools (requires COGNI_REPO_PATH)
	const repoCapability = createRepoCapability(env);

	// Deployed work items are Dolt-backed. When the hub is unavailable, fail
	// closed instead of silently writing ephemeral markdown inside the pod.
	let workItemAdapter: RuntimeWorkItemAdapter =
		createUnavailableWorkItemAdapter();
	const workItemCommand = createUnavailableWorkItemCommand();

	// ScheduleCapability for AI tools (reads actorUserId from ALS at invocation time)
	const scheduleCapability = createScheduleCapability({
		scheduleManager,
		getOrCreateBillingAccountId: async (userId) => {
			const accountService = new UserDrizzleAccountService(
				db,
				userId,
				financialLedger,
			);
			const account = await accountService.getOrCreateBillingAccountForUser({
				userId: userId as string,
			});
			return account.id;
		},
	});

	// KnowledgeCapability + EdoCapability for AI tools (require DOLTGRES_URL)
	let knowledgeCapability: KnowledgeCapability;
	let edoCapability: EdoCapability;
	let knowledgeContributionService: ContributionService | undefined;
	let knowledgeStorePort: KnowledgeStorePort | undefined;
	if (env.DOLTGRES_URL) {
		const doltgresUrl = env.DOLTGRES_URL;
		const doltClient = buildDoltgresClient({
			connectionString: doltgresUrl,
			applicationName: `cogni_knowledge_${env.SERVICE_NAME ?? "app"}`,
		});
		const buildWorkItemClient = () =>
			buildDoltgresClient({
				connectionString: doltgresUrl,
				applicationName: `cogni_work_items_${env.SERVICE_NAME ?? "app"}`,
				max: 1,
			});
		const workItemClient = buildWorkItemClient();
		workItemAdapter = new DoltgresPolyWorkItemAdapter(
			workItemClient,
			log.child({ component: "doltgres-work-items" }),
			{ recreateClient: buildWorkItemClient },
		);
		const knowledgePort = new DoltgresKnowledgeStoreAdapter({
			sql: doltClient,
		});
		knowledgeStorePort = knowledgePort;
		knowledgeCapability = createKnowledgeCapability(knowledgePort);
		const edoResolver = new DoltgresEdoResolverAdapter({
			sql: doltClient,
			store: knowledgePort,
		});
		edoCapability = createEdoCapability(knowledgePort, edoResolver);
		const contributionPort = new DoltgresKnowledgeContributionAdapter({
			sql: doltClient,
		});
		// Optional post-merge mirror to DoltHub (task.5069). Disabled when
		// DOLTHUB_REMOTE_URL is unset. Gate-by-secret-presence follows the
		// established pattern (Langfuse, Privy, PostHog) — DOLTHUB_REMOTE_URL
		// is only granted to the production GitHub Environment Secret scope, so
		// candidate-a/preview boot with the hook undefined and never push. v0
		// invariant: prod is the only writer. Bootstrap: see
		// docs/runbooks/dolthub-remote-bootstrap.md.
		const remoteUrl = env.DOLTHUB_REMOTE_URL;
		const pushMainOnMerge = remoteUrl
			? wrapPushSafe(
					createDoltgresPusher({
						sql: doltClient,
						remoteName: "origin",
						remoteUrl,
					}),
					{
						onSuccess: () => log.info({ remote: remoteUrl }, "dolthub_push_ok"),
						onFailure: (err) =>
							log.warn({ err, remote: remoteUrl }, "dolthub_push_failed"),
					},
				)
			: undefined;
		knowledgeContributionService = createContributionService({
			port: contributionPort,
			canMergeKnowledge: defaultCanMergeKnowledge,
			rateLimit: { maxOpenPerPrincipal: 10 },
			// v0 write-pipeline: shape gate only on the contribution path.
			// Provenance is stamped by the adapter (`source_type='external'`,
			// `source_ref='contribution:<id>:<seq>'`), so the provenance gate is
			// reserved for internal `core__knowledge_write` where the caller
			// controls those fields. See work/projects/proj.knowledge-syntropy.md.
			gates: [shapeGate],
			...(pushMainOnMerge ? { pushMainOnMerge } : {}),
		});
		log.info(
			{ dolthubMirror: Boolean(env.DOLTHUB_REMOTE_URL) },
			"Knowledge store + EDO capability configured (Doltgres)",
		);
	} else {
		const notConfigured = () => {
			throw new Error("KnowledgeCapability not configured. Set DOLTGRES_URL.");
		};
		knowledgeCapability = {
			search: notConfigured,
			list: notConfigured,
			get: notConfigured,
			write: notConfigured,
		};
		edoCapability = {
			hypothesize: notConfigured,
			decide: notConfigured,
			recordOutcome: notConfigured,
			getChain: notConfigured,
		};
		knowledgeContributionService = undefined;
		knowledgeStorePort = undefined;
		log.warn("Knowledge store not configured (DOLTGRES_URL not set)");
	}

	const workItemCapability = createWorkItemCapability({
		workItemQuery: workItemAdapter,
		workItemCommand,
	});

	// ToolSource with real implementations (per CAPABILITY_INJECTION)
	const toolBindings = createToolBindings({
		knowledgeCapability,
		edoCapability,
		metricsCapability,
		webSearchCapability,
		repoCapability,
		scheduleCapability,
		vcsCapability: stubVcsCapability,
		workItemCapability,
	});
	const toolSource = createBoundToolSource([...CORE_TOOL_BUNDLE], toolBindings);

	// Config: rethrow in dev/test for diagnosis, respond_500 in production for safety
	const config: ContainerConfig = {
		unhandledErrorPolicy: env.isProd ? "respond_500" : "rethrow",
		// Rate limit bypass: only enabled in test mode (APP_ENV=test)
		// Security: Production builds will never enable bypass regardless of header
		rateLimitBypass: {
			enabled: env.isTestMode,
			headerName: "x-stack-test",
			headerValue: "1",
		},
		// Deploy environment for metrics/logging
		DEPLOY_ENVIRONMENT: env.DEPLOY_ENVIRONMENT ?? "local",
	};

	// OperatorWallet: test uses fake, production uses Privy (optional — only when configured)
	const operatorWalletConfig = getOperatorWalletConfig();
	const operatorWallet: OperatorWalletPort | undefined = env.isTestMode
		? getTestOperatorWallet()
		: (() => {
				if (
					!env.PRIVY_APP_ID ||
					!env.PRIVY_APP_SECRET ||
					!env.PRIVY_SIGNING_KEY
				) {
					return undefined;
				}
				if (!operatorWalletConfig) {
					log.warn(
						"PRIVY_APP_ID set but operator_wallet missing from repo-spec — skipping operator wallet",
					);
					return undefined;
				}
				const treasuryAddress = getDaoTreasuryAddress();
				if (!treasuryAddress) {
					log.warn(
						"operator_wallet configured but governance.dao_contract missing — skipping operator wallet",
					);
					return undefined;
				}
				const paymentConfig = getPaymentConfig();
				if (!paymentConfig) {
					log.warn(
						"PRIVY_APP_ID set but payments_in missing from repo-spec — run `pnpm node:activate-payments`",
					);
					return undefined;
				}
				if (!env.EVM_RPC_URL) {
					log.warn(
						"PRIVY_APP_ID set but EVM_RPC_URL missing — operator wallet requires RPC for tx confirmation",
					);
					return undefined;
				}
				// Steward wallet is optional — when payments_out is absent the adapter
				// fails closed on withdrawToSteward but inbound/distribute still work.
				const stewardWalletConfig = getStewardWalletConfig();
				return new PrivyOperatorWalletAdapter({
					appId: env.PRIVY_APP_ID,
					appSecret: env.PRIVY_APP_SECRET,
					signingKey: env.PRIVY_SIGNING_KEY,
					expectedAddress: operatorWalletConfig.address,
					splitAddress: paymentConfig.receivingAddress,
					treasuryAddress,
					markupPpm: numberToPpm(env.USER_PRICE_MARKUP_FACTOR),
					revenueSharePpm: numberToPpm(env.SYSTEM_TENANT_REVENUE_SHARE),
					maxTopUpUsd: env.OPERATOR_MAX_TOPUP_USD,
					rpcUrl: env.EVM_RPC_URL,
					...(stewardWalletConfig
						? { stewardAddress: stewardWalletConfig.address }
						: {}),
				});
			})();

	// ProviderFunding (OpenRouter/Coinbase top-up) was retired — OpenRouter 410'd
	// programmatic crypto top-up. Outbound vendor funding now flows through the
	// operator wallet's withdrawToSteward + a manual human checkout. The post-credit
	// chain here is now just inbound credit + Split distribute (treasurySettlement below).

	// Connection broker — BYO-AI credential resolution
	// Undefined when CONNECTIONS_ENCRYPTION_KEY not set
	const connectionBroker: ConnectionBrokerPort | undefined = (() => {
		if (!env.CONNECTIONS_ENCRYPTION_KEY) return undefined;
		const keyBuf = Buffer.from(env.CONNECTIONS_ENCRYPTION_KEY, "hex");
		if (keyBuf.length !== 32) {
			log.warn(
				"CONNECTIONS_ENCRYPTION_KEY must be 64 hex chars (32 bytes). BYO-AI disabled.",
			);
			return undefined;
		}
		return new DrizzleConnectionBrokerAdapter({
			db: db as unknown as import("drizzle-orm/node-postgres").NodePgDatabase,
			encryptionKey: keyBuf,
			encryptionKeyId: "v1",
			log,
		});
	})();

	// Redis client for run event streaming (ephemeral stream plane)
	// Per REDIS_IS_STREAM_PLANE: only transient data, no durable state
	const redisClient = new Redis(env.REDIS_URL, {
		lazyConnect: true,
		maxRetriesPerRequest: 3,
	});
	const runStream = new RedisRunStreamAdapter(redisClient);
	const nodeStream = new RedisNodeStreamAdapter(redisClient);

	// Process health publisher (node-local metrics only — external sources use Temporal)
	const publisherAbort = new AbortController();
	process.on("SIGTERM", () => publisherAbort.abort());
	process.on("SIGINT", () => publisherAbort.abort());
	startProcessHealthPublisher({
		port: nodeStream,
		streamKey: `node:${nodeId}:events`,
		signal: publisherAbort.signal,
		logger: log,
		environment: env.DEPLOY_ENVIRONMENT ?? "local",
	});

	return {
		log,
		config,
		llmService,
		accountsForUser: (userId: UserId) =>
			new UserDrizzleAccountService(db, userId, financialLedger),
		serviceAccountService,
		clock,
		paymentAttemptsForUser: (userId: UserId) =>
			new UserDrizzlePaymentAttemptRepository(db, userId),
		paymentAttemptServiceRepository,
		onChainVerifier,
		evmOnchainClient,
		paymentRailsActive: !!getPaymentConfig(),
		metricsQuery,
		treasuryReadPort,
		aiTelemetry,
		langfuse,
		nodeId,
		scheduleControl,
		executionGrantPort,
		executionGrantWorkerPort,
		executionRequestPort,
		graphRunRepository,
		scheduleManager,
		metricsCapability,
		webSearchCapability,
		repoCapability,
		toolSource,
		knowledgeContributionService,
		knowledgeStorePort,
		edoCapability,
		threadPersistenceForUser: (userId: UserId) =>
			new DrizzleThreadPersistenceAdapter(db, userActor(userId)),
		governanceStatus: new DrizzleGovernanceStatusAdapter(
			db,
			userActor(toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID)),
		),
		attributionStore: new DrizzleAttributionAdapter(serviceDb, getScopeId()),
		workItemQuery: workItemAdapter,
		workItemCommand,
		doltgresWorkItems: workItemAdapter,
		runStream,
		nodeStream,
		get webhookRegistrations() {
			return getWebhookRegistrations();
		},
		get registries() {
			return getCollectRegistries();
		},
		// Collect over webhook-delivered receipts: reuse the webhook-only registrations.
		// No poll adapter → runCollectPass skips polling and selects delivered receipts.
		get sourceRegistrations() {
			return getWebhookRegistrations();
		},
		financialLedger,
		operatorWallet,
		treasurySettlement: operatorWallet
			? new SplitTreasurySettlementAdapter(operatorWallet, USDC_TOKEN_ADDRESS)
			: undefined,
		connectionBroker,
		serviceDb,
		orderLedger,
		copyTradeTargetSource,
		redeemPipelineFor: (billingAccountId: string) =>
			redeemPipelines.get(billingAccountId),
		invalidatePolyTradeExecutorFor(billingAccountId: string) {
			polyTradeExecutorFactory?.invalidatePolyTradeExecutorFor(
				billingAccountId,
			);
		},
		// Multi-provider model ports
		...(() => {
			const platformProvider = new PlatformModelProvider(llmService);
			// Parse MCP server config for Codex native MCP support (bug.0232).
			// parseMcpConfigFromEnv is synchronous (reads file + env vars).
			const codexMcpConfig = mcpServersToCodexConfig(parseMcpConfigFromEnv());
			const codexProvider = new CodexModelProvider(codexMcpConfig);
			const openAiCompatibleProvider = new OpenAiCompatibleModelProvider(
				connectionBroker,
				resolveAppDb,
			);
			const providers = [
				platformProvider,
				codexProvider,
				openAiCompatibleProvider,
			];
			return {
				modelCatalog: new AggregatingModelCatalog(providers),
				providerResolver: new ProviderResolver(providers),
			};
		})(),
	};
}

/**
 * Resolves dependencies for AI adapter construction.
 * Used by graph-executor.factory.ts.
 */
export function resolveAiAdapterDeps(userId: UserId): AiAdapterDeps {
	const container = getContainer();
	return {
		llmService: container.llmService,
		accountService: container.accountsForUser(userId),
		clock: container.clock,
		aiTelemetry: container.aiTelemetry,
		langfuse: container.langfuse,
		nodeId: container.nodeId,
	};
}

export function resolveActivityDeps(userId: UserId): ActivityDeps {
	const container = getContainer();
	return {
		accountService: container.accountsForUser(userId),
	};
}

/**
 * Scheduling dependencies for CRUD operations.
 * Used by schedule routes.
 */
export type SchedulingDeps = Pick<
	Container,
	| "scheduleControl"
	| "executionGrantPort"
	| "executionGrantWorkerPort"
	| "graphRunRepository"
	| "scheduleManager"
>;

export function resolveSchedulingDeps(): SchedulingDeps {
	const container = getContainer();
	return {
		scheduleControl: container.scheduleControl,
		executionGrantPort: container.executionGrantPort,
		executionGrantWorkerPort: container.executionGrantWorkerPort,
		graphRunRepository: container.graphRunRepository,
		scheduleManager: container.scheduleManager,
	};
}

/**
 * Resolve appDb for facade-level queries that don't need a full port abstraction.
 * Uses appDb (RLS-scoped) — caller must be authenticated.
 */
export function resolveAppDb(): Database {
	return getAppDb();
}

/**
 * Resolve serviceDb for pre-auth or system-level writes that must bypass RLS.
 * Background jobs and writers stay on this pool (DB_SERVICE_POOL_MAX).
 */
export function resolveServiceDb(): Database {
	return getServiceDb();
}

/**
 * Resolve the service READ pool (BYPASSRLS, same app_service credentials as
 * resolveServiceDb but a separate postgres-js pool: DB_READ_POOL_MAX, default 5,
 * application_name cogni_service_read). Dashboard/research READ routes use this
 * so background jobs cannot starve them (task.5014). Never use for writes/jobs.
 */
export function resolveServiceReadDb(): Database {
	return getServiceReadDb();
}
