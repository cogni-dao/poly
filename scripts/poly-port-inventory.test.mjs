import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyEntry,
  completionProblems,
  coveredTargetsDigest,
  deriveBehavioralGates,
  groupProblems,
  regressionProblems,
  sourceEntryDigest,
  validatePolicy,
} from "./poly-port-inventory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/porting/poly-port-policy.json"), "utf8")
);
const inventory = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/porting/poly-port-inventory.json"), "utf8")
);

test("the committed v2 ledger verifies against the current worktree", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/poly-port-inventory.mjs", "verify"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mission 8\/79/);
});

test("source pin covers every path, mode, and blob", () => {
  assert.equal(inventory.entries.length, 1736);
  assert.equal(sourceEntryDigest(inventory.entries), policy.source.entryDigest);
  assert.equal(policy.source.treeObject, "0e10d2baa4acbf50914476562c06788ff2a3d040");
});

test("the Pareto mission assigns 28 P0 and 51 P1 files exactly once", () => {
  const assigned = policy.deliveryGroups.flatMap((group) => group.sourcePaths);
  assert.equal(assigned.length, 79);
  assert.equal(new Set(assigned).size, 79);
  const mission = inventory.entries.filter(({ deliveryGroup }) => deliveryGroup);
  assert.equal(mission.filter(({ priority }) => priority === "P0").length, 28);
  assert.equal(mission.filter(({ priority }) => priority === "P1").length, 51);
  assert.equal(inventory.summary.missionResolved, 8);
});

test("the generated report contains all 1,736 file rows", () => {
  const report = readFileSync(
    path.join(repoRoot, "docs/porting/poly-port-inventory.md"),
    "utf8"
  );
  const table = report.split("## Complete legacy file table\n")[1];
  assert.ok(table);
  assert.equal((table.match(/^\| P[0-3] \|/gm) ?? []).length, 1736);
  assert.deepEqual(
    new Set(inventory.entries.map(({ status }) => status)),
    new Set(["exact", "upgraded", "retired", "unresolved"])
  );
});

test("target-only inventory is limited to tracked files", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
  );
  assert.ok(inventory.targetOnly.every(({ targetPath }) => tracked.has(targetPath)));
});

test("resolution drift becomes approval_stale instead of terminal", () => {
  const entry = {
    sourcePath: "a.ts",
    sourceBlob: "a".repeat(40),
    sourceMode: "100644",
    targetPath: "a.ts",
  };
  const target = { blob: "b".repeat(40), mode: "100644" };
  const resolution = {
    outcome: "upgraded",
    source: { blob: "a".repeat(40), mode: "100644" },
    target: { path: "a.ts", blob: "c".repeat(40), mode: "100644" },
  };
  assert.deepEqual(classifyEntry(entry, target, resolution, "lane"), {
    status: "unresolved",
    unresolvedReason: "approval_stale",
  });
});

test("behavioral gate state is derived and target drift stales its proofs", () => {
  const entries = [
    {
      sourcePath: "a.ts",
      targetPath: "a.ts",
      targetMode: "100644",
      targetBlob: "a".repeat(40),
    },
  ];
  const digest = coveredTargetsDigest(["a.ts"], entries);
  const gatePolicy = {
    deliveryGroups: [
      {
        id: "lane",
        requiredProofEnvironments: ["candidate", "production"],
      },
    ],
    behavioralGates: [
      {
        id: "gate",
        deliveryGroup: "lane",
        coveredSourcePaths: ["a.ts"],
        proofs: [
          { environment: "candidate", expectedTargetDigest: digest },
          { environment: "production", expectedTargetDigest: digest },
        ],
      },
    ],
  };
  assert.equal(deriveBehavioralGates(gatePolicy, entries)[0].status, "passed");
  const drifted = [{ ...entries[0], targetBlob: "b".repeat(40) }];
  const result = deriveBehavioralGates(gatePolicy, drifted)[0];
  assert.equal(result.status, "unresolved");
  assert.equal(result.unresolvedReason, "proof_stale_or_incomplete");
});

test("policy rejects manually authored behavioral status", () => {
  const invalid = structuredClone(policy);
  invalid.behavioralGates[0].status = "passed";
  assert.throws(
    () => validatePolicy(invalid, { checkContract: false }),
    /status must be derived/
  );
});

test("group and completion checks use files plus derived gates", () => {
  assert.deepEqual(groupProblems(inventory, "hub-control-plane"), []);
  const problems = completionProblems(inventory, "P1");
  assert.equal(problems.length, 75);
  assert.ok(problems.some((problem) => problem.startsWith("dashboard.open_positions:")));
});

test("regression rejects contract drift and terminal regressions", () => {
  const base = {
    source: inventory.source,
    contract: inventory.contract,
    entries: [
      {
        sourcePath: "a.ts",
        priority: "P0",
        deliveryGroup: "lane",
        status: "upgraded",
      },
    ],
    behavioralGates: [{ id: "gate", status: "passed" }],
  };
  const current = {
    source: inventory.source,
    contract: { ...inventory.contract, sha256: "0".repeat(64) },
    entries: [
      {
        sourcePath: "a.ts",
        priority: "P0",
        deliveryGroup: "lane",
        status: "unresolved",
      },
    ],
    behavioralGates: [{ id: "gate", status: "unresolved" }],
  };
  assert.deepEqual(regressionProblems(base, current), [
    "immutable contract path or hash changed",
    "terminal resolution regressed: a.ts",
    "behavioral gate regressed: gate",
  ]);
});
