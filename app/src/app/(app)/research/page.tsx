// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/research/page`
 * Purpose: Auth-gated Poly research route shell.
 * Scope: Server auth check only. Rendering and API polling live in `ResearchView`.
 * Invariants: Protected route. No trading, signing, or wallet mutation.
 * Side-effects: IO
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { ResearchView } from "./view";

export default async function ResearchPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  return <ResearchView />;
}
