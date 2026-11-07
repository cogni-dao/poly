// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/goals/goals-tab`
 * Purpose: Prove the Goals board reads at a glance: KPI cards carry a label, a
 *   number, at most one short hint and a symbol+word pill, never sentences;
 *   unknown is "—", never 0; each card renders by display type; a failed poll
 *   stays quiet until it repeats; a card opens a named chart that keeps gaps and
 *   links every reading; the Goals tab is URL-addressable.
 * Scope: React Query plus the browser fetch boundary. No live network.
 *   recharts ResponsiveContainer is mocked to a fixed size so jsdom renders SVG.
 * Invariants: STATUS_NEVER_COLOR_ONLY, UNKNOWN_IS_NOT_ZERO, NO_SENTENCES_ON_CARDS,
 *   QUIET_REFRESH, GAPS_STAY_GAPS, WAI_ARIA_TABS, URL_DRIVEN_MODE.
 * Side-effects: global (stubbed fetch)
 * Links: app/src/features/goals/components/GoalsBoard.tsx, app/src/app/(app)/knowledge/view.tsx
 * @vitest-environment jsdom
 * @internal
 */

import { type GoalsProgress, GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  everyStatusFixture,
  goalFixture,
  history,
  kpiFixture,
  visualFixture,
} from "@tests/_fixtures/goals/progress";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";
import { GoalsBoard, MetricEvidence } from "@/features/goals";
import { STATUS_META } from "@/features/goals/lib/presentation";

