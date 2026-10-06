import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildInventoryFromSource,
  classifyEntry,
  completionProblems,
  contractDigest,
  coveredTargetsDigest,
  deriveBehavioralGates,
  groupProblems,
  mappedSourceTargets,
  mappedTargetPath,
  markdown,
  regressionProblems,
  sourceEntryDigest,
  validatePolicy,
  validateSourceEntries,
  validateSourceIdentity,
  verificationProblems,
  worktreeFile,
} from "./poly-port-inventory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/porting/poly-port-policy.json"), "utf8")
);
const inventory = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/porting/poly-port-inventory.json"), "utf8")
);
const sourceEntries = inventory.entries.map(
  ({ sourcePath, sourceMode, sourceBlob }) => ({
    sourcePath,
    sourceMode,
    sourceBlob,
  })
);
const committedReport = readFileSync(
  path.join(repoRoot, "docs/porting/poly-port-inventory.md"),
  "utf8"
);
// Amendment 1: mission scope is policy-derived (additive growth allowed), never below the floor.
const missionScopePaths = policy.deliveryGroups.flatMap((group) => group.sourcePaths);
const ratifiedMissionScopeFloor = { P0: 28, P1: 51 };

test("the committed v2 ledger verifies against the current worktree", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/poly-port-inventory.mjs", "verify"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`mission \\d+/${missionScopePaths.length}`));
});

test("source pin covers every path, mode, and blob", () => {
  assert.equal(inventory.entries.length, 1736);
  assert.equal(sourceEntryDigest(inventory.entries), policy.source.entryDigest);
  assert.equal(policy.source.treeObject, "0e10d2baa4acbf50914476562c06788ff2a3d040");
});

test("source identity rejects tree, count, and entry-digest tampering", () => {
  assert.throws(
    () => validateSourceIdentity(policy, policy.source.revision, "0".repeat(40)),
    /Legacy subtree/
  );
  assert.throws(
    () =>
      validateSourceEntries(
        { ...policy, source: { ...policy.source, fileCount: 1735 } },
        sourceEntries
      ),
    /expected 1735/
  );
  const tampered = sourceEntries.map((entry, index) =>
    index === 0 ? { ...entry, sourceBlob: "0".repeat(40) } : entry
  );
  assert.throws(() => validateSourceEntries(policy, tampered), /entry digest differs/);
});

test("longest path mapping wins and duplicate targets are rejected", () => {
  const mappingPolicy = {
    pathMappings: [
      { sourcePrefix: "packages/", targetPrefix: "broad/" },
      { sourcePrefix: "packages/a/", targetPrefix: "specific/" },
    ],
  };
  assert.equal(mappedTargetPath("packages/a/x.ts", mappingPolicy), "specific/x.ts");
  assert.throws(
    () =>
      mappedSourceTargets(
        [{ sourcePath: "a/x.ts" }, { sourcePath: "b/x.ts" }],
        {
          pathMappings: [
            { sourcePrefix: "a/", targetPrefix: "same/" },
            { sourcePrefix: "b/", targetPrefix: "same/" },
          ],
        }
      ),
    /More than one legacy file maps/
  );
});

