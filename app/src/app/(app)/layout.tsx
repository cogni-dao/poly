// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/layout`
 * Purpose: Sidebar navigation shell for protected application pages.
 * Scope: Server layout component providing sidebar + top bar shell for all routes under (app). Does not handle authentication — proxy.ts guarantees only authenticated users reach this layout.
 * Invariants: Auth enforced at proxy level; this layout is a pure UI shell. The brand mark is read server-side from repo-spec and passed to the client sidebar, mirroring `(public)/layout.tsx`.
 * Side-effects: repo-spec read on first call (cached)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/security-auth.md, src/proxy.ts, src/app/(public)/layout.tsx
 * @public
 */

import type { ReactNode } from "react";

import { AppShell } from "@/features/layout";
import { getBrandMark } from "@/shared/config/repoSpec.server";
import { EntityPeekProvider } from "./_components/EntityPeek";

export default function AppLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  // Server-side, build-safe repo-spec read; passed to the (client) sidebar as a
  // serializable prop so the sidebar never imports server-only repo-spec IO.
  const brandMark = getBrandMark();
  return (
    <AppShell brandMark={brandMark}>
      <EntityPeekProvider>{children}</EntityPeekProvider>
    </AppShell>
  );
}
