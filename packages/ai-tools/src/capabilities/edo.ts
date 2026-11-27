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
/** The capability a tool sees: the host binds each write's attribution (knowledge-store 0.24.0). */
export type { EdoToolCapability as EdoCapability } from "@cogni-dao/knowledge-store/contracts";
