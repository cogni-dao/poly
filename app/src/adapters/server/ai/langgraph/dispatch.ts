// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import type { CatalogBoundTool } from "@cogni/ai-tools";
import { type LangGraphCatalog, requiresInProcess } from "@cogni/langgraph-graphs";
import type { GraphExecutorPort } from "@/ports";

import { packageToolBundle } from "./inproc.provider";

/**
 * The in-process provider runs every graph that needs source context, a principal, MCP tools, a scoped or write tool, or the shell
 * audience (`requiresInProcess`, from the package). Only a plain read-only graph may reach the dev server; an unknown graph never does.
 */
export function createLangGraphDispatch(
  inproc: GraphExecutorPort,
  catalog: LangGraphCatalog,
  toolBundle: readonly CatalogBoundTool[],
  dev?: GraphExecutorPort,
): GraphExecutorPort & { readonly providerId: string } {
  return {
    providerId: "langgraph",
    runGraph: (req, ctx) => {
      const entry = catalog[req.graphId.replace(/^langgraph:/, "")];
      const devOk =
        dev !== undefined &&
        entry !== undefined &&
        !requiresInProcess(entry, packageToolBundle(toolBundle));
      return (devOk ? dev : inproc).runGraph(req, ctx);
    },
  };
}
