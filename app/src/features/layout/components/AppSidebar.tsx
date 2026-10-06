// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppSidebar`
 * Purpose: Cogni-specific sidebar composition with nav items, collapsible chat threads, and external links.
 * Scope: Composes vendor Sidebar primitives into the app sidebar. Does not handle authentication or data fetching.
 * Invariants: The brand mark comes from repo-spec `intent.brand` via the server layout — same source as `AppHeader`, so both shells draw one identity and forks never hand-edit this JSX. Admin nav item is shown only when the session wallet is a repo-spec approver (`session.user.isApprover`); the `(admin)/` layout still enforces server-side. Chat threads always visible as collapsible menu item.
 * Side-effects: reads NextAuth session (`useSession`)
 * Links: src/features/layout/components/AppHeader.tsx, src/shared/brand/brandIcons.tsx, src/components/vendor/shadcn/sidebar.tsx
 * @public
 */

"use client";

import { BookOpen, Shield } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import type { ReactElement } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components";
import { ChatThreadsSidebarGroup } from "@/features/ai/chat/components/ChatThreadsSidebarGroup";
import { nodeConfig } from "@/node-config";
import { resolveBrandIcon } from "@/shared/brand/brandIcons";
import type { BrandMark } from "@/shared/config/repoSpec.server";

const KNOWLEDGE_NAV_ITEM = {
  href: "/knowledge",
  label: "Knowledge",
  icon: BookOpen,
} as const;

const ADMIN_NAV_ITEM = {
  href: "/admin",
  label: "Admin",
  icon: Shield,
} as const;

export function AppSidebar({
  brandMark,
}: {
  brandMark: BrandMark;
}): ReactElement {
  const pathname = usePathname();
  // Same brand source as AppHeader: repo-spec {icon,color,slug}, resolved here from
  // the serializable prop the server layout passes in. Icon name -> component.
  const BrandIcon = resolveBrandIcon(brandMark.icon);
  const { data: session } = useSession();
  const isApprover = session?.user?.isApprover ?? false;
  const configuredNavItems = nodeConfig.navItems.filter(
    (item) => item.href !== "/admin" || isApprover
  );
  const navItems = [
    ...configuredNavItems,
    ...(nodeConfig.navItems.some((item) => item.href === "/knowledge")
      ? []
      : [KNOWLEDGE_NAV_ITEM]),
    ...(isApprover &&
    !nodeConfig.navItems.some((item) => item.href === "/admin")
      ? [ADMIN_NAV_ITEM]
      : []),
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 shrink-0 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={`cogni/${brandMark.slug}`}>
              <Link href={nodeConfig.logo.href}>
                <div className="flex aspect-square size-8 items-center justify-center">
                  <BrandIcon
                    className="size-5 shrink-0"
                    color={brandMark.color ?? undefined}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </div>
                <span className="truncate font-bold">
                  cogni
                  <span className="text-gradient-accent">/{brandMark.slug}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                pathname.startsWith(`${item.href.replace(/\/$/, "")}/`);
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={item.label}
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}

            {/* Collapsible Threads — last item so it can expand downward */}
            <ChatThreadsSidebarGroup />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          {nodeConfig.externalLinks.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild tooltip={item.label}>
                <a href={item.href} target="_blank" rel="noopener noreferrer">
                  <item.icon />
                  <span>{item.label}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
