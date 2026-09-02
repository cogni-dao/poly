import { readFileSync } from "node:fs";
import { parse } from "yaml";

const CI_WORKFLOW_PATH = ".github/workflows/ci.yaml";
const PR_BUILD_WORKFLOW_PATH = ".github/workflows/pr-build.yml";
const PR_LINT_WORKFLOW_PATH = ".github/workflows/pr-lint.yaml";
const REPO_POLICY_PATH = ".cogni/repo-policy.json";

const ciWorkflow = readWorkflow(CI_WORKFLOW_PATH);
const prBuildWorkflow = readWorkflow(PR_BUILD_WORKFLOW_PATH);
const prLintWorkflow = readWorkflow(PR_LINT_WORKFLOW_PATH);
const repoPolicy = JSON.parse(readFileSync(REPO_POLICY_PATH, "utf8"));

function readWorkflow(path) {
  return parse(readFileSync(path, "utf8"));
}

function fail(path, message) {
  console.error(`${path}: ${message}`);
  process.exitCode = 1;
}

function expectEqual(path, actual, expected, label) {
  if (actual !== expected) {
    fail(path, `${label} must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}

function expectOwnKey(path, object, key, label) {
  if (!object || typeof object !== "object" || !Object.hasOwn(object, key)) {
    fail(path, `${label} must define ${key}`);
    return undefined;
  }
  return object[key];
}

function expectIncludes(path, value, fragment, label) {
  if (!String(value ?? "").includes(fragment)) {
    fail(path, `${label} must include ${JSON.stringify(fragment)}`);
  }
}

function expectStep(path, steps, name) {
  const step = steps.find((candidate) => candidate?.name === name);
  if (!step) fail(path, `steps must include ${JSON.stringify(name)}`);
  return step;
}

function expectTrigger(path, workflow, trigger) {
  const triggers = expectOwnKey(path, workflow, "on", "workflow");
  return expectOwnKey(path, triggers, trigger, "workflow triggers");
}

function expectMainPush(path, workflow) {
  const push = expectTrigger(path, workflow, "push");
  const branches = Array.isArray(push?.branches) ? push.branches : [];
  if (!branches.includes("main")) {
    fail(path, "push trigger must include main");
  }
}

function expectNoWorkflowDispatch(path, workflow) {
  const triggers = expectOwnKey(path, workflow, "on", "workflow");
  if (Object.hasOwn(triggers ?? {}, "workflow_dispatch")) {
    fail(path, "workflow must not use workflow_dispatch as launch or image evidence");
  }
}

function requiredCheckContexts(policy) {
  expectEqual(
    REPO_POLICY_PATH,
    policy?.schemaVersion,
    "cogni.node-repo-policy.v1",
    "schemaVersion"
  );
  expectEqual(
    REPO_POLICY_PATH,
    policy?.ruleset?.target,
    "default_branch",
    "ruleset.target"
  );
  expectEqual(
    REPO_POLICY_PATH,
    policy?.ruleset?.enforcement,
    "active",
    "ruleset.enforcement"
  );
  const bypassActors = policy?.ruleset?.bypassActors;
  if (!Array.isArray(bypassActors) || bypassActors.length !== 0) {
    fail(REPO_POLICY_PATH, "ruleset.bypassActors must be an empty array");
  }
  const contexts = policy?.ruleset?.requiredStatusChecks?.contexts;
  if (
    !Array.isArray(contexts) ||
    contexts.length === 0 ||
    contexts.some(
      (context) => typeof context !== "string" || context.length === 0
    ) ||
    new Set(contexts).size !== contexts.length
  ) {
    fail(
      REPO_POLICY_PATH,
      "ruleset.requiredStatusChecks.contexts must be non-empty unique strings"
    );
    return [];
  }
  return contexts;
}

// GitHub names a check run after the job's static `name` when one is present, and
// falls back to the job ID otherwise. Matching a required context against the job ID
// alone is therefore unsound: adding `name: Unit Tests` to job `unit` leaves the job
// ID intact while the emitted context becomes "Unit Tests" — the required check
// `unit` then never reports and the ruleset deadlocks the repo. Resolve the effective
// name the same way GitHub does.
function effectiveCheckName(jobId, job) {
  const declared = job?.name;
  return typeof declared === "string" && declared.length > 0 ? declared : jobId;
}

// A required context must resolve to ONE statically-known check name. Expressions are
// interpolated at run time and matrices fan one job out into `name (value)` per leg,
// so neither can be proven to emit the exact context this policy requires.
function unprovableCheckNameReason(jobId, job) {
  if (String(job?.name ?? "").includes("${{")) {
    return "declares a templated `name:` whose emitted check context cannot be resolved statically";
  }
  if (job?.strategy?.matrix !== undefined) {
    return "uses `strategy.matrix`, which emits one check per matrix leg rather than the bare context";
  }
  return null;
}

function findRequiredCheckProviders(workflows, context) {
  const providers = [];
  for (const { path, workflow } of workflows) {
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      if (effectiveCheckName(jobId, job) === context) {
        providers.push({ path, workflow, jobId, job });
      }
    }
  }
  return providers;
}

function assertRequiredChecksRunOnReviewEvents(policy, workflows) {
  for (const context of requiredCheckContexts(policy)) {
    const providers = findRequiredCheckProviders(workflows, context);
    if (providers.length !== 1) {
      // Name the near-miss explicitly: a job whose ID matches but whose `name:` has
      // been changed is the exact drift this check exists to catch, and "found 0" on
      // its own sends the reader hunting for a deleted job.
      const renamed = workflows.flatMap(({ path, workflow }) =>
        Object.entries(workflow?.jobs ?? {})
          .filter(([jobId, job]) => jobId === context && effectiveCheckName(jobId, job) !== context)
          .map(([jobId, job]) => `${path} job ${jobId} now emits ${JSON.stringify(effectiveCheckName(jobId, job))}`)
      );
      fail(
        REPO_POLICY_PATH,
        `required check ${JSON.stringify(context)} must be emitted by exactly one job; found ${providers.length}` +
          (renamed.length ? ` (${renamed.join("; ")})` : "")
      );
      continue;
    }
    const [{ path, workflow, jobId, job }] = providers;
    const unprovable = unprovableCheckNameReason(jobId, job);
    if (unprovable) {
      fail(path, `required check ${JSON.stringify(context)} ${unprovable}`);
    }
    expectTrigger(path, workflow, "pull_request");
    expectTrigger(path, workflow, "merge_group");
    const jobIf = String(job?.if ?? "");
    if (
      jobIf.includes("github.event_name") ||
      jobIf.includes("github.event.action")
    ) {
      fail(
        path,
        `required job ${JSON.stringify(context)} must not conditionally disappear for a review event`
      );
    }
  }
}

// A required context that can SKIP is a required context that can pass while nothing
// ran — GitHub scores a skipped required check as success. Any required job whose
// upstream deps are themselves optional must therefore run under a bare `always()`
// and assert those deps itself, rather than gating its own `if` on their results.
function assertRequiredChecksFailClosed(policy, workflows) {
  for (const context of requiredCheckContexts(policy)) {
    const providers = findRequiredCheckProviders(workflows, context);
    if (providers.length !== 1) continue; // already reported by the emitter check
    const [{ path, job }] = providers;
    if (!Object.hasOwn(job ?? {}, "if")) continue; // no condition: cannot skip
    const condition = String(job.if).replace(/\s+/g, " ").trim();
    if (condition === "always()") continue;
    if (condition.includes("needs.") && condition.includes(".result")) {
      fail(
        path,
        `required check ${JSON.stringify(context)} gates its own \`if\` on upstream ` +
          `results (${JSON.stringify(condition)}); it would SKIP on upstream failure and ` +
          "GitHub scores a skipped required check as SUCCESS. Use `if: always()` and " +
          "assert the upstream results in a failing step instead."
      );
      continue;
    }
    fail(
      path,
      `required check ${JSON.stringify(context)} declares a conditional \`if\` ` +
        `(${JSON.stringify(condition)}); a required check must not be skippable`
    );
  }
}

expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.name, "CI", "workflow name");
expectTrigger(CI_WORKFLOW_PATH, ciWorkflow, "pull_request");
expectTrigger(CI_WORKFLOW_PATH, ciWorkflow, "merge_group");
expectMainPush(CI_WORKFLOW_PATH, ciWorkflow);
expectNoWorkflowDispatch(CI_WORKFLOW_PATH, ciWorkflow);
expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.permissions?.contents, "read", "permissions.contents");
expectIncludes(CI_WORKFLOW_PATH, ciWorkflow?.concurrency?.group, "ci-${{ github.workflow }}-${{ github.ref }}", "concurrency.group");
expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.concurrency?.["cancel-in-progress"], true, "concurrency.cancel-in-progress");

const staticJob = ciWorkflow?.jobs?.static;
if (!staticJob) fail(CI_WORKFLOW_PATH, "jobs must include static");
const staticSteps = Array.isArray(staticJob?.steps) ? staticJob.steps : [];
expectStep(CI_WORKFLOW_PATH, staticSteps, "Install dependencies");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Build workspace packages");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Type check");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Workflow contract check");

const unitJob = ciWorkflow?.jobs?.unit;
if (!unitJob) fail(CI_WORKFLOW_PATH, "jobs must include unit");
expectEqual(CI_WORKFLOW_PATH, unitJob?.needs, "static", "jobs.unit.needs");
const unitSteps = Array.isArray(unitJob?.steps) ? unitJob.steps : [];
expectStep(CI_WORKFLOW_PATH, unitSteps, "Install dependencies");
expectStep(CI_WORKFLOW_PATH, unitSteps, "Build workspace packages");
expectStep(CI_WORKFLOW_PATH, unitSteps, "Unit + contract coverage tests");

expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.name, "PR Build", "workflow name");
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "pull_request");
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "merge_group");
expectMainPush(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow);
// MONOREPO PARITY (bug.5057): pr-build MUST support the operator's RBAC-gated
// trusted-build `workflow_dispatch` (build an approved fork PR head → flightable
// image). This is the operator dispatch path, NOT a fork self-pushing — the
// `should_push=false` fork guard below still holds. The old `expectNoWorkflowDispatch`
// here was split-brain vs the monorepo and is removed; require the trusted-build
// inputs instead so the dispatch contract can't silently drift.
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "workflow_dispatch");
{
  const dispatchInputs =
    prBuildWorkflow?.on?.workflow_dispatch?.inputs ?? {};
  for (const required of ["head_repo", "head_sha"]) {
    if (!Object.hasOwn(dispatchInputs, required)) {
      fail(
        PR_BUILD_WORKFLOW_PATH,
        `workflow_dispatch must declare the trusted-build input "${required}"`
      );
    }
  }
}
expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.permissions?.contents, "read", "permissions.contents");
expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.permissions?.packages, "write", "permissions.packages");
// cancel-in-progress must NOT cancel a push:main (publishes the deployable) or a
// trusted dispatch (each fork build keyed by its own head_sha) — same as the monorepo.
// So it is an expression, not a literal `true`; assert it is present.
if (prBuildWorkflow?.concurrency?.["cancel-in-progress"] === undefined) {
  fail(PR_BUILD_WORKFLOW_PATH, "concurrency.cancel-in-progress must be set");
}

const resolveJob = prBuildWorkflow?.jobs?.resolve;
if (!resolveJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include resolve");
const resolveSteps = Array.isArray(resolveJob?.steps) ? resolveJob.steps : [];
const sourceStep = expectStep(PR_BUILD_WORKFLOW_PATH, resolveSteps, "Resolve source metadata");
const sourceRun = String(sourceStep?.run ?? "");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, 'source_sha="$PR_HEAD_SHA"', "pull_request source SHA");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, 'source_sha="$PUSH_SHA"', "push source SHA");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "image_name=ghcr.io/${owner_lc}/${repo_lc}", "repo-owned image name");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "image_tag=sha-${source_sha}", "source SHA image tag");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "should_push=false", "fork pull_request push guard");

