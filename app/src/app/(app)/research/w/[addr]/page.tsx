// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/research/w/[addr]/page`
 * Purpose: Auth-gated Poly wallet research route shell.
 * Scope: Server auth and wallet address validation only.
 * Invariants: Protected route. No trading, signing, or wallet mutation.
 * Side-effects: IO
 * @public
 */

import { notFound, redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { WalletResearchView } from "./view";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

type PageProps = {
  params: Promise<{ addr: string }>;
};

export default async function WalletResearchPage({ params }: PageProps) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const { addr } = await params;
  if (!WALLET_RE.test(addr)) {
    notFound();
  }

  return <WalletResearchView address={addr.toLowerCase()} />;
}
