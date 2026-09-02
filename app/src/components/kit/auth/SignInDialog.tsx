// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/auth/SignInDialog`
 * Purpose: Modal dialog presenting the sign-in options this deployment actually offers.
 * Scope: Client component that fetches available providers and renders sign-in options; does not manage session state or implement OAuth flow directly.
 * Invariants: Renders exactly what `/api/auth/providers` advertises — never a hardcoded
 *   provider list. A node that configures a provider gets a button for it with no code
 *   change, and a provider it does not configure is never advertised.
 *   Filters out "credentials" (SIWE) since the wallet flow is handled separately.
 * Side-effects: IO (fetch /api/auth/providers, signIn redirect)
 * Links: src/components/kit/auth/WalletConnectButton.tsx, src/auth.ts
 * @public
 */

"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@cogni/node-ui-kit/shadcn/dialog";
import { signIn } from "next-auth/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import {
	DiscordIcon,
	EthereumIcon,
	GitHubIcon,
	GoogleIcon,
} from "@/components/kit/data-display/ProviderIcons";
import { Button } from "@/components/kit/inputs/Button";
import { OPERATOR_ATTESTED_PROVIDER_ID } from "@/shared/identity/signin-paths";

/**
 * Presentation for providers we ship artwork for. This is a LOOKUP, never a filter —
 * an id missing from here still renders, using the display name NextAuth returns.
 * Hardcoding the render list instead is what hid Discord on every node while
 * advertising GitHub on nodes that never register it (bug.5074).
 */
const PROVIDER_META: Record<
	string,
	{ readonly label: string; readonly icon: typeof GitHubIcon }
> = {
	github: { label: "Continue with GitHub", icon: GitHubIcon },
	[OPERATOR_ATTESTED_PROVIDER_ID]: {
		label: "Continue with GitHub",
		icon: GitHubIcon,
	},
	google: { label: "Continue with Google", icon: GoogleIcon },
	discord: { label: "Continue with Discord", icon: DiscordIcon },
};

interface OauthProvider {
	readonly id: string;
	readonly name: string;
}

/**
 * Begin sign-in for one provider.
 *
 * A real OAuth provider goes straight to NextAuth. `operator-github` is NOT one: it is a
 * Credentials provider whose credential is an attestation the OPERATOR has to mint first,
 * so calling `signIn()` on it posts an empty credential to the callback and bounces with
 * `?error=CredentialsSignin`. It has to take the broker round trip and only returns to
 * NextAuth from the completion page, token in hand.
 *
 * Caught by clicking the real button on the deployed candidate: the provider was
 * correctly advertised by `/api/auth/providers` AND correctly registered in `auth.ts`,
 * and the button still did nothing. Neither typecheck nor unit tests can see this.
 */
async function startSignIn(providerId: string): Promise<void> {
	if (providerId !== OPERATOR_ATTESTED_PROVIDER_ID) {
		void signIn(providerId, { callbackUrl: "/chat" });
		return;
	}
	const res = await fetch("/api/v1/identity/bindings/import/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
	});
	if (!res.ok) throw new Error("start leg failed");
	const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
	window.location.assign(authorizeUrl);
}

interface SignInDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** Called when user picks the Ethereum wallet option */
	readonly onWalletConnect: () => void;
}

export function SignInDialog({
	open,
	onOpenChange,
	onWalletConnect,
}: SignInDialogProps): ReactElement {
	// Starts empty and fills from the server. There is nothing to be optimistic WITH:
	// which providers exist is per-deployment, so guessing renders buttons that vanish
	// (or worse, ones that cannot work).
	const [providers, setProviders] = useState<readonly OauthProvider[]>([]);
	// `operator-github` has to fetch a challenge before it can leave the page, so the
	// click is followed by a real network hop. Without this the button sits inert and
	// the page looks hung until the redirect finally happens.
	const [pendingId, setPendingId] = useState<string | null>(null);

	// Fetch on MOUNT, not on open. The dialog is always mounted and merely toggles
	// `open`, so gating the fetch on `open` meant every user paid the round trip AFTER
	// clicking Connect and watched an empty dialog fill in. Warm it ahead of time and
	// the buttons are already there when the dialog appears.
	useEffect(() => {
		let cancelled = false;
		fetch("/api/auth/providers")
			.then((res) => res.json())
			.then((fetched: Record<string, { id: string; name: string }>) => {
				if (cancelled) return;
				setProviders(
					Object.values(fetched)
						.filter((provider) => provider.id !== "credentials")
						.map((provider) => ({ id: provider.id, name: provider.name })),
				);
			})
			.catch(() => {
				// Wallet sign-in still works; advertising an unconfirmed provider does not.
			});

		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Sign in to Cogni</DialogTitle>
					<DialogDescription>Choose a method to get started.</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3 pt-2">
					{/* Wallet option — always available */}
					<Button
						variant="outline"
						className="h-12 justify-start gap-3 text-sm"
						onClick={() => {
							onOpenChange(false);
							onWalletConnect();
						}}
					>
						<EthereumIcon className="size-5" />
						Ethereum Wallet
					</Button>

					{/* Every OAuth provider this deployment actually configured */}
					{providers.map((provider) => {
						const meta = PROVIDER_META[provider.id];
						const Icon = meta?.icon;
						return (
							<Button
								key={provider.id}
								variant="outline"
								className="h-12 justify-start gap-3 text-sm"
								disabled={pendingId !== null}
								onClick={() => {
									setPendingId(provider.id);
									void startSignIn(provider.id).catch(() => setPendingId(null));
								}}
							>
								{Icon ? <Icon className="size-5" /> : null}
								{meta?.label ?? `Continue with ${provider.name}`}
							</Button>
						);
					})}
				</div>
			</DialogContent>
		</Dialog>
	);
}
