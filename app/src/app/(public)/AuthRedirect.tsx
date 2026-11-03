// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/AuthRedirect`
 * Purpose: Client-side auth transition gate for SIWE sign-in on public pages.
 * Scope: Watches NextAuth session status; does not enforce auth policy or access control.
 *   When authenticated, renders a full-screen overlay and hard-navigates to /dashboard
 *   (Poly's product hub) so middleware/RSC run on the new request. Server remains the routing authority.
 * Invariants: No-op when session is loading or unauthenticated; overlay prevents flash.
 * Side-effects: IO (hard navigation via window.location.replace)
 * Links: src/proxy.ts (server-side authority), src/app/(public)/page.tsx
 * @public
 */

"use client";

import { useSession } from "next-auth/react";
import { useEffect } from "react";
import { BrainLoading } from "@/components";
import { AppShell } from "@/features/layout";
import type { BrandMark } from "@/shared/config/repoSpec.server";

export function AuthRedirect({
  brandMark,
}: {
  brandMark: BrandMark;
}): React.JSX.Element | null {
  const { status } = useSession();

  useEffect(() => {
    if (status === "authenticated") {
      window.location.replace("/dashboard");
    }
  }, [status]);

  if (status !== "authenticated") return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-background">
      <AppShell brandMark={brandMark}>
        <BrainLoading />
      </AppShell>
    </div>
  );
}
