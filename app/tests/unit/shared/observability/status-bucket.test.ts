// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/observability/status-bucket`
 * Purpose: statusBucket keeps redirects out of the 5xx failure count.
 * Scope: Pure bucket mapping only. Does NOT test counters or route wrappers.
 * Side-effects: none
 * Links: src/shared/observability/server/metrics.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { statusBucket } from "@/shared/observability/server/metrics";

describe("statusBucket", () => {
  it("buckets 3xx as 3xx, so a redirect is never counted as a 5xx failure", () => {
    // Defect guarded: 300-399 fell through to "5xx" and inflated the failure rate.
    expect(statusBucket(301)).toBe("3xx");
    expect(statusBucket(307)).toBe("3xx");
    expect(statusBucket(399)).toBe("3xx");
  });

  it("keeps 2xx, 4xx and 5xx edges", () => {
    expect(statusBucket(200)).toBe("2xx");
    expect(statusBucket(299)).toBe("2xx");
    expect(statusBucket(400)).toBe("4xx");
    expect(statusBucket(499)).toBe("4xx");
    expect(statusBucket(500)).toBe("5xx");
  });
});
