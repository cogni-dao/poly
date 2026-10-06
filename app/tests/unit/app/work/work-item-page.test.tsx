// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves direct work-item URLs retain route identity and authentication. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: auth }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/app/(app)/work/view", () => ({ WorkDashboardView: () => null }));

import WorkItemPage from "@/app/(app)/work/items/[id]/page";

describe("WorkItemPage", () => {
  beforeEach(() => {
    auth.mockReset();
    redirect.mockReset();
  });

  it("projects a refreshed permalink into the route-backed view", async () => {
    auth.mockResolvedValue({ id: "user-1" });

    const element = await WorkItemPage({
      params: Promise.resolve({ id: "story.5000" }),
    });

    expect(element.props.selectedItemId).toBe("story.5000");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("passes the logical route id through without decoding it again", async () => {
    auth.mockResolvedValue({ id: "user-1" });

    const element = await WorkItemPage({
      params: Promise.resolve({ id: "bug.%2F" }),
    });

    expect(element.props.selectedItemId).toBe("bug.%2F");
  });

  it("keeps direct permalinks behind the authenticated app boundary", async () => {
    auth.mockResolvedValue(null);

    await WorkItemPage({ params: Promise.resolve({ id: "story.5000" }) });

    expect(redirect).toHaveBeenCalledWith("/");
  });
});
