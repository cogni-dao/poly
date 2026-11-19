// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Domain-owned EDO contracts flow through the shared tools compatibility exports. */
export type {
  ChainDirection,
  ChainNodeEntry,
  DecideParams,
  EdoSourceType,
  GetChainParams,
  GetChainResult,
  HypothesizeParams,
  RecordOutcomeParams,
  RecordOutcomeResult,
} from "@cogni/shared-ai-tools";
/** The tool-facing capability: the host binds the run attribution to each write (task.0133), so a tool never builds one. */
export type { EdoToolCapability as EdoCapability } from "@cogni-dao/knowledge-store";
