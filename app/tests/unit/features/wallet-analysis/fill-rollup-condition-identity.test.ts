// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** SQL rendering guard for opt-in condition identity normalization. */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  EPOCH_ISO,
  windowedFillFlowsSelect,
} from "@/features/wallet-analysis/server/fill-rollup-service";

const WALLET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function render(conditionIdentity?: "exact" | "case_insensitive") {
  return new PgDialect().sqlToQuery(
    windowedFillFlowsSelect({
      walletIds: [WALLET_ID],
      windowStartIso: EPOCH_ISO,
      conditionIds: ["MiXeD-Condition"],
      ...(conditionIdentity ? { conditionIdentity } : {}),
    })
  );
}

describe("windowed fill-flow condition identity", () => {
  it("keeps the default SQL and parameters byte-identical to explicit exact mode", () => {
    expect(render()).toEqual(render("exact"));
    expect(render().sql).not.toContain("lower(r.condition_id)");
    expect(render().params).toContain("MiXeD-Condition");
  });

  it("normalizes both SQL predicate sides in all three union branches", () => {
    const query = render("case_insensitive");
    expect(query.sql.match(/lower\([rf]\.condition_id\)/g)).toHaveLength(3);
    expect(query.params).not.toContain("MiXeD-Condition");
    expect(query.params.filter((value) => value === "mixed-condition")).toHaveLength(3);
  });
});
