// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/review/view`
 * Purpose: Single admin workspace for opening, finalizing, and publishing the oldest unfinished epoch work.
 * Scope: Composes existing governance hooks and actions. Does not perform server-side logic or construct transactions.
 * Invariants: OLDEST_FIRST, ONE_PRIMARY_ACTION, PINNED_APPROVERS_CAN_FINISH, WRITE_ROUTES_APPROVER_GATED.
 * Side-effects: IO (via existing review, finalize, and publish hooks)
 * Links: src/features/governance/hooks/useFinishEpochWorkspace.ts, task.5038
 * @public
 */

"use client";

import {
  CheckCircle2,
  ExternalLink,
  FileSignature,
  Loader2,
  Lock,
  Pencil,
  Pin,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  type Phase,
  PhaseList,
  TableCell,
  TableRow,
} from "@/components";
import {
  receiptTitle,
  TYPE_ICONS,
  TYPE_LABELS,
} from "@/features/governance/components/ContributionRow";
import { EpochDetail } from "@/features/governance/components/EpochDetail";
import { EpochReviewAction } from "@/features/governance/components/EpochReviewAction";
import { ExecuteDistributionPanel } from "@/features/governance/components/ExecuteDistributionPanel";
import { SourceBadge } from "@/features/governance/components/SourceBadge";
import {
  type FinishEpochSelection,
  isEligibleForFinishEpochWork,
  useFinishEpochWorkspace,
} from "@/features/governance/hooks/useFinishEpochWorkspace";
import { useOpenEpochReview } from "@/features/governance/hooks/useOpenEpochReview";
import {
  type ReviewSubjectOverrideView,
  useReviewSubjectOverrides,
} from "@/features/governance/hooks/useReviewSubjectOverrides";
import { useSignEpoch } from "@/features/governance/hooks/useSignEpoch";
import { applyOverridesToEpochView } from "@/features/governance/lib/compose-epoch";
import type {
  EpochContributor,
  EpochView,
  IngestionReceipt,
} from "@/features/governance/types";

interface ReviewViewProps {
  readonly walletAddress: string | null;
  readonly isCurrentApprover: boolean;
  readonly operatorSetupUrl: string;
}

function workflowPhases(
  selection: FinishEpochSelection | null,
  lifecycleUnavailable: boolean,
  recentlyPublished: boolean
): readonly Phase[] {
  if (recentlyPublished) {
    return [
      { label: "Open review", state: "done" },
      { label: "Sign and finalize", state: "done" },
      {
        label: "Publish",
        state: "done",
        detail: "Latest global settlement confirmed",
      },
    ];
  }
  if (!selection) {
    return [
      { label: "Open review", state: "done" },
      { label: "Sign and finalize", state: "done" },
      {
        label: "Publish",
        state: lifecycleUnavailable ? "error" : "done",
        detail: lifecycleUnavailable
          ? "Couldn’t verify the latest global settlement."
          : "The latest global settlement is live.",
      },
    ];
  }
  if (selection.kind === "open_review") {
    return [
      { label: "Open review", state: "active", detail: "Next action" },
      { label: "Sign and finalize", state: "pending" },
      { label: "Publish", state: "pending" },
    ];
  }
  if (selection.kind === "finalize") {
    return [
      { label: "Open review", state: "done" },
      { label: "Sign and finalize", state: "active", detail: "Next action" },
      { label: "Publish", state: "pending" },
    ];
  }
  return [
    { label: "Open review", state: "done" },
    { label: "Sign and finalize", state: "done" },
    {
      label: "Publish",
      state: "active",
      detail: "Publish the latest global settlement",
    },
  ];
}

