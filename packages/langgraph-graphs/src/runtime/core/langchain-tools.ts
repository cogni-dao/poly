// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Delegate generic execution behavior; retain local product contract types and graph context. */
import type { ToolContract } from "@cogni/ai-tools";
import {
  type ToLangChainToolsCapturedOptions as SharedCapturedOptions,
  type MakeLangChainToolOptions as SharedToolOptions,
  type MakeLangChainToolsOptions as SharedToolsOptions,
  toLangChainToolsCaptured as sharedCaptured,
  makeLangChainTool as sharedTool,
  makeLangChainTools as sharedTools,
} from "@cogni/shared-langgraph-graphs/runtime";

export type {
  ExecResolver,
  ToolExecFn,
  ToolExecResult,
} from "@cogni/shared-langgraph-graphs/runtime";

type LocalContract = ToolContract<string, unknown, unknown, unknown>;
export type MakeLangChainToolOptions = Omit<SharedToolOptions, "contract"> & {
  readonly contract: LocalContract;
};
export type MakeLangChainToolsOptions = Omit<
  SharedToolsOptions,
  "contracts"
> & { readonly contracts: readonly LocalContract[] };
export type ToLangChainToolsCapturedOptions = Omit<
  SharedCapturedOptions,
  "contracts"
> & { readonly contracts: readonly LocalContract[] };

// LangChain accepts both local Zod 3 schemas and the published Zod 4 schemas.
// The published wrapper owns deny-by-default, config propagation and result handling.
export function makeLangChainTool(options: MakeLangChainToolOptions) {
  return sharedTool(options as SharedToolOptions);
}
export function makeLangChainTools(options: MakeLangChainToolsOptions) {
  return sharedTools(options as SharedToolsOptions);
}
export function toLangChainToolsCaptured(
  options: ToLangChainToolsCapturedOptions,
) {
  return sharedCaptured(options as SharedCapturedOptions);
}
