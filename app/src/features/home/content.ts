// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/content`
 * Purpose: Single customization surface for the public landing page. ALL editable
 *   copy and placeholder data for the homepage lives here — hero, showcase cards,
 *   activity feed, and stats. The components in `./components/*` are layout only;
 *   they read everything from this file.
 * Scope: Public homepage content. No logic, no IO — pure data.
 * Invariants: Shapes are stable so layout components stay generic. Customize VALUES,
 *   not shapes, when minting a new node.
 * Side-effects: none
 * Links: src/features/home/components/LandingHero.tsx,
 *   src/features/home/components/ShowcaseCards.tsx,
 *   src/features/home/components/ActivityFeed.tsx,
 *   src/features/home/components/AgentStream.tsx,
 *   src/features/home/components/HomeStats.tsx
 * @public
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ███  CUSTOMIZE YOUR NODE HERE  ███
 *
 *  This file is the homepage. To make the landing page yours, you edit WORDS in
 *  this file and the brand HUE in `src/styles/tailwind.css`. You should not need
 *  to touch the layout components for a first-class customization.
 *
 *  Walk top-to-bottom and replace every placeholder with copy + data that sells
 *  YOUR node's mission. A stranger should understand what this node is for in
 *  five seconds. See `docs/guides/new-node-styling.md` and the `node-styling`
 *  skill for the full playbook.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Activity,
  BrainCircuit,
  CheckCircle,
  Network,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/* ─── HERO ────────────────────────────────────────────────────────────────
 * The first thing a visitor sees. `headline` renders as two lines; the second
 * line gets the brand gradient. Keep it short and declarative.
 */
export interface HeroContent {
  /** Tiny uppercase label inside the status pill at the top of the hero. */
  statusLabel: string;
  /** Line 1 of the headline (plain foreground color). */
  headlineTop: string;
  /** Line 2 of the headline (renders with the brand gradient). */
  headlineAccent: string;
  /** One- to two-sentence value prop under the headline. */
  subhead: string;
  /** Primary CTA — wired to the "try the demo" sign-in flow. */
  primaryCta: string;
  /** Small uppercase tagline shown next to the primary CTA. */
  ctaTagline: string;
}

export const HERO: HeroContent = {
  statusLabel: "Scanning markets",
  headlineTop: "Bet smarter.",
  headlineAccent: "Together.",
  subhead:
    "A community-built AI that researches, monitors, and signals across Polymarket, Kalshi, and more. You stay in control.",
  primaryCta: "Sign in",
  ctaTagline: "Teach it. Guide it. Profit with it.",
};

/* ─── HERO LINKS ──────────────────────────────────────────────────────────
 * Secondary buttons in the hero. Point them at your community + source.
 */
export const HERO_LINKS = {
  chatUrl: "https://discord.gg/3b9sSyhZ4z",
  sourceUrl: "https://github.com/cogni-dao/poly",
} as const;

/* ─── AGENT STREAM ────────────────────────────────────────────────────────
 * The live "console" embedded in the hero. Each sequence plays out like the
 * agent thinking in real time, then loops to the next. Rewrite these lines to
 * describe what YOUR agent actually does, step by step. Keep ~4-6 events each.
 */
export type StreamEventType =
  | "thinking"
  | "searching"
  | "analyzing"
  | "signal"
  | "done";

export interface StreamEvent {
  id: string;
  type: StreamEventType;
  text: string;
  /** ms offset from the start of the sequence when this line appears. */
  at: number;
}

/** Label shown in the stream header next to the spinner. */
export const AGENT_STREAM_SUBJECT = "cogni/poly-brain";

