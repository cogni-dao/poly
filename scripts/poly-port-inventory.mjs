#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const policyPath = path.join(repoRoot, "docs/porting/poly-port-policy.json");
const inventoryPath = path.join(repoRoot, "docs/porting/poly-port-inventory.json");
const reportPath = path.join(repoRoot, "docs/porting/poly-port-inventory.md");
const generatedPaths = new Set([
  "docs/porting/poly-port-inventory.json",
  "docs/porting/poly-port-inventory.md",
]);
const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const statusRank = {
  approval_stale: 0,
  missing: 1,
  review_required: 2,
  exact: 3,
  adapted: 3,
  retired: 3,
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function runBuffer(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function worktreeBlobHash(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return null;
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) return gitBlobHash(readlinkSync(absolutePath));
  if (!stat.isFile()) return null;
  return gitBlobHash(readFileSync(absolutePath));
}

function currentFiles() {
  const output = runBuffer("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => !generatedPaths.has(file))
    .sort();
}

function sourceFiles(legacyRepo, revision, treeRoot) {
  const output = runBuffer(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", revision, "--", treeRoot],
    legacyRepo
  );
  const prefix = `${treeRoot.replace(/\/$/, "")}/`;
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d+) blob ([0-9a-f]{40})\t(.+)$/s);
      if (!match) fail(`Unsupported legacy tree entry: ${record}`);
      const [, mode, sourceBlob, fullPath] = match;
      if (!fullPath.startsWith(prefix)) {
        fail(`Legacy path escaped ${treeRoot}: ${fullPath}`);
      }
      return {
        mode,
        sourceBlob,
        sourcePath: fullPath.slice(prefix.length),
      };
    })
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function mappedTargetPath(sourcePath, policy) {
  const rule = [...policy.pathMappings]
    .sort((a, b) => b.sourcePrefix.length - a.sourcePrefix.length)
    .find(({ sourcePrefix }) => sourcePath.startsWith(sourcePrefix));
  if (!rule) return sourcePath;
  return `${rule.targetPrefix}${sourcePath.slice(rule.sourcePrefix.length)}`;
}

function priorityFor(sourcePath, policy) {
  const rule = policy.priorityRules.find(({ prefixes }) =>
    prefixes.some((prefix) => sourcePath.startsWith(prefix))
  );
  return rule
    ? { priority: rule.priority, priorityLabel: rule.label }
    : { priority: "P3", priorityLabel: "remaining source parity" };
}

function queueOrderFor(sourcePath, policy) {
  const index = policy.queueOrder.findIndex((prefix) =>
    sourcePath.startsWith(prefix)
  );
  return index === -1 ? policy.queueOrder.length : index;
}

function validatePolicy(policy) {
  if (policy.version !== 1) fail(`Unsupported policy version: ${policy.version}`);
  const duplicateMappings = policy.pathMappings
    .map(({ sourcePrefix }) => sourcePrefix)
    .filter((value, index, all) => all.indexOf(value) !== index);
  if (duplicateMappings.length > 0) {
    fail(`Duplicate source path mappings: ${duplicateMappings.join(", ")}`);
  }
  for (const approval of policy.acceptedAdaptations) {
    for (const field of [
      "sourcePath",
      "targetPath",
      "expectedSourceBlob",
      "expectedTargetBlob",
      "rationale",
      "validation",
    ]) {
      if (!approval[field]) fail(`Accepted adaptation missing ${field}`);
    }
  }
  for (const retirement of policy.retiredSourceFiles) {
    for (const field of [
      "sourcePath",
      "expectedSourceBlob",
      "rationale",
      "validation",
    ]) {
      if (!retirement[field]) fail(`Retired source file missing ${field}`);
    }
  }
  const gateIds = new Set();
  for (const gate of policy.behavioralGates) {
    for (const field of [
      "id",
      "priority",
      "status",
      "owner",
      "requirement",
      "evidence",
    ]) {
      if (!gate[field]) fail(`Behavioral gate missing ${field}`);
    }
    if (gateIds.has(gate.id)) fail(`Duplicate behavioral gate: ${gate.id}`);
    gateIds.add(gate.id);
    if (!Object.hasOwn(priorityRank, gate.priority)) {
      fail(`Unsupported behavioral gate priority: ${gate.priority}`);
    }
    if (!["failing", "in_progress", "passed"].includes(gate.status)) {
      fail(`Unsupported behavioral gate status: ${gate.status}`);
    }
  }
}

