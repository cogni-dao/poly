// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { KnowledgeStorePort } from "@cogni-dao/knowledge-store";

/**
 * The shared coordinator's source context, with node-template's semantics (resolveNodeSourceContext):
 * mission + origin + the content-free governing index. No snapshot freshness or goal gate and no
 * local row/byte caps: a slow or stale cognition snapshot must not deny the run.
 */
export async function loadCogniSourceContext(input: {
  readonly store: Pick<KnowledgeStorePort, "listGoverningIndex">;
  readonly nodeId: string;
  readonly origin: string;
  readonly mission: string;
  readonly buildSha?: string | undefined;
}) {
  if (!input.nodeId || !input.origin || !input.mission)
    throw new Error("node_source_context_unavailable");
  const governingIndex = await input.store
    .listGoverningIndex()
    .catch(() => {
      throw new Error("node_source_context_unavailable");
    });
  return {
    nodeId: input.nodeId,
    origin: input.origin,
    mission: {
      content: input.mission,
      sourceRef: ".cogni/repo-spec.yaml",
      buildSha: input.buildSha ?? null,
    },
    governingIndex,
  };
}
