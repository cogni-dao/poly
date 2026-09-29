// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/node-config`
 * Purpose: Poly node shell navigation and external links.
 * Scope: Static `nodeConfig` export only.
 * Invariants: Research and Money remain reachable; identity points at Poly.
 * Side-effects: none
 * Links: app/src/features/layout/components/AppSidebar.tsx
 * @public
 */

import type { NodeAppConfig } from "@cogni/node-app/extensions";
import {
  Briefcase,
  Coins,
  FlaskConical,
  Github,
  LayoutDashboard,
  Vote,
} from "lucide-react";
import { DiscordIcon } from "@/components";

export const nodeConfig: NodeAppConfig = {
  name: "Poly",
  logo: { src: "/TransparentBrainOnly.png", alt: "Poly", href: "/chat" },
  navItems: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/research", label: "Research", icon: FlaskConical },
    { href: "/work", label: "Work", icon: Briefcase },
    { href: "/gov", label: "Gov", icon: Vote },
    { href: "/credits", label: "Money", icon: Coins },
  ],
  externalLinks: [
    {
      href: "https://github.com/cogni-dao/poly",
      label: "GitHub",
      icon: Github,
    },
    {
      href: "https://discord.gg/3b9sSyhZ4z",
      label: "Discord",
      icon: DiscordIcon,
    },
  ],
};
