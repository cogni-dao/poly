// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/inproc-events-parity`
 * Purpose: Pin the package provider's event names to Poly's event registry.
 * Scope: Compares two constant tables. Does NOT run a provider.
 * Invariants:
 *   - EVENT_PARITY: every `INPROC_EVENTS` key exists in `EVENT_NAMES` with an equal value, so a log line the package emits is a registered event of this node
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/publish-shared-runtime-core
 * @internal
 */

import { INPROC_EVENTS } from "@cogni/langgraph-graphs";
import { describe, expect, it } from "vitest";
import { EVENT_NAMES } from "@/shared/observability";

describe("INPROC_EVENTS parity with Poly's event registry", () => {
  it.each(Object.entries(INPROC_EVENTS))(
    "%s is registered with the same value",
    (key, value) => {
      expect((EVENT_NAMES as Record<string, string>)[key]).toBe(value);
    }
  );
});
