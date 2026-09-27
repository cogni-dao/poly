// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@/node-config`
 * Purpose: Poly node shell navigation — labels and Lucide icons for the App Router layout.
 * Scope: Static `nodeConfig` export only. Does not fetch or read env at runtime.
 * Invariants:
 *   - RESEARCH_IS_REACHABLE (bug.5271) — `/research` carries the trader-comparison
 *     P/L overlay and target-overlap panels. The page shipped with the fork but this
 *     config did not, so the route was URL-only for the node's entire life. Any nav
 *     entry removed here silently orphans a working page; add, don't replace.
 *   - `/credits` route label "Money" with `Coins` icon (URL stays `/credits`).
 * Side-effects: none
 * Links: app/src/features/layout/components/AppSidebar.tsx, app/src/app/(app)/research/view.tsx
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
    /** Monochrome Lucide icon — avoids emoji so the rail matches Dashboard/Work/etc. */
    { href: "/credits", label: "Money", icon: Coins },
  ],
  externalLinks: [
    { href: "https://github.com/cogni-dao/poly", label: "GitHub", icon: Github },
    {
      href: "https://discord.gg/3b9sSyhZ4z",
      label: "Discord",
      icon: DiscordIcon,
    },
  ],
};