test("the Pareto mission assigns every policy-scoped P0/P1 file exactly once", () => {
  assert.equal(new Set(missionScopePaths).size, missionScopePaths.length);
  const priorityByPath = new Map(
    inventory.entries.map(({ sourcePath, priority }) => [sourcePath, priority])
  );
  const counts = { P0: 0, P1: 0 };
  for (const sourcePath of missionScopePaths) {
    const priority = priorityByPath.get(sourcePath);
    assert.ok(priority === "P0" || priority === "P1", `${sourcePath} must be P0/P1`);
    counts[priority] += 1;
  }
  assert.ok(counts.P0 >= ratifiedMissionScopeFloor.P0, "P0 scope below ratified floor");
  assert.ok(counts.P1 >= ratifiedMissionScopeFloor.P1, "P1 scope below ratified floor");
  const mission = inventory.entries.filter(({ deliveryGroup }) => deliveryGroup);
  assert.equal(mission.length, missionScopePaths.length);
  assert.equal(mission.filter(({ priority }) => priority === "P0").length, counts.P0);
  assert.equal(mission.filter(({ priority }) => priority === "P1").length, counts.P1);
  assert.equal(
    inventory.summary.missionResolved,
    mission.filter(({ status }) => status !== "unresolved").length
  );
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

test("worktree hashing detects untracked mapped files, executable modes, and symlinks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "poly-port-"));
  try {
    writeFileSync(path.join(root, "mapped.ts"), "export const x = 1;\n");
    assert.equal(worktreeFile("mapped.ts", root).mode, "100644");
    chmodSync(path.join(root, "mapped.ts"), 0o755);
    assert.equal(worktreeFile("mapped.ts", root).mode, "100755");
    symlinkSync("mapped.ts", path.join(root, "link.ts"));
    assert.equal(worktreeFile("link.ts", root).mode, "120000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unresolved reasons distinguish missing, content, mode, and missing resolution", () => {
  const entry = {
    sourcePath: "a.ts",
    sourceBlob: "a".repeat(40),
    sourceMode: "100644",
    targetPath: "a.ts",
  };
  assert.equal(
    classifyEntry(entry, { blob: null, mode: null }, null, null).unresolvedReason,
    "missing_target"
  );
  assert.equal(
    classifyEntry(entry, { blob: "b".repeat(40), mode: "100644" }, null, null)
      .unresolvedReason,
    "content_differs"
  );
  assert.equal(
    classifyEntry(entry, { blob: entry.sourceBlob, mode: "100755" }, null, null)
      .unresolvedReason,
    "mode_differs"
  );
  assert.equal(
    classifyEntry(
      entry,
      { blob: entry.sourceBlob, mode: entry.sourceMode },
      null,
      "lane"
    ).unresolvedReason,
    "resolution_missing"
  );
});

test("resolution drift becomes approval_stale instead of terminal", () => {
  const entry = {
    sourcePath: "a.ts",
    sourceBlob: "a".repeat(40),
    sourceMode: "100644",
    targetPath: "a.ts",
  };
  const target = { blob: "b".repeat(40), mode: "100644" };
  const targetDigest = coveredTargetsDigest(
    ["a.ts"],
    [{ ...entry, targetBlob: target.blob, targetMode: target.mode }]
  );
  const resolution = {
    outcome: "upgraded",
    source: { blob: "a".repeat(40), mode: "100644" },
    target: { path: "a.ts", blob: "c".repeat(40), mode: "100644" },
    proofs: [{ expectedTargetDigest: targetDigest }],
  };
  assert.deepEqual(classifyEntry(entry, target, resolution, "lane"), {
    status: "unresolved",
    unresolvedReason: "approval_stale",
  });
});

test("valid upgrades and retirements become stale on any pinned drift", () => {
  const entry = {
    sourcePath: "a.ts",
    sourceBlob: "a".repeat(40),
    sourceMode: "100644",
    targetPath: "a.ts",
  };
  const target = { blob: "b".repeat(40), mode: "100755" };
  const upgradeDigest = coveredTargetsDigest(
    ["a.ts"],
    [{ ...entry, targetBlob: target.blob, targetMode: target.mode }]
  );
  const upgrade = {
    outcome: "upgraded",
    source: { blob: entry.sourceBlob, mode: entry.sourceMode },
    target: { path: entry.targetPath, blob: target.blob, mode: target.mode },
    proofs: [
      { environment: "candidate", expectedTargetDigest: upgradeDigest },
      { environment: "production", expectedTargetDigest: upgradeDigest },
    ],
  };
  assert.equal(classifyEntry(entry, target, upgrade, "lane").status, "upgraded");
  assert.equal(
    classifyEntry({ ...entry, sourceMode: "100755" }, target, upgrade, "lane")
      .unresolvedReason,
    "approval_stale"
  );
  assert.equal(
    classifyEntry(entry, { ...target, blob: "c".repeat(40) }, upgrade, "lane")
      .unresolvedReason,
    "approval_stale"
  );
  const retirementDigest = coveredTargetsDigest(
    ["a.ts"],
    [{ ...entry, targetBlob: null, targetMode: null }]
  );
  const retirement = {
    outcome: "retired",
    source: { blob: entry.sourceBlob, mode: entry.sourceMode },
    target: null,
    proofs: [
      { environment: "candidate", expectedTargetDigest: retirementDigest },
      { environment: "production", expectedTargetDigest: retirementDigest },
    ],
  };
  assert.equal(
    classifyEntry(entry, { blob: null, mode: null }, retirement, "lane").status,
    "retired"
  );
  assert.equal(
    classifyEntry(entry, target, retirement, "lane").unresolvedReason,
    "approval_stale"
  );
  assert.equal(
    classifyEntry(
      { ...entry, sourceBlob: "d".repeat(40) },
      { blob: null, mode: null },
      retirement,
      "lane"
    ).unresolvedReason,
    "approval_stale"
  );
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

test("policy rejects duplicate, orphaned, and conflicting resolution ownership", () => {
  const duplicate = structuredClone(policy);
  duplicate.resolutions.push({ ...duplicate.resolutions[0] });
  assert.throws(
    () => validatePolicy(duplicate, { checkContract: false }),
    /duplicated/
  );

  const orphan = structuredClone(policy);
  orphan.resolutions[0].deliveryGroup = "visible-p0";
  assert.throws(
    () => validatePolicy(orphan, { checkContract: false }),
    /orphaned from delivery group/
  );

  const conflicting = structuredClone(policy);
  conflicting.deliveryGroups[1].sourcePaths.push(
    conflicting.deliveryGroups[0].sourcePaths[0]
  );
  assert.throws(
    () => validatePolicy(conflicting, { checkContract: false }),
    /belongs to both/
  );
});

test("proof refresh marker is exact, audited, and preserves historical evidence", () => {
  const marker = policy.proofRefreshPending[0];
  assert.equal(marker.taskId, "task.5176");
  assert.equal(marker.prNumber, 124);
  assert.doesNotThrow(() => validatePolicy(policy));

  for (const mutate of [
    (candidate) => {
      candidate.proofRefreshPending[0].target.blob = "0".repeat(40);
    },
    (candidate) => {
      candidate.proofRefreshPending[0].historicalProofsDigest = "0".repeat(64);
    },
    (candidate) => {
      candidate.proofRefreshPending[0].gateTargets[0].targetDigest = "0".repeat(64);
    },
  ]) {
    const candidate = structuredClone(policy);
    mutate(candidate);
    assert.throws(() => validatePolicy(candidate));
  }
});

test("current candidate evidence can coexist with preserved history while production stays pending", () => {
  const candidate = structuredClone(policy);
  const marker = candidate.proofRefreshPending[0];
  const resolution = candidate.resolutions.find(
    ({ sourcePath }) => sourcePath === marker.sourcePath
  );
  resolution.proofs.push({
    ...resolution.proofs[0],
    buildSha: "1".repeat(40),
    expectedTargetDigest: marker.target.digest,
  });
  for (const gateTarget of marker.gateTargets) {
    const gate = candidate.behavioralGates.find(({ id }) => id === gateTarget.id);
    gate.proofs.push({
      ...gate.proofs[0],
      buildSha: "1".repeat(40),
      expectedTargetDigest: gateTarget.targetDigest,
    });
  }
  assert.doesNotThrow(() => validatePolicy(candidate));
  const rebuilt = buildInventoryFromSource(candidate, sourceEntries, {
    root: repoRoot,
    checkContract: false,
  });
  const entry = rebuilt.entries.find(
    ({ sourcePath }) => sourcePath === marker.sourcePath
  );
  assert.equal(entry.status, "unresolved");
  assert.equal(entry.unresolvedReason, "proof_refresh_pending");
  for (const gateTarget of marker.gateTargets) {
    const gate = rebuilt.behavioralGates.find(({ id }) => id === gateTarget.id);
    assert.equal(gate.status, "unresolved");
    assert.equal(gate.unresolvedReason, "proof_refresh_pending");
  }
});

test("group and completion checks use files plus derived gates", () => {
  const hubProblems = groupProblems(inventory, "hub-control-plane");
  assert.ok(
    hubProblems.includes(
      "app/src/adapters/server/db/doltgres/work-items-adapter.ts: proof_refresh_pending"
    )
  );
  assert.ok(
    hubProblems.includes("hub.work_item_create: proof_refresh_pending")
  );
  const problems = completionProblems(inventory, "P1");
  assert.ok(problems.length > 0);
  assert.ok(problems.some((problem) => problem.startsWith("dashboard.open_positions:")));
});

test("completion succeeds for a synthetic fully resolved P0/P1 inventory", () => {
  const complete = structuredClone(inventory);
  for (const entry of complete.entries) {
    if (entry.priority === "P0" || entry.priority === "P1") {
      entry.status = "exact";
      entry.unresolvedReason = null;
    }
  }
  for (const gate of complete.behavioralGates) {
    gate.status = "passed";
    gate.unresolvedReason = null;
  }
  assert.deepEqual(completionProblems(complete, "P1"), []);
});

test("JSON and Markdown artifact staleness are independently detected", () => {
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  assert.deepEqual(verificationProblems(json, committedReport, inventory, policy), []);
  assert.ok(
    verificationProblems(`${json} `, committedReport, inventory, policy).includes(
      "JSON ledger is stale"
    )
  );
  assert.ok(
    verificationProblems(json, `${committedReport} `, inventory, policy).includes(
      "Markdown report is stale"
    )
  );
});

test("reversed source input produces identical canonical inventory and full report", () => {
  const rebuilt = buildInventoryFromSource(policy, sourceEntries, { root: repoRoot });
  const reversed = buildInventoryFromSource(policy, [...sourceEntries].reverse(), {
    root: repoRoot,
  });
  assert.deepEqual(reversed, rebuilt);
  const report = markdown(rebuilt, policy);
  const table = report.split("## Complete legacy file table\n")[1];
  assert.ok((table.match(/^\| P[0-3] \|/gm) ?? []).length > 100);
  assert.equal(markdown(reversed, policy), report);
});

test("regression freezes contract, groups, gate definitions, and P0/P1 terminal progress", () => {
  const current = structuredClone(inventory);
  current.contract.sha256 = "0".repeat(64);
  current.deliveryGroups[0].resolutionProofMode = "file-only";
  current.deliveryGroups[0].behaviorExpectation = "weaker";
  current.behavioralGates[0].requirement = "weaker";
  const terminal = current.entries.find(
    ({ priority, status }) =>
      (priority === "P0" || priority === "P1") && status !== "unresolved"
  );
  terminal.status = "unresolved";
  const problems = regressionProblems(inventory, current);
  assert.ok(problems.includes("immutable contract path or hash changed"));
  assert.ok(
    problems.includes(
      `delivery group resolutionProofMode changed: ${current.deliveryGroups[0].id}`
    )
  );
  assert.ok(
    problems.includes(
      `delivery group behaviorExpectation changed: ${current.deliveryGroups[0].id}`
    )
  );
  assert.ok(
    problems.includes(
      `behavioral gate requirement changed: ${current.behavioralGates[0].id}`
    )
  );
  assert.ok(problems.includes(`terminal resolution regressed: ${terminal.sourcePath}`));
});

test("Amendment 2 unfreezes a gate requirement only for the named gate on a ratified advance", () => {
  const amendment1Digest =
    "eeb47ab2f13fb44ac54b671600137e063e3cac7f47ab887bc0780c40fc59508d";
  const named = "dashboard.wallet_identity";

  // The real advance: Amendment 1 head -> the committed Amendment 2 head, with the
  // named gate's requirement rewritten. Legal, and reported as a note, not a problem.
  const base = structuredClone(inventory);
  base.contract.sha256 = amendment1Digest;
  base.behavioralGates.find(({ id }) => id === named).requirement =
    "funder_address when present, otherwise the legacy signer address.";
  assert.deepEqual(regressionProblems(base, inventory), []);

  // Same ratified advance, but a gate the amendment did not name stays frozen.
  const unnamed = structuredClone(inventory);
  const other = unnamed.behavioralGates.find(({ id }) => id !== named);
  other.requirement = "something else";
  assert.ok(
    regressionProblems(base, unnamed).includes(
      `behavioral gate requirement changed: ${other.id}`
    )
  );

  // The named gate without a lineage advance is still frozen: an unchanged contract
  // pin must never carry a requirement rewrite.
  const noAdvance = structuredClone(inventory);
  noAdvance.behavioralGates.find(({ id }) => id === named).requirement = "drifted";
  assert.ok(
    regressionProblems(inventory, noAdvance).includes(
      `behavioral gate requirement changed: ${named}`
    )
  );
});

test("regression leaves non-mission P2/P3 forward differences visibly queued", () => {
  const current = structuredClone(inventory);
  const queued = current.entries.find(
    ({ priority, status }) =>
      (priority === "P2" || priority === "P3") && status !== "unresolved"
  );
  assert.ok(queued);
  queued.status = "unresolved";
  queued.unresolvedReason = "content_differs";

  assert.deepEqual(regressionProblems(inventory, current), []);
});

test("regression allows only an exact validated proof-refresh transition", () => {
  const base = structuredClone(inventory);
  base.proofRefreshPending = [];
  const pendingEntry = base.entries.find(
    ({ unresolvedReason }) => unresolvedReason === "proof_refresh_pending"
  );
  pendingEntry.status = "upgraded";
  pendingEntry.unresolvedReason = null;
  for (const gate of base.behavioralGates) {
    if (gate.unresolvedReason === "proof_refresh_pending") {
      gate.status = "passed";
      gate.unresolvedReason = null;
    }
  }
  assert.deepEqual(regressionProblems(base, inventory), []);

  const unmarked = structuredClone(inventory);
  unmarked.proofRefreshPending = [];
  const problems = regressionProblems(base, unmarked);
  assert.ok(
    problems.includes(
      `terminal resolution regressed: ${pendingEntry.sourcePath}`
    )
  );
  assert.ok(problems.includes("behavioral gate regressed: hub.work_item_create"));
});

test("regression allows strictly additive delivery-group growth within the inventory", () => {
  const current = structuredClone(inventory);
  const group = current.deliveryGroups.find(({ id }) => id === "visible-p0");
  const addition = current.entries.find(
    ({ deliveryGroup, priority }) =>
      !deliveryGroup && (priority === "P0" || priority === "P1")
  ).sourcePath;
  group.sourcePaths = [...group.sourcePaths, addition];
  const notes = [];
  assert.deepEqual(regressionProblems(inventory, current, notes), []);
  assert.ok(
    notes.includes(`delivery group sourcePaths grew additively: visible-p0 (+${addition})`)
  );
});

test("regression still rejects removals, renames, and out-of-inventory additions", () => {
  const removal = structuredClone(inventory);
  const removalGroup = removal.deliveryGroups.find(({ id }) => id === "visible-p0");
  const [removedPath] = removalGroup.sourcePaths.splice(0, 1);
  assert.ok(
    regressionProblems(inventory, removal).some(
      (problem) =>
        problem.includes("sourcePaths removed") && problem.includes(removedPath)
    )
  );

  const rename = structuredClone(inventory);
  const renameGroup = rename.deliveryGroups.find(({ id }) => id === "visible-p0");
  const replacement = rename.entries.find(({ deliveryGroup }) => !deliveryGroup).sourcePath;
  renameGroup.sourcePaths = [...renameGroup.sourcePaths.slice(1), replacement];
  assert.ok(
    regressionProblems(inventory, rename).some((problem) =>
      problem.includes("sourcePaths removed")
    )
  );

  const outside = structuredClone(inventory);
  const outsideGroup = outside.deliveryGroups.find(({ id }) => id === "visible-p0");
  outsideGroup.sourcePaths = [...outsideGroup.sourcePaths, "not/in/the/inventory.ts"];
  assert.ok(
    regressionProblems(inventory, outside).some((problem) =>
      problem.includes("outside the pinned inventory")
    )
  );
});

test("a ratified amendment advances the contract lineage without tripping regression", () => {
  const base = structuredClone(inventory);
  base.contract.sha256 =
    "196fb0e9863d53823db200479d940d9d7d3db93d7d221c5ef9ca793eaf0431ba";
  const notes = [];
  const problems = regressionProblems(base, inventory, notes);
  assert.ok(!problems.some((problem) => problem.includes("contract")));
  assert.ok(notes.includes("contract advanced along the ratified amendment lineage"));
});

test("only amendment-exempt regions are outside the frozen contract digest", () => {
  const contract = readFileSync(
    path.join(repoRoot, policy.contract.path),
    "utf8"
  );
  assert.equal(contractDigest(contract), policy.contract.sha256);
  const scopeGrown = contract.replace("| `visible-p0` | 11 | 0 |", "| `visible-p0` | 12 | 0 |");
  assert.notEqual(scopeGrown, contract);
  assert.equal(contractDigest(scopeGrown), policy.contract.sha256);
  const weakened = contract.replace("## Locked outcome", "## Loosened outcome");
  assert.notEqual(contractDigest(weakened), policy.contract.sha256);
  assert.throws(
    () => contractDigest("<!-- amendment-exempt:begin -->\nnever closed"),
    /Unterminated amendment-exempt/
  );
});
