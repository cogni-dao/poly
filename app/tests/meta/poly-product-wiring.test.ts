// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/meta/poly-product-wiring`
 * Purpose: Prevent template syncs from orphaning Poly's product surfaces.
 * Scope: Source-level conformance for the node-owned UI composition and config.
 * Invariants: MONEY_HAS_WALLET, DASHBOARD_HAS_TRADING, POLY_IDENTITY_REACHABLE.
 * Side-effects: IO (reads repository source files).
 * Links: .cogni/sync-manifest.yaml, app/src/node-config.ts
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "..");

function readRepoFile(relativePath: string): string {
	return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Poly product wiring", () => {
	it("keeps wallet onboarding rendered on the Money page", () => {
		const credits = readRepoFile(
			"app/src/app/(app)/credits/CreditsPage.client.tsx",
		);

		expect(credits).toContain('from "./TradingWalletPanel"');
		expect(credits).toContain("<TradingWalletPanel />");
		expect(credits).toContain("<AiCreditsPanel />");
	});

	it("keeps trading controls rendered on the dashboard", () => {
		const dashboard = readRepoFile("app/src/app/(app)/dashboard/view.tsx");

		for (const component of [
			"CopyTargetControlPanel",
			"TradingWalletCard",
			"OperatorWalletChartsRow",
			"ExecutionActivityCard",
			"MirrorAttemptsCard",
		]) {
			expect(dashboard).toContain(`<${component} />`);
		}
	});

	it("keeps Poly identity and research reachable", () => {
		const nodeConfig = readRepoFile("app/src/node-config.ts");
		const layout = readRepoFile("app/src/app/layout.tsx");
		const brandIcons = readRepoFile("app/src/shared/brand/brandIcons.tsx");

		expect(nodeConfig).toContain('name: "Poly"');
		expect(nodeConfig).toContain('href: "/research"');
		expect(nodeConfig).toContain('href: "/credits", label: "Money"');
		expect(nodeConfig).toContain("https://github.com/cogni-dao/poly");
		expect(layout).toContain("Cogni Poly — Community AI Prediction Trading");
		expect(brandIcons).toMatch(/const BRAND_ICONS = \{\s+Activity,/);
	});

	it("protects the Poly-owned seams from fork sync", () => {
		const manifest = readRepoFile(".cogni/sync-manifest.yaml");
		const secrets = readRepoFile(".cogni/secrets-catalog.yaml");

		for (const ownedPath of [
			'"app/src/app/(app)/credits/**"',
			'"app/src/app/(app)/dashboard/view.tsx"',
			'"app/src/node-config.ts"',
			'"app/src/app/layout.tsx"',
			'"app/src/shared/brand/brandIcons.tsx"',
			'".cogni/secrets-catalog.yaml"',
		]) {
			expect(manifest).toContain(ownedPath);
		}

		for (const secretName of [
			"PRIVY_USER_WALLETS_APP_ID",
			"PRIVY_USER_WALLETS_APP_SECRET",
			"PRIVY_USER_WALLETS_SIGNING_KEY",
			"POLY_WALLET_AEAD_KEY_HEX",
			"POLYGON_RPC_URL",
			"PAPER_ENFORCE_MODE",
		]) {
			expect(secrets).toContain(`name: ${secretName}`);
		}
	});
});
