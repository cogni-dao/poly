import { appendFileSync } from "node:fs";

const repository = process.env.GITHUB_REPOSITORY ?? "unknown/node";
const repoName = repository.split("/").at(-1) ?? "node";
const appTarget = repoName.toLowerCase();
const targets = [appTarget, "paper-trader"];

writeOutput("has_targets", "true");
writeOutput("targets", targets.join(","));
writeOutput("targets_json", JSON.stringify(targets));

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(`${key}=${value}`);
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
