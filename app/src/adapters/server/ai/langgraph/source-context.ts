// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type CognitionReadPort,
  readCognitionSnapshot,
} from "@cogni-dao/knowledge-store";

// Admission limits on the complete prompt context, not on the underlying database reads.
// 64 KiB matches the existing tool argument buffer ceiling; 2,048 rows leaves room
// for hubs beyond the old 1,000-row boundary, provided the full context also fits.
export const SOURCE_CONTEXT_MAX_ROWS = 2048;
export const SOURCE_CONTEXT_MAX_BYTES = 64 * 1024;
const ORIENTATION_IDS = [
  "red-agent-orientation",
  "cogni-agent-orientation",
] as const;

/** Read canonical governing metadata via the released helper and admit all or none. */
export async function loadCogniSourceContext(input: {
  readonly store: CognitionReadPort;
  readonly nodeId: string;
  readonly origin: string;
  readonly mission: string;
  readonly buildSha?: string | undefined;
}) {
  if (!input.nodeId || !input.origin || !input.mission)
    throw new Error("node_source_context_unavailable");
  // The helper also reads domains, goals and these orientation entries. Its
  // deadlines bound caller waiting, not native query time or pool occupancy.
  const result = await readCognitionSnapshot(input.store, ORIENTATION_IDS);
  if (result.stale || result.snapshot.goals.status !== "ok")
    throw new Error("node_source_context_unavailable");
  const context = {
    nodeId: input.nodeId,
    origin: input.origin,
    mission: {
      content: input.mission,
      sourceRef: ".cogni/repo-spec.yaml",
      buildSha: input.buildSha ?? null,
    },
    governingIndex: result.snapshot.governingIndex,
  };
  if (
    context.governingIndex.length > SOURCE_CONTEXT_MAX_ROWS ||
    Buffer.byteLength(JSON.stringify(context), "utf8") >
      SOURCE_CONTEXT_MAX_BYTES
  )
    throw new Error("node_source_context_overflow");
  return context;
}
