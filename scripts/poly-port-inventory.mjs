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
const statusRank = { unresolved: 0, exact: 1, upgraded: 2, retired: 3 };
const terminalStatuses = new Set(["exact", "upgraded", "retired"]);
const resolutionOutcomes = new Set(["exact", "upgraded", "retired"]);
const gitModes = new Set(["100644", "100755", "120000"]);
const proofEnvironments = new Set(["candidate", "production"]);
const expectedMissionScope = { P0: 28, P1: 51 };

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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

export function sourceEntryDigest(entries) {
  return sha256(
    entries
      .map(
        ({ sourcePath, sourceMode, sourceBlob }) =>
          `${sourcePath}\0${sourceMode}\0${sourceBlob}`
      )
      .sort()
      .join("\n")
  );
}

function gitBlobHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function worktreeFile(relativePath, root = repoRoot) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) return { blob: null, mode: null };
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return { blob: gitBlobHash(readlinkSync(absolutePath)), mode: "120000" };
  }
  if (!stat.isFile()) return { blob: null, mode: null };
  return {
    blob: gitBlobHash(readFileSync(absolutePath)),
    mode: stat.mode & 0o111 ? "100755" : "100644",
  };
}

function currentFiles() {
  const output = runBuffer("git", ["ls-files", "-z", "--cached"]);
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))]
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
      invariant(match, `Unsupported legacy tree entry: ${record}`);
      const [, sourceMode, sourceBlob, fullPath] = match;
      invariant(
        fullPath.startsWith(prefix),
        `Legacy path escaped ${treeRoot}: ${fullPath}`
      );
      return {
        sourceMode,
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
  return rule
    ? `${rule.targetPrefix}${sourcePath.slice(rule.sourcePrefix.length)}`
    : sourcePath;
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

function validateProof(proof, context, { gate = false } = {}) {
  for (const field of ["environment", "reference"]) {
    invariant(proof?.[field], `${context} proof missing ${field}`);
  }
  invariant(
    proofEnvironments.has(proof.environment),
    `${context} proof has unsupported environment: ${proof.environment}`
  );
  if (gate) {
    invariant(
      /^[0-9a-f]{40}$/.test(proof.buildSha ?? ""),
      `${context} proof missing buildSha`
    );
    invariant(
      typeof proof.observedAt === "string" && !Number.isNaN(Date.parse(proof.observedAt)),
      `${context} proof missing observedAt`
    );
    invariant(
      /^[0-9a-f]{64}$/.test(proof.expectedTargetDigest ?? ""),
      `${context} proof missing expectedTargetDigest`
    );
    const notApplicable = new Set(proof.notApplicable ?? []);
    for (const [axis, field] of [
      ["api", "apiRefs"],
      ["ui", "uiRefs"],
      ["loki", "lokiRefs"],
      ["oracle", "oracleRefs"],
    ]) {
      invariant(Array.isArray(proof[field]), `${context} proof missing ${field}`);
      invariant(
        (proof[field].length > 0) !== notApplicable.has(axis),
        `${context} proof must provide ${field} or mark ${axis} notApplicable`
      );
      invariant(
        proof[field].every((reference) => typeof reference === "string" && reference.length > 0),
        `${context} proof has invalid ${field}`
      );
    }
  } else {
    invariant(proof.kind, `${context} proof missing kind`);
  }
}

function validateProofCoverage(proofs, environments, context, options) {
  const seen = new Set();
  for (const proof of proofs) {
    validateProof(proof, context, options);
    invariant(
      !seen.has(proof.environment),
      `${context} has duplicate ${proof.environment} proof`
    );
    seen.add(proof.environment);
  }
  for (const environment of environments) {
    invariant(
      seen.has(environment),
      `${context} is missing required ${environment} proof`
    );
  }
}

export function validatePolicy(
  policy,
  { root = repoRoot, checkContract = true } = {}
) {
  invariant(policy.version === 2, `Unsupported policy version: ${policy.version}`);
  for (const field of [
    "repository",
    "revision",
    "treeRoot",
    "treeObject",
    "fileCount",
    "entryDigest",
  ]) {
    invariant(policy.source?.[field], `Policy source missing ${field}`);
  }
  invariant(
    /^[0-9a-f]{40}$/.test(policy.source.revision),
    "Policy revision must be a full commit SHA"
  );
  invariant(
    /^[0-9a-f]{40}$/.test(policy.source.treeObject),
    "Policy treeObject must be a full Git object SHA"
  );
  invariant(
    Number.isInteger(policy.source.fileCount) && policy.source.fileCount > 0,
    "Policy source fileCount must be a positive integer"
  );
  invariant(
    /^[0-9a-f]{64}$/.test(policy.source.entryDigest),
    "Policy source entryDigest must be a SHA-256 digest"
  );
  invariant(policy.contract?.path, "Policy contract missing path");
  invariant(
    /^[0-9a-f]{64}$/.test(policy.contract?.sha256 ?? ""),
    "Policy contract missing sha256"
  );
  if (checkContract) {
    const contractPath = path.join(root, policy.contract.path);
    invariant(existsSync(contractPath), `Parity contract missing: ${policy.contract.path}`);
    invariant(
      sha256(readFileSync(contractPath)) === policy.contract.sha256,
      "Immutable parity contract hash changed"
    );
  }

  const mappingPrefixes = policy.pathMappings.map(({ sourcePrefix }) => sourcePrefix);
  invariant(
    new Set(mappingPrefixes).size === mappingPrefixes.length,
    "Duplicate source path mapping"
  );
  for (const rule of policy.priorityRules) {
    invariant(Object.hasOwn(priorityRank, rule.priority), `Bad priority ${rule.priority}`);
    invariant(rule.label && rule.prefixes?.length, `Incomplete ${rule.priority} rule`);
  }

  const groups = new Map();
  const groupedPaths = new Map();
  for (const group of policy.deliveryGroups ?? []) {
    for (const field of ["id", "label", "behaviorExpectation"]) {
      invariant(group[field], `Delivery group missing ${field}`);
    }
    invariant(!groups.has(group.id), `Duplicate delivery group: ${group.id}`);
    groups.set(group.id, group);
    invariant(group.sourcePaths?.length, `${group.id} has no source paths`);
    invariant(
      group.requiredProofEnvironments?.length,
      `${group.id} has no proof environments`
    );
    for (const environment of group.requiredProofEnvironments) {
      invariant(
        proofEnvironments.has(environment),
        `${group.id} has unsupported proof environment: ${environment}`
      );
    }
    for (const sourcePath of group.sourcePaths) {
      invariant(
        !groupedPaths.has(sourcePath),
        `${sourcePath} belongs to both ${groupedPaths.get(sourcePath)} and ${group.id}`
      );
      groupedPaths.set(sourcePath, group.id);
    }
  }

  const resolutions = new Set();
  for (const resolution of policy.resolutions ?? []) {
    const context = `Resolution ${resolution.sourcePath ?? "<unknown>"}`;
    for (const field of [
      "sourcePath",
      "deliveryGroup",
      "outcome",
      "source",
      "rationale",
      "behaviorExpectation",
      "proofs",
    ]) {
      invariant(resolution[field], `${context} missing ${field}`);
    }
    invariant(!resolutions.has(resolution.sourcePath), `${context} is duplicated`);
    resolutions.add(resolution.sourcePath);
    invariant(
      groupedPaths.get(resolution.sourcePath) === resolution.deliveryGroup,
      `${context} is orphaned from delivery group ${resolution.deliveryGroup}`
    );
    invariant(resolutionOutcomes.has(resolution.outcome), `${context} has bad outcome`);
    invariant(
      /^[0-9a-f]{40}$/.test(resolution.source.blob ?? "") &&
        gitModes.has(resolution.source.mode),
      `${context} has invalid source pin`
    );
    if (resolution.outcome === "retired") {
      invariant(resolution.target === null, `${context} retirement target must be null`);
    } else {
      invariant(
        resolution.target?.path &&
          /^[0-9a-f]{40}$/.test(resolution.target?.blob ?? "") &&
          gitModes.has(resolution.target?.mode),
        `${context} has invalid target pin`
      );
    }
    validateProofCoverage(
      resolution.proofs,
      groups.get(resolution.deliveryGroup).requiredProofEnvironments,
      context
    );
  }

  const gateIds = new Set();
  for (const gate of policy.behavioralGates ?? []) {
    const context = `Behavioral gate ${gate.id ?? "<unknown>"}`;
    for (const field of [
      "id",
      "priority",
      "deliveryGroup",
      "requirement",
      "coveredSourcePaths",
      "proofs",
    ]) {
      invariant(gate[field], `${context} missing ${field}`);
    }
    invariant(!Object.hasOwn(gate, "status"), `${context} status must be derived`);
    invariant(!gateIds.has(gate.id), `Duplicate behavioral gate: ${gate.id}`);
    gateIds.add(gate.id);
    invariant(Object.hasOwn(priorityRank, gate.priority), `${context} has bad priority`);
    invariant(groups.has(gate.deliveryGroup), `${context} has unknown delivery group`);
    invariant(gate.coveredSourcePaths.length > 0, `${context} covers no paths`);
    for (const sourcePath of gate.coveredSourcePaths) {
      invariant(
        groupedPaths.get(sourcePath) === gate.deliveryGroup,
        `${context} covers ${sourcePath} outside ${gate.deliveryGroup}`
      );
    }
    const gateProofEnvironments = new Set();
    for (const proof of gate.proofs) {
      validateProof(proof, context, { gate: true });
      invariant(
        !gateProofEnvironments.has(proof.environment),
        `${context} has duplicate ${proof.environment} proof`
      );
      gateProofEnvironments.add(proof.environment);
    }
  }
  return { groups, groupedPaths };
}

function resolutionByPath(policy) {
  return new Map(policy.resolutions.map((resolution) => [resolution.sourcePath, resolution]));
}

export function classifyEntry(entry, target, resolution, deliveryGroup) {
  if (!resolution) {
    if (deliveryGroup) {
      return {
        status: "unresolved",
        unresolvedReason:
          target.blob === null
            ? "missing"
            : target.blob === entry.sourceBlob && target.mode === entry.sourceMode
              ? "resolution_required"
              : "review_required",
      };
    }
    if (target.blob === null) {
      return { status: "unresolved", unresolvedReason: "missing" };
    }
    return target.blob === entry.sourceBlob && target.mode === entry.sourceMode
      ? { status: "exact", unresolvedReason: null }
      : { status: "unresolved", unresolvedReason: "review_required" };
  }

  const sourcePinCurrent =
    resolution.source.blob === entry.sourceBlob &&
    resolution.source.mode === entry.sourceMode;
  if (!sourcePinCurrent) {
    return { status: "unresolved", unresolvedReason: "approval_stale" };
  }
  if (resolution.outcome === "retired") {
    if (target.blob !== null || target.mode !== null) {
      return { status: "unresolved", unresolvedReason: "approval_stale" };
    }
    return { status: "retired", unresolvedReason: null };
  }
  if (
    resolution.target.path !== entry.targetPath ||
    resolution.target.blob !== target.blob ||
    resolution.target.mode !== target.mode
  ) {
    return { status: "unresolved", unresolvedReason: "approval_stale" };
  }
  const byteAndModeExact =
    target.blob === entry.sourceBlob && target.mode === entry.sourceMode;
  if (
    (resolution.outcome === "exact" && !byteAndModeExact) ||
    (resolution.outcome === "upgraded" && byteAndModeExact)
  ) {
    return { status: "unresolved", unresolvedReason: "approval_stale" };
  }
  return { status: resolution.outcome, unresolvedReason: null };
}

export function coveredTargetsDigest(sourcePaths, entries) {
  const byPath = new Map(entries.map((entry) => [entry.sourcePath, entry]));
  return sha256(
    sourcePaths
      .map((sourcePath) => {
        const entry = byPath.get(sourcePath);
        invariant(entry, `Gate coverage path is missing: ${sourcePath}`);
        return `${sourcePath}\0${entry.targetPath}\0${entry.targetMode ?? "-"}\0${entry.targetBlob ?? "-"}`;
      })
      .sort()
      .join("\n")
  );
}

export function deriveBehavioralGates(policy, entries) {
  const groups = new Map(policy.deliveryGroups.map((group) => [group.id, group]));
  return policy.behavioralGates.map((gate) => {
    const currentTargetDigest = coveredTargetsDigest(gate.coveredSourcePaths, entries);
    const group = groups.get(gate.deliveryGroup);
    const currentProofs = gate.proofs.filter(
      (proof) => proof.expectedTargetDigest === currentTargetDigest
    );
    const currentEnvironments = new Set(
      currentProofs.map((proof) => proof.environment)
    );
    const missing = group.requiredProofEnvironments.filter(
      (environment) => !currentEnvironments.has(environment)
    );
    return {
      ...gate,
      currentTargetDigest,
      status: missing.length === 0 ? "passed" : "unresolved",
      unresolvedReason:
        missing.length === 0
          ? null
          : gate.proofs.length === 0
            ? "proof_missing"
            : "proof_stale_or_incomplete",
    };
  });
}

function summarize(entries, targetOnly, behavioralGates, deliveryGroups) {
  const byStatus = {};
  const unresolvedByPriority = {};
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    if (entry.status === "unresolved") {
      unresolvedByPriority[entry.priority] =
        (unresolvedByPriority[entry.priority] ?? 0) + 1;
    }
  }
  const missionEntries = entries.filter(({ deliveryGroup }) => deliveryGroup);
  return {
    sourceFiles: entries.length,
    mappedTargets: new Set(entries.map(({ targetPath }) => targetPath)).size,
    targetOnlyFiles: targetOnly.length,
    unresolved: entries.filter(({ status }) => status === "unresolved").length,
    byStatus: Object.fromEntries(
      Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b))
    ),
    unresolvedByPriority: Object.fromEntries(
      Object.entries(unresolvedByPriority).sort(
        ([a], [b]) => priorityRank[a] - priorityRank[b]
      )
    ),
    missionFiles: missionEntries.length,
    missionResolved: missionEntries.filter(({ status }) => terminalStatuses.has(status))
      .length,
    deliveryGroups: deliveryGroups.length,
    behavioralGates: behavioralGates.length,
    unresolvedBehavioralGates: behavioralGates.filter(
      ({ status }) => status !== "passed"
    ).length,
  };
}