export function ReviewView({
  walletAddress,
  isCurrentApprover,
  operatorSetupUrl,
}: ReviewViewProps): ReactElement {
  const { data, isLoading, error } = useFinishEpochWorkspace();
  const openReview = useOpenEpochReview();
  const [publishedExplorerUrl, setPublishedExplorerUrl] = useState<
    string | null
  >(null);

  if (error) {
    return (
      <div className="border-destructive bg-destructive/10 rounded-lg border p-6">
        <h2 className="text-destructive text-lg font-semibold">
          Error loading review data
        </h2>
        <p className="text-muted-foreground text-sm">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="bg-muted h-8 w-64 rounded-md" />
        <div className="bg-muted h-64 rounded-lg" />
      </div>
    );
  }

  const { selection, epochView, lifecycleUnavailable } = data;
  const canAct = selection
    ? isEligibleForFinishEpochWork({
        selection,
        walletAddress,
        isCurrentApprover,
      })
    : false;
  const period = selection
    ? `${new Date(selection.epoch.periodStart).toLocaleDateString()} — ${new Date(
        selection.epoch.periodEnd
      ).toLocaleDateString()}`
    : null;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-bold text-3xl tracking-tight">Finish epoch</h1>
        <p className="max-w-2xl text-muted-foreground text-sm">
          One workspace for the next review, finalization, or publication step.
        </p>
      </header>

      <section
        aria-labelledby="finish-progress-title"
        aria-live="polite"
        className="rounded-lg border bg-card p-4 sm:p-6"
      >
        <div className="mb-4 space-y-1">
          <h2 id="finish-progress-title" className="font-semibold">
            {selection ? `Epoch #${selection.epoch.id}` : "All epoch work"}
          </h2>
          {period ? (
            <p className="text-muted-foreground text-sm">{period}</p>
          ) : null}
        </div>
        <PhaseList
          phases={workflowPhases(
            selection,
            lifecycleUnavailable,
            publishedExplorerUrl !== null
          )}
        />
      </section>

      {publishedExplorerUrl ? (
        <Alert>
          <AlertTitle>Latest settlement published</AlertTitle>
          <AlertDescription>
            The transaction is confirmed.{" "}
            <a
              href={publishedExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              View transaction
            </a>
          </AlertDescription>
        </Alert>
      ) : !selection ? (
        lifecycleUnavailable ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Couldn’t verify publication</AlertTitle>
            <AlertDescription>
              Review and finalization are caught up, but the latest global
              settlement could not be checked. No publish action is available.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border bg-card p-5">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            <div>
              <h2 className="font-semibold">All caught up</h2>
              <p className="mt-1 text-muted-foreground text-sm">
                There is no ended epoch to review and the latest global
                settlement is published.
              </p>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {!canAct ? <LockedActionNotice selection={selection} /> : null}

          {selection.kind === "open_review" && epochView ? (
            <div className="space-y-4">
              <EpochDetail epoch={epochView} />
              {canAct ? (
                <EpochReviewAction
                  status="open"
                  reviewReady
                  isApprover
                  isPending={openReview.isPending}
                  error={openReview.error}
                  onOpen={() => openReview.mutate(selection.epoch.id)}
                  onContinue={() => undefined}
                />
              ) : null}
            </div>
          ) : null}

          {selection.kind === "finalize" && epochView ? (
            canAct ? (
              <ReviewEpochSection epoch={epochView} />
            ) : (
              <EpochDetail epoch={epochView} />
            )
          ) : null}

          {selection.kind === "publish" ? (
            <div className="space-y-4">
              {selection.lifecycle ? (
                <p className="text-muted-foreground text-sm">
                  {selection.lifecycle.publishedLiabilityCount === null
                    ? "Publication coverage is unknown. The chain read will verify safety before any action appears."
                    : `${selection.lifecycle.publishedLiabilityCount} of ${selection.lifecycle.settledLiabilityCount} settled allocations are published.`}
                </p>
              ) : null}
              {canAct ? (
                <ExecuteDistributionPanel
                  epochId={selection.epoch.id}
                  operatorSetupUrl={operatorSetupUrl}
                  onConfirmed={setPublishedExplorerUrl}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}

function LockedActionNotice({
  selection,
}: {
  readonly selection: FinishEpochSelection;
}): ReactElement {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-4">
      <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div>
        <h2 className="font-semibold">View only</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {selection.kind === "open_review"
            ? "A current ledger approver must open this review."
            : "A current or pinned approver must complete this step."}
        </p>
      </div>
    </div>
  );
}

// ── Per-epoch review section ─────────────────────────────────────────────────

function ReviewEpochSection({
  epoch,
}: {
  readonly epoch: EpochView;
}): ReactElement {
  const { state, sign, reset } = useSignEpoch(epoch.id);
  const overrides = useReviewSubjectOverrides(epoch.id);

  // Recompute contributor sums with overrides applied
  const adjustedEpoch = useMemo(
    () => applyOverridesToEpochView(epoch, overrides.overridesByRef),
    [epoch, overrides.overridesByRef]
  );

  const handleSign = useCallback(() => {
    void sign();
  }, [sign]);

  const renderExpandedRows = useCallback(
    (contributor: EpochContributor): ReactElement[] | null => {
      if (contributor.receipts.length === 0) return null;
      return contributor.receipts.map((receipt) => (
        <ReviewReceiptRow
          key={receipt.receiptId}
          receipt={receipt}
          override={overrides.overridesByRef.get(receipt.receiptId) ?? null}
          onSave={overrides.saveOverride}
          onRemove={overrides.removeOverride}
          isSaving={overrides.isSaving}
        />
      ));
    },
    [overrides]
  );

  const activeOverrideCount = overrides.overridesByRef.size;

  return (
    <div className="space-y-4">
      {activeOverrideCount > 0 && (
        <div className="border-warning/30 bg-warning/5 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Pencil className="text-warning h-3.5 w-3.5" />
          <span className="text-warning">
            {activeOverrideCount} active weight{" "}
            {activeOverrideCount === 1 ? "override" : "overrides"}
          </span>
          <span className="text-muted-foreground">
            — expand contributions to view or edit
          </span>
        </div>
      )}

      <EpochDetail
        epoch={adjustedEpoch}
        renderExpandedRows={renderExpandedRows}
      />

      <div className="bg-card flex flex-wrap items-center gap-3 rounded-lg border p-4">
        {state.phase === "IDLE" && (
          <Button onClick={handleSign}>
            <FileSignature className="mr-2 h-4 w-4" />
            Sign & Finalize
          </Button>
        )}

        {state.isInFlight && (
          <Button disabled>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {state.phase === "FETCHING_DATA" && "Preparing..."}
            {state.phase === "AWAITING_SIGNATURE" && "Awaiting wallet..."}
            {state.phase === "SUBMITTING" && "Submitting..."}
          </Button>
        )}

        {state.phase === "SUCCESS" && (
          <div className="text-success flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4" />
            <span>Finalization started (workflow: {state.workflowId})</span>
          </div>
        )}

        {state.phase === "ERROR" && (
          <div className="flex items-center gap-3">
            <div className="text-destructive text-sm">{state.errorMessage}</div>
            <Button size="sm" onClick={reset}>
              Try Again
            </Button>
          </div>
        )}

        <p className="text-muted-foreground w-full text-xs">
          Verify the deployment environment shown in your wallet. This signature
          cannot be reused in another environment.
        </p>
      </div>
    </div>
  );
}

// ── Receipt row with inline override editing ────────────────────────────────

function ReviewReceiptRow({
  receipt,
  override,
  onSave,
  onRemove,
  isSaving,
}: {
  readonly receipt: IngestionReceipt;
  readonly override: ReviewSubjectOverrideView | null;
  readonly onSave: (
    subjectRef: string,
    overrideUnits: string,
    reason?: string
  ) => Promise<void>;
  readonly onRemove: (subjectRef: string) => Promise<void>;
  readonly isSaving: boolean;
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [editUnits, setEditUnits] = useState(override?.overrideUnits ?? "");
  const [editReason, setEditReason] = useState(override?.overrideReason ?? "");

  const handleStartEdit = useCallback(() => {
    setEditUnits(override?.overrideUnits ?? "");
    setEditReason(override?.overrideReason ?? "");
    setIsEditing(true);
  }, [override]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editUnits.trim() || !/^\d+$/.test(editUnits.trim())) return;
    try {
      await onSave(
        receipt.receiptId,
        editUnits.trim(),
        editReason.trim() || undefined
      );
      setIsEditing(false);
    } catch {
      // Mutation error is surfaced via useReviewSubjectOverrides hook state
    }
  }, [receipt.receiptId, editUnits, editReason, onSave]);

  const handleRemove = useCallback(async () => {
    try {
      await onRemove(receipt.receiptId);
    } catch {
      // Mutation error is surfaced via useReviewSubjectOverrides hook state
    }
  }, [receipt.receiptId, onRemove]);

  const hasOverride = override !== null;
  const Icon = TYPE_ICONS[receipt.eventType] ?? Pin;
  const title = receiptTitle(receipt);
  const score = receipt.units;

  // Editing mode: use a colSpan row for the inline form
  if (isEditing) {
    return (
      <TableRow className="bg-primary/5 hover:bg-primary/5">
        <TableCell colSpan={6} className="p-2">
          <div className="space-y-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Icon className="text-muted-foreground h-3.5 w-3.5" />
              <SourceBadge source={receipt.source as "github" | "discord"} />
              <span className="text-muted-foreground text-xs">
                {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
              </span>
              {title && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-foreground/80 truncate text-xs">
                    {title}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-col items-stretch gap-2 pl-1 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`override-units-${receipt.receiptId}`}
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  Override weight (units)
                </label>
                <Input
                  id={`override-units-${receipt.receiptId}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={editUnits}
                  onChange={(e) => setEditUnits(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. 500"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`override-reason-${receipt.receiptId}`}
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  Reason (optional)
                </label>
                <Input
                  id={`override-reason-${receipt.receiptId}`}
                  type="text"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. trivial fix"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleSave();
                }}
                disabled={
                  isSaving ||
                  !editUnits.trim() ||
                  !/^\d+$/.test(editUnits.trim())
                }
              >
                <Save className="mr-1 h-3 w-3" />
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                aria-label="Cancel weight adjustment"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancel();
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow
      className={
        hasOverride
          ? "border-warning/20 bg-warning/5 hover:bg-warning/10"
          : "hover:bg-muted/20"
      }
    >
      {/* Chevron column — empty */}
      <TableCell className="w-8 px-2" />
      {/* # column — type icon */}
      <TableCell className="w-10 text-center">
        <Icon className="text-muted-foreground mx-auto h-3.5 w-3.5" />
      </TableCell>
      {/* Contributor column — source + type + title + override badge */}
      <TableCell>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <SourceBadge source={receipt.source as "github" | "discord"} />
          <span className="text-muted-foreground shrink-0 text-xs">
            {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
          </span>
          {title && (
            <>
              <span className="text-muted-foreground/40">·</span>
              {receipt.artifactUrl ? (
                <a
                  href={receipt.artifactUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group text-foreground/80 hover:text-foreground flex min-w-0 items-center gap-1 text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{title}</span>
                  <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ) : (
                <span className="text-foreground/80 truncate text-xs">
                  {title}
                </span>
              )}
            </>
          )}
          {hasOverride && override.overrideReason && (
            <Badge intent="secondary" size="sm" className="h-5 shrink-0 px-1.5">
              {override.overrideReason}
            </Badge>
          )}
        </div>
      </TableCell>
      {/* Share column — empty */}
      <TableCell className="text-right" />
      {/* Score column — includes edit/reset buttons */}
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          {score != null && hasOverride ? (
            <span className="font-mono text-xs">
              <span className="text-muted-foreground/50 line-through">
                {score}
              </span>
              <span className="text-muted-foreground/40">{" → "}</span>
              <span className="text-warning">{override.overrideUnits}</span>
            </span>
          ) : score != null ? (
            <span className="text-muted-foreground font-mono text-xs">
              {score}
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 min-w-11 px-2"
              aria-label="Adjust weight"
              onClick={(e) => {
                e.stopPropagation();
                handleStartEdit();
              }}
              title="Adjust weight"
            >
              <Pencil className="h-3 w-3" />
            </Button>
            {hasOverride && (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
                aria-label="Reset to original weight"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemove();
                }}
                disabled={isSaving}
                title="Reset to original"
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}
