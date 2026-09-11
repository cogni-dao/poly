import { appendFileSync, readFileSync } from "node:fs";

import {
  extractNodeArtifactBuilds,
  parseRepoSpec,
} from "../../packages/repo-spec/dist/index.js";

const repository = process.env.GITHUB_REPOSITORY ?? "unknown/node";
const repoName = repository.split("/").at(-1) ?? "node";
const baseImageName = process.env.IMAGE_NAME?.toLowerCase();
if (!baseImageName) throw new Error("IMAGE_NAME is required");

const spec = parseRepoSpec(readFileSync(".cogni/repo-spec.yaml", "utf8"));
const targets = extractNodeArtifactBuilds(spec).map((declared) => ({
  ...declared,
  image_name: declared.public
    ? baseImageName
    : `${baseImageName}-${declared.artifact}`,
  legacy_target: declared.public
    ? repoName.toLowerCase()
    : `${repoName.toLowerCase()}-${declared.artifact}`,
}));

writeOutput("has_targets", "true");
writeOutput("targets", targets.map((target) => target.artifact).join(","));
writeOutput("targets_json", JSON.stringify(targets));

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(`${key}=${value}`);
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