export const AGENT_STREAM_SEQUENCES: StreamEvent[][] = [
  [
    {
      id: "a1",
      type: "thinking",
      text: "Checking macro calendar for upcoming catalysts...",
      at: 0,
    },
    {
      id: "a2",
      type: "searching",
      text: "Scanning Kalshi climate markets - 23 active contracts",
      at: 1800,
    },
    {
      id: "a3",
      type: "analyzing",
      text: "NOAA updated Gulf SST anomaly to +1.8C - comparing to hurricane model base rates",
      at: 3400,
    },
    {
      id: "a4",
      type: "signal",
      text: 'Signal: "Cat 5 hurricane hits US" - Kalshi 41c, model says 46c. Moderate edge detected.',
      at: 5600,
    },
    {
      id: "a5",
      type: "done",
      text: "Scan complete. 1 signal generated, 23 markets reviewed.",
      at: 7200,
    },
  ],
  [
    {
      id: "b1",
      type: "thinking",
      text: "Reviewing Fed futures curve vs Kalshi rate-cut pricing...",
      at: 0,
    },
    {
      id: "b2",
      type: "searching",
      text: "Pulling CME FedWatch probabilities and CPI trend data",
      at: 2000,
    },
    {
      id: "b3",
      type: "analyzing",
      text: 'Kalshi "June cut" at 62c - FedWatch implies 68%. Spread: 6c mispricing.',
      at: 3800,
    },
    {
      id: "b4",
      type: "signal",
      text: 'Signal: "Fed cuts at June meeting" - Buy Yes at 62c, target 68c. High confidence.',
      at: 5400,
    },
    {
      id: "b5",
      type: "done",
      text: "Scan complete. 1 signal generated, 8 markets reviewed.",
      at: 6800,
    },
  ],
  [
    {
      id: "c1",
      type: "thinking",
      text: "Monitoring Polymarket tech category for new listings...",
      at: 0,
    },
    {
      id: "c2",
      type: "searching",
      text: "3 new markets detected - GPT-5, Apple AI, Anthropic funding round",
      at: 1600,
    },
    {
      id: "c3",
      type: "analyzing",
      text: "GPT-5 before July: 34c. No credible leaks. Historical AI release markets have 12% optimism bias.",
      at: 3200,
    },
    {
      id: "c4",
      type: "analyzing",
      text: "Anthropic $10B+ round: 78c. Multiple credible sources. Fair price - no actionable edge.",
      at: 4800,
    },
    {
      id: "c5",
      type: "done",
      text: "Scan complete. 0 signals - no edge detected in current tech markets.",
      at: 6200,
    },
  ],
];

/* ─── SHOWCASE CARDS ──────────────────────────────────────────────────────
 * A grid of cards showing what the node tracks / produces. The two-segment bar
 * is a generic split (e.g. Yes/No, Open/Closed, On-track/At-risk) — name the
 * segments per item. Replace the category list and the cards with your domain.
 */
export interface ShowcaseOutcome {
  label: string;
  /** 0-100; the two outcomes in a card should sum to ~100. */
  value: number;
}

export interface ShowcaseItem {
  id: string;
  title: string;
  /** Must match one of SHOWCASE_CATEGORIES (besides "All"). */
  category: string;
  /** Free-text source / origin shown in muted text. */
  source: string;
  /** Headline number shown top-right, e.g. "$4.2M" or "94%". */
  metric: string;
  /** 24h-style delta in percent; positive = up (success), negative = down. */
  change: number;
  /** Two-segment split bar. */
  outcomes: [ShowcaseOutcome, ShowcaseOutcome];
  /** Left footer meta (e.g. volume, members, size). */
  footerLeft: string;
  /** Right footer meta (e.g. "Updated 2h ago", "Resolves Jun 18"). */
  footerRight: string;
}

export const SHOWCASE_SECTION = {
  eyebrow: "Live coverage",
  heading: "One bot. Every market.",
  subhead:
    "It goes where the signal is. Cross-platform research means you never miss a mispricing, regardless of where it surfaces.",
} as const;

export const SHOWCASE_CATEGORIES = [
  "All",
  "Economics",
  "Tech",
  "Crypto",
  "Climate",
  "Politics",
] as const;

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    id: "1",
    title: "Fed cuts rates at June meeting?",
    category: "Economics",
    source: "Kalshi",
    metric: "62%",
    change: 4,
    outcomes: [
      { label: "Yes", value: 62 },
      { label: "No", value: 38 },
    ],
    footerLeft: "$4.2M Vol.",
    footerRight: "Resolves Jun 18",
  },
  {
    id: "2",
    title: "GPT-5 released before July 2026?",
    category: "Tech",
    source: "Polymarket",
    metric: "34%",
    change: -2,
    outcomes: [
      { label: "Yes", value: 34 },
      { label: "No", value: 66 },
    ],
    footerLeft: "$1.8M Vol.",
    footerRight: "Resolves Jul 1",
  },
  {
    id: "3",
    title: "Bitcoin above $150k by EOY?",
    category: "Crypto",
    source: "Polymarket",
    metric: "28%",
    change: 7,
    outcomes: [
      { label: "Yes", value: 28 },
      { label: "No", value: 72 },
    ],
    footerLeft: "$12.4M Vol.",
    footerRight: "Resolves Dec 31",
  },
  {
    id: "4",
    title: "Category 5 hurricane hits US in 2026?",
    category: "Climate",
    source: "Kalshi",
    metric: "41%",
    change: -1,
    outcomes: [
      { label: "Yes", value: 41 },
      { label: "No", value: 59 },
    ],
    footerLeft: "$890K Vol.",
    footerRight: "Resolves Nov 30",
  },
];

