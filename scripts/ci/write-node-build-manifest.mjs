import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  buildNodeArtifactBundle,
  parseRepoSpec,
} from "../../packages/repo-spec/dist/index.js";

const required = [
  "MANIFEST_FILE",
  "BUNDLE_FILE",
  "IMAGE_NAME",
  "IMAGE_TAG",
  "SOURCE_SHA",
  "REPOSITORY",
  "SOURCE_REPOSITORY",
];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

const fragmentsDir = process.env.FRAGMENTS_DIR ?? "";
const emitBundle = process.env.EMIT_BUNDLE === "true";
const targets = [];
const artifacts = [];
if (fragmentsDir && existsSync(fragmentsDir)) {
  for (const file of readdirSync(fragmentsDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const payload = JSON.parse(readFileSync(join(fragmentsDir, file), "utf8"));
    targets.push(...(payload.targets ?? []));
    if (payload.built_artifact) artifacts.push(payload.built_artifact);
  }
}

const bundle = emitBundle
  ? buildNodeArtifactBundle({
      spec: parseRepoSpec(
        readFileSync(
          process.env.REPO_SPEC_FILE ?? ".cogni/repo-spec.yaml",
          "utf8"
        )
      ),
      sourceSha: process.env.SOURCE_SHA,
      repository: process.env.SOURCE_REPOSITORY,
      artifacts,
    })
  : null;

const manifest = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  repository: process.env.REPOSITORY,
  head_sha: process.env.SOURCE_SHA,
  ref_name: process.env.REF_NAME ?? "",
  workflow: {
    name: process.env.WORKFLOW_NAME ?? "",
    run_id: process.env.RUN_ID ?? "",
    run_attempt: process.env.RUN_ATTEMPT ?? "",
  },
  image_name: process.env.IMAGE_NAME.toLowerCase(),
  image_tag: process.env.IMAGE_TAG,
  platform: "linux/amd64",
  targets,
};

if (bundle) writeJsonAtomically(process.env.BUNDLE_FILE, bundle);
writeJsonAtomically(process.env.MANIFEST_FILE, manifest);

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