const navigation = vi.hoisted(() => ({
  mode: "browse",
  observation: null as string | null,
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () =>
    new URLSearchParams({
      mode: navigation.mode,
      ...(navigation.observation
        ? { observation: navigation.observation }
        : {}),
    }),
}));
// jsdom measures 0×0, so a real ResponsiveContainer renders nothing.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      React.createElement(
        "div",
        { style: { width: 800, height: 192 } },
        React.cloneElement(children as ReactElement<Record<string, unknown>>, {
          width: 800,
          height: 192,
        })
      ),
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid", () => ({
  DataGrid: () => null,
  DataGridContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({ DataGridColumnVisibility: () => null })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null,
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/KnowledgeDetail", () => ({
  KnowledgeDetail: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/GraphView", () => ({
  GraphView: () => null,
}));
vi.mock("@/components", () => ({
  Button: ({ children, onClick }: ComponentProps<"button">) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

function client() {
  return new QueryClient({
    // retryDelay 0: the history queries retry once; tests need not wait 1 s.
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.push.mockReset();
  navigation.observation = null;
});


function renderBoard(data: GoalsProgress, c = client()) {
  return {
    c,
    ...render(
      <QueryClientProvider client={c}>
        <GoalsBoard initialData={data} />
      </QueryClientProvider>
    ),
  };
}

/** Visible words on a card: aria-only text is excluded. */
function visibleWords(el: Element): string[] {
  const clone = el.cloneNode(true) as Element;
  for (const n of clone.querySelectorAll(".sr-only")) n.remove();
  return (clone.textContent ?? "").split(/\s+/).filter(Boolean);
}

function withKpis(kpis: GoalsProgress["goals"][number]["kpis"]): GoalsProgress {
  return GoalsProgressSchema.parse({
    asOf: "2026-11-02T10:05:00.000Z",
    environment: "local",
    goals: [goalFixture("goal-x", "Goal: Ship it", kpis)],
  });
}

describe("GoalsBoard", () => {
  it("renders every measured KPI status as a symbol plus a word", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = renderBoard(everyStatusFixture());
    for (const [status, meta] of Object.entries(STATUS_META)) {
      if (status === "not_measured") continue;
      const pill = container.querySelector(`[data-goal="goal-${status}"] [data-status="${status}"]`);
      expect(pill, status).not.toBeNull();
      expect(pill?.textContent).toContain(meta.symbol);
      expect(pill?.textContent).toContain(meta.short);
    }
    // A goal with nothing measured is a collapsed row; its cards stay hidden until opened.
    const row = container.querySelector('[data-goal="goal-not_measured"]') as HTMLElement;
    const header = within(row).getAllByRole("button")[0] as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(header.getAttribute("aria-controls") ?? "")?.hidden).toBe(true);
  });

  it("counts goals and KPIs once each, and every status as a count of KPIs", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const data = visualFixture();
    const kpis = data.goals.reduce((n, g) => n + g.kpis.length, 0);
    const { container } = renderBoard(data);
    const cell = (label: string) =>
      [...container.querySelectorAll("dl > div")].find((d) => d.querySelector("dt")?.textContent === label)
        ?.querySelector("dd")?.textContent;
    expect(cell("Goals")).toBe(String(data.goals.length));
    expect(cell("KPIs")).toBe(String(kpis));
    const behind = data.goals.flatMap((g) => g.kpis).filter((k) => k.assessment.status === "behind").length;
    expect(cell("Behind")).toBe(String(behind));
    const onTrack = data.goals.flatMap((g) => g.kpis).filter((k) => k.assessment.status === "on_track").length;
    expect(cell("On track")).toBe(String(onTrack));
    // Each measured goal row links to its goal page beside its toggle.
    const first = data.goals[0]!;
    const row = container.querySelector(`[data-goal="${first.id}"]`) as HTMLElement;
    expect(row.querySelector(`h3 a[href="/knowledge/${first.id}"]`)).not.toBeNull();
  });

  it("puts no sentences on a card and never prints unknown as zero", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = renderBoard(everyStatusFixture());
    const cards = container.querySelectorAll("[data-kpi]");
    expect(cards.length).toBeGreaterThan(5);
    for (const card of cards) expect(visibleWords(card).length, card.textContent ?? "").toBeLessThanOrEqual(10);
    expect(container.textContent).not.toMatch(/unknown, not zero|could not be read/);
    // The reason is the card's accessible description and hover title, in plain words.
    const failing = container.querySelector('[data-goal="goal-failing"] [data-kpi]') as HTMLElement;
    const toggle = within(failing).getByRole("button");
    expect(toggle.getAttribute("title")).toBe("The data source timed out.");
    expect(document.getElementById(toggle.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
      "The data source timed out."
    );
    cleanup();
    const empty = kpiFixture(
      "m",
      "M",
      { ...productionLike(0, "ratio"), status: "failing", reason: "source_timeout", value: null, observationId: null, observedAt: null },
      null
    );
    const board = renderBoard(withKpis([empty])).container;
    const card = board.querySelector("[data-kpi]") as HTMLElement;
    expect(card.querySelector(".text-3xl")?.textContent).toBe("—");
    const emptyToggle = within(card).getByRole("button");
    expect(document.getElementById(emptyToggle.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/^No reading/);
    expect(card.textContent).not.toMatch(/\b0\b(?!\.)/);
  });

  it("renders each card by the display type the read model carries", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const stars = kpiFixture(
      "github-stars",
      "GitHub stars",
      { ...productionLike(120, "stars"), comparator: "gte", target: { value: 200, unit: "stars" } },
      history("github-stars", "stars", "1d", "2026-11-03T00:00:00.000Z", [100, null, 110, 120])
    );
    const uptime = kpiFixture(
      "uptime",
      "Uptime",
      { ...productionLike(99.95, "%"), comparator: "gte", target: { value: 99.9, unit: "%" } },
      history("uptime", "%", "1d", "2026-11-03T00:00:00.000Z", [99.99, 99.8, 99.95])
    );
    const as = <K extends typeof stars>(kpi: K, display: "progress" | "slo" | "volume"): K => ({
      ...kpi,
      metric: kpi.metric && { ...kpi.metric, display },
    });
    const { container } = renderBoard(
      withKpis([visualFixture().goals[0]!.kpis[0]!, as(stars, "volume"), as(uptime, "slo")])
    );
    const card = (id: string) => container.querySelector(`[data-kpi="${id}"]`) as HTMLElement;
    expect(card("convergence-ratio-7d").dataset.display).toBe("progress");
    expect(card("github-stars").dataset.display).toBe("volume");
    expect(card("github-stars").textContent).toContain("+20 since Oct 30");
    expect(card("uptime").dataset.display).toBe("slo");
    expect(card("uptime").textContent).toContain("99.95%");
    expect(card("uptime").textContent).toContain("budget 50%");
  });

  it("stays quiet on one failed poll, marks stale after repeats, and says signed out on 401", async () => {
    let status = 503;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    const { c } = renderBoard(visualFixture());
    await c.refetchQueries({ queryKey: ["goals", "progress"] });
    await waitFor(() => expect(c.getQueryState(["goals", "progress"])?.status).toBe("error"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Stale/)).toBeNull();
    expect(screen.getByText(/Updated/)).toBeTruthy();
    await c.refetchQueries({ queryKey: ["goals", "progress"] });
    await c.refetchQueries({ queryKey: ["goals", "progress"] });
    expect(await screen.findByText(/Stale ·/)).toBeTruthy();
    status = 401;
    await c.refetchQueries({ queryKey: ["goals", "progress"] });
    expect(await screen.findByText("Signed out · reload")).toBeTruthy();
  });

  it("opens a card into a named chart that keeps gaps and links every reading", async () => {
    const data = visualFixture();
    const kpi = data.goals[0]!.kpis[0]!;
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/v1/metrics/convergence-ratio-7d/history")
        ? Response.json(history("convergence-ratio-7d", "ratio", "1h", "2026-11-02T10:00:00.000Z", [0.5, 0.6, null, null, 0.7, 0.8]))
        : new Promise(() => {})
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderBoard(data);
    const card = container.querySelector(`[data-kpi="${kpi.binding.metricId}"]`) as HTMLElement;
    const toggle = within(card).getByRole("button", { name: kpi.metric!.title });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")?.tagName).toBe("FIGURE");
    const figure = await screen.findByRole("figure", { name: kpi.metric!.title });
    await waitFor(() => expect(figure.querySelector(".recharts-area-curve")).not.toBeNull());
    // Two runs of readings around the gap: the curve restarts, never bridges.
    const d = figure.querySelector(".recharts-area-curve")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)?.length).toBe(2);
    const links = within(figure).getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(4);
    expect(links[0]?.getAttribute("href")).toMatch(/^\/knowledge\/convergence-ratio-7d\?observation=/);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/history"))).toHaveLength(1);
  });
});

