import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const CI_WORKFLOW_PATH = ".github/workflows/ci.yaml";
const CI_ACTION_PATH = ".github/actions/node-ci/action.yml";
const PR_BUILD_WORKFLOW_PATH = ".github/workflows/pr-build.yml";
const PR_LINT_WORKFLOW_PATH = ".github/workflows/pr-lint.yaml";
const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-packages.yml";
const REPO_POLICY_PATH = ".cogni/repo-policy.json";
const CONTRACT_INSTALL_COMMAND =
  "pnpm --filter @cogni/repo-spec... install --frozen-lockfile --ignore-scripts --config.dedupe-peer-dependents=false";
const MAIN_CACHE_EXPORT =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && format('type=gha,mode=max,scope=node-template-{0}', matrix.target.artifact) || '' }}";

// node-template carries the action file; a fleet node pins the action by SHA and has no such file. The
// node-template-shaped pr-build checks run only in the template tree (one signal, the same one the
// self-test uses). The publish-lane checks run wherever publish-packages.yml exists, so they cannot be
// switched off by removing the action directory and repointing the caller to a remote SHA.
const IS_TEMPLATE = existsSync(CI_ACTION_PATH);
const HAS_PUBLISH_WORKFLOW = IS_TEMPLATE || existsSync(PUBLISH_WORKFLOW_PATH);

const ciWorkflow = readWorkflow(CI_WORKFLOW_PATH);
const prBuildWorkflow = readWorkflow(PR_BUILD_WORKFLOW_PATH);
const prLintWorkflow = readWorkflow(PR_LINT_WORKFLOW_PATH);
const publishWorkflow = HAS_PUBLISH_WORKFLOW ? readWorkflow(PUBLISH_WORKFLOW_PATH) : undefined;
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

