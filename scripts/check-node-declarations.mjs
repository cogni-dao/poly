// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Fail the PR on an invalid `.cogni/secrets-catalog.yaml` or a retired `secret_refs`
// (bug.5254). The slug is the repo-spec's `intent.name`, never the repository name.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const slug = parse(readFileSync(".cogni/repo-spec.yaml", "utf8"))?.intent?.name;
if (typeof slug !== "string" || slug.trim() === "") {
  console.error(".cogni/repo-spec.yaml: intent.name is required");
  process.exit(1);
}
const run = spawnSync(
  "pnpm",
  ["exec", "node-declarations-check", "--repo-root", ".", "--node-slug", slug],
  { stdio: "inherit" }
);
process.exit(run.status ?? 1);
