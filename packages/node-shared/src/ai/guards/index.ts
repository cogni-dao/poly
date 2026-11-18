// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/ai/guards`
 * Purpose: Pure validation guards for AI responses.
 * Scope: Citation validation for Brain-mode. Does not perform IO or modify state.
 * Invariants: All guard functions are pure — no side-effects, no network calls.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/cogni-brain.md
 * @public
 */

export {
  INSUFFICIENT_CITATION_MESSAGE,
  needsCitationRetry,
  type ParsedCitation,
  parseCitation,
  validateSources,
} from "./citation.guard";
