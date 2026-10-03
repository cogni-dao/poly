// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /openapi.json", () => {
  it("advertises create and patch work-item operations", async () => {
    const response = GET();
    const document = (await response.json()) as {
      paths?: Record<string, Record<string, unknown>>;
    };

    expect(document.paths?.["/work/items"]?.post).toBeDefined();
    expect(document.paths?.["/work/items/{id}"]?.patch).toBeDefined();
  });
});
