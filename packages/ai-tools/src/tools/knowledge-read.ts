// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared read contracts and execution; Poly retains catalog composition. */
export {
  createKnowledgeReadImplementation,
  KNOWLEDGE_READ_NAME,
  type KnowledgeReadDeps,
  type KnowledgeReadInput,
  KnowledgeReadInputSchema,
  type KnowledgeReadOutput,
  KnowledgeReadOutputSchema,
  type KnowledgeReadRedacted,
  knowledgeReadBoundTool,
  knowledgeReadContract,
  knowledgeReadStubImplementation,
} from "@cogni/shared-ai-tools";

import { KnowledgeReadOutputSchema } from "@cogni/shared-ai-tools";
export const KnowledgeReadEntrySchema =
  KnowledgeReadOutputSchema.shape.entries.element;
