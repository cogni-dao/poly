// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Retired endpoint contract; cancellation uses the current PATCH operation. */
import { z } from "zod";
export const workItemsDeleteOperation = {
	id: "work.items.delete.v1",
	summary: "Deletion is retired",
	description:
		"Returns HTTP 410. Read the revision and PATCH reasoned cancellation instead; retain history and artifacts.",
	input: z.object({ id: z.string() }),
	output: z.object({ error: z.literal("gone"), message: z.string() }),
} as const;
export type WorkItemsDeleteInput = z.infer<
	typeof workItemsDeleteOperation.input
>;
export type WorkItemsDeleteOutput = z.infer<
	typeof workItemsDeleteOperation.output
>;
