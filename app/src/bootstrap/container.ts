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
} from "@cogni/attribution-pipeline-plugins";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
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
import { MarkdownWorkItemAdapter } from "@cogni/work-items/markdown";
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
import { ServiceDrizzlePaymentAttemptRepository } from "@/adapters/server/payments/drizzle-payment-attempt.adapter";
import { SplitTreasurySettlementAdapter } from "@/adapters/server/treasury/split-treasury-settlement.adapter";
import {
	FakeMetricsAdapter,
	getTestEvmOnchainClient,
	getTestOnChainVerifier,
	getTestOperatorWallet,
} from "@/adapters/test";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";
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
import {
	type OrderReconcilerHandle,
	startOrderReconciler,
} from "@/bootstrap/jobs/order-reconciler.job";
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
import {
	getDaoTreasuryAddress,
	getLedgerConfig,
	getNodeId,
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
	/** Work item queries — reads from markdown files via WorkItemQueryPort */
	workItemQuery: WorkItemQueryPort;
	/** Work item commands — writes to markdown files via WorkItemCommandPort */
	workItemCommand: WorkItemCommandPort;
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
// Per-asset price-history mirror job stop fn (task.5018). Public CLOB only.
let _priceHistoryStop: (() => void) | null = null;

/**
 * Get the singleton container instance.
 * Lazily initializes on first access.
 */
export function getContainer(): Container {
	if (!_container) {
		_container = createContainer();
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
	_reconcilerHandle = null;
	if (_targetsReconcilerStop) {
		try {
			_targetsReconcilerStop();
		} catch {
			// Best-effort — tests re-create the container; nothing blocks here.
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
	if (_priceHistoryStop) {
		try {
			_priceHistoryStop();
		} catch {
			// Best-effort.
		}
		_priceHistoryStop = null;
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
	const orderLedger = createOrderLedger({
		db: serviceDb,
		appDb: db,
		logger: log.child({ component: "order-ledger" }),
		paperEnforceMode: env.PAPER_ENFORCE_MODE,
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
		// PAPER_ENFORCE_MODE=paper routes every placement through the paper
		// sidecar (no wallet signing), so skip the wallet_connections +
		// wallet_grants activation joins so targets activate without Privy
		// onboarding the user doesn't need for paper.
		paperEnforced: env.PAPER_ENFORCE_MODE === "paper",
	});
	const redeemPipelines = new Map<string, RedeemPipelineHandles>();

	// Per-tenant trade-executor factory. Lazily constructs a
	// `PolyTradeExecutor` for a given `billingAccountId`. Uses the per-user
	// Privy app (`PRIVY_USER_WALLETS_*`) — distinct from the operator-wallet
	// Privy app used by `OperatorWalletPort`. Undefined when any of those
	// envs are missing; callers degrade gracefully (no mirror polls, no
	// order reconciler). Sole placement path post Stage 4 purge — the former
	// single-operator `polyTradeBundle` is gone and will not come back.
	const polyTradeExecutorFactory:
		| ReturnType<typeof createPolyTradeExecutorFactory>
		| undefined = (() => {
		try {
			const walletPort = getPolyTraderWalletAdapter(log);
			return createPolyTradeExecutorFactory({
				walletPort,
				logger: log,
				metrics: noopMetricsForExecutor,
				host: env.POLY_CLOB_HOST,
				polygonRpcUrl: env.POLYGON_RPC_URL,
				paperSidecarUrl: env.PAPER_SIDECAR_URL,
				paperEnforceMode: env.PAPER_ENFORCE_MODE,
			});
		} catch (err) {
			if (err instanceof WalletAdapterUnconfiguredError) {
				log.info(
					{ missing: err.message },
					"per-tenant poly-trade executor not configured (PRIVY_USER_WALLETS_* or POLY_WALLET_AEAD_* missing)",
				);
				return undefined;
			}
			throw err;
		}
	})();

	// Autonomous 30s mirror poll per target wallet. A target-set reconciler
	// ticks `copyTradeTargetSource.listAllActive()` every 30s and diffs the
	// result against running per-target polls — so a user POSTing a tracked
	// wallet begins copy-trading within one tick, with no pod restart
	// (bug.0338 / POLL_RECONCILES_PER_TICK). One `startMirrorPoll` per active
	// (tenant × wallet); exactly one `startOrderReconciler` process-wide
	// (per-tenant dispatch is internal, routed through the executor factory).
	//
	// Post-cutover gate: the poll + reconciler start iff
	// `polyTradeExecutorFactory` exists, i.e. `PRIVY_USER_WALLETS_*` and
	// `POLY_WALLET_AEAD_*` are configured. Daily/hourly USDC caps live in
	// each tenant's `poly_wallet_grants` and are enforced by `authorizeIntent`
	// on the hot path inside `PolyTradeExecutor.placeIntent`.
	// bug.0438: copy-trade has no per-tenant kill-switch; the gate is the
	// active-target × active-connection × active-grant join inside `listAllActive`.
	if (polyTradeExecutorFactory !== undefined) {
		const executorFactory = polyTradeExecutorFactory;
		// Lazy-load the poll wiring so its transitive imports (Data-API HTTP
		// client, Drizzle queries) don't run on pods without Polymarket creds.
		void (async () => {
			try {
				const { createPolymarketChainActivitySource } = await import(
					"@/features/wallet-watch"
				);
				const { PolymarketDataApiClient } = await import(
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
				const { createPublicClient, webSocket } = await import("viem");
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

				// task.5014 — per-(billing, target, condition) baseline writer. Run
				// under `withTenantScope(appDb, createdByUserId)` so RLS clamps the
				// INSERT/SELECT to the calling tenant (mirrors the order-ledger
				// tenant surface pattern). `INSERT ... ON CONFLICT DO NOTHING
				// RETURNING` captures the row when fresh; on conflict, the SELECT
				// reads back the persisted baseline. Either branch returns the
				// canonical number the planner divides delta against.
				const { polyCopyTargetConditionBaseline } = await import(
					"@cogni/poly-db-schema"
				);
				const { withTenantScope } = await import("@cogni/db-client");
				const { and, eq } = await import("drizzle-orm");
				const baselineAppDb =
					db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
						Record<string, unknown>
					>;
				async function getOrInsertConditionBaseline(params: {
					createdByUserId: string;
					billingAccountId: string;
					targetId: string;
					conditionId: string;
					observedTargetUsdc: number;
					capturedAtFillId: string;
				}): Promise<number | undefined> {
					try {
						const actor = userActor(toUserId(params.createdByUserId));
						return await withTenantScope(baselineAppDb, actor, async (tx) => {
							const inserted = await tx
								.insert(polyCopyTargetConditionBaseline)
								.values({
									billingAccountId: params.billingAccountId,
									targetId: params.targetId,
									conditionId: params.conditionId,
									baselineTargetPositionUsdc:
										params.observedTargetUsdc.toFixed(2),
									capturedAtFillId: params.capturedAtFillId,
								})
								.onConflictDoNothing()
								.returning({
									baseline:
										polyCopyTargetConditionBaseline.baselineTargetPositionUsdc,
								});
							if (inserted[0]) return Number(inserted[0].baseline);
							const existing = await tx
								.select({
									baseline:
										polyCopyTargetConditionBaseline.baselineTargetPositionUsdc,
								})
								.from(polyCopyTargetConditionBaseline)
								.where(
									and(
										eq(
											polyCopyTargetConditionBaseline.billingAccountId,
											params.billingAccountId,
										),
										eq(
											polyCopyTargetConditionBaseline.targetId,
											params.targetId,
										),
										eq(
											polyCopyTargetConditionBaseline.conditionId,
											params.conditionId,
										),
									),
								)
								.limit(1);
							return existing[0] ? Number(existing[0].baseline) : undefined;
						});
					} catch (err) {
						log.warn(
							{
								event: "poly.mirror.condition_baseline.write_failed",
								billing_account_id: params.billingAccountId,
								target_id: params.targetId,
								condition_id: params.conditionId,
								err: err instanceof Error ? err.message : String(err),
							},
							"baseline upsert failed; planner will skip before_baseline_snapshot this tick",
						);
						return undefined;
					}
				}
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
				_reconcilerHandle = startOrderReconciler({
					ledger: orderLedger,
					getOrderForTenant: async (billingAccountId, orderId) => {
						const executor =
							await executorFactory.getPolyTradeExecutorFor(billingAccountId);
						return executor.getOrder(orderId);
					},
					logger: mirrorLogger,
					metrics: noopMetrics,
					notFoundGraceMs: env.POLY_CLOB_NOT_FOUND_GRACE_MS,
				});

				// Target-set reconciler — ticks listAllActive every 30s, starts/stops
				// per-wallet polls to match. First tick fires immediately. See
				// docs/spec/poly-tenant-and-collateral.md § POLL_RECONCILES_PER_TICK.
				//
				// `listAllActive` joins `poly_wallet_connections` +
				// `poly_wallet_grants`, so the reconciler only hands us tenants that
				// have (a) an active trading wallet and (b) an active grant. Each
				// per-tenant poll routes placements through the per-tenant
				// `PolyTradeExecutor`, which wraps every `placeOrder` with
				// `authorizeIntent` so scope + cap + grant-revoke checks run on the
				// hot path.
				_targetsReconcilerStop = startCopyTradeReconciler({
					targetSource: copyTradeTargetSource,
					startPollForTarget: (enumeratedTarget) => {
						const targetWallet = enumeratedTarget.targetWallet;
						// MODE_STAMPED_AT_LEDGER_FROM_ENV — the ledger reads
						// PAPER_ENFORCE_MODE once at construction and stamps every fill /
						// decision row with the env-derived mode. No need to thread mode
						// through `MirrorTargetConfig`; the planner + pipeline are mode-
						// agnostic. Pair with PAPER_DISPATCH_IS_ENV_ONLY
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

						let stopPoll: (() => void) | null = null;
						try {
							stopPoll = startMirrorPoll({
								target,
								source,
								ledger: orderLedger,
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
									const positions = await dataApiClient.listUserPositions(
										params.targetWallet,
										{
											market: params.conditionId,
											sizeThreshold: 0,
										},
									);
									return targetConditionPositionFromDataApiPositions(
										params.conditionId,
										positions,
									);
								},
								getOrInsertConditionBaseline: async (params) =>
									getOrInsertConditionBaseline({
										createdByUserId: enumeratedTarget.createdByUserId,
										billingAccountId: params.billingAccountId,
										targetId: params.targetId,
										conditionId: params.conditionId,
										observedTargetUsdc: params.observedTargetUsdc,
										capturedAtFillId: params.capturedAtFillId,
									}),
								closePosition: async (params) => {
									const executor = await getExecutor();
									return executor.closePosition(params);
								},
								getOperatorPositions: async () => {
									const executor = await getExecutor();
									const positions = await executor.listPositions();
									return positions.map((p) => ({
										asset: p.asset,
										size: p.size,
									}));
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
				_restingSweepStop = startRestingSweep({
					ledger: orderLedger,
					cancelOrderFor: async (billing_account_id) => {
						const exec =
							await executorFactory.getPolyTradeExecutorFor(billing_account_id);
						return exec.cancelOrder.bind(exec);
					},
					logger: sweepLogger,
					metrics: noopMetricsForSweep,
				});
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
					const { and, isNotNull, isNull } = await import("drizzle-orm");
					const { noopMetrics: noopMetricsForAutoWrap } = await import(
						"@cogni/poly-market-provider"
					);
					// Same pino-as-LoggerPort cast as the mirror block above; that
					// declaration is scoped to its own try/catch so we re-cast here.
					const autoWrapLogger =
						log as unknown as import("@cogni/poly-market-provider").LoggerPort;
					_autoWrapHandle = startAutoWrap({
						walletPort: getPolyTraderWalletAdapter(log),
						listEligible: async (limit) => {
							const rows = await serviceDb
								.select({
									billingAccountId: polyWalletConnections.billingAccountId,
								})
								.from(polyWalletConnections)
								.where(
									and(
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
			_traderObservationStop = startTraderObservationJob({
				db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
					Record<string, unknown>
				>,
				client: new PolymarketDataApiClient(),
				userPnlClient: new PolymarketUserPnlClient(),
				logger: observerLogger,
				metrics: noopMetricsForObservation,
			});
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
			_marketOutcomeStop = startMarketOutcomeJob({
				db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
					Record<string, unknown>
				>,
				clobClient: new PolymarketClobPublicClient(),
				logger: outcomeLogger,
				metrics: noopMetricsForOutcomes,
			});
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
				_priceHistoryStop = startPriceHistoryJob({
					db: serviceDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
						Record<string, unknown>
					>,
					clobClient: new PolymarketClobPublicClient(),
					logger: priceHistoryLogger,
					metrics: noopMetricsForPriceHistory,
				});
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

	// WorkItemCapability for AI tools (delegates to markdown adapter ports)
	const workItemAdapter = new MarkdownWorkItemAdapter(
		env.COGNI_REPO_ROOT ?? "/nonexistent",
	);
	const workItemCapability = createWorkItemCapability({
		workItemQuery: workItemAdapter,
		workItemCommand: workItemAdapter,
	});

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
		const doltClient = buildDoltgresClient({
			connectionString: env.DOLTGRES_URL,
			applicationName: `cogni_knowledge_${env.SERVICE_NAME ?? "app"}`,
		});
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
		workItemCommand: workItemAdapter,
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
 */
export function resolveServiceDb(): Database {
	return getServiceDb();
}
