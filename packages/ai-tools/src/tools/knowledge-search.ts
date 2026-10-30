// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared read contracts and execution; Poly retains catalog composition. */
export {
  createKnowledgeSearchImplementation,
  KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS,
  KNOWLEDGE_SEARCH_NAME,
  type KnowledgeSearchDeps,
  type KnowledgeSearchInput,
  KnowledgeSearchInputSchema,
  type KnowledgeSearchOutput,
  KnowledgeSearchOutputSchema,
  type KnowledgeSearchRedacted,
  knowledgeSearchBoundTool,
  knowledgeSearchContract,
  knowledgeSearchStubImplementation,
} from "@cogni/shared-ai-tools";

import { KnowledgeSearchOutputSchema } from "@cogni/shared-ai-tools";
export const KnowledgeSearchResultSchema =
  KnowledgeSearchOutputSchema.shape.results.element;
