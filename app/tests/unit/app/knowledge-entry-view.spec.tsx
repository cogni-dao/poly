// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-entry-view`
 * Purpose: Keep poly's retrieval trigger visible under the permalink title.
 * Scope: Real reader and React Query cache. No live services or database.
 * Invariants: TRIMMED_TRIGGER, EMPTY_TRIGGER_HIDDEN, PLAIN_TEXT_SUBTITLE.
 * Side-effects: Stubbed fetch; clipboard is not exercised.
 * Links: https://github.com/cogni-dao/cogni/issues/2832
 * @vitest-environment jsdom
 * @internal
 */

import type { KnowledgeRow } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEntryView } from "@/app/(app)/knowledge/_components/KnowledgeEntryView";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/app/(app)/knowledge/_components/KnowledgeEntryFields", () => ({
  KnowledgeEntryFields: ({ item }: { item: KnowledgeRow }) => (
    <p>{item.content}</p>
  ),
}));

function mount(useWhen: KnowledgeRow["useWhen"]) {
  const entry: KnowledgeRow = {
    id: "poly-reader",
    domain: "poly",
    entityId: null,
    title: "poly reader fixture",
    content: "Existing selected body",
    useWhen,
    entryType: "finding",
    confidencePct: null,
    sourceType: "human",
    sourceRef: null,
    tags: null,
    createdAt: null,
  };
  const fetchMock = vi.fn(() => Promise.reject(new Error("Unexpected read")));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(["knowledge", "entry", entry.id], entry);
  render(
    <QueryClientProvider client={client}>
      <KnowledgeEntryView id={entry.id} />
    </QueryClientProvider>
  );
  return {
    heading: screen.getByRole("heading", { level: 1, name: entry.title }),
    fetchMock,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("poly permalink retrieval trigger", () => {
  it("renders a trimmed plain-text subtitle immediately beneath the title", () => {
    const trigger = "Use poly guidance for <strong>review</strong>.";
    const { heading, fetchMock } = mount(`  ${trigger} \n`);
    const subtitle = heading.nextElementSibling;

    expect(subtitle?.tagName).toBe("P");
    expect(subtitle?.textContent).toBe(`Use when: ${trigger}`);
    expect(subtitle?.querySelector("strong")).toBeNull();
    expect(screen.getByText("Existing selected body")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy block link" })
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", useWhen: undefined },
    { label: "null", useWhen: null },
    { label: "empty", useWhen: "" },
    { label: "whitespace", useWhen: " \n\t " },
  ])("omits a $label trigger", ({ useWhen }) => {
    const { heading, fetchMock } = mount(useWhen);

    expect(heading.nextElementSibling?.tagName).toBe("DIV");
    expect(screen.getByText("Existing selected body")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