/* ─── ACTIVITY FEED ───────────────────────────────────────────────────────
 * "What the agent is thinking" — public, explainable output. Each signal shows
 * the call, a confidence, the reasoning, and the sources. This is where you
 * prove the node works in the open. Rewrite for your domain.
 */
export type SignalDirection = "positive" | "negative" | "neutral";

export interface FeedSignal {
  id: string;
  title: string;
  category: string;
  source: string;
  direction: SignalDirection;
  /** 0-100 self-reported confidence. */
  confidence: number;
  /** The agent's reasoning, 1-2 sentences. */
  thesis: string;
  /** Citations / inputs the agent used. */
  sources: string[];
  /** Human-friendly relative time, e.g. "2m ago". */
  timestamp: string;
}

export const FEED_SECTION = {
  eyebrow: "Brain activity",
  heading: "What the bot is thinking.",
  subhead:
    "Live output from Cogni's analysis engine. Every signal is public. See exactly what it sees and why.",
} as const;

/** The status-bar verbs and the running totals shown above the feed. */
export const FEED_STATUS = {
  scannedLabel: "markets",
  signalsLabel: "signals today",
  startScanned: 2847,
  signalsToday: 12,
} as const;

export const FEED_SIGNALS: FeedSignal[] = [
  {
    id: "s1",
    title: "Fed cuts rates at June meeting?",
    category: "Economics",
    source: "Kalshi",
    direction: "positive",
    confidence: 74,
    thesis:
      "CPI trend + Fed language shift in May minutes suggests high probability of 25bp cut. Market underpricing relative to futures curve.",
    sources: ["Fed Minutes", "BLS CPI Report", "CME FedWatch"],
    timestamp: "2m ago",
  },
  {
    id: "s2",
    title: "Category 5 hurricane hits US in 2026?",
    category: "Climate",
    source: "Kalshi",
    direction: "positive",
    confidence: 61,
    thesis:
      "NOAA seasonal outlook + unusually warm Gulf SSTs tracking above 2005 analogs. Historical base rate ~15% but current conditions elevate to ~35-45%.",
    sources: ["NOAA Outlook", "SST Data", "Historical Analogs"],
    timestamp: "8m ago",
  },
  {
    id: "s3",
    title: "Bitcoin above $150k by EOY?",
    category: "Crypto",
    source: "Polymarket",
    direction: "negative",
    confidence: 58,
    thesis:
      "On-chain metrics show distribution phase. ETF inflow momentum decelerating. 28c seems fair. No edge detected. Monitoring for re-entry below 20c.",
    sources: ["Glassnode", "ETF Flow Data", "On-chain Analytics"],
    timestamp: "14m ago",
  },
  {
    id: "s4",
    title: "GPT-5 released before July 2026?",
    category: "Tech",
    source: "Polymarket",
    direction: "negative",
    confidence: 67,
    thesis:
      "No credible leak or announcement. OpenAI roadmap suggests H2 earliest. Current 34c likely overpriced given historical AI-release optimism bias.",
    sources: ["OpenAI Blog", "Insider Reports", "Release History"],
    timestamp: "21m ago",
  },
];

/* ─── STATS ───────────────────────────────────────────────────────────────
 * The closing band of big numbers. Keep them true and specific to your node.
 */
export interface StatItem {
  value: string;
  label: string;
}

export const STATS: StatItem[] = [
  { value: "2,847", label: "Markets scanned" },
  { value: "12", label: "Signals today" },
  { value: "3", label: "Platforms watched" },
  { value: "24/7", label: "Agent coverage" },
];

/* ─── STREAM ICONS ────────────────────────────────────────────────────────
 * Maps stream event types to icons. You usually won't need to touch this.
 */
export const STREAM_ICONS: Record<StreamEventType, LucideIcon> = {
  thinking: BrainCircuit,
  searching: Search,
  analyzing: Activity,
  signal: Sparkles,
  done: CheckCircle,
};

export const SECTION_ICON: LucideIcon = Network;