function validateMissionScope(policy, entries) {
  const byPath = new Map(entries.map((entry) => [entry.sourcePath, entry]));
  const grouped = policy.deliveryGroups.flatMap((group) =>
    group.sourcePaths.map((sourcePath) => ({ sourcePath, group: group.id }))
  );
  const counts = { P0: 0, P1: 0 };
  for (const { sourcePath, group } of grouped) {
    const entry = byPath.get(sourcePath);
    invariant(entry, `${group} contains orphaned source path: ${sourcePath}`);
    invariant(
      entry.priority === "P0" || entry.priority === "P1",
      `${group} contains non-P0/P1 path: ${sourcePath}`
    );
    counts[entry.priority] += 1;
  }
  for (const priority of ["P0", "P1"]) {
    invariant(
      counts[priority] === expectedMissionScope[priority],
      `Mission ${priority} scope is ${counts[priority]}, expected ${expectedMissionScope[priority]}`
    );
  }
  for (const resolution of policy.resolutions) {
    invariant(
      byPath.has(resolution.sourcePath),
      `Resolution source is absent from the pinned tree: ${resolution.sourcePath}`
    );
  }
}

export function buildInventoryFromSource(policy, sourceEntries, options = {}) {
  const { groupedPaths } = validatePolicy(policy, options);
  invariant(
    sourceEntries.length === policy.source.fileCount,
    `Legacy source contains ${sourceEntries.length} files, expected ${policy.source.fileCount}`
  );
  invariant(
    sourceEntryDigest(sourceEntries) === policy.source.entryDigest,
    "Legacy source entry digest differs from the pinned path+mode+blob manifest"
  );
  const uniqueSourcePaths = new Set(sourceEntries.map(({ sourcePath }) => sourcePath));
  invariant(uniqueSourcePaths.size === sourceEntries.length, "Duplicate legacy source path");
  const resolutions = resolutionByPath(policy);
  const targetPaths = new Set();
  const entries = sourceEntries.map((source) => {
    const targetPath = mappedTargetPath(source.sourcePath, policy);
    invariant(!targetPaths.has(targetPath), `More than one legacy file maps to ${targetPath}`);
    targetPaths.add(targetPath);
    const target = worktreeFile(targetPath, options.root ?? repoRoot);
    const priority = priorityFor(source.sourcePath, policy);
    const deliveryGroup = groupedPaths.get(source.sourcePath) ?? null;
    const base = {
      ...source,
      targetPath,
      targetBlob: target.blob,
      targetMode: target.mode,
      ...priority,
      deliveryGroup,
    };
    const result = classifyEntry(
      base,
      target,
      resolutions.get(source.sourcePath),
      deliveryGroup
    );
    const resolution = resolutions.get(source.sourcePath);
    return {
      ...base,
      ...result,
      resolution: resolution
        ? {
            rationale: resolution.rationale,
            behaviorExpectation: resolution.behaviorExpectation,
            proofs: resolution.proofs,
          }
        : null,
    };
  });
  validateMissionScope(policy, entries);

  const targetOnly = currentFiles()
    .filter((targetPath) => !targetPaths.has(targetPath))
    .map((targetPath) => ({ targetPath }));
  const behavioralGates = deriveBehavioralGates(policy, entries);
  const deliveryGroups = policy.deliveryGroups.map((group) => {
    const groupEntries = entries.filter(({ deliveryGroup }) => deliveryGroup === group.id);
    const groupGates = behavioralGates.filter(
      ({ deliveryGroup }) => deliveryGroup === group.id
    );
    return {
      id: group.id,
      label: group.label,
      behaviorExpectation: group.behaviorExpectation,
      requiredProofEnvironments: group.requiredProofEnvironments,
      files: groupEntries.length,
      resolved: groupEntries.filter(({ status }) => terminalStatuses.has(status)).length,
      gates: groupGates.length,
      gatesPassed: groupGates.filter(({ status }) => status === "passed").length,
    };
  });

  return {
    schemaVersion: 2,
    source: policy.source,
    contract: policy.contract,
    policySha256: sha256(readFileSync(options.policyPath ?? policyPath)),
    targetTreeDigest: sha256(
      entries
        .map(
          ({ targetPath, targetBlob, targetMode }) =>
            `${targetPath}\0${targetMode ?? "-"}\0${targetBlob ?? "-"}`
        )
        .sort()
        .join("\n")
    ),
    summary: summarize(entries, targetOnly, behavioralGates, deliveryGroups),
    deliveryGroups,
    behavioralGates,
    entries,
    targetOnly,
  };
}

