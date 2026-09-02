// Self-tests for check-node-ci-workflow.mjs.
//
// WHY THIS FILE EXISTS: the checker's whole purpose is to prove that every context
// named in .cogni/repo-policy.json is actually emitted, on review events, by exactly
// one job that cannot skip. A checker that silently stops catching drift is worse than
// no checker — it reports "protected" while a spawned node's required check never
// reports and its default branch deadlocks. A green run against the current tree
// proves nothing about that; only a mutation that MUST fail does.
//
// Each case mutates a throwaway copy of the real workflow/policy files and asserts the
// checker exits non-zero with a recognisable message.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-node-ci-workflow.mjs");
const FILES = [
  ".github/workflows/ci.yaml",
  ".github/workflows/pr-build.yml",
  ".github/workflows/pr-lint.yaml",
  ".cogni/repo-policy.json",
];

function runCheckerOn(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "node-ci-policy-"));
  for (const file of FILES) {
    cpSync(join(REPO_ROOT, file), join(dir, file), { recursive: true });
  }
  mutate({
    read: (file) => readFileSync(join(dir, file), "utf8"),
    write: (file, text) => writeFileSync(join(dir, file), text),
  });
  // The checker resolves its inputs relative to CWD, so running it from the fixture
  // dir points it at the mutated copies while `yaml` still resolves from the repo.
  const result = spawnSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const edit = (file, from, to) => ({ read, write }) => {
  const before = read(file);
  if (!before.includes(from)) throw new Error(`fixture anchor missing in ${file}: ${from}`);
  write(file, before.replace(from, to));
};

const CASES = [
  {
    name: "baseline tree passes",
    mutate: () => {},
    expectExit: 0,
  },
  {
    name: "renaming a required job breaks the emitted context (the deadlock case)",
    mutate: edit(".github/workflows/ci.yaml", "\n  unit:\n", "\n  unit:\n    name: Unit Tests\n"),
    expectExit: 1,
    expectMatch: /required check "unit" must be emitted by exactly one job/,
  },
  {
    name: "a templated job name cannot be statically resolved",
    mutate: edit(".github/workflows/ci.yaml", "\n  static:\n", "\n  static:\n    name: static-${{ github.event_name }}\n"),
    expectExit: 1,
    expectMatch: /required check "static"/,
  },
  {
    name: "a matrix on a required job fans the context out per leg",
    mutate: edit(".github/workflows/ci.yaml", "\n  component:\n", "\n  component:\n    strategy:\n      matrix:\n        shard: [1, 2]\n"),
    expectExit: 1,
    expectMatch: /strategy\.matrix/,
  },
  {
    name: "a required check gated on upstream results can skip, and skip scores as success",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "  manifest:\n    needs: [resolve, detect, build]\n    if: always()",
      "  manifest:\n    needs: [resolve, detect, build]\n    if: |\n      always() &&\n      needs.detect.result == 'success'"
    ),
    expectExit: 1,
    expectMatch: /scores a skipped required check as SUCCESS/,
  },
  {
    name: "a policy context with no emitting job at all is rejected",
    mutate: edit(".cogni/repo-policy.json", '"manifest"]', '"manifest", "nonexistent-check"]'),
    expectExit: 1,
    expectMatch: /required check "nonexistent-check"/,
  },
];

let failed = 0;
for (const testCase of CASES) {
  const { code, output } = runCheckerOn(testCase.mutate);
  const exitOk = code === testCase.expectExit;
  const matchOk = !testCase.expectMatch || testCase.expectMatch.test(output);
  if (exitOk && matchOk) {
    console.log(`ok   ${testCase.name}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL ${testCase.name}`);
  console.error(`     expected exit ${testCase.expectExit}, got ${code}`);
  if (!matchOk) console.error(`     expected output to match ${testCase.expectMatch}`);
  console.error(output.replace(/^/gm, "     | "));
}

if (failed > 0) {
  console.error(`\n${failed} of ${CASES.length} self-tests failed`);
  process.exit(1);
}
console.log(`\nall ${CASES.length} self-tests passed`);
