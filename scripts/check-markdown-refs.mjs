// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/check-markdown-refs`
 * Purpose: Keep node-template Markdown in the knowledge hub: fail when Git tracks Markdown outside the bootstrap set, or when any tracked file points at a repo Markdown doc path.
 * Scope: Static analysis of `git ls-files`. Does not fetch the hub, run a test, or touch a database.
 * Invariants:
 *   - Tracked `*.md` is limited to `AGENTS.md` and `README.md` at any depth, root `CLAUDE.md`, the harness shells under `.claude/` and `.agents/`, and the vendored-code `PROVENANCE.md` (named in ALLOWED_MD).
 *   - No tracked file (outside `.context/`) names a repo Markdown doc path (`docs/.../*.md`, `work/.../*.md`); knowledge lives at a hub atom URL.
 *   - A pinned `github.com/<owner>/<repo>/blob/<40-hex sha>/...` URL is immutable evidence and is exempt.
 *   - Applied SQL migrations are immutable history (their hash is in the drizzle ledger) and are exempt.
 *   - Each EXCEPTIONS entry names one file and one path that is program data, not a doc link, and states why.
 * Side-effects: IO (runs `git ls-files`, reads tracked files).
 * Links: package.json, .github/workflows/ci.yaml, https://node-template.cognidao.org/knowledge/file-header-standard
 */

// biome-ignore-all lint/suspicious/noConsole: validator script

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// File + path pairs that are matched as data by program logic, not read as doc links.
const EXCEPTIONS = [
  {
    file: "packages/repo-spec/src/accessors.ts",
    path: "docs/guides/new-worktree-setup.md",
    why: "ride-along file-path matcher for operator PR diffs; a string literal compared with a changed-file path",
  },
  {
    file: "packages/langgraph-graphs/src/graphs/pr-manager/prompts.ts",
    path: "docs/guides/pr-management-playbook.md",
    why: "runtime prompt, separate PR",
  },
];

const ALLOWED_MD = [
  /(^|\/)AGENTS\.md$/,
  /(^|\/)README\.md$/,
  /^CLAUDE\.md$/,
  /^\.claude\//,
  /^\.agents\//,
  // Vendored upstream provenance: records the pinned upstream SHA, MIT license obligation and the
  // local diff log that make the vendored paper-trader code auditable; not hub knowledge.
  /^sidecars\/paper-trader\/vendor\/pm_trader\/PROVENANCE\.md$/,
];

const PINNED_GITHUB_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/blob\/[0-9a-f]{40}\/\S*/gi;
// A blob URL on a moving ref (main, staging, a branch) breaks when the Markdown is purged upstream.
const UNPINNED_GITHUB_DOC =
  /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/blob\/(?![0-9a-f]{40}\/)[^\s/]+\/(?:\S*\/)?(?:docs|work)\/\S*?\.md\b/gi;
const DOC_PATH =
  /(?<![A-Za-z0-9_@~./-])(?:\.{1,2}\/)*(?:[A-Za-z0-9_@-]+\/)*(?:docs|work)\/[A-Za-z0-9_./@-]*\.md\b/g;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const failures = [];

for (const file of tracked) {
  if (file.endsWith(".md") && !ALLOWED_MD.some((re) => re.test(file))) {
    failures.push(`tracked Markdown outside the bootstrap set: ${file}`);
  }
}

for (const file of tracked) {
  // The EXCEPTIONS table above must spell the one allowed path, so this file is not scanned.
  if (file.startsWith(".context/") || file === "scripts/check-markdown-refs.mjs") continue;
  // Applied migrations are immutable: rewriting a comment changes the ledgered hash.
  if (/\/migrations\/[^/]+\.sql$/.test(file)) continue;
  const abs = join(REPO_ROOT, file);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  const buf = readFileSync(abs);
  if (buf.includes(0)) continue;
  const lines = buf.toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(UNPINNED_GITHUB_DOC)) {
      failures.push(`${file}:${i + 1}: unpinned GitHub Markdown URL ${match[0]}`);
    }
    const scrubbed = lines[i].replace(PINNED_GITHUB_URL, "").replace(UNPINNED_GITHUB_DOC, "");
    for (const match of scrubbed.matchAll(DOC_PATH)) {
      const hit = match[0].replace(/^(?:\.{1,2}\/)+/, "");
      if (EXCEPTIONS.some((e) => e.file === file && hit.endsWith(e.path))) continue;
      failures.push(`${file}:${i + 1}: repo Markdown doc path ${hit}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`✗ check-markdown-refs: ${failures.length} violation(s):`);
  for (const f of failures.slice(0, 200)) console.error(`  - ${f}`);
  if (failures.length > 200) console.error(`  ... and ${failures.length - 200} more`);
  console.error(
    "Fix: link the owning hub atom (https://<node>/knowledge/<id>) or a pinned other-repo commit URL; never a repo Markdown path."
  );
  process.exit(1);
}

console.log(
  `✓ check-markdown-refs: ${tracked.length} tracked files; Markdown limited to bootstrap set; no repo Markdown doc path references.`
);
