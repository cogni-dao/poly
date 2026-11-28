// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/util/process-singleton.test`
 * Purpose: Prove ONE_PER_PROCESS (bug.5066): two evaluated copies of the helper
 *          module — what Next/Turbopack gives the instrumentation hook, a page
 *          and a route handler in one process — still share one instance.
 * Scope: `processSingleton` / `clearProcessSingleton`. No IO.
 * Links: work/items/bug.5066, src/shared/util/process-singleton.ts
 * @public
 */

import { describe, expect, it, vi } from "vitest";

describe("processSingleton", () => {
	it("shares one instance across separately evaluated module copies", async () => {
		const copyA = await import("@/shared/util/process-singleton");
		vi.resetModules();
		const copyB = await import("@/shared/util/process-singleton");
		expect(copyB).not.toBe(copyA); // genuinely two module instances

		let created = 0;
		const make = () => ({ id: ++created });
		const a = copyA.processSingleton("t.shared", make);
		const b = copyB.processSingleton("t.shared", make);

		expect(b).toBe(a);
		expect(created).toBe(1);
	});

	it("clearProcessSingleton forgets one key and leaves others", async () => {
		const { processSingleton, clearProcessSingleton } = await import(
			"@/shared/util/process-singleton"
		);
		const x = processSingleton("t.x", () => ({}));
		const y = processSingleton("t.y", () => ({}));
		clearProcessSingleton("t.x");
		expect(processSingleton("t.x", () => ({}))).not.toBe(x);
		expect(processSingleton("t.y", () => ({}))).toBe(y);
	});
});
