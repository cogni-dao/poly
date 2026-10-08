// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/meta/poly-product-wiring`
 * Purpose: Prevent changes from orphaning Poly's product surfaces.
 * Scope: Source-level conformance for the node-owned UI composition and config.
 * Invariants: MONEY_HAS_WALLET, DASHBOARD_HAS_TRADING, POLY_IDENTITY_REACHABLE.
 * Side-effects: IO (reads repository source files).
 * Links: app/src/node-config.ts, app/src/app/(app)/credits/CreditsPage.client.tsx
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
		const walletPanel = readRepoFile(
			"app/src/app/(app)/credits/TradingWalletPanel.tsx",
		);

		expect(credits).toContain('from "./TradingWalletPanel"');
		expect(credits).toContain("<TradingWalletPanel />");
		expect(credits).toContain("<AiCreditsPanel />");
		// Wallet reset is a privileged recovery tool, NOT a self-serve control.
		// It shipped briefly as a Money-page button; the guards behind it block
		// on residual funds and unsettled orders, but a healthy funded wallet
		// that happens to be flat passes all of them and gets revoked on a
		// mis-click. The owner-scoped API route still exists for operator-driven
		// recovery — what must never come back is a product-page entry point.
		expect(walletPanel).not.toContain("TradingWalletResetButton");
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
		const sidebar = readRepoFile(
			"app/src/features/layout/components/AppSidebar.tsx",
		);
		const layout = readRepoFile("app/src/app/layout.tsx");
		const appLayout = readRepoFile("app/src/app/(app)/layout.tsx");
		const adminLayout = readRepoFile("app/src/app/(admin)/layout.tsx");
		const repoSpec = readRepoFile(".cogni/repo-spec.yaml");
		const brandIcons = readRepoFile("app/src/shared/brand/brandIcons.tsx");
		const footer = readRepoFile(
			"app/src/features/layout/components/footer-items.tsx",
		);

		expect(nodeConfig).toContain('name: "Poly"');
		expect(nodeConfig).toContain('href: "/research"');
		expect(nodeConfig).toContain('href: "/credits", label: "Money"');
		expect(nodeConfig).toContain("https://github.com/cogni-dao/poly");
		expect(sidebar).toContain('from "@/node-config"');
		expect(sidebar).toContain("nodeConfig.logo.href");
		// The shell's brand mark comes from repo-spec `intent.brand` via the server
		// layout — the same source AppHeader uses — so both shells draw one identity
		// and a fork re-brands by editing repo-spec, never this JSX.
		expect(sidebar).toContain("resolveBrandIcon(brandMark.icon)");
		expect(sidebar).toContain("brandMark.slug");
		expect(sidebar).not.toContain("next/image");
		expect(appLayout).toContain("getBrandMark()");
		expect(adminLayout).toContain("getBrandMark()");
		expect(repoSpec).toMatch(/brand:\s+icon: Activity/);
		expect(sidebar).toContain("nodeConfig.navItems.filter");
		expect(sidebar).toContain("...configuredNavItems");
		expect(sidebar).toContain("nodeConfig.externalLinks.map");
		expect(sidebar).toContain('href: "/knowledge"');
		expect(sidebar).toContain('href: "/admin"');
		expect(sidebar).toContain("isApprover");
		expect(sidebar).not.toContain("cogni-template");
		expect(layout).toContain("Cogni Poly — Community AI Prediction Trading");
		expect(brandIcons).toMatch(/const BRAND_ICONS = \{\s+Activity,/);
		expect(footer).toContain('{ label: "Knowledge", href: "/knowledge" }');
		expect(footer).toContain('{ label: "Money", href: "/credits" }');
		expect(footer).not.toContain('{ label: "Credits", href: "/credits" }');
	});

	it("keeps every homepage auth transition on the Poly dashboard", () => {
		const publicPage = readRepoFile("app/src/app/(public)/page.tsx");
		const authRedirect = readRepoFile(
			"app/src/app/(public)/AuthRedirect.tsx",
		);

		expect(publicPage).toContain('redirect("/dashboard")');
		expect(authRedirect).toContain('window.location.replace("/dashboard")');
		expect(authRedirect).not.toContain('window.location.replace("/chat")');
	});

	it("keeps wallet secret shapes declared", () => {
		const secrets = readRepoFile(".cogni/secrets-catalog.yaml");
		const repoSpec = readRepoFile(".cogni/repo-spec.yaml");

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
		expect(repoSpec).not.toContain("OPS_TOKEN");
	});
});