function productionLike(value: number, unit: string) {
  return {
    status: "on_track" as const,
    reason: null,
    value,
    unit,
    observationId: "00000000-0000-4000-8000-000000000001",
    observedAt: "2026-11-02T10:00:00.000Z",
    comparator: "gte" as const,
    target: { value: 1, unit },
    deadline: "2027-01-31T00:00:00.000Z",
    pace: { observed: null, needed: null },
  };
}

describe("Knowledge Goals tab", () => {
  it("is a WAI-ARIA tab that writes ?mode=goals and shows the attention badge", async () => {
    navigation.mode = "browse";
    const data = visualFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/metrics/goals") return Response.json(data);
        if (url.startsWith("/api/v1/knowledge/contributions"))
          return Response.json({ contributions: [] });
        return new Promise(() => {});
      })
    );
    const qc = client();
    const view = () => (
      <QueryClientProvider client={qc}>
        <KnowledgeDashboardView
          initialList={{ items: [], domains: [] }}
          initialDomains={{ domains: [] }}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(view());
    const tablist = screen.getByRole("tablist", { name: "Knowledge views" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/,.*$/, ""))).toEqual([
      "Browse",
      "Graph",
      "Chains",
      "Domains",
      expect.stringMatching(/^Goals/),
      "Inbox",
    ]);
    const goals = within(tablist).getByRole("tab", { name: /^Goals/ });
    await waitFor(() =>
      expect(goals.textContent).toContain("1 goal needs attention")
    );
    expect(goals.getAttribute("aria-selected")).toBe("false");
    expect(goals.getAttribute("tabindex")).toBe("-1");

    fireEvent.click(goals);
    expect(navigation.push).toHaveBeenCalledWith("/knowledge?mode=goals", {
      scroll: false,
    });
    expect(goals.getAttribute("aria-selected")).toBe("true");
    // Re-selecting the current tab adds no history entry.
    fireEvent.click(goals);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(goals.id);
    expect(
      within(panel).getByRole("region", { name: "Goals" })
    ).toBeTruthy();

    // Arrow keys move focus along the tablist (manual activation).
    goals.focus();
    fireEvent.keyDown(goals, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toMatch(/^Inbox/);

    // Back/forward: the URL changes under the view and the tab follows it.
    navigation.mode = "goals";
    rerender(view());
    navigation.mode = "browse";
    rerender(view());
    expect(
      within(tablist)
        .getByRole("tab", { name: "Browse" })
        .getAttribute("aria-selected")
    ).toBe("true");
    navigation.mode = "goals";
    rerender(view());
    expect(goals.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(tablist).getByRole("tab", { name: "Browse" }));
    expect(navigation.push).toHaveBeenLastCalledWith("/knowledge", {
      scroll: false,
    });
  });
});

describe("MetricEvidence", () => {
  it("pins the linked immutable reading ahead of newer rolling readings", async () => {
    const reading = (n: number, value: number) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      metricId: "work",
      definitionRevision: "1",
      definitionHash: "hash1",
      calculatorVersion: "work.count@1",
      paramsHash: "params1",
      node: "test",
      environment: "test",
      dataScope: "test",
      window: { start: "2026-11-02T00:00:00Z", end: `2026-11-02T0${n}:00:00Z` },
      sourceWatermarks: [{ source: "work", asOf: "2026-11-02T00:00:00Z" }],
      observedAt: `2026-11-02T0${n}:00:00Z`,
      status: "ok",
      value,
      unit: "items",
      reason: null,
      evidenceRefs: ["node:work"],
    });
    const pinned = reading(1, 5);
    const later = reading(2, 20);
    const definition = {
      id: "work",
      title: "Work",
      revision: "1",
      spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
    };
    navigation.observation = pinned.id;
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/v1/metrics/work"
        ? Response.json({
            definition,
            latestAttempt: later,
            lastGood: later,
            viewState: "ok",
            history: [later, pinned],
          })
        : url === `/api/v1/metrics/work/observations/${pinned.id}`
          ? Response.json({ definition, observation: pinned })
          : new Response("{}", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <QueryClientProvider client={client()}>
        <MetricEvidence id="work" />
      </QueryClientProvider>
    );
    await screen.findByText(/Linked immutable evidence/);
    const articles = container.querySelectorAll("article");
    expect(articles).toHaveLength(1);
    expect(articles[0]?.id).toBe(`observation-${pinned.id}`);
    expect(articles[0]?.textContent).toContain("5 items");
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "/api/v1/metrics/work",
      `/api/v1/metrics/work/observations/${pinned.id}`,
    ]);
  });
});

describe("server rendering", () => {
  it("emits the same markup on every request", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = () =>
      renderToString(
        <QueryClientProvider client={client()}>
          <GoalsBoard initialData={visualFixture()} />
        </QueryClientProvider>
      );
    expect(html()).toBe(html());
  });
});
