// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Runtime composition proof for the scheduled algorithm-evaluation graph. */
import { CORE_TOOL_BUNDLE, EDO_HYPOTHESIZE_NAME } from "@cogni/ai-tools";
import { POLY_ALGORITHM_EVALUATION_GRAPH_NAME } from "@cogni/poly-graphs";
import { describe, expect, it } from "vitest";

import {
	POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS,
	POLY_NODE_LANGGRAPH_CATALOG,
} from "@/bootstrap/ai/node-catalog";

describe("poly algorithm-evaluation runtime catalog", () => {
	it("is executable through the node-local provider catalog", () => {
		const entry =
			POLY_NODE_LANGGRAPH_CATALOG[POLY_ALGORITHM_EVALUATION_GRAPH_NAME];
		expect(entry?.graphFactory).toBeTypeOf("function");
		expect(entry?.toolIds).toEqual(POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS);
	});

	it("resolves every allowed tool from the node bundle", () => {
		const resolvable = new Set(
			CORE_TOOL_BUNDLE.map((tool) => tool.contract.name),
		);
		expect(
			POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS.every((toolId) =>
				resolvable.has(toolId),
			),
		).toBe(true);
	});

	it("permits only read tools plus narrowly scoped EDO persistence", () => {
		const contracts = new Map(
			CORE_TOOL_BUNDLE.map((tool) => [tool.contract.name, tool.contract]),
		);
		const stateChanges = POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS.filter(
			(toolId) => contracts.get(toolId)?.effect === "state_change",
		);

		expect(stateChanges).toEqual([EDO_HYPOTHESIZE_NAME]);
		expect(POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS).not.toContain(
			"core__work_item_transition",
		);
		expect(POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS).not.toContain(
			"core__poly_place_trade",
		);
		expect(POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS).not.toContain(
			"core__knowledge_write",
		);
		expect(POLY_ALGORITHM_EVALUATION_NODE_TOOL_IDS).not.toContain(
			"core__poly_account_copy_trade_orders",
		);
	});
});