function rebuildInventory(policy, inventory) {
  invariant(inventory.schemaVersion === 2, "Inventory schema must be v2");
  invariant(
    JSON.stringify(inventory.source) === JSON.stringify(policy.source),
    "Inventory source pin differs from policy"
  );
  const sourceEntries = inventory.entries.map(
    ({ sourceMode, sourceBlob, sourcePath }) => ({
      sourceMode,
      sourceBlob,
      sourcePath,
    })
  );
  return buildInventoryFromSource(policy, sourceEntries);
}

function sortedEntries(entries, policy) {
  return [...entries].sort(
    (a, b) =>
      priorityRank[a.priority] - priorityRank[b.priority] ||
      queueOrderFor(a.sourcePath, policy) - queueOrderFor(b.sourcePath, policy) ||
      statusRank[a.status] - statusRank[b.status] ||
      a.sourcePath.localeCompare(b.sourcePath)
  );
}

export function markdown(inventory, policy) {
  const { summary } = inventory;
  const statusRows = ["exact", "upgraded", "retired", "unresolved"]
    .map((status) => `| ${status} | ${summary.byStatus[status] ?? 0} |`)
    .join("\n");
  const priorityRows = ["P0", "P1", "P2", "P3"]
    .map(
      (priority) =>
        `| ${priority} | ${summary.unresolvedByPriority[priority] ?? 0} |`
    )
    .join("\n");
  const deliveryRows = inventory.deliveryGroups
    .map(
      (group) =>
        `| \`${group.id}\` | ${group.resolved}/${group.files} | ${group.gatesPassed}/${group.gates} | ${group.label} |`
    )
    .join("\n");
  const behavioralRows = [...inventory.behavioralGates]
    .sort(
      (a, b) =>
        priorityRank[a.priority] - priorityRank[b.priority] ||
        a.id.localeCompare(b.id)
    )
    .map(
      ({ priority, status, id, deliveryGroup, requirement }) =>
        `| ${priority} | ${status} | \`${id}\` | \`${deliveryGroup}\` | ${requirement} |`
    )
    .join("\n");
  const fileRows = sortedEntries(inventory.entries, policy)
    .map(
      (entry) =>
        `| ${entry.priority} | ${entry.status} | ${entry.unresolvedReason ?? "—"} | ${entry.deliveryGroup ? `\`${entry.deliveryGroup}\`` : "—"} | \`${entry.sourceMode}\` | \`${entry.sourceBlob}\` | \`${entry.sourcePath}\` | ${entry.targetMode ? `\`${entry.targetMode}\`` : "—"} | ${entry.targetBlob ? `\`${entry.targetBlob}\`` : "—"} | \`${entry.targetPath}\` |`
    )
    .join("\n");

  return `<!-- Generated by scripts/poly-port-inventory.mjs. Do not edit by hand. -->
# Poly legacy → node-repo port inventory

Legacy source is pinned to \`${inventory.source.revision}\`, subtree \`${inventory.source.treeObject}\`, under \`${inventory.source.treeRoot}\` (${inventory.source.fileCount} files). The immutable completion boundary is [poly-parity-contract.md](./poly-parity-contract.md).

## Resolution contract

- \`exact\`, \`upgraded\`, and \`retired\` are terminal only when the v2 policy's structured resolution and proof requirements are satisfied for mission files.
- \`unresolved\` covers missing targets, unreviewed differences, absent resolution records, and incomplete or stale behavior evidence.
- Source and target Git blobs **and file modes** are pinned. Drift invalidates a resolution.
- Gate status is derived from candidate/production proof records and the digest of every covered target; it is never hand-authored.
- Current-only files remain recorded in JSON and do not prove a legacy file was ported.

Run \`pnpm poly:port:verify\` for deterministic ledger integrity, \`pnpm poly:port:check-group -- GROUP\` for one lane, and \`pnpm poly:port:complete -- --through P1\` for the locked mission gate.

## Progress

| Metric | Count |
| --- | ---: |
| Legacy source files | ${summary.sourceFiles} |
| Unique mapped target paths | ${summary.mappedTargets} |
| Current-only files | ${summary.targetOnlyFiles} |
| Unresolved legacy files | ${summary.unresolved} |
| P0/P1 mission files resolved | ${summary.missionResolved}/${summary.missionFiles} |
| Behavioral gates passed | ${summary.behavioralGates - summary.unresolvedBehavioralGates}/${summary.behavioralGates} |

| State | Count |
| --- | ---: |
${statusRows}

| Priority | Unresolved |
| --- | ---: |
${priorityRows}

## Delivery groups

| Group | Files resolved | Gates passed | Outcome |
| --- | ---: | ---: | --- |
${deliveryRows}

## Behavioral parity gates

| Priority | State | Gate | Delivery group | Required invariant |
| --- | --- | --- | --- | --- |
${behavioralRows || "| — | — | — | — | No behavioral gates |"}

## Complete legacy file table

All ${summary.sourceFiles} files are shown. Ordering is deterministic: priority, Pareto queue, state, then source path. P2/P3 remain visible even though the current completion gate stops after P1.

| Priority | State | Unresolved reason | Delivery group | Source mode | Source blob | Legacy source | Target mode | Target blob | Current target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${fileRows}
`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function verifiedInventory(policy) {
  invariant(existsSync(inventoryPath) && existsSync(reportPath), "Inventory is missing");
  const committed = readJson(inventoryPath);
  const rebuilt = rebuildInventory(policy, committed);
  const problems = [];
  if (readFileSync(inventoryPath, "utf8") !== stableJson(rebuilt)) {
    problems.push("JSON ledger is stale");
  }
  if (readFileSync(reportPath, "utf8") !== markdown(rebuilt, policy)) {
    problems.push("Markdown report is stale");
  }
  const staleApprovals = rebuilt.entries.filter(
    ({ unresolvedReason }) => unresolvedReason === "approval_stale"
  );
  if (staleApprovals.length > 0) {
    problems.push(
      `stale approvals: ${staleApprovals.map(({ sourcePath }) => sourcePath).join(", ")}`
    );
  }
  invariant(problems.length === 0, `${problems.join("; ")}. Run poly:port:refresh.`);
  return rebuilt;
}

