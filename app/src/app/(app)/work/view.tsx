// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Client-side work dashboard. ReUI DataGrid table (default) or the
 *          published work board (`?view=board`, `@cogni/knowledge-base-ui`)
 *          over one TanStack table, with URL-driven state and detail panel.
 * Scope: Presentation. Fetches data via React Query.
 * Invariants:
 *   - BOARD_FROM_PACKAGE — board mode renders only `WorkBoardToolbar` and
 *     `WorkBoardView` from `@cogni/knowledge-base-ui` (task.0044).
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in
 *     the package column headers (see `_components/columns.tsx`).
 *   - SINGLE_COLUMNS_TOGGLE — table visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search / rank range / view / board
 *     columns persist in URL params.
 *   - ONE_ROW_MODEL — the board renders the table's filtered, sorted rows
 *     (unpaginated); the table paginates the same rows.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemDto`.
 * Side-effects: IO (fetches from /api/v1/work/items)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import {
  ACTIVE_WORK_STATUSES,
  WORK_STATUSES,
  WorkBoardToolbar,
  WorkBoardView,
  type WorkTableMeta,
  workItemGlobalFilterFn,
} from "@cogni/knowledge-base-ui";
import type { WorkItemDto } from "@cogni/node-contracts";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridPagination } from "@cogni/node-ui-kit/reui/data-grid/data-grid-pagination";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  functionalUpdate,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Columns3, List, Settings2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components";

import { fetchWorkItem, fetchWorkItems } from "./_api/fetchWorkItems";
import { columns } from "./_components/columns";
import { WorkItemDetail } from "./_components/WorkItemDetail";
import { WorkGoalLink } from "./_components/WorkKanban";
import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  workItemHref,
  workListHref,
  workViewHref,
} from "./_lib/workItemNavigation";

const ALL_STATUSES = WORK_STATUSES;
const ACTIVE_STATUSES = ACTIVE_WORK_STATUSES;

type RankRange = [number | undefined, number | undefined];

function readFilters(searchParams: URLSearchParams): ColumnFiltersState {
  const filters: ColumnFiltersState = [];
  const typeParam = searchParams.get("type");
  if (typeParam) filters.push({ id: "type", value: typeParam.split(",") });
  const statusParam = searchParams.get("status");
  if (statusParam && statusParam !== "all") {
    filters.push({ id: "status", value: statusParam.split(",") });
  } else if (!statusParam) {
    filters.push({ id: "status", value: [...ACTIVE_STATUSES] });
  }
  const projectParam = searchParams.get("project");
  if (projectParam)
    filters.push({ id: "projectId", value: projectParam.split(",") });
  const numberParam = (key: string) => {
    const raw = searchParams.get(key);
    if (!raw?.trim()) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const rankRange: RankRange = [numberParam("rankMin"), numberParam("rankMax")];
  if (rankRange.some((value) => value !== undefined)) {
    filters.push({ id: "rankScore", value: rankRange });
  }
  return filters;
}

function readColumns(params: URLSearchParams): string[] {
  const value = params.get("columns");
  return value === null
    ? [...ACTIVE_STATUSES]
    : value.split(",").filter((status) => ALL_STATUSES.includes(status));
}

export function WorkDashboardView({
  selectedItemId,
}: {
  readonly selectedItemId?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items"],
    queryFn: fetchWorkItems,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const boardView = searchParams.get("view") === "board";

  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: () => fetchWorkItem(selectedItemId as string),
    enabled: selectedItemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  const initialFilters = useMemo(
    () => readFilters(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );

  const initialSorting = useMemo((): SortingState => {
    const sortParam = searchParams.get("sort");
    if (sortParam) {
      const desc = sortParam.startsWith("-");
      const id = desc ? sortParam.slice(1) : sortParam;
      return [{ id, desc }];
    }
    return [{ id: "rankScore", desc: true }];
  }, [searchParams]);

  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnFilters, setColumnFilters] =
    useState<ColumnFiltersState>(initialFilters);
  const [globalFilter, setGlobalFilter] = useState(searchParams.get("q") ?? "");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const syncUrl = useCallback(
    (
      newFilters: ColumnFiltersState,
      newSorting: SortingState,
      newQuery: string
    ) => {
      const rankRange =
        (newFilters.find((filter) => filter.id === "rankScore")?.value as
          | RankRange
          | undefined) ?? ([undefined, undefined] as RankRange);
      const valuesFor = (id: string): readonly string[] => {
        const value = newFilters.find((filter) => filter.id === id)?.value;
        return Array.isArray(value) ? (value as string[]) : [];
      };
      const sort = newSorting[0];
      router.replace(
        workViewHref(selectedItemId, searchParams, {
          type: valuesFor("type"),
          status: valuesFor("status"),
          project: valuesFor("projectId"),
          sort: sort ? `${sort.desc ? "-" : ""}${sort.id}` : null,
          query: newQuery,
          rankRange,
        }),
        { scroll: false }
      );
    },
    [router, searchParams, selectedItemId]
  );

  const openItem = useCallback(
    (item: WorkItemDto) => {
      openWorkItemPermalink(router, item.id, searchParams);
    },
    [router, searchParams]
  );

  const closeItem = useCallback(() => {
    closeWorkItemPermalink(router, searchParams);
  }, [router, searchParams]);

  const table = useReactTable({
    data: items,
    columns,
    meta: { isLoading } satisfies WorkTableMeta,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
      syncUrl(columnFilters, next, globalFilter);
    },
    onColumnFiltersChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(columnFilters) : updater;
      setColumnFilters(next);
      syncUrl(next, sorting, globalFilter);
    },
    onGlobalFilterChange: (updater) => {
      const next = functionalUpdate(updater, globalFilter);
      setGlobalFilter(next);
      syncUrl(columnFilters, sorting, next);
    },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    // Board mode shows every filtered row; only the table paginates.
    ...(boardView ? {} : { getPaginationRowModel: getPaginationRowModel() }),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: workItemGlobalFilterFn,
  });

  const rows = table.getRowModel().rows;

  const [focusedRowIndex, setFocusedRowIndex] = useState(-1);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (rows.length === 0) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusedRowIndex((prev) => Math.min(prev + 1, rows.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusedRowIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          if (focusedRowIndex >= 0 && focusedRowIndex < rows.length) {
            const row = rows[focusedRowIndex];
            if (row) {
              e.preventDefault();
              openItem(row.original);
            }
          }
          break;
        case "/":
          e.preventDefault();
          document
            .querySelector<HTMLInputElement>("[data-search-input]")
            ?.focus();
          break;
        case "Escape":
          if (selectedItemId) {
            closeItem();
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [rows, focusedRowIndex, selectedItemId, openItem, closeItem]);

  const visibleStatuses = readColumns(searchParams);

  const setView = (view: "board" | "table") => {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "board") params.set("view", "board");
    else params.delete("view");
    router.replace(
      selectedItemId
        ? workItemHref(selectedItemId, params)
        : workListHref(params),
      { scroll: false }
    );
  };

  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
        Work Dashboard
      </h1>

      <WorkBoardToolbar
        table={table}
        visibleStatuses={visibleStatuses}
        onVisibleStatusesChange={(updater) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set(
            "columns",
            functionalUpdate(updater, readColumns(params)).join(",")
          );
          router.replace(
            selectedItemId
              ? workItemHref(selectedItemId, params)
              : workListHref(params),
            { scroll: false }
          );
        }}
        showBoardColumns={boardView}
      >
        <fieldset
          className="inline-flex min-w-0 rounded-lg border bg-muted/30 p-1"
          aria-label="Work view"
        >
          <Button
            variant={boardView ? "ghost" : "secondary"}
            size="sm"
            className="h-7 gap-1.5"
            aria-pressed={!boardView}
            onClick={() => setView("table")}
          >
            <List className="size-3.5" />
            Table
          </Button>
          <Button
            variant={boardView ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5"
            aria-pressed={boardView}
            onClick={() => setView("board")}
          >
            <Columns3 className="size-3.5" />
            Board
          </Button>
        </fieldset>
        {!boardView && (
          <DataGridColumnVisibility
            table={table}
            trigger={
              <Button variant="outline" size="sm" className="h-9 gap-1.5">
                <Settings2 className="size-3.5" />
                Columns
              </Button>
            }
          />
        )}
      </WorkBoardToolbar>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      {!error && boardView && (
        <WorkBoardView
          table={table}
          visibleStatuses={visibleStatuses}
          isLoading={isLoading}
          onOpenItem={openItem}
          renderGoalLink={WorkGoalLink}
        />
      )}

      {!error && !boardView && (
        <DataGrid
          table={table}
          recordCount={items.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={openItem}
          tableLayout={{
            headerSticky: true,
            headerBackground: true,
            rowBorder: true,
            dense: true,
          }}
          tableClassNames={{
            bodyRow: "cursor-pointer",
          }}
          emptyMessage="No work items found."
        >
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination sizes={[25, 50, 100]} />
        </DataGrid>
      )}

      <WorkItemDetail
        item={selectedItemQuery.data ?? null}
        {...(selectedItemId !== undefined && { itemId: selectedItemId })}
        isLoading={selectedItemQuery.isLoading}
        error={selectedItemQuery.error}
        open={selectedItemId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeItem();
        }}
      />
    </div>
  );
}