function classify(entry, targetBlob, policy) {
  const approval = policy.acceptedAdaptations.find(
    ({ sourcePath }) => sourcePath === entry.sourcePath
  );
  const retirement = policy.retiredSourceFiles.find(
    ({ sourcePath }) => sourcePath === entry.sourcePath
  );

  if (approval) {
    const currentTargetPath = entry.targetPath;
    const isCurrent =
      approval.targetPath === currentTargetPath &&
      approval.expectedSourceBlob === entry.sourceBlob &&
      approval.expectedTargetBlob === targetBlob;
    return isCurrent ? "adapted" : "approval_stale";
  }
  if (retirement) {
    const isCurrent =
      retirement.expectedSourceBlob === entry.sourceBlob && targetBlob === null;
    return isCurrent ? "retired" : "approval_stale";
  }
  if (targetBlob === null) return "missing";
  return targetBlob === entry.sourceBlob ? "exact" : "review_required";
}

function summarize(entries, targetOnly, behavioralGates) {
  const byStatus = {};
  const unresolvedByPriority = {};
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    if (["missing", "review_required", "approval_stale"].includes(entry.status)) {
      unresolvedByPriority[entry.priority] =
        (unresolvedByPriority[entry.priority] ?? 0) + 1;
    }
  }
  return {
    sourceFiles: entries.length,
    mappedTargets: new Set(entries.map(({ targetPath }) => targetPath)).size,
    targetOnlyFiles: targetOnly.length,
    unresolved: entries.filter(({ status }) =>
      ["missing", "review_required", "approval_stale"].includes(status)
    ).length,
    byStatus: Object.fromEntries(
      Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b))
    ),
    unresolvedByPriority: Object.fromEntries(
      Object.entries(unresolvedByPriority).sort(
        ([a], [b]) => priorityRank[a] - priorityRank[b]
      )
    ),
    behavioralGates: behavioralGates.length,
    unresolvedBehavioralGates: behavioralGates.filter(
      ({ status }) => status !== "passed"
    ).length,
  };
}

function buildInventoryFromSource(policy, sourceEntries) {
  const targetPaths = new Set();
  const entries = sourceEntries.map((source) => {
    const targetPath = mappedTargetPath(source.sourcePath, policy);
    if (targetPaths.has(targetPath)) {
      fail(`More than one legacy file maps to ${targetPath}`);
    }
    targetPaths.add(targetPath);
    const targetBlob = worktreeBlobHash(targetPath);
    const priority = priorityFor(source.sourcePath, policy);
    const base = { ...source, targetPath, targetBlob, ...priority };
    return {
      ...base,
      status: classify(base, targetBlob, policy),
    };
  });

  const targetOnly = currentFiles()
    .filter((targetPath) => !targetPaths.has(targetPath))
    .map((targetPath) => ({ targetPath }));

  const policyContents = readFileSync(policyPath);
  return {
    schemaVersion: 1,
    source: policy.source,
    policySha256: sha256(policyContents),
    targetTreeDigest: sha256(
      entries
        .map(({ targetPath, targetBlob }) => `${targetPath}\0${targetBlob ?? "-"}`)
        .sort()
        .join("\n")
    ),
    summary: summarize(entries, targetOnly, policy.behavioralGates),
    behavioralGates: policy.behavioralGates,
    entries,
    targetOnly,
  };
}

function rebuildInventory(policy, inventory) {
  const sourceEntries = inventory.entries.map(
    ({ mode, sourceBlob, sourcePath }) => ({ mode, sourceBlob, sourcePath })
  );
  return buildInventoryFromSource(policy, sourceEntries);
}

function unresolvedQueue(inventory, policy) {
  return inventory.entries
    .filter(({ status }) =>
      ["missing", "review_required", "approval_stale"].includes(status)
    )
    .sort((a, b) => {
      return (
        priorityRank[a.priority] - priorityRank[b.priority] ||
        queueOrderFor(a.sourcePath, policy) -
          queueOrderFor(b.sourcePath, policy) ||
        statusRank[a.status] - statusRank[b.status] ||
        a.sourcePath.localeCompare(b.sourcePath)
      );
    });
}