const detectJob = prBuildWorkflow?.jobs?.detect;
if (!detectJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include detect");
expectEqual(PR_BUILD_WORKFLOW_PATH, detectJob?.needs, "resolve", "jobs.detect.needs");
const detectSteps = Array.isArray(detectJob?.steps) ? detectJob.steps : [];
expectStep(PR_BUILD_WORKFLOW_PATH, detectSteps, "Typecheck package closure");
expectStep(PR_BUILD_WORKFLOW_PATH, detectSteps, "Detect node image targets");

const buildJob = prBuildWorkflow?.jobs?.build;
if (!buildJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include build");
if (!Array.isArray(buildJob?.needs) || buildJob.needs.join(",") !== "resolve,detect") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.build.needs must be [\"resolve\", \"detect\"]");
}
expectEqual(PR_BUILD_WORKFLOW_PATH, buildJob?.strategy?.["fail-fast"], false, "jobs.build.strategy.fail-fast");
const buildSteps = Array.isArray(buildJob?.steps) ? buildJob.steps : [];
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Checkout");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Login to GHCR");
const imageBuildStep = expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Build app image");
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  imageBuildStep?.with?.context,
  "${{ matrix.target.context }}",
  "declared artifact build context"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  imageBuildStep?.with?.file,
  "${{ matrix.target.dockerfile }}",
  "declared artifact Dockerfile"
);
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Write build fragment");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Upload build fragment");

const manifestJob = prBuildWorkflow?.jobs?.manifest;
if (!manifestJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include manifest");
if (!Array.isArray(manifestJob?.needs) || manifestJob.needs.join(",") !== "resolve,detect,build") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.manifest.needs must be [\"resolve\", \"detect\", \"build\"]");
}
const manifestSteps = Array.isArray(manifestJob?.steps) ? manifestJob.steps : [];
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Download build fragments");
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Build repo-spec contract");
const setupOrasStep = expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Set up ORAS");
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  setupOrasStep?.if,
  "needs.resolve.outputs.should_push == 'true'",
  "ORAS setup trust gate"
);
const writeManifestStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  manifestSteps,
  "Write build manifest"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  writeManifestStep?.env?.EMIT_BUNDLE,
  "${{ needs.resolve.outputs.should_push }}",
  "trusted bundle publication gate"
);
const publishBundleStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  manifestSteps,
  "Publish immutable node artifact bundle"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.if,
  "needs.resolve.outputs.should_push == 'true'",
  "OCI bundle publication trust gate"
);
expectIncludes(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.run,
  "oras push",
  "OCI bundle publisher"
);
expectIncludes(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.run,
  ":bundle-sha-${SOURCE_SHA}",
  "deterministic source-SHA bundle tag"
);
expectIncludes(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.run,
  "node-artifact-bundle.json:${PAYLOAD_MEDIA_TYPE}",
  "canonical OCI payload filename"
);
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Upload build manifest");
const uploadBundleStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  manifestSteps,
  "Upload node artifact bundle"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  uploadBundleStep?.if,
  "needs.resolve.outputs.should_push == 'true'",
  "immutable bundle upload trust gate"
);

expectEqual(PR_LINT_WORKFLOW_PATH, prLintWorkflow?.name, "Lint PR", "workflow name");
expectTrigger(PR_LINT_WORKFLOW_PATH, prLintWorkflow, "pull_request");
expectNoWorkflowDispatch(PR_LINT_WORKFLOW_PATH, prLintWorkflow);

const REQUIRED_CHECK_WORKFLOWS = [
  { path: CI_WORKFLOW_PATH, workflow: ciWorkflow },
  { path: PR_BUILD_WORKFLOW_PATH, workflow: prBuildWorkflow },
  { path: PR_LINT_WORKFLOW_PATH, workflow: prLintWorkflow },
];

assertRequiredChecksRunOnReviewEvents(repoPolicy, REQUIRED_CHECK_WORKFLOWS);
assertRequiredChecksFailClosed(repoPolicy, REQUIRED_CHECK_WORKFLOWS);