export function groupProblems(inventory, groupId) {
  const group = inventory.deliveryGroups.find(({ id }) => id === groupId);
  invariant(group, `Unknown delivery group: ${groupId}`);
  const problems = inventory.entries
    .filter(({ deliveryGroup, status }) => deliveryGroup === groupId && status === "unresolved")
    .map(({ sourcePath, unresolvedReason }) => `${sourcePath}: ${unresolvedReason}`);
  problems.push(
    ...inventory.behavioralGates
      .filter(({ deliveryGroup, status }) => deliveryGroup === groupId && status !== "passed")
      .map(({ id, unresolvedReason }) => `${id}: ${unresolvedReason}`)
  );
  return problems;
}

export function completionProblems(inventory, through) {
  invariant(Object.hasOwn(priorityRank, through), `Unsupported priority: ${through}`);
  const ceiling = priorityRank[through];
  const problems = inventory.entries
    .filter(
      ({ priority, status }) =>
        priorityRank[priority] <= ceiling && status === "unresolved"
    )
    .map(({ sourcePath, unresolvedReason }) => `${sourcePath}: ${unresolvedReason}`);
  problems.push(
    ...inventory.behavioralGates
      .filter(
        ({ priority, status }) =>
          priorityRank[priority] <= ceiling && status !== "passed"
      )
      .map(({ id, unresolvedReason }) => `${id}: ${unresolvedReason}`)
  );
  return problems;
}

