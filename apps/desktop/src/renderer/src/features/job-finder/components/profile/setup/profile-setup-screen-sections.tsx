import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FolderOpen,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type {
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProfileSetupStep,
  ResumeImportFieldCandidateSummary,
  ResumeImportProgressEvent,
} from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { cn } from "@renderer/lib/cn";
import { profileSetupStepDefinitions } from "./profile-setup-steps";
import { ResumeImportProgress } from "../resume-import-progress";
import {
  badgeVariantForSeverity,
  canClearReviewItem,
  canConfirmReviewItem,
  formatProfileSetupRequiredItemCount,
  formatReviewSeverity,
  formatReviewStatus,
  formatProfileSetupReviewValue,
  getReviewItemEditActionLabel,
  getReviewItemEditHint,
  getProfileSetupReviewItemCopy,
  isFinishBlockingReviewItem,
  isProfileSetupMissingFieldReviewItem,
  isProfileSetupPathStepComplete,
  type ProfileSetupPathStepReadiness,
  type ProfileSetupReviewItemDisplay,
  isBlockingPendingReviewItem,
  isOptionalPendingReviewItem,
} from "./profile-setup-screen-helpers";

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}% confidence`;
}

function getCandidateConflictLabel(
  candidate: ResumeImportFieldCandidateSummary | null,
): string | null {
  if (!candidate || (candidate.conflictChoices?.length ?? 0) < 2) {
    return null;
  }

  const sourceLabels = Array.from(
    new Set(
      (candidate.conflictChoices ?? []).map((choice) => choice.sourceLabel),
    ),
  );
  return sourceLabels.length > 0
    ? `Different values found in ${sourceLabels.join(" and ")}.`
    : "Different imported values need review.";
}

/**
 * The guided-setup entry card. It renders only before setup has started: once
 * a step is open, setup is the step editor plus the stepper and sticky footer,
 * with no summary strip above it.
 */
export function ProfileSetupSummaryCards(props: {
  actionMessage: string | null;
  importDisabledReason?: string | null;
  /** Set when the last import was cut off by the app closing. */
  interruptedImportMessage?: string | null;
  interruptedImportFileName?: string | null;
  /** Imports that file again from the copy the stopped import saved. */
  onRetryInterruptedImport?: () => void;
  isImportResumePending: boolean;
  isProfileSetupPending: boolean;
  resumeImportProgress: ResumeImportProgressEvent | null;
  hasImportedResume: boolean;
  onImportResume: () => void;
  onStartManually: () => void;
  profileSetupState: ProfileSetupState;
}) {
  const importDisabledReasonId = useId();
  // The import control mirrors the shared Button pending contract: in-flight
  // work keeps it focusable via aria-disabled/aria-busy with guarded
  // activation, while a hard import guard (no workspace write access,
  // unsupported file, …) keeps native disabled semantics. Manual setup only
  // waits for an actual processing event, not the unresolved native picker;
  // this leaves a recovery path if a local pending lifecycle goes stale after
  // the picker closes or the renderer remounts. The visible reason text is
  // associated with the import control through aria-describedby.
  const isImportControlLocked =
    props.isImportResumePending || props.isProfileSetupPending;
  const isManualControlLocked = props.isProfileSetupPending;
  const isImportDisabledByReason = Boolean(props.importDisabledReason);
  const isPristine =
    props.profileSetupState.status === "not_started" &&
    !props.hasImportedResume;

  if (isPristine) {
    return (
      <Card className="min-w-0 overflow-hidden border-(--surface-panel-border) bg-(--surface-panel)">
        <CardHeader className="gap-3 border-b border-border/30 pb-5">
          <CardTitle>Start with the resume you already have.</CardTitle>
          <CardDescription className="max-w-2xl">
            Job Finder fills in your profile from it and asks only about the
            gaps. The file stays on this device. The text read from it is sent
            to Job Finder&apos;s AI to fill in your profile; nothing is sent
            anywhere else.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 pt-6">
          {props.interruptedImportMessage ? (
            <div
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) p-3 text-sm leading-6 text-(--warning-text)"
              data-profile-setup-import-interrupted
              role="status"
            >
              <p className="min-w-0 flex-1 basis-80">
                {props.interruptedImportMessage}
              </p>
              {props.onRetryInterruptedImport &&
              props.interruptedImportFileName ? (
                <Button
                  disabled={Boolean(props.importDisabledReason)}
                  onClick={props.onRetryInterruptedImport}
                  pending={props.isImportResumePending}
                  size="compact"
                  type="button"
                  variant="outline"
                >
                  Import {props.interruptedImportFileName} again
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="grid items-stretch gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <button
              // F49: this card was `bg-foreground text-background`, which in
              // dark mode paints a ~650x195px near-white slab carrying a
              // near-black CTA - the exact inverse of the primary treatment
              // the user learns everywhere else, and the lowest-contrast text
              // measured in either theme. It now uses the app's own primary
              // accent on the normal surface, so the recommended path reads as
              // recommended without inverting the theme.
              className="group flex h-full flex-col rounded-(--radius-field) border border-primary/45 bg-primary/10 p-5 text-left transition-colors hover:border-primary hover:bg-primary/15"
              data-profile-setup-import-path
              aria-busy={props.isImportResumePending || undefined}
              aria-describedby={
                isImportDisabledByReason ? importDisabledReasonId : undefined
              }
              aria-disabled={isImportControlLocked || undefined}
              disabled={isImportDisabledByReason && !isImportControlLocked}
              onClick={(event) => {
                if (isImportControlLocked) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                props.onImportResume();
              }}
              type="button"
            >
              <span className="sr-only">Recommended. </span>
              <span className="inline-flex w-fit items-center gap-2 rounded-(--radius-button) border border-primary-fill bg-primary-fill px-4 py-2 font-semibold text-primary-fill-foreground shadow-[0_1px_0_var(--surface-inset-highlight)] group-hover:bg-primary-fill/90">
                <FolderOpen className="size-4 shrink-0" />
                {props.isImportResumePending
                  ? props.resumeImportProgress === null
                    ? "File browser open…"
                    : "Importing resume…"
                  : "Choose my resume file"}
              </span>
              <span className="mt-3 block text-sm leading-6 text-foreground-soft">
                PDF, DOCX, TXT, or Markdown. You review everything before it is
                used.
              </span>
              <span className="mt-1 block text-(length:--text-small) leading-5 text-foreground-muted">
                Scanned image PDFs have no readable text.
              </span>
            </button>
            <button
              className="group flex h-full flex-col rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel) p-5 text-left transition-colors hover:border-(--control-border-hover) hover:bg-secondary/35"
              data-profile-setup-manual-path
              aria-busy={props.isProfileSetupPending || undefined}
              aria-disabled={isManualControlLocked || undefined}
              onClick={(event) => {
                if (isManualControlLocked) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                props.onStartManually();
              }}
              type="button"
            >
              <span className="block font-semibold text-foreground">
                Enter details manually
              </span>
              <span className="mt-2 block text-sm leading-6 text-foreground-soft">
                {props.isImportResumePending &&
                props.resumeImportProgress === null
                  ? "If the file browser does not return, continue here with contact details and target roles."
                  : "Begin with contact details and target roles; add the rest when it becomes useful."}
              </span>
              {/* Both paths carry a real button face; a text link beside a
                  filled card made the second path read as an afterthought. */}
              <span className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-(--radius-button) border border-(--border-strong) bg-background px-4 py-2 pt-2 text-sm font-semibold text-foreground group-hover:bg-secondary/50">
                {props.isImportResumePending &&
                props.resumeImportProgress !== null
                  ? "Stop import and start manually"
                  : "Start manually"}
                <ArrowRight aria-hidden className="size-4" />
              </span>
            </button>
          </div>
          {/* Right under the button that started it: below the setup list it
              fell under the fold at a normal window height (N-006). */}
          <ResumeImportProgress
            isPending={props.isImportResumePending}
            progress={props.resumeImportProgress}
          />
          {props.importDisabledReason ? (
            <p
              className="text-sm leading-6 text-foreground-soft"
              id={importDisabledReasonId}
            >
              {props.importDisabledReason}
            </p>
          ) : null}
          {/* The first thing a new person reads. It was set at the small
              scale in the softest text colour, which made the one list that
              explains the whole flow the least legible block on the screen.
              It reads at the body scale in the body colour now. */}
          <div className="rounded-(--radius-field) border border-border/25 bg-background/60 p-4">
            <p className="text-(length:--text-body) font-semibold text-(--text-headline)">
              What guided setup will ask for
            </p>
            <ul className="mt-2 grid list-none gap-1.5 p-0 text-(length:--text-body) leading-7 text-foreground">
              <li>Your resume, or the same details entered by hand.</li>
              <li>At least one contact method, such as an email address.</li>
              <li>
                Where you can work, and whether you would need visa sponsorship:
                application forms ask both.
              </li>
              <li>
                One public job page for Job Finder to search — for example, a
                job board you already browse.
              </li>
            </ul>
            <p className="mt-3 border-t border-border/25 pt-3 text-(length:--text-body) leading-7 text-foreground">
              Five short steps, saved as you go. Stop after any step and pick up
              later.
            </p>
          </div>
          {props.actionMessage ? (
            <div
              className="rounded-(--radius-field) border border-border/25 bg-background/70 p-4 text-sm text-foreground-soft"
              role="status"
            >
              {props.actionMessage}
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  // Non-pristine setup has no separate readiness strip. Guided setup keeps one
  // readiness system: the stepper chips carry per-step review counts, and the
  // sticky footer states whether setup can finish and what is still needed.
  // The strip used to restate both with different numbers, and it also pinned
  // the last "Saved. Next: …" confirmation onto the step it had already
  // reached.
  return null;
}

export function ProfileSetupPathCard(props: {
  currentStep: ProfileSetupStep;
  unsavedSteps?: readonly ProfileSetupStep[];
  disabled?: boolean;
  /** Omitted means no imported resume: the Import row must then never read complete. */
  hasImportedResume?: boolean;
  onGoToStep: (step: ProfileSetupStep) => void;
  profileSetupState: ProfileSetupState;
  /**
   * Draft readiness evidence for honest per-step Complete badges; omitted or
   * null keeps the legacy chronology-only badges.
   */
  readiness?: ProfileSetupPathStepReadiness | null;
  /**
   * Draft-aware review items so stepper badges match the review queue.
   * Saved `profileSetupState.reviewItems` alone can still show "to review"
   * after the draft already filled the flagged field.
   */
  reviewItems?: ProfileSetupState["reviewItems"];
}) {
  // One compact horizontal stepper row: step name plus a small state badge.
  // Every step stays a real button (clickable, keyboard reachable) and the
  // row wraps onto a second line at narrow widths instead of scrolling.
  return (
    <nav
      aria-label="Setup steps"
      className="min-w-0"
      data-profile-setup-stepper
    >
      <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {profileSetupStepDefinitions.map((step, index) => {
          const isActive = props.currentStep === step.id;
          const stepReviewItems = (
            props.reviewItems ?? props.profileSetupState.reviewItems
          ).filter((item) => item.step === step.id);
          const pendingReviewCount = stepReviewItems.filter(
            isBlockingPendingReviewItem,
          ).length;
          // The chip counts exactly what the footer refuses to finish on.
          // Counting a different set is what left "1 required setup item"
          // standing on a step whose fields were all filled in.
          const requiredSetupItemCount = stepReviewItems.filter(
            isFinishBlockingReviewItem,
          ).length;
          const importedReviewCount =
            pendingReviewCount - requiredSetupItemCount;
          const optionalReviewCount = stepReviewItems.filter(
            isOptionalPendingReviewItem,
          ).length;
          const hasUnsavedChanges =
            props.unsavedSteps?.includes(step.id) ?? false;
          const awaitingImportedReview =
            props.hasImportedResume &&
            props.profileSetupState.status !== "completed" &&
            ["essentials", "background"].includes(step.id) &&
            !props.profileSetupState.reviewedSteps?.includes(step.id);
          const isComplete =
            !awaitingImportedReview &&
            !hasUnsavedChanges &&
            ((props.profileSetupState.reviewedSteps?.includes(step.id) &&
              requiredSetupItemCount === 0) ||
              isProfileSetupPathStepComplete({
                currentStep: props.currentStep,
                hasImportedResume: props.hasImportedResume ?? false,
                pendingBlockingReviewCount: pendingReviewCount,
                readiness: props.readiness ?? null,
                setupStatus: props.profileSetupState.status,
                stepId: step.id,
              }));
          const stateBadge =
            awaitingImportedReview &&
            !hasUnsavedChanges &&
            requiredSetupItemCount === 0
              ? { label: "Ready to review", variant: "outline" as const }
              : hasUnsavedChanges
                ? { label: "Unsaved changes", variant: "outline" as const }
                : requiredSetupItemCount > 0
                  ? {
                      label: formatProfileSetupRequiredItemCount(
                        requiredSetupItemCount,
                      ),
                      variant: "status" as const,
                    }
                  : importedReviewCount > 0
                    ? {
                        // F30: imported suggestions do not gate finishing setup,
                        // so the chip must not use the attention tone or the words
                        // "to review" - that is what let the stepper say
                        // "Basics 2 TO REVIEW" in the same viewport as
                        // "Everything required is in. You can finish setup."
                        label: `${importedReviewCount} suggested`,
                        variant: "outline" as const,
                      }
                    : optionalReviewCount > 0
                      ? {
                          label: `${optionalReviewCount} optional`,
                          variant: "outline" as const,
                        }
                      : // A step nothing depends on must keep saying so even when
                        // it has no pending suggestions left; otherwise it reads
                        // as mandatory in the stepper.
                        step.optional && !isComplete
                        ? { label: "Optional", variant: "outline" as const }
                        : null;

          return (
            <li className="min-w-0" key={step.id}>
              <button
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "inline-flex min-h-9 max-w-full items-center gap-2 rounded-(--radius-field) border px-2.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
                  isActive
                    ? "border-primary bg-accent text-(--text-headline) shadow-[inset_0_-2px_0_var(--primary)]"
                    : "border-border/30 bg-background/50 text-foreground-soft hover:border-border hover:bg-secondary/35 hover:text-foreground",
                )}
                data-profile-setup-stepper-step={step.id}
                disabled={props.disabled}
                onClick={() => props.onGoToStep(step.id)}
                title={step.summary}
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-(length:--text-tiny) font-semibold",
                    isComplete
                      ? "border-transparent bg-(--success-surface,transparent) text-(--success-text,inherit)"
                      : isActive
                        ? "border-primary text-(--text-headline)"
                        : "border-border/50 text-foreground-muted",
                  )}
                >
                  {isComplete ? <CheckCircle2 className="size-4" /> : index + 1}
                </span>
                <span className="truncate text-sm font-medium">
                  {step.label}
                </span>
                {/* The numbered circle already turns into a check, so a second
                    "Complete" chip only widened the chip and reflowed the
                    whole stepper (and the page under it) on every advance. */}
                {isComplete ? <span className="sr-only">Complete</span> : null}
                {stateBadge ? (
                  <Badge className="shrink-0" variant={stateBadge.variant}>
                    {stateBadge.label}
                  </Badge>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function ProfileSetupReviewQueueCard(props: {
  compact?: boolean;
  title?: string;
  description?: string;
  getSavedValue?: (item: ProfileSetupReviewItemDisplay) => string | null;
  actionsDisabledReason?: string | null;
  isReviewItemPending: (reviewItemId: string) => boolean;
  items: readonly ProfileSetupReviewItemDisplay[];
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  onApplyReviewAction: (
    reviewItemId: string,
    action: "confirm" | "dismiss" | "clear_value",
    options?: ProfileSetupReviewActionOptions,
  ) => void;
  onEditReviewItem: (item: ProfileSetupReviewItemDisplay) => void;
}) {
  const [pendingReviewAction, setPendingReviewAction] = useState<{
    action: "confirm" | "dismiss" | "clear_value";
    selectedConflictChoiceId?: string;
    reviewItemId: string;
  } | null>(null);
  const resumeImportCandidateById = new Map(
    props.latestResumeImportReviewCandidates.map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  // The same "edit this in <step>" sentence used to repeat above every row.
  // One deduplicated list per queue says the same thing without the noise.
  const queueEditHints = Array.from(
    new Set(
      props.items
        .map((item) => getReviewItemEditHint(item))
        .filter((hint): hint is string => Boolean(hint)),
    ),
  );
  const isPendingReviewActionStillPending = pendingReviewAction
    ? props.isReviewItemPending(pendingReviewAction.reviewItemId)
    : false;

  useEffect(() => {
    if (!pendingReviewAction || isPendingReviewActionStillPending) {
      return;
    }

    setPendingReviewAction(null);
  }, [isPendingReviewActionStillPending, pendingReviewAction]);

  const isReviewActionPending = (
    reviewItemId: string,
    action?: "confirm" | "dismiss" | "clear_value",
    selectedConflictChoiceId?: string,
  ) =>
    props.isReviewItemPending(reviewItemId) &&
    pendingReviewAction?.reviewItemId === reviewItemId &&
    (!action || pendingReviewAction.action === action) &&
    (!selectedConflictChoiceId ||
      pendingReviewAction.selectedConflictChoiceId ===
        selectedConflictChoiceId);

  const applyReviewAction = (
    reviewItemId: string,
    action: "confirm" | "dismiss" | "clear_value",
    options?: ProfileSetupReviewActionOptions,
  ) => {
    setPendingReviewAction(
      options?.selectedConflictChoiceId
        ? {
            action,
            reviewItemId,
            selectedConflictChoiceId: options.selectedConflictChoiceId,
          }
        : { action, reviewItemId },
    );
    props.onApplyReviewAction(reviewItemId, action, options);
  };

  // A card whose only content is "nothing to confirm" is a box that says
  // nothing; the step editor already has the room.
  const optionalItems = props.items.filter(
    (item) => item.severity === "optional",
  );
  const requiredItems = props.items.filter(
    (item) => item.severity !== "optional",
  );
  if (props.items.length === 0) {
    return null;
  }

  return (
    <Card
      className="min-h-0 flex-1 overflow-hidden rounded-(--radius-panel) border-border/40 scroll-mt-4 sm:scroll-mt-[8.25rem] xl:scroll-mt-[4.5rem]"
      id="profile-setup-review-queue"
      tabIndex={-1}
    >
      <CardHeader className="gap-2 border-b border-border/30 pb-5">
        {/* The stepper chip above owns the count for this step; this card
            owns the items themselves and never restates the number. */}
        <CardTitle>{props.title ?? "Still to confirm on this step"}</CardTitle>
        <CardDescription>
          {props.description ??
            "Imported suggestions stay here until you confirm, dismiss, or clear them. Required details stay here until you fill them in."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-6">
        {!props.compact && queueEditHints.length > 0 ? (
          <div
            className="grid gap-1 rounded-(--radius-field) border border-dashed border-border/40 bg-background/70 p-3 text-sm leading-6 text-foreground-soft"
            data-profile-setup-review-queue-edit-hint
          >
            {queueEditHints.map((hint) => (
              <p key={hint}>{hint}</p>
            ))}
          </div>
        ) : null}
        {props.items.length === 0 ? null : (
          <ScrollArea className="min-h-0 flex-1">
            <div
              className={`grid gap-3 pr-4 ${props.compact ? "md:grid-cols-2" : ""}`}
            >
              {[requiredItems, optionalItems].map((items, groupIndex) => {
                const cards = items.map((item) => {
                  const isRowReviewActionPending = isReviewActionPending(
                    item.id,
                  );
                  const itemCopy = getProfileSetupReviewItemCopy(item);
                  const savedValue = props.getSavedValue?.(item);
                  const editActionLabel = getReviewItemEditActionLabel(item);
                  const linkedCandidate = item.sourceCandidateId
                    ? (resumeImportCandidateById.get(item.sourceCandidateId) ??
                      null)
                    : null;
                  const conflictLabel =
                    getCandidateConflictLabel(linkedCandidate);

                  return (
                    <div
                      key={item.id}
                      id={
                        item.sourceCandidateId
                          ? `profile-import-review-${item.sourceCandidateId}`
                          : undefined
                      }
                      tabIndex={-1}
                      className="rounded-(--radius-field) border border-border/30 bg-background/50 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-foreground">
                              {itemCopy.label}
                            </p>
                            {/* One status badge per item: severity only while
                              the item is still pending; a resolved item
                              shows its outcome and whether it is saved. */}
                            {item.status === "pending" ? (
                              <Badge
                                variant={badgeVariantForSeverity(item.severity)}
                              >
                                {isFinishBlockingReviewItem(item) &&
                                isProfileSetupMissingFieldReviewItem(item)
                                  ? "Required"
                                  : formatReviewSeverity(item.severity)}
                              </Badge>
                            ) : (
                              <Badge
                                variant={
                                  item.statusSource === "draft"
                                    ? "status"
                                    : "default"
                                }
                              >
                                {formatReviewStatus(item.status)}
                                {item.statusSource === "draft"
                                  ? " · unsaved"
                                  : ""}
                              </Badge>
                            )}
                          </div>
                          {item.status === "pending" ? (
                            <p className="mt-2 text-sm leading-6 text-foreground-soft">
                              {itemCopy.reason}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {item.status === "pending" && savedValue ? (
                        <div className="mt-3 rounded-(--radius-field) border border-border/40 bg-background/70 p-3">
                          <p className="text-(length:--text-tiny) uppercase tracking-[0.2em] text-muted-foreground">
                            Currently saved
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {savedValue}
                          </p>
                        </div>
                      ) : null}
                      {item.status === "pending" && item.proposedValue ? (
                        <div className="mt-3 rounded-(--radius-field) border border-dashed border-border/40 bg-background/70 p-3">
                          <p className="text-(length:--text-tiny) uppercase tracking-[0.2em] text-muted-foreground">
                            Suggested value
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {formatProfileSetupReviewValue(item.proposedValue)}
                          </p>
                        </div>
                      ) : null}
                      {(linkedCandidate?.conflictChoices?.length ?? 0) >= 2 ? (
                        <div className="mt-3 rounded-(--radius-field) border border-(--surface-panel-border) p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-(length:--text-tiny) uppercase tracking-[0.2em] text-(--warning-text)">
                              Import comparison
                            </p>
                            {conflictLabel ? (
                              <Badge variant="status">Needs choice</Badge>
                            ) : null}
                          </div>
                          {conflictLabel ? (
                            <p className="mt-2 text-sm leading-6 text-foreground-soft">
                              {conflictLabel}
                            </p>
                          ) : null}
                          <div className="mt-3 grid gap-2">
                            {(linkedCandidate?.conflictChoices ?? []).map(
                              (choice) => (
                                <div
                                  className="rounded-(--radius-field) border border-border/30 bg-background/70 p-3"
                                  key={choice.id}
                                >
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge
                                        variant={
                                          choice.recommended
                                            ? "default"
                                            : "outline"
                                        }
                                      >
                                        {choice.recommended
                                          ? "Recommended"
                                          : "Alternative"}
                                      </Badge>
                                      <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                                        {choice.sourceLabel}
                                      </span>
                                      <span className="text-xs text-muted-foreground">
                                        {formatConfidence(choice.confidence)}
                                      </span>
                                    </div>
                                    {item.status === "pending" ? (
                                      <Button
                                        disabled={
                                          Boolean(
                                            props.actionsDisabledReason,
                                          ) ||
                                          props.isReviewItemPending(item.id) ||
                                          !canConfirmReviewItem(item)
                                        }
                                        pending={isReviewActionPending(
                                          item.id,
                                          "confirm",
                                          choice.id,
                                        )}
                                        onClick={() =>
                                          applyReviewAction(
                                            item.id,
                                            "confirm",
                                            {
                                              selectedConflictChoiceId:
                                                choice.id,
                                            },
                                          )
                                        }
                                        size="sm"
                                        type="button"
                                        variant={
                                          choice.recommended
                                            ? "primary"
                                            : "secondary"
                                        }
                                      >
                                        Use {choice.sourceLabel}
                                      </Button>
                                    ) : null}
                                  </div>
                                  <p className="mt-2 text-sm text-foreground">
                                    {formatProfileSetupReviewValue(
                                      choice.valuePreview ?? choice.value,
                                    ) ?? "Review this imported value."}
                                  </p>
                                  {choice.evidenceText ? (
                                    <p className="mt-1 text-xs leading-5 text-foreground-soft">
                                      {choice.evidenceText}
                                    </p>
                                  ) : null}
                                </div>
                              ),
                            )}
                          </div>
                        </div>
                      ) : null}
                      {item.sourceSnippet && !props.compact ? (
                        <div className="mt-3 flex gap-2 rounded-(--radius-field) bg-secondary/30 p-3 text-sm text-foreground-soft">
                          <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <p>{item.sourceSnippet}</p>
                        </div>
                      ) : null}
                      {item.status === "pending" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            aria-label={`${editActionLabel} ${itemCopy.label}`}
                            disabled={Boolean(props.actionsDisabledReason)}
                            onClick={() => props.onEditReviewItem(item)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            {editActionLabel}
                          </Button>
                          {canConfirmReviewItem(item) ? (
                            <Button
                              disabled={
                                Boolean(props.actionsDisabledReason) ||
                                props.isReviewItemPending(item.id) ||
                                (linkedCandidate?.conflictChoices?.length ??
                                  0) >= 2
                              }
                              pending={isRowReviewActionPending}
                              onClick={() =>
                                applyReviewAction(item.id, "confirm")
                              }
                              size="sm"
                              type="button"
                            >
                              Confirm
                            </Button>
                          ) : null}
                          {/* A field that was never set has nothing to clear;
                            offering "Clear current value" there reads as a
                            third mystery button. */}
                          {canClearReviewItem(item) &&
                          !isProfileSetupMissingFieldReviewItem(item) ? (
                            <Button
                              disabled={
                                Boolean(props.actionsDisabledReason) ||
                                props.isReviewItemPending(item.id)
                              }
                              pending={isRowReviewActionPending}
                              onClick={() =>
                                applyReviewAction(item.id, "clear_value")
                              }
                              size="sm"
                              type="button"
                              variant="secondary"
                            >
                              Clear current value
                            </Button>
                          ) : null}
                          {!(
                            isFinishBlockingReviewItem(item) &&
                            isProfileSetupMissingFieldReviewItem(item)
                          ) ? (
                            <Button
                              disabled={
                                Boolean(props.actionsDisabledReason) ||
                                props.isReviewItemPending(item.id)
                              }
                              pending={isRowReviewActionPending}
                              onClick={() =>
                                applyReviewAction(item.id, "dismiss")
                              }
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Dismiss for now
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {item.status === "pending" &&
                      props.actionsDisabledReason ? (
                        <p className="mt-2 text-(length:--text-tiny) text-muted-foreground">
                          {props.actionsDisabledReason}
                        </p>
                      ) : null}
                    </div>
                  );
                });
                return groupIndex === 0 ? (
                  <div className="contents" key="required">
                    {cards}
                  </div>
                ) : items.length > 0 ? (
                  <details className="md:col-span-2" key="optional">
                    <summary className="cursor-pointer text-sm font-medium">
                      {items.length} optional suggestions
                    </summary>
                    <div className="mt-3 grid gap-3">{cards}</div>
                  </details>
                ) : null;
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
