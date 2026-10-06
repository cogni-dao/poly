// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/AdminShell`
 * Purpose: Client sidebar shell for admin pages — mirrors `(app)/layout.tsx` so admin/app/non-admin nav stays visually coherent.
 * Scope: Pure UI shell. Auth + role enforcement live in the server `(admin)/layout.tsx` that wraps this component.
 * Invariants: Renders children unconditionally; never gates access. The brand mark is supplied by the server `(admin)/layout.tsx`, never read here.
 * Side-effects: none
 * Links: src/app/(admin)/layout.tsx, src/features/layout/components/AppSidebar.tsx
 * @public
 */

"use client";

import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components";
import { AppSidebar, AppTopBar } from "@/features/layout";
import type { BrandMark } from "@/shared/config/repoSpec.server";

export function AdminShell({
  children,
  brandMark,
}: {
  children: ReactNode;
  brandMark: BrandMark;
}): ReactNode {
  return (
    <SidebarProvider>
      <AppSidebar brandMark={brandMark} />
      <SidebarInset>
        <AppTopBar />
        <div className="flex flex-1 flex-col overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