export function regressionProblems(base, current) {
  const problems = [];
  if (JSON.stringify(base.source) !== JSON.stringify(current.source)) {
    problems.push("source pin changed");
  }
  if (JSON.stringify(base.contract) !== JSON.stringify(current.contract)) {
    problems.push("immutable contract path or hash changed");
  }
  const currentByPath = new Map(current.entries.map((entry) => [entry.sourcePath, entry]));
  for (const oldEntry of base.entries) {
    const newEntry = currentByPath.get(oldEntry.sourcePath);
    if (!newEntry) {
      problems.push(`source path removed: ${oldEntry.sourcePath}`);
      continue;
    }
    if (
      priorityRank[oldEntry.priority] <= priorityRank.P1 &&
      oldEntry.priority !== newEntry.priority
    ) {
      problems.push(`P0/P1 priority changed: ${oldEntry.sourcePath}`);
    }
    if (oldEntry.deliveryGroup && oldEntry.deliveryGroup !== newEntry.deliveryGroup) {
      problems.push(`delivery group changed: ${oldEntry.sourcePath}`);
    }
    if (terminalStatuses.has(oldEntry.status) && !terminalStatuses.has(newEntry.status)) {
      problems.push(`terminal resolution regressed: ${oldEntry.sourcePath}`);
    }
  }
  const currentGate = new Map(current.behavioralGates.map((gate) => [gate.id, gate]));
  for (const gate of base.behavioralGates) {
    if (gate.status === "passed" && currentGate.get(gate.id)?.status !== "passed") {
      problems.push(`behavioral gate regressed: ${gate.id}`);
    }
  }
  return problems;
}

