// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";

describe("safeErrorDimensions", () => {
	it("finds a nested plain-object SQLSTATE and scrubs message secrets", () => {
		const cause = {
			name: "Postgres Error!",
			message:
				"connect postgresql://alice:hunter2@db/app where id='tenant-secret' token=api-secret",
			cause: { sqlState: "23505" },
		};
		const error = Object.assign(new Error("request failed Bearer abc.def.ghi"), {
			cause,
		});

		const dimensions = safeErrorDimensions(error);

		expect(dimensions.err).toBe("request failed Bearer <redacted>");
		expect(dimensions.cause_message).not.toContain("hunter2");
		expect(dimensions.cause_message).not.toContain("tenant-secret");
		expect(dimensions.cause_message).not.toContain("api-secret");
		expect(dimensions.cause_code).toBe("23505");
		expect(dimensions.cause_class).toBe("Postgres_Error_");
	});

	it("bounds labels and terminates a cyclic cause chain", () => {
		const cyclic: Record<string, unknown> = {
			name: "x".repeat(200),
			code: `bad code ${"y".repeat(200)}`,
			message: "wrapped failure",
		};
		cyclic.cause = cyclic;

		const dimensions = safeErrorDimensions({
			name: "Wrapper",
			message: "top",
			cause: cyclic,
		});

		expect(dimensions.cause_class).toHaveLength(80);
		expect(dimensions.cause_code).toHaveLength(80);
		expect(dimensions.cause_code).not.toContain(" ");
	});
});