// These jobs consume one contract; required CI owns the full app/test closure.
function expectContractInstall(steps, jobName) {
  const install = expectStep(PR_BUILD_WORKFLOW_PATH, steps, "Install");
  expectEqual(
    PR_BUILD_WORKFLOW_PATH,
    install?.run,
    CONTRACT_INSTALL_COMMAND,
    `${jobName} frozen contract install`
  );
  const node = expectStep(PR_BUILD_WORKFLOW_PATH, steps, "Set up Node");
  for (const key of ["cache", "cache-dependency-path"]) {
    if (Object.hasOwn(node?.with ?? {}, key)) {
      fail(PR_BUILD_WORKFLOW_PATH, `${jobName} must not hydrate a broad Node cache`);
    }
  }
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
      // A job that calls a reusable workflow reports `<this job> / <called job>`, never the bare
      // name, so it cannot provide a bare required context (story.0052).
      if (typeof job?.uses === "string") continue;
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
          (renamed.length ? ` (${renamed.join("; ")})` : "") +
          " (a job that calls a reusable workflow reports `<job> / <called job>`, never the bare context)"
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

// ---------------------------------------------------------------------------------------------
// Required lanes (story.0052). ci.yaml is a thin caller: each required job checks out and runs
// the node-ci composite action with `lane: <job id>`. The action owns the steps, so this file
// pins both halves: the caller shape here, the lane behaviour in the action below.
// ---------------------------------------------------------------------------------------------
const LANES = ["static", "unit", "component"];
const CI_ACTION_LOCAL = "./.github/actions/node-ci";
const CI_ACTION_PINNED = /^cogni-dao\/node-template\/\.github\/actions\/node-ci@[0-9a-f]{40}$/;

for (const lane of LANES) {
  const job = ciWorkflow?.jobs?.[lane];
  if (!job) {
    fail(CI_WORKFLOW_PATH, `jobs must include ${lane}`);
    continue;
  }
  // The lanes run in PARALLEL: each does its own install and build, so gating one on another
  // only serialised the fast gate onto the critical path.
  if (Object.hasOwn(job, "needs")) {
    fail(CI_WORKFLOW_PATH, `jobs.${lane} must run in parallel (no \`needs\`); got ${JSON.stringify(job.needs)}`);
  }
  // A required job that cannot fail reports green whatever its steps did.
  if (Object.hasOwn(job, "continue-on-error")) {
    fail(CI_WORKFLOW_PATH, `jobs.${lane} must not set continue-on-error: it is a required check`);
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const checkout = steps.find((step) => String(step?.uses ?? "").startsWith("actions/checkout@"));
  if (checkout?.with?.["fetch-depth"] !== 0) {
    fail(CI_WORKFLOW_PATH, `${lane} must check out with fetch-depth: 0 (the classifier diffs a PR against its base)`);
  }
  const actionSteps = steps.filter((step) => /(^|\/)\.github\/actions\/node-ci(@|$)/.test(String(step?.uses ?? "")));
  if (actionSteps.length !== 1) {
    fail(CI_WORKFLOW_PATH, `${lane} must run the node-ci action exactly once; found ${actionSteps.length}`);
    continue;
  }
  const [action] = actionSteps;
  // A pin is a full commit SHA: a tag or branch is mutable, so a moved ref would change CI under a
  // node that never edited its workflow. node-template, the reference consumer, uses the local path.
  if (action.uses !== CI_ACTION_LOCAL && !CI_ACTION_PINNED.test(action.uses)) {
    fail(
      CI_WORKFLOW_PATH,
      `${lane} must call ${CI_ACTION_LOCAL} or cogni-dao/node-template/.github/actions/node-ci@<40-char commit SHA>; got ${JSON.stringify(action.uses)}`
    );
  }
  expectEqual(CI_WORKFLOW_PATH, action.with?.lane, lane, `${lane} node-ci lane input`);
  expectEqual(CI_WORKFLOW_PATH, action.with?.node_version, "${{ env.NODE_VERSION }}", `${lane} node-ci node_version input`);
  if (Object.hasOwn(action, "if") || Object.hasOwn(action, "continue-on-error")) {
    fail(CI_WORKFLOW_PATH, `${lane} node-ci step must not be conditional or continue-on-error: it IS the required check`);
  }
  // node-template, the reference consumer, keeps the full gate: schema drift check on, and the
  // real-Doltgres acceptance lane it owns. A fleet node sets its own inputs.
  if (action.uses === CI_ACTION_LOCAL) {
    if (lane === "static" && action.with?.db_check !== undefined && String(action.with.db_check) !== "true") {
      fail(CI_WORKFLOW_PATH, 'static must run db:check in node-template (db_check must be unset or "true")');
    }
    if (lane === "component") {
      expectEqual(
        CI_WORKFLOW_PATH,
        action.with?.doltgres_command,
        "pnpm --filter @cogni/node-template-app test:doltgres",
        "component doltgres_command input"
      );
    }
  }
}
// FORK_FREEDOM: CI runs without secrets.
if (JSON.stringify(ciWorkflow).includes("secrets.")) {
  fail(CI_WORKFLOW_PATH, "ci.yaml must not reference secrets (FORK_FREEDOM)");
}

// task.0127 AFFECTED_ON_PR_FULL_ON_QUEUE: the step-level `if:` expressions in the action ARE the
// scoping policy, so pin their behaviour, not their text. Each condition is evaluated against
// every (event, scope) a lane can see. merge_group and push always get `full` from the
// classifier; an empty scope is a crashed classifier and must also mean full.
function evaluateIf(expression, context) {
  const source = String(expression);
  const tokens = [...source.matchAll(/\s*(&&|\|\||==|!=|'[^']*'|[A-Za-z_][\w.-]*)\s*/gy)].map((m) => m[1]);
  if (tokens.join("") !== source.replace(/\s+/g, "")) {
    throw new Error(`unsupported syntax in ${JSON.stringify(source)}`);
  }
  let at = 0;
  const operand = () => {
    const token = tokens[at++];
    if (token?.startsWith("'")) return token.slice(1, -1);
    if (token && Object.hasOwn(context, token)) return context[token];
    throw new Error(`unknown operand ${JSON.stringify(token)} in ${JSON.stringify(source)}`);
  };
  const comparison = () => {
    const left = operand();
    if (tokens[at] !== "==" && tokens[at] !== "!=") return left !== "";
    const equal = tokens[at++] === "==";
    return (left === operand()) === equal;
  };
  const conjunction = () => {
    let value = comparison();
    while (tokens[at] === "&&") {
      at++;
      value = comparison() && value;
    }
    return value;
  };
  let value = conjunction();
  while (tokens[at] === "||") {
    at++;
    value = conjunction() || value;
  }
  if (at !== tokens.length) throw new Error(`unsupported syntax in ${JSON.stringify(source)}`);
  return value;
}

const stepLabel = (step) => step.name ?? step.uses ?? step.run;
// A step belongs to the lane its `if` names (`inputs.lane == 'unit'`); a step naming none belongs to all.
const stepLane = (step) => /inputs\.lane == '(\w+)'/.exec(String(step?.if ?? ""))?.[1];

function expectLaneStep(steps, name, lane, expectedRun, label) {
  const step = steps.find((candidate) => candidate?.name === name);
  if (!step) {
    fail(CI_ACTION_PATH, `steps must include ${JSON.stringify(name)}`);
    return;
  }
  if (stepLane(step) !== lane) fail(CI_ACTION_PATH, `${JSON.stringify(name)} must be gated to the ${lane} lane`);
  if (typeof expectedRun === "string") expectEqual(CI_ACTION_PATH, step.run, expectedRun, label);
  else expectIncludes(CI_ACTION_PATH, step.run, expectedRun.fragment, label);
}

function assertCiScopePolicy(steps) {
  const SETUP_ACTIONS = ["pnpm/action-setup@", "actions/setup-node@"];
  const isSetup = (step) => SETUP_ACTIONS.some((setup) => String(step.uses ?? "").startsWith(setup));
  const events = [
    ...["merge_group", "push"].flatMap((event) => ["full", ""].map((scope) => ({ event, scope }))),
    ...["full", "", "affected", "docs-only"].map((scope) => ({ event: "pull_request", scope })),
  ];
  for (const lane of LANES) {
    const mine = steps.filter((step) => [undefined, lane].includes(stepLane(step)));
    for (const { event, scope } of events) {
      for (const [cacheHit, dbCheck] of [["", "true"], ["true", "true"], ["", "false"]]) {
        const where = `${lane} on ${event} with scope ${JSON.stringify(scope)}, build cache hit ${JSON.stringify(cacheHit)}, db_check ${dbCheck}`;
        const context = {
          "github.event_name": event,
          "inputs.lane": lane,
          "inputs.db_check": dbCheck,
          "inputs.doltgres_command": "configured",
          "steps.scope.outputs.scope": scope,
          "steps.build_cache.outputs.cache-hit": cacheHit,
        };
        let ran;
        try {
          ran = mine.filter((step) => !Object.hasOwn(step, "if") || evaluateIf(step.if, context));
        } catch (error) {
          fail(CI_ACTION_PATH, `${where}: cannot evaluate step conditions: ${error.message}`);
          return;
        }
        // A docs-only diff runs the classifier and the one never-scoped check (Markdown refs, static
        // only), nothing else. Every other scope runs EVERY lane step: scoping narrows which unit
        // packages run inside the one unit step, never which steps run. A restored build cache skips
        // the build, db_check=false skips the schema check, and nothing else may be skipped.
        const expected =
          scope === "docs-only"
            ? mine.filter((step) => isSetup(step) || step.name === "Validate inputs" || step.id === "scope" || (lane === "static" && step.run === "pnpm check:markdown-refs"))
            : mine.filter(
                (step) =>
                  !(cacheHit === "true" && ["Build workspace packages", "Save workspace package build"].includes(step.name)) &&
                  !(dbCheck === "false" && step.name === "Database schema checks")
              );
        if (JSON.stringify(ran.map(stepLabel)) !== JSON.stringify(expected.map(stepLabel))) {
          fail(
            CI_ACTION_PATH,
            `${where} must run exactly ${JSON.stringify(expected.map(stepLabel))}; it runs ${JSON.stringify(ran.map(stepLabel))}`
          );
        }
      }
    }
  }
}

function assertCiAction(actionFile) {
  const action = parse(actionFile);
  if (action?.runs?.using !== "composite") {
    fail(CI_ACTION_PATH, "runs.using must be composite so a caller job keeps its bare required check name");
    return;
  }
  const steps = Array.isArray(action.runs.steps) ? action.runs.steps : [];
  if (/secrets\./.test(actionFile)) fail(CI_ACTION_PATH, "must not reference secrets (FORK_FREEDOM)");
  for (const step of steps) {
    if (step?.run !== undefined && step.shell === undefined) {
      fail(CI_ACTION_PATH, `step ${JSON.stringify(stepLabel(step))} runs a command without a shell`);
    }
    // NO_RUNTIME_FETCHES intent: every nested action is immutable.
    if (step?.uses !== undefined && !/@[0-9a-f]{40}(\s|$)/.test(String(step.uses))) {
      fail(CI_ACTION_PATH, `step ${JSON.stringify(stepLabel(step))} must pin ${step.uses} to a full commit SHA`);
    }
  }

  const classify = steps.find((step) => step?.id === "scope");
  if (
    !String(classify?.run ?? "").includes("scripts/classify-ci-scope.mjs") ||
    Object.hasOwn(classify ?? {}, "if") ||
    classify?.["continue-on-error"] !== true
  ) {
    fail(CI_ACTION_PATH, 'must run classify-ci-scope.mjs as step id "scope", ungated and with continue-on-error: true');
  }

  // Inputs are validated before anything else runs: a typo in `lane` would otherwise match no
  // lane-gated step and the required job would pass having run only setup.
  const first = steps[0];
  if (
    first?.name !== "Validate inputs" ||
    !/static\|unit\|component/.test(String(first?.run ?? "")) ||
    !/true\|false/.test(String(first?.run ?? ""))
  ) {
    fail(CI_ACTION_PATH, 'the first step must be "Validate inputs", failing unless lane is static|unit|component and db_check is true|false');
  }

  // The build cache. A restored build skips the build, so the key must cover every input that can
  // change a build (an exact-key hit only: restore-keys would hand a lane a build of other sources),
  // and only the static lane saves, from the key the restore computed, right after a build that passed.
  const CACHE_PATHS = "packages/*/dist\npackages/*/*.tsbuildinfo\ngraphs/dist\ngraphs/*.tsbuildinfo\n";
  const CACHE_KEY =
    "node-ci-build-v1-${{ runner.os }}-node${{ inputs.node_version }}-${{ hashFiles('packages/**', 'graphs/**', '!**/node_modules/**', '!**/dist/**', '!**/*.tsbuildinfo', '!**/*.md', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'tsconfig.base.json') }}";
  const cache = steps.find((step) => step?.id === "build_cache");
  if (!String(cache?.uses ?? "").startsWith("actions/cache/restore@")) {
    fail(CI_ACTION_PATH, 'step id "build_cache" must be actions/cache/restore');
  }
  expectEqual(CI_ACTION_PATH, cache?.with?.key, CACHE_KEY, "build_cache key");
  expectEqual(CI_ACTION_PATH, cache?.with?.path, CACHE_PATHS, "build_cache path");
  for (const option of ["restore-keys", "lookup-only", "fail-on-cache-miss"]) {
    if (Object.hasOwn(cache?.with ?? {}, option)) {
      fail(CI_ACTION_PATH, `build_cache must not set ${option}: only an exact input hash may skip the build`);
    }
  }
  const buildAt = steps.findIndex((step) => step?.name === "Build workspace packages");
  const saveAt = steps.findIndex((step) => step?.name === "Save workspace package build");
  const save = steps[saveAt];
  if (
    saveAt < 0 ||
    saveAt < buildAt ||
    buildAt < 0 ||
    !String(save?.uses ?? "").startsWith("actions/cache/save@") ||
    save?.with?.key !== "${{ steps.build_cache.outputs.cache-primary-key }}" ||
    save?.with?.path !== CACHE_PATHS ||
    Object.hasOwn(save?.with ?? {}, "lookup-only") ||
    save?.["continue-on-error"] === true ||
    /always\(\)|failure\(\)|cancelled\(\)/.test(String(save?.if ?? "")) ||
    !String(save?.if ?? "").includes("inputs.lane == 'static'")
  ) {
    fail(
      CI_ACTION_PATH,
      "\"Save workspace package build\" must be actions/cache/save, after the build, only in the static lane, with the restore's cache-primary-key, the same paths, and no always()/lookup-only"
    );
  }

  for (const [name, run] of [
    ["Install dependencies", "pnpm install --frozen-lockfile"],
    ["Build workspace packages", "pnpm packages:build"],
  ]) {
    const step = steps.find((candidate) => candidate?.name === name);
    if (!step) fail(CI_ACTION_PATH, `steps must include ${JSON.stringify(name)}`);
    else expectEqual(CI_ACTION_PATH, step.run, run, `${name} command`);
  }
  for (const [name, command] of [
    ["Database schema checks", "pnpm db:check"],
    ["Type check", "pnpm typecheck"],
    ["Workflow contract check", "pnpm check:workflow"],
    ["Node declarations check", "pnpm check:declarations"],
    ["Markdown references check", "pnpm check:markdown-refs"],
  ]) {
    expectLaneStep(steps, name, "static", command, `static ${name} command`);
  }
  expectLaneStep(steps, "Unit tests", "unit", { fragment: "scripts/run-unit-tests.mjs" }, "unit test command");
  expectLaneStep(steps, "Component tests (testcontainers)", "component", "pnpm test:component", "component test command");
  assertCiScopePolicy(steps);
}

if (existsSync(CI_ACTION_PATH)) {
  assertCiAction(readFileSync(CI_ACTION_PATH, "utf8"));
} else if (LANES.some((lane) => ciWorkflow?.jobs?.[lane]?.steps?.some((step) => step?.uses === CI_ACTION_LOCAL))) {
  fail(CI_ACTION_PATH, "ci.yaml calls the local node-ci action but the action file is missing");
}

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
if (IS_TEMPLATE) {
  expectContractInstall(detectSteps, "detect");
  const detectBuildStep = expectStep(
    PR_BUILD_WORKFLOW_PATH,
    detectSteps,
    "Build repo-spec contract"
  );
  expectEqual(
    PR_BUILD_WORKFLOW_PATH,
    detectBuildStep?.run,
    "pnpm --filter @cogni/repo-spec build",
    "detect dependency build"
  );
  // The image path consumes a build contract; ci.yaml owns verification. Catch
  // reintroducing the duplicated full check/test gate under a different step name.
  for (const step of detectSteps) {
    if (
      /\bpnpm\s+(?:run\s+)?(?:check(?::[\w:-]+)?|test(?::[\w:-]+)?|typecheck|db:check)(?=\s|$|[;&|])/.test(
        String(step?.run ?? "")
      )
    ) {
      fail(
        PR_BUILD_WORKFLOW_PATH,
        "jobs.detect must not duplicate CI checks or tests"
      );
    }
  }
}
expectStep(PR_BUILD_WORKFLOW_PATH, detectSteps, "Detect node image targets");

const buildJob = prBuildWorkflow?.jobs?.build;
if (!buildJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include build");
if (!Array.isArray(buildJob?.needs) || buildJob.needs.join(",") !== "resolve,detect") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.build.needs must be [\"resolve\", \"detect\"]");
}
expectEqual(PR_BUILD_WORKFLOW_PATH, buildJob?.strategy?.["fail-fast"], false, "jobs.build.strategy.fail-fast");
const buildSteps = Array.isArray(buildJob?.steps) ? buildJob.steps : [];
// Omitting Buildx teardown is bounded to this disposable GitHub-hosted job.
expectEqual(PR_BUILD_WORKFLOW_PATH, buildJob?.["runs-on"], "ubuntu-latest", "ephemeral image runner");
const buildxStep = expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Set up Docker Buildx");
if (IS_TEMPLATE) {
  expectEqual(PR_BUILD_WORKFLOW_PATH, buildxStep?.with?.cleanup, false, "ephemeral Buildx cleanup");
}
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Checkout");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Login to GHCR");
const imageBuildStep = expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Build app image");
if (IS_TEMPLATE) {
  expectEqual(
    PR_BUILD_WORKFLOW_PATH,
    imageBuildStep?.with?.["cache-to"],
    MAIN_CACHE_EXPORT,
    "trusted main cache export"
  );
}
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
if (IS_TEMPLATE) expectContractInstall(manifestSteps, "manifest");
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Download build fragments");
if (IS_TEMPLATE) expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Build repo-spec contract");
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

if (HAS_PUBLISH_WORKFLOW) {
  // The publish lane distributes bytes that every node repo then pins. The checks
  // below are the invariants that make a published version trustworthy; each one is
  // here because its absence was a live defect in the first version of this
  // workflow (story.5069), and each is cheap to re-break by hand.
  expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.name, "Publish Packages", "workflow name");
  // THE PACKAGE REGISTRY IS THE CONTRACT. `env.PACKAGES` in the publish workflow is
  // the single source of truth for which packages this repo distributes; `on.push.tags`
  // is what makes each one reachable. Those two drifting apart is silent in both
  // directions — an entry with no tag filter can never be published, and a tag filter
  // with no entry starts a run whose `select` job fails after the tag is already pushed
  // (and a pushed tag is not retractable in any consumer's eyes). Assert the bijection.
  //
  // The registry lives in the workflow YAML rather than being derived from
  // `packages/*/package.json` on purpose: the self-test harness copies only the 5 files
  // in its FILES list into a tmpdir, so a checker that read package manifests would be
  // unrunnable there. Keeping it in `env.PACKAGES` satisfies that by construction.
  const publishRegistry = (() => {
    const raw = publishWorkflow?.env?.PACKAGES;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      fail(PUBLISH_WORKFLOW_PATH, "env.PACKAGES must declare the publishable package registry");
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(PUBLISH_WORKFLOW_PATH, `env.PACKAGES must be valid JSON; ${error.message}`);
      return [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      fail(PUBLISH_WORKFLOW_PATH, "env.PACKAGES must be a non-empty JSON array");
      return [];
    }
    const seen = new Set();
    for (const [index, entry] of parsed.entries()) {
      for (const field of ["name", "dir", "tagPrefix"]) {
        if (typeof entry?.[field] !== "string" || entry[field].length === 0) {
          fail(
            PUBLISH_WORKFLOW_PATH,
            `env.PACKAGES[${index}] must declare a non-empty string "${field}"`
          );
        }
      }
      // Two entries under one name would publish twice from one tag, or silently
      // shadow each other in the matrix.
      if (typeof entry?.name === "string") {
        if (seen.has(entry.name)) {
          fail(PUBLISH_WORKFLOW_PATH, `env.PACKAGES declares ${entry.name} more than once`);
        }
        seen.add(entry.name);
      }
    }
    return parsed;
  })();

  {
    const tags = publishWorkflow?.on?.push?.tags;
    if (!Array.isArray(tags) || tags.length === 0) {
      fail(PUBLISH_WORKFLOW_PATH, "push trigger must declare tag filters");
    } else {
      const tagSet = new Set(tags);
      // Every registered package must be taggable.
      for (const entry of publishRegistry) {
        if (typeof entry?.tagPrefix !== "string") continue;
        const filter = `${entry.tagPrefix}*`;
        if (!tagSet.has(filter)) {
          fail(
            PUBLISH_WORKFLOW_PATH,
            `push trigger must include the tag filter ${JSON.stringify(filter)} for ` +
              `${entry.name}; without it no tag can ever publish that package`
          );
        }
      }
      // ...and every tag filter must map back to a registered package, or pushing a
      // matching tag starts a run that `select` can only fail.
      const prefixes = publishRegistry
        .map((entry) => entry?.tagPrefix)
        .filter((prefix) => typeof prefix === "string");
      for (const filter of tags) {
        if (!prefixes.some((prefix) => filter === `${prefix}*`)) {
          fail(
            PUBLISH_WORKFLOW_PATH,
            `tag filter ${JSON.stringify(filter)} matches no env.PACKAGES entry; it would ` +
              "fire a publish run that selects nothing"
          );
        }
      }
    }
  }

  // The matrix must be DERIVED from `select`, never a static list. GitHub does not
  // expose `matrix` in `jobs.<id>.if`, so a static matrix could only be narrowed to the
  // pushed tag step-by-step — which forces every mutating step's `if` into a compound
  // expression and breaks the `github.event_name == 'push'` exact-equality assertion
  // below. Deriving it means every emitted leg is one that should run, and the gate
  // stays a literal.
  {
    const selectJob = publishWorkflow?.jobs?.select;
    if (!selectJob) {
      fail(PUBLISH_WORKFLOW_PATH, "jobs must include select (it resolves the publish matrix)");
    } else if (typeof selectJob?.outputs?.packages !== "string" || selectJob.outputs.packages.length === 0) {
      fail(PUBLISH_WORKFLOW_PATH, "jobs.select must expose a non-empty `packages` output");
    }

    const publishNeeds = publishWorkflow?.jobs?.publish?.needs;
    const needsList = Array.isArray(publishNeeds) ? publishNeeds : [publishNeeds];
    if (!needsList.includes("select")) {
      fail(
        PUBLISH_WORKFLOW_PATH,
        `jobs.publish.needs must include "select"; got ${JSON.stringify(publishNeeds)}`
      );
    }

    expectEqual(
      PUBLISH_WORKFLOW_PATH,
      publishWorkflow?.jobs?.publish?.strategy?.matrix?.pkg,
      "${{ fromJSON(needs.select.outputs.packages) }}",
      "jobs.publish.strategy.matrix.pkg must be derived from jobs.select"
    );
  }
  expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.permissions?.contents, "write", "permissions.contents");
  // Provenance is not optional: `npm publish --provenance` only works against
  // registry.npmjs.org, so a Release asset's equivalent is an attestation over the
  // exact tarball, and that needs Sigstore OIDC plus attestation storage.
  expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.permissions?.["id-token"], "write", "permissions.id-token");
  expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.permissions?.attestations, "write", "permissions.attestations");
  // Least privilege, and an honesty check. A `packages: write` grant here means
  // someone re-added a GitHub Packages publish — a registry that returns 401 even
  // for a public package in a public repo, so it is unreachable for the forks this
  // repo exists to serve. One distribution channel, or consumers cannot tell which
  // bytes are canonical.
  if (publishWorkflow?.permissions?.packages !== undefined) {
    fail(
      PUBLISH_WORKFLOW_PATH,
      "permissions.packages must not be granted: the Release asset is the only distribution channel"
    );
  }
  // A publish must never be cancelled mid-upload, or a Release exists with no asset.
  expectEqual(
    PUBLISH_WORKFLOW_PATH,
    publishWorkflow?.concurrency?.["cancel-in-progress"],
    false,
    "concurrency.cancel-in-progress"
  );
  // Build the artifact on the toolchain that gates it and runs it. Skew here ships
  // dist + .d.ts files off a Node major no consumer uses.
  expectEqual(
    PUBLISH_WORKFLOW_PATH,
    publishWorkflow?.env?.NODE_VERSION,
    ciWorkflow?.env?.NODE_VERSION,
    `env.NODE_VERSION must match ${CI_WORKFLOW_PATH}`
  );
  {
    const publishJob = publishWorkflow?.jobs?.publish;
    if (!publishJob) fail(PUBLISH_WORKFLOW_PATH, "jobs must include publish");
    const publishSteps = Array.isArray(publishJob?.steps) ? publishJob.steps : [];

    // Each of these encodes one fail-closed assertion. Deleting a step is the
    // regression this guards, so require them by name.
    for (const name of [
      "Tagged commit must have passed every required check",
      "Tag must match the package version",
      "Release must not already exist",
      "Tarball must contain every declared entrypoint",
      "Tarball must carry its licence",
      "Attest the tarball",
      "Attach the tarball to a Release",
    ]) {
      expectStep(PUBLISH_WORKFLOW_PATH, publishSteps, name);
    }

    for (const step of publishSteps) {
      const label = JSON.stringify(step?.name ?? step?.uses ?? "<unnamed step>");

      // A version is immutable or it is not a version. `--clobber` replaces the
      // asset bytes at an already-published version, so every consumer pinning that
      // URL either breaks on an integrity mismatch or silently receives different
      // code under a version they already reviewed.
      if (String(step?.run ?? "").includes("--clobber")) {
        fail(
          PUBLISH_WORKFLOW_PATH,
          `step ${label} uses --clobber; a published version must never be overwritten. Bump the version instead.`
        );
      }

      // A step that cannot fail proves nothing, and reads as coverage it does not have.
      if (step?.["continue-on-error"] === true) {
        fail(
          PUBLISH_WORKFLOW_PATH,
          `step ${label} sets continue-on-error: true; a publish step that cannot fail proves nothing`
        );
      }

      // Anything that mutates the published world must be unreachable from
      // workflow_dispatch, which carries no tag and therefore skips the
      // tag/version correspondence proof.
      const mutatesPublishedState =
        /gh release (create|upload|edit|delete)/.test(String(step?.run ?? "")) ||
        /\b(npm|pnpm)\b[^\n]*\bpublish\b/.test(String(step?.run ?? "")) ||
        String(step?.uses ?? "").includes("attest-build-provenance");
      if (mutatesPublishedState && step?.if !== "github.event_name == 'push'") {
        fail(
          PUBLISH_WORKFLOW_PATH,
          `step ${label} publishes or attests but is not gated on \`if: github.event_name == 'push'\`; ` +
            "a workflow_dispatch carries no tag, so it cannot prove the version it would publish"
        );
      }
    }
  }
}

const REQUIRED_CHECK_WORKFLOWS = [
  { path: CI_WORKFLOW_PATH, workflow: ciWorkflow },
  { path: PR_BUILD_WORKFLOW_PATH, workflow: prBuildWorkflow },
  { path: PR_LINT_WORKFLOW_PATH, workflow: prLintWorkflow },
];

assertRequiredChecksRunOnReviewEvents(repoPolicy, REQUIRED_CHECK_WORKFLOWS);
assertRequiredChecksFailClosed(repoPolicy, REQUIRED_CHECK_WORKFLOWS);
