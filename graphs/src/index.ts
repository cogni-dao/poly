export {
  createPolyBrainGraph,
  createPolyResearchGraph,
  POLY_BRAIN_GRAPH_NAME,
  POLY_BRAIN_TOOL_IDS,
  POLY_RESEARCH_GRAPH_NAME,
  POLY_RESEARCH_TOOL_IDS,
} from "./graphs";
// Tool contracts (task.1791070967). Contracts only; implementations are
// injected at bootstrap. Authored here because they must be zod v3 to satisfy
// `@cogni/ai-tools` — see ./tools/poly-account-copy-trade-orders.
export {
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  polyAccountCopyTradeOrdersBoundTool,
  polyAccountCopyTradeOrdersToolContract,
  type PolyAccountCopyTradeOrdersToolInput,
  PolyAccountCopyTradeOrdersToolInputSchema,
  type PolyAccountCopyTradeOrdersToolOutput,
  PolyAccountCopyTradeOrdersToolOutputSchema,
  type PolyAccountCopyTradeOrdersToolRedacted,
  type PolyAccountReadUnavailableReason,
  PolyAccountReadUnavailableReasonSchema,
} from "./tools";

import type { CreateGraphFn } from "@cogni/langgraph-graphs";
import {
  createPolyBrainGraph,
  createPolyResearchGraph,
  POLY_BRAIN_GRAPH_NAME,
  POLY_BRAIN_TOOL_IDS,
  POLY_RESEARCH_GRAPH_NAME,
  POLY_RESEARCH_TOOL_IDS,
} from "./graphs";

interface CatalogEntry {
  readonly displayName: string;
  readonly description: string;
  readonly toolIds: readonly string[];
  readonly graphFactory: CreateGraphFn;
}

export const POLY_LANGGRAPH_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  [POLY_BRAIN_GRAPH_NAME]: {
    displayName: "Poly Brain",
    description:
      "Prediction market analyst with live market data and web research",
    toolIds: POLY_BRAIN_TOOL_IDS,
    graphFactory: createPolyBrainGraph,
  },
  [POLY_RESEARCH_GRAPH_NAME]: {
    displayName: "Poly Research",
    description:
      "Patient wallet-research analyst — profiles proxy-wallets via Polymarket Data-API and returns a structured PolyResearchReport",
    toolIds: POLY_RESEARCH_TOOL_IDS,
    graphFactory: createPolyResearchGraph,
  },
} as const;