function flagValue(args, flag) {
  const clean = args.filter((arg) => arg !== "--");
  const index = clean.indexOf(flag);
  return index >= 0 ? clean[index + 1] : null;
}

function positional(args) {
  return args.filter((arg) => arg !== "--" && !arg.startsWith("--"));
}

function main() {
  const [, , command, ...args] = process.argv;
  const policy = readJson(policyPath);
  validatePolicy(policy);

  if (command === "refresh") {
    const legacyRepo = flagValue(args, "--legacy-repo") ?? process.env.POLY_LEGACY_REPO;
    invariant(legacyRepo, "refresh requires --legacy-repo PATH or POLY_LEGACY_REPO");
    const legacyTop = run("git", ["rev-parse", "--show-toplevel"], legacyRepo);
    const revision = run("git", ["rev-parse", policy.source.revision], legacyTop);
    invariant(revision === policy.source.revision, "Policy revision did not resolve exactly");
    const treeObject = run(
      "git",
      ["rev-parse", `${policy.source.revision}:${policy.source.treeRoot}`],
      legacyTop
    );
    invariant(
      treeObject === policy.source.treeObject,
      `Legacy subtree is ${treeObject}, expected ${policy.source.treeObject}`
    );
    const inventory = buildInventoryFromSource(
      policy,
      sourceFiles(legacyTop, policy.source.revision, policy.source.treeRoot)
    );
    writeFileSync(inventoryPath, stableJson(inventory));
    writeFileSync(reportPath, markdown(inventory, policy));
    process.stdout.write(
      `refreshed ${inventory.summary.sourceFiles} legacy files; mission ${inventory.summary.missionResolved}/${inventory.summary.missionFiles}; ${inventory.summary.unresolved} unresolved\n`
    );
    return;
  }

  if (command === "verify") {
    const inventory = verifiedInventory(policy);
    process.stdout.write(
      `verified ${inventory.summary.sourceFiles} legacy files; mission ${inventory.summary.missionResolved}/${inventory.summary.missionFiles}; ${inventory.summary.unresolved} unresolved\n`
    );
    return;
  }

  if (command === "summary") {
    process.stdout.write(`${JSON.stringify(readJson(inventoryPath).summary, null, 2)}\n`);
    return;
  }

  if (command === "regression") {
    const baseRef = flagValue(args, "--base");
    invariant(baseRef, "regression requires --base REF");
    const current = verifiedInventory(policy);
    const base = JSON.parse(
      run("git", ["show", `${baseRef}:docs/porting/poly-port-inventory.json`])
    );
    if (base.schemaVersion !== 2) {
      process.stdout.write(`verified current inventory; ${baseRef} predates schema v2\n`);
      return;
    }
    const problems = regressionProblems(base, current);
    invariant(problems.length === 0, `Parity regression:\n${problems.join("\n")}`);
    process.stdout.write(`no parity regression against ${baseRef}\n`);
    return;
  }

  if (command === "check-group") {
    const [groupId] = positional(args);
    invariant(groupId, "check-group requires GROUP");
    const inventory = verifiedInventory(policy);
    const problems = groupProblems(inventory, groupId);
    invariant(problems.length === 0, `${groupId} is incomplete:\n${problems.join("\n")}`);
    process.stdout.write(`${groupId} is complete\n`);
    return;
  }

  if (command === "complete") {
    const through = flagValue(args, "--through");
    invariant(through, "complete requires --through P0|P1|P2|P3");
    const inventory = verifiedInventory(policy);
    const problems = completionProblems(inventory, through);
    invariant(problems.length === 0, `Parity is incomplete through ${through}:\n${problems.join("\n")}`);
    const lowerPriorityRemaining = inventory.entries.filter(
      ({ priority, status }) =>
        priorityRank[priority] > priorityRank[through] && status === "unresolved"
    ).length;
    process.stdout.write(
      `parity complete through ${through}; ${lowerPriorityRemaining} lower-priority files remain visible\n`
    );
    return;
  }

  throw new Error(
    "usage: poly-port-inventory.mjs <refresh|verify|summary|regression|check-group|complete>"
  );
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
