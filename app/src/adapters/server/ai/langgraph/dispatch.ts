// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import type { GraphExecutorPort } from "@/ports";

/** Shared programs always use their guarded in-process provider; other graphs retain dev routing. */
export function createLangGraphDispatch(
  inproc: GraphExecutorPort,
  dev?: GraphExecutorPort,
): GraphExecutorPort & { readonly providerId: string } {
  return {
    providerId: "langgraph",
    runGraph: (req, ctx) =>
      (dev && req.graphId !== "langgraph:cogni" && req.graphId !== "langgraph:work-prioritizer" ? dev : inproc).runGraph(
        req,
        ctx,
      ),
  };
}