function markdown(inventory, policy) {
  const { summary } = inventory;
  const queue = unresolvedQueue(inventory, policy);
  const statusRows = Object.entries(summary.byStatus)
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join("\n");
  const priorityRows = ["P0", "P1", "P2", "P3"]
    .map(
      (priority) =>
        `| ${priority} | ${summary.unresolvedByPriority[priority] ?? 0} |`
    )
    .join("\n");
  const queueRows = queue
    .slice(0, 100)
    .map(
      ({ priority, status, sourcePath, targetPath }) =>
        `| ${priority} | ${status} | \`${sourcePath}\` | \`${targetPath}\` |`
    )
    .join("\n");
  const behavioralRows = [...inventory.behavioralGates]
    .sort(
      (a, b) =>
        priorityRank[a.priority] - priorityRank[b.priority] ||
        a.id.localeCompare(b.id)
    )
    .map(
      ({ priority, status, id, owner, requirement }) =>
        `| ${priority} | ${status} | \`${id}\` | \`${owner}\` | ${requirement} |`
    )
    .join("\n");

  return `<!-- Generated by scripts/poly-port-inventory.mjs. Do not edit by hand. -->
# Poly legacy → node-repo port inventory

Legacy source is pinned to \`${inventory.source.revision}\` under \`${inventory.source.treeRoot}\`. The JSON ledger beside this report is the complete, deterministic source-to-target map; this page is its human review queue.

## Contract

- \`exact\`: Git blob bytes match, including explicit package relocations.
- \`review_required\`: both files exist but differ; it is not parity until reviewed.
- \`missing\`: the legacy file has no target.
- \`adapted\`: an intentional improvement is hash-pinned in the policy with rationale and validation evidence.
- \`retired\`: removal is hash-pinned and justified in the policy.
- \`approval_stale\`: an approved source or target hash changed and must be reviewed again.
- Current-only files are recorded in JSON; they are not evidence that a legacy file was ported.

Run \`pnpm poly:port:refresh -- --legacy-repo /path/to/legacy-monorepo\` after a reviewed port checkpoint. Run \`pnpm poly:port:verify\` to prove this ledger matches the current worktree.

## Progress

| Metric | Count |
| --- | ---: |
| Legacy source files | ${summary.sourceFiles} |
| Unique mapped target paths | ${summary.mappedTargets} |
| Current-only files | ${summary.targetOnlyFiles} |
| Unresolved legacy files | ${summary.unresolved} |
| Behavioral parity gates | ${summary.behavioralGates} |
| Unresolved behavioral gates | ${summary.unresolvedBehavioralGates} |

| State | Count |
| --- | ---: |
${statusRows}

| Priority | Unresolved |
| --- | ---: |
${priorityRows}

## Behavioral parity gates

File equality is necessary but not sufficient. These gates prevent an adapted implementation from being marked complete while user-visible semantics differ from the legacy product or external ground truth.

| Priority | State | Gate | Owner | Required invariant |
| --- | --- | --- | --- | --- |
${behavioralRows || "| — | — | — | — | No behavioral gates |"}

## Prioritized port queue

The first 100 unresolved files are shown. Ordering is deterministic: product focus, missing-before-different, then path. P0 is visible dashboard/research/wallet UI parity; P1 is live trading/data-contract parity. Coordinate P1 edits with the active trading-loss diagnosis.

| Priority | State | Legacy source | Current target |
| --- | --- | --- | --- |
${queueRows || "| — | — | No unresolved files | — |"}
`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const [, , command, ...args] = process.argv;
const policy = readJson(policyPath);
validatePolicy(policy);

if (command === "refresh") {
  const repoFlag = args.indexOf("--legacy-repo");
  const legacyRepo =
    repoFlag >= 0 ? args[repoFlag + 1] : process.env.POLY_LEGACY_REPO;
  if (!legacyRepo) {
    fail("refresh requires --legacy-repo PATH or POLY_LEGACY_REPO");
  }
  const legacyTop = run("git", ["rev-parse", "--show-toplevel"], legacyRepo);
  const revision = run("git", ["rev-parse", policy.source.revision], legacyTop);
  if (revision !== policy.source.revision) {
    fail(`Policy revision must be a full commit SHA; resolved ${revision}`);
  }
  const sources = sourceFiles(
    legacyTop,
    policy.source.revision,
    policy.source.treeRoot
  );
  const inventory = buildInventoryFromSource(policy, sources);
  writeFileSync(inventoryPath, stableJson(inventory));
  writeFileSync(reportPath, markdown(inventory, policy));
  process.stdout.write(
    `refreshed ${inventory.summary.sourceFiles} legacy files; ${inventory.summary.unresolved} unresolved\n`
  );
} else if (command === "verify") {
  if (!existsSync(inventoryPath) || !existsSync(reportPath)) {
    fail("Inventory is missing; run poly:port:refresh first");
  }
  const committed = readJson(inventoryPath);
  const rebuilt = rebuildInventory(policy, committed);
  const expectedJson = stableJson(rebuilt);
  const expectedReport = markdown(rebuilt, policy);
  const problems = [];
  if (readFileSync(inventoryPath, "utf8") !== expectedJson) {
    problems.push("JSON ledger is stale");
  }
  if (readFileSync(reportPath, "utf8") !== expectedReport) {
    problems.push("Markdown report is stale");
  }
  if (problems.length > 0) {
    fail(`${problems.join("; ")}. Run poly:port:refresh.`);
  }
  process.stdout.write(
    `verified ${rebuilt.summary.sourceFiles} legacy files; ${rebuilt.summary.unresolved} unresolved\n`
  );
} else if (command === "summary") {
  const inventory = readJson(inventoryPath);
  process.stdout.write(`${JSON.stringify(inventory.summary, null, 2)}\n`);
} else {
  fail("usage: poly-port-inventory.mjs <refresh|verify|summary>");
}
