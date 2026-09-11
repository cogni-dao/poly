// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/fresh-node-spec`
 * Purpose: Regression tests for bug.5033 — a freshly minted node's repo-spec MUST parse.
 * Scope: Feeds real fleet spec shapes (wizard-minted bare-slug knowledge repo, legacy
 *   `knowledge-<slug>` forks, distributions-activated variant) through `parseRepoSpec`,
 *   the exact function container init runs; a throw here turns every public route into
 *   a 503 (CONTAINER_INIT_FAILED). Also asserts a truly corrupt spec still fails loudly
 *   with the offending path — tolerance must not become silence.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, app/src/bootstrap/http/index.ts (wrapPublicRoute lazy init)
 * @public
 */

import {
  extractChainId,
  extractDistributorAddress,
  extractGovernanceConfig,
  extractKnowledgeConfig,
  parseRepoSpec,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

/**
 * Verbatim mirror of the spec shape the node wizard mints today (toks3 PR-era spec,
 * 2026-08): bare-slug `knowledge.remote.repo` (dolt name == git name — the operator
 * retired the `knowledge-` prefix at mint), governance identity, pending distributions.
 * This exact shape threw at `knowledge.remote.repo` before bug.5033's fix, 503ing all
 * public routes on any fresh node.
 */
const FRESH_NODE_SPEC_YAML = `
schema_version: "0.1.4"

node_id: "2bbccec7-e6e7-48a9-be1e-bca8c58f503c"
scope_id: "855a9922-d947-5b62-9ea3-adf9508a9fa8"
scope_key: "default"

intent:
  name: toks3
  mission: "Define toks3's one-line mission here."

governance:
  dao_contract: "0x0a168a1eca4a380a794782675966524752237e67"
  plugin_contract: "0x6492d701ce5f5158335c9fa5776487c856a86ea7"
  signal_contract: "0x62e25ab10f738bdcd7948f5f64ba216e1df11482"
  token_contract: "0xe15634981c3437Aa78c286A58802981EFabe12C8"
  chain_id: "8453"
  base_url: "https://proposal.cognidao.org"

knowledge:
  database: "knowledge_toks3"
  remote:
    provider: dolthub
    owner: "cogni-dao"
    repo: "toks3"
    url: "https://doltremoteapi.dolthub.com/cogni-dao/toks3"
    custody: cogni-owned

activity_ledger:
  epoch_length_days: 7
  approvers:
    - "0x070075F1389Ae1182aBac722B36CA12285d0c949"
  activity_sources:
    github:
      attribution_pipeline: cogni-v0.0
      source_refs: ["cogni-dao/toks3"]

payments:
  status: pending_activation

distributions:
  status: pending_activation

gates:
  - type: review-limits
    id: review_limits
    with:
      max_changed_files: 50
      max_total_diff_kb: 1500
  - type: ai-rule
    with:
      rule_file: pr-syntropy-coherence.yaml
`;

describe("fresh-node repo-spec shapes parse (bug.5033)", () => {
  it("parses a wizard-minted fresh-node spec (bare-slug knowledge repo)", () => {
    const spec = parseRepoSpec(FRESH_NODE_SPEC_YAML);

    // The eager container-init reads must all succeed on this spec.
    expect(spec.node_id).toBe("2bbccec7-e6e7-48a9-be1e-bca8c58f503c");
    expect(spec.scope_id).toBe("855a9922-d947-5b62-9ea3-adf9508a9fa8");
    expect(extractChainId(spec)).toBe(8453);
    expect(extractGovernanceConfig(spec)).toBeDefined();
    expect(extractKnowledgeConfig(spec)?.remote.repo).toBe("toks3");
  });

  it("parses the distributions-activated variant (toks3 PR #1 shape)", () => {
    const spec = parseRepoSpec(
      FRESH_NODE_SPEC_YAML.replace(
        "distributions:\n  status: pending_activation",
        [
          "distributions:",
          "  status: active",
          "  claim_contract_pattern: uniswap.merkle-distributor.v1",
          '  distributor_address: "0x2222222222222222222222222222222222222222"',
        ].join("\n")
      ).replace(
        'chain_id: "8453"',
        'chain_id: "8453"\n  emissions_holder: "0x0a168A1eca4A380A794782675966524752237e67"'
      )
    );

    expect(spec.distributions?.status).toBe("active");
    expect(extractDistributorAddress(spec)).toBe(
      "0x2222222222222222222222222222222222222222"
    );
  });

  it("parses the legacy `knowledge-<slug>` shape still live on older forks", () => {
    // habitat/blue/oss ship this today; rejecting it would 503 them via fork-sync.
    const spec = parseRepoSpec(
      FRESH_NODE_SPEC_YAML.replace(
        'repo: "toks3"',
        'repo: "knowledge-toks3"'
      ).replace(
        'url: "https://doltremoteapi.dolthub.com/cogni-dao/toks3"',
        'url: "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-toks3"'
      )
    );
    expect(extractKnowledgeConfig(spec)?.remote.repo).toBe("knowledge-toks3");
  });

  it("still fails loudly, naming the path, on a truly corrupt spec", () => {
    // Tolerance for legitimate shapes must NOT swallow real config errors.
    expect(() =>
      parseRepoSpec(FRESH_NODE_SPEC_YAML.replace('repo: "toks3"', 'repo: "Bad Repo!"'))
    ).toThrowError(/knowledge/);
    expect(() =>
      parseRepoSpec(
        FRESH_NODE_SPEC_YAML.replace(
          'node_id: "2bbccec7-e6e7-48a9-be1e-bca8c58f503c"',
          'node_id: "not-a-uuid"'
        )
      )
    ).toThrowError(/node_id/);
  });
});
