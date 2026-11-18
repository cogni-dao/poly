// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/tool-card`
 * Purpose: Public surface for ToolCard + ToolChip primitives used in chat tool-call rendering.
 * Scope: Re-exports only. Does not introduce any new components or runtime behavior.
 * Invariants: BARREL_ONLY — keep this file as a pure re-export; component logic lives in sibling files.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/guides/assistant-ui-tool-rendering.md
 * @public
 */

export { ToolCard, type ToolCardProps, type ToolCardTone } from "./tool-card";
export { ToolChip, type ToolChipProps } from "./tool-chip";
