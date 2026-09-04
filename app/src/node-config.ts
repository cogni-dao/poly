import type { NodeAppConfig } from "@cogni/node-app/extensions";
import {
  Briefcase,
  Coins,
  FlaskConical,
  Github,
  LayoutDashboard,
  Vote,
} from "lucide-react";

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
    { href: "https://github.com/cogni-dao", label: "GitHub", icon: Github },
  ],
};
