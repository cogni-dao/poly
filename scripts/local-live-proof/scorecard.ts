// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
	evaluateProof,
	findLeakedSecretNames,
	type LocalLiveProofEvidence,
} from "./proof-contract";

const evidencePath = process.argv[2];
if (!evidencePath) {
	process.stderr.write(
		"usage: pnpm exec tsx scripts/local-live-proof/scorecard.ts <evidence.json>\n",
	);
	process.exitCode = 1;
} else {
	try {
		const serialized = await readFile(evidencePath, "utf8");
		const leaked = findLeakedSecretNames(serialized, process.env);
		if (leaked.length > 0) {
			process.stderr.write(
				`local live proof FAIL\nevidence contains secret values for: ${leaked.join(", ")}\n`,
			);
			process.exitCode = 1;
		} else {
			const evidence = JSON.parse(serialized) as LocalLiveProofEvidence;
			const result = evaluateProof(evidence);
			process.stdout.write(`${result.lines.join("\n")}\n`);
			if (result.issues.length > 0) {
				process.stderr.write(
					`${result.issues.map((issue) => `- ${issue}`).join("\n")}\n`,
				);
			}
			process.exitCode =
				result.status === "PASS" ? 0 : result.status === "BLOCKED" ? 2 : 1;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`local live proof FAIL\n${message}\n`);
		process.exitCode = 1;
	}
}
