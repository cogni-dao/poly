// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFile } from "node:fs/promises";
import process from "node:process";
import { collectCorrelatedLogEvidence } from "./proof-contract";

const correlationId = process.argv[2];
const appLogPath = process.argv[3] ?? ".context/local-runtime/app.log";

if (!correlationId) {
	process.stderr.write(
		"usage: pnpm exec tsx scripts/local-live-proof/collect-logs.ts <correlation-id> [app-log]\n",
	);
	process.exitCode = 1;
} else {
	try {
		const serialized = await readFile(appLogPath, "utf8");
		const records = collectCorrelatedLogEvidence(serialized, correlationId);
		process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`local live proof log collection FAIL\n${message}\n`);
		process.exitCode = 1;
	}
}
