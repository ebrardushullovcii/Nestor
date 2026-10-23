import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Download,
  Save,
  ShieldOff,
  TriangleAlert,
} from "lucide-react";
import {
  isBlockingResumeValidationIssue,
  type ResumeValidationIssue,
} from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { getJobFinderScrollBehavior } from "../../lib/job-finder-scroll-behavior";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@renderer/components/ui/tabs";
import {
  getResumeValidationIssueTargetId,
  ResumeValidationIssueList,
} from "./resume-validation-issue-list";
import {
  RESUME_STUDIO_ATTENTION_PANEL_SELECTOR,
  ResumeStudioAttentionPanel,
} from "./resume-studio-attention-panel";
import { useDesktopStudioLayout } from "./use-desktop-studio-layout";
import type { ResumeReviewFlow } from "./resume-review-session";
import {
  eventMatchesJobFinderShortcut,
  formatJobFinderShortcutCombo,
  getJobFinderAriaKeyshortcuts,
  isImeComposingEvent,
  RESUME_REVIEW_APPROVE_AND_NEXT_COMBO,
} from "../../lib/job-finder-shortcuts";

/**
 * The studio's compact tab surface. The Assistant is deliberately not a tab:
 * it is the same floating panel at every width, so switching tabs, opening it
 * or minimizing it never changes the studio layout.
 */
export type ResumeStudioMobileTab = "preview" | "editor";

interface ResumeWorkspaceStudioShellProps {
  /**
   * True while the Assistant is open. The studio then gives it a docked
   * right-hand column (the dock slot below) and narrows the panes beside it,
   * instead of letting a floating panel rest over the tools column.
   */
  assistantDocked?: boolean;
  approvalBlockedReason: string | null;
  approvalStateLabel: string | null;
  /**
   * Page count of the exact approved application PDF, when one exists. It
   * resolves the "creating the PDF in the background" promise into a
   * finished, inspectable fact instead of leaving present-tense work copy on
   * screen after approval.
   */
  approvedExportPageCount?: number | null;
  canApproveResume: boolean;
  canClearApproval: boolean;
  claimConfirmationPanel?: ReactNode;
  editorPanel: ReactNode;
  exportBlockedReason: string | null;
  exportBlockedActionLabel?: string;
  hasUnsavedChanges: boolean;
  historyPanel: ReactNode;
  /** Native PDF export is pending without invalidating a ready workspace. */
  isExportPending?: boolean;
  /** An application run is starting from this editor. */
  isApplyPending?: boolean;
  isWorkspacePending: boolean;
  mobileStudioTab: ResumeStudioMobileTab;
  onApproveCurrentPdf: () => void;
  canRestoreValidationIssuePreviousText?: (
    issue: ResumeValidationIssue,
  ) => boolean;
  canApproveClaim?: (issue: ResumeValidationIssue) => boolean;
  onApproveClaim?: (issue: ResumeValidationIssue) => void;
  onAskAiFix?: (issue: ResumeValidationIssue) => void;
  onRestoreValidationIssuePreviousText?: (issue: ResumeValidationIssue) => void;
  onClearApproval: () => void;
  onDismissSetAsideProposalNote?: () => void;
  /**
   * Set when approval had to resolve a still-pending Guided edits proposal.
   * Approval freezes one exact artifact, so an unresolved proposal cannot be
   * left hanging where accepting it would silently invalidate the approval.
   */
  setAsideProposalNote?: string;
  onContinueToShortlisted: () => void;
  onExportPdf: () => void;
  /**
   * Resolves an identity mismatch by recording that the imported document is
   * this person's, under a name they no longer use (ADR 0018 keeps the
   * honesty decision theirs). Absent when the caller cannot save a profile.
   */
  onClaimResumeIdentity?: () => void;
  onPrepareApplication?: () => void;
  onReviewBlockingIssues: () => void;
  /** Reopens the Assistant on a proposal approval set aside, so a discarded
   * suggestion stays inspectable and recoverable. */
  onReviewSetAsideProposal?: () => void;
  onSaveDraft: () => void;
  onSelectValidationIssue?: (
    issue: ResumeValidationIssue,
    targetId: string | null,
  ) => void;
  onSetMobileStudioTab: (tab: ResumeStudioMobileTab) => void;
  /**
   * Set when this job sends the imported file unchanged. The draft here is
   * never sent, so the header says that and offers the one press that writes
   * an editable resume at the saved level instead of approval.
   */
  originalResume?: {
    levelLabel: string;
    filePanel?: ReactNode;
    /** The one-press route is running: the job is being moved and written. */
    writing?: boolean;
    onWriteEditableResume: () => void;
  } | null;
  previewPane: ReactNode;
  selectedTemplateApprovalEligible: boolean;
  supportingDetailsPanel?: ReactNode;
  studioStatusMessage: string;
  rewriteFailed?: boolean;
  templatePanel: ReactNode;
  validationIssues?: readonly ResumeValidationIssue[];
  /**
   * Set while this resume waits in "To review": the approve button becomes
   * "Approve and next" (Ctrl/Cmd+Enter), with the person's progress beside it.
   */
  reviewFlow?: ResumeReviewFlow | null;
}

// Only the displayed status row may be a live region, otherwise assistive tech
// announces every update twice.

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function describeApprovedPageCount(pageCount: number | null): string {
  if (pageCount === null || !Number.isFinite(pageCount) || pageCount < 1) {
    return "";
  }

  return ` · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

function StudioStatusRow(props: {
  approvalStateLabel: string | null;
  clearApprovalSlot: ReactNode;
  /** Plain text beside the toolbar instead of a boxed row of its own. */
  inline?: boolean;
  live: boolean;
  message: string;
}) {
  return (
    <div
      {...(props.live ? { "aria-live": "polite", role: "status" } : {})}
      className={
        props.inline
          ? "flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-(length:--text-small) leading-5 text-foreground-soft"
          : "flex flex-wrap items-center justify-between gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3 py-1.5 text-(length:--text-body) leading-6 text-foreground"
      }
      data-resume-studio-status
    >
      <span>{props.message}</span>
      <span className="flex flex-wrap items-center gap-2">
        {props.approvalStateLabel ? (
          <Badge variant="outline">{props.approvalStateLabel}</Badge>
        ) : null}
        {props.clearApprovalSlot}
      </span>
    </div>
  );
}

function StudioHistoryDisclosure(props: { children: ReactNode }) {
  return (
    <details className="group min-w-0 shrink-0" data-resume-history-disclosure>
      <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 rounded-(--radius-field) border border-(--control-border) bg-background/45 px-3 py-1.5 text-(length:--text-small) font-semibold text-(--text-headline) outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring">
        Version history
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="pt-2">{props.children}</div>
    </details>
  );
}

function StudioToolbar(props: {
  canDownloadPdf: boolean;
  isApproved: boolean;
  isExportPending: boolean;
  isWorkspacePending: boolean;
  onDownloadPdf: () => void;
  onSaveDraft: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        pending={props.isWorkspacePending}
        onClick={props.onSaveDraft}
        size="compact"
        title={
          props.isApproved
            ? "Saving a new draft clears the current approval; you will approve again."
            : "Save the current draft"
        }
        type="button"
        variant="secondary"
      >
        <Save className="size-4" />
        Save draft
      </Button>
      {/* "Refresh draft" here and "Retry with AI" in the disclosure were the
          same whole-draft rewrite under two names, neither of which said it
          discards your edits. Both now live in the Assistant. */}
      <Button
        disabled={
          !props.canDownloadPdf ||
          props.isWorkspacePending ||
          props.isExportPending
        }
        onClick={props.onDownloadPdf}
        pending={props.isExportPending}
        size="compact"
        title="Save an optional PDF copy to your computer"
        type="button"
        variant="secondary"
      >
        <Download className="size-4" />
        Download PDF
      </Button>
    </div>
  );
}

const RESUME_EDITOR_EDITABLE_CONTROL_SELECTOR = [
  'input:not([type="hidden"])',
  "textarea",
  "select",
  'button[role="checkbox"]',
  'button[role="switch"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
].join(", ");

type ResumeValidationFocusKind =
  | "exact"
  | "section"
  | "entry-fallback"
  | "section-fallback"
  | "identity-fallback"
  | "work-history";

interface ResumeValidationFocusResolution {
  kind: ResumeValidationFocusKind;
  target: HTMLElement;
}

function isDisabledEditorElement(element: HTMLElement): boolean {
  return (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled") === "true"
  );
}

function isReadOnlyEditorElement(element: HTMLElement): boolean {
  if (element.hasAttribute("readonly")) {
    return true;
  }

  if (!("readOnly" in element)) {
    return false;
  }

  return Boolean((element as HTMLInputElement | HTMLTextAreaElement).readOnly);
}

function hasHiddenEditorAncestor(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;

  while (current) {
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      (current.tagName === "DETAILS" && !(current as HTMLDetailsElement).open)
    ) {
      return true;
    }

    const computedStyle = window.getComputedStyle(current);
    if (
      computedStyle.display === "none" ||
      computedStyle.visibility === "hidden"
    ) {
      return true;
    }

    current = current.parentElement;
  }

  return false;
}

function isEditableEditorControl(element: HTMLElement): boolean {
  if (
    isDisabledEditorElement(element) ||
    isReadOnlyEditorElement(element) ||
    hasHiddenEditorAncestor(element)
  ) {
    return false;
  }

  return element.matches(RESUME_EDITOR_EDITABLE_CONTROL_SELECTOR);
}

function findRenderedEditorElement(
  elements: readonly HTMLElement[],
): HTMLElement | null {
  const rendered = elements.filter(
    (element) => !hasHiddenEditorAncestor(element),
  );

  return (
    rendered.find((element) => element.getClientRects().length > 0) ??
    rendered[0] ??
    null
  );
}

function findEnabledEditorControl(
  elements: readonly HTMLElement[],
): HTMLElement | null {
  const controls: HTMLElement[] = [];

  for (const element of elements) {
    if (isEditableEditorControl(element)) {
      controls.push(element);
    }

    controls.push(
      ...Array.from(
        element.querySelectorAll<HTMLElement>(
          RESUME_EDITOR_EDITABLE_CONTROL_SELECTOR,
        ),
      ).filter(isEditableEditorControl),
    );
  }

  return findRenderedEditorElement(
    controls.filter((element, index) => controls.indexOf(element) === index),
  );
}

function findRenderedEditorContainers(
  containers: readonly HTMLElement[],
  requireEditableControl: boolean,
): HTMLElement | null {
  const uniqueContainers = containers.filter(
    (container, index) => containers.indexOf(container) === index,
  );
  const renderedContainers = uniqueContainers.filter(
    (container) => !hasHiddenEditorAncestor(container),
  );
  const editableContainer = requireEditableControl
    ? renderedContainers.find((container) =>
        findEnabledEditorControl([container]),
      )
    : null;

  return editableContainer ?? findRenderedEditorElement(renderedContainers);
}

function getValidationSectionCandidates(
  issue: ResumeValidationIssue,
): HTMLElement[] {
  if (!issue.sectionId) {
    return [];
  }

  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-resume-editor-section]"),
  ).filter(
    (candidate) => candidate.dataset.resumeEditorSection === issue.sectionId,
  );
}

function getValidationEntryCandidates(
  issue: ResumeValidationIssue,
  sectionCandidates: readonly HTMLElement[],
): HTMLElement[] {
  if (!issue.entryId) {
    return [];
  }

  const entryCandidates = sectionCandidates.flatMap((section) =>
    Array.from(
      section.querySelectorAll<HTMLElement>("[data-resume-editor-entry]"),
    ).filter(
      (candidate) => candidate.dataset.resumeEditorEntry === issue.entryId,
    ),
  );

  return entryCandidates;
}

function resolveValidationFocusTarget(input: {
  issue: ResumeValidationIssue;
  targetId: string | null;
}): ResumeValidationFocusResolution | null {
  const { issue, targetId } = input;
  const exactCandidates = targetId
    ? Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-resume-editor-target="${targetId}"]`,
        ),
      )
    : [];
  const sectionCandidates = getValidationSectionCandidates(issue);
  const entryCandidates = getValidationEntryCandidates(
    issue,
    sectionCandidates,
  );
  const identityCandidates = targetId?.startsWith("identity:")
    ? Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-resume-identity-details]",
        ),
      )
    : [];

  if (issue.category === "work_history_review") {
    const decisionsTarget = findRenderedEditorElement(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-resume-work-history-decisions]",
        ),
      ),
    );

    if (decisionsTarget) {
      return { kind: "work-history", target: decisionsTarget };
    }
  }

  // An issue that only names a section has no stable field locator. Land on
  // the section card so the user gets the right context without claiming a
  // field was opened.
  if (issue.sectionId && !issue.entryId && !issue.bulletId) {
    const sectionTarget = findRenderedEditorElement(sectionCandidates);
    if (sectionTarget) {
      return { kind: "section", target: sectionTarget };
    }
  }

  const exactTarget = findEnabledEditorControl(exactCandidates);
  if (exactTarget) {
    return { kind: "exact", target: exactTarget };
  }

  const exactEntryCandidates = exactCandidates
    .map((candidate) =>
      candidate.closest<HTMLElement>("[data-resume-editor-entry]"),
    )
    .filter((candidate): candidate is HTMLElement => candidate !== null);
  const entryTarget = findRenderedEditorContainers(
    [...exactEntryCandidates, ...entryCandidates],
    true,
  );
  if (entryTarget) {
    return { kind: "entry-fallback", target: entryTarget };
  }

  const sectionTarget = findRenderedEditorContainers(sectionCandidates, true);
  if (sectionTarget) {
    return { kind: "section-fallback", target: sectionTarget };
  }

  // A locked or otherwise unavailable entry may not contain any enabled
  // fields. Keep the nearest rendered section as a truthful context fallback
  // before giving up to the validation row itself.
  const unavailableSectionTarget = findRenderedEditorElement(sectionCandidates);
  if (unavailableSectionTarget) {
    return { kind: "section-fallback", target: unavailableSectionTarget };
  }

  const identityTarget = findRenderedEditorContainers(identityCandidates, true);
  if (identityTarget) {
    return { kind: "identity-fallback", target: identityTarget };
  }

  return null;
}

function getValidationFocusAnnouncement(kind: ResumeValidationFocusKind) {
  switch (kind) {
    case "exact":
      return "Opened the matching editor field for this issue.";
    case "section":
      return "Opened the matching section in the editor.";
    case "entry-fallback":
      return "Opened the nearest editable entry in the editor; the exact field was not available.";
    case "section-fallback":
      return "Opened the matching section in the editor; the exact field was not available.";
    case "identity-fallback":
      return "Opened the resume identity editor; the exact field was not available.";
    case "work-history":
      return "Opened the work-history decisions panel in the editor.";
  }
}

function scrollAndFocusValidationTarget(
  target: HTMLElement,
  kind: ResumeValidationFocusKind,
) {
  target.scrollIntoView({
    behavior: getJobFinderScrollBehavior(),
    block: kind === "exact" ? "center" : "start",
  });

  const scrollRegion =
    target.closest<HTMLElement>("[data-resume-workspace-scroll-region]") ??
    target.closest<HTMLElement>("[data-resume-editor-scroll-region]");
  if (scrollRegion && scrollRegion.clientHeight > 0) {
    const regionRect = scrollRegion.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = targetRect.top - regionRect.top;
    const targetBottom = targetRect.bottom - regionRect.top;

    if (kind === "exact") {
      const targetCenter = (targetTop + targetBottom) / 2;
      const desiredCenter = scrollRegion.clientHeight / 2;
      scrollRegion.scrollTop += targetCenter - desiredCenter;
    } else {
      const inset = Math.min(24, scrollRegion.clientHeight / 4);
      if (targetTop < inset) {
        scrollRegion.scrollTop += targetTop - inset;
      } else if (targetBottom > scrollRegion.clientHeight - inset) {
        scrollRegion.scrollTop +=
          targetBottom - (scrollRegion.clientHeight - inset);
      }
    }
  }

  target.focus({ preventScroll: true });
}

export function ResumeWorkspaceStudioShell(
  props: ResumeWorkspaceStudioShellProps,
) {
  const mobileTemplatePanelRef = useRef<HTMLDivElement | null>(null);
  const desktopTemplatePanelRef = useRef<HTMLDivElement | null>(null);
  const [validationFocusRequest, setValidationFocusRequest] = useState<{
    issue: ResumeValidationIssue;
    targetId: string | null;
  } | null>(null);
  const [validationFocusAnnouncement, setValidationFocusAnnouncement] =
    useState<string | null>(null);
  const validationIssues = props.validationIssues ?? [];
  const isExportPending = props.isExportPending ?? false;
  const isApplyPending = props.isApplyPending ?? false;
  const firstBlockingIssue = validationIssues.find(
    isBlockingResumeValidationIssue,
  );
  const approvalBlockedByValidation = Boolean(firstBlockingIssue);
  const canApproveResume =
    props.canApproveResume && !approvalBlockedByValidation;
  const reviewFlow =
    props.reviewFlow && !props.canClearApproval && !props.originalResume
      ? props.reviewFlow
      : null;
  const canApproveAndNext =
    reviewFlow !== null &&
    canApproveResume &&
    !props.isWorkspacePending &&
    !(props.isExportPending ?? false) &&
    !props.exportBlockedReason;
  const approveAndNextRef = useRef<(() => void) | null>(null);
  approveAndNextRef.current =
    canApproveAndNext && reviewFlow ? () => reviewFlow.onApproveAndNext() : null;
  const hasReviewFlow = reviewFlow !== null;
  // Ctrl/Cmd+Enter approves and opens the next resume, from anywhere in the
  // studio including a field being edited (the edit is saved first).
  useEffect(() => {
    if (!hasReviewFlow) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) return;
      if (
        !eventMatchesJobFinderShortcut(
          event,
          RESUME_REVIEW_APPROVE_AND_NEXT_COMBO,
        )
      )
        return;
      const approveAndNext = approveAndNextRef.current;
      if (!approveAndNext) return;
      event.preventDefault();
      approveAndNext();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasReviewFlow]);
  const canDownloadPdf =
    !props.hasUnsavedChanges &&
    !approvalBlockedByValidation &&
    !props.approvalBlockedReason &&
    !props.exportBlockedReason &&
    props.selectedTemplateApprovalEligible;

  function focusTemplateChooser() {
    props.onSetMobileStudioTab("editor");

    window.requestAnimationFrame(() => {
      const visibleTarget = [
        desktopTemplatePanelRef.current,
        mobileTemplatePanelRef.current,
      ].find((candidate) => candidate && candidate.getClientRects().length > 0);
      const target =
        visibleTarget ??
        mobileTemplatePanelRef.current ??
        desktopTemplatePanelRef.current;

      target?.scrollIntoView({
        behavior: getJobFinderScrollBehavior(),
        block: "start",
      });
      target?.focus({ preventScroll: true });
    });
  }

  const approvalBlockedByDecisions = Boolean(props.approvalBlockedReason);
  const studioPanesRef = useRef<HTMLDivElement | null>(null);
  const isDesktopStudio = useDesktopStudioLayout(studioPanesRef);

  function focusWorkHistoryDecisions() {
    props.onSetMobileStudioTab("editor");

    window.requestAnimationFrame(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-resume-work-history-decisions]",
        ),
      );
      const target =
        candidates.find((candidate) => candidate.getClientRects().length > 0) ??
        candidates[0] ??
        null;

      target?.scrollIntoView({
        behavior: getJobFinderScrollBehavior(),
        block: "start",
      });
      target?.focus({ preventScroll: true });
    });
  }

  function focusValidationIssue(issue: ResumeValidationIssue) {
    const targetId = getResumeValidationIssueTargetId(issue);
    props.onSetMobileStudioTab("editor");
    props.onSelectValidationIssue?.(issue, targetId);
    setValidationFocusAnnouncement(null);
    setValidationFocusRequest({ issue, targetId });

    for (const details of document.querySelectorAll<HTMLDetailsElement>(
      "[data-resume-validation-notes]",
    )) {
      details.open = false;
    }

    if (targetId?.startsWith("identity:")) {
      for (const details of document.querySelectorAll<HTMLDetailsElement>(
        "[data-resume-identity-details]",
      )) {
        details.open = true;
      }
    }
  }

  useEffect(() => {
    const request = validationFocusRequest;
    if (!request) {
      return undefined;
    }

    let cancelled = false;
    let frame = 0;
    let attempts = 0;
    const maxAttempts = 12;

    const focusTarget = () => {
      if (cancelled) {
        return;
      }

      const resolution = resolveValidationFocusTarget(request);
      if (resolution) {
        scrollAndFocusValidationTarget(resolution.target, resolution.kind);
        if (
          resolution.kind !== "exact" &&
          resolution.kind !== "section" &&
          request.targetId
        ) {
          props.onSelectValidationIssue?.(request.issue, null);
        }
        setValidationFocusAnnouncement(
          getValidationFocusAnnouncement(resolution.kind),
        );
        setValidationFocusRequest(null);
        return;
      }

      if (attempts >= maxAttempts) {
        const issueRow = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-resume-validation-issue]",
          ),
        ).find(
          (candidate) =>
            candidate.dataset.resumeValidationIssue === request.issue.id,
        );

        issueRow?.focus({ preventScroll: true });
        setValidationFocusAnnouncement(
          "No matching editor field is available for this issue. Review the validation note and live preview.",
        );
        setValidationFocusRequest(null);
        return;
      }

      attempts += 1;
      frame = window.requestAnimationFrame(focusTarget);
    };

    frame = window.requestAnimationFrame(focusTarget);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [validationFocusRequest, props.mobileStudioTab]);

  const studioStatusText = isExportPending
    ? "Exporting PDF…"
    : props.isWorkspacePending
      ? "Working on your resume…"
      : props.originalResume
        ? "The file below is what this job attaches."
        : props.studioStatusMessage;
  const blockingIssueCount = validationIssues.filter(
    isBlockingResumeValidationIssue,
  ).length;
  const showsWorkHistoryWarning =
    approvalBlockedByDecisions && !props.canClearApproval;
  // Every notice the attention panel can actually show, so the chip that opens
  // it appears exactly when the panel has something to act on — a set-aside
  // proposal used to be silently unreachable from the header.
  const attentionItemCount =
    blockingIssueCount +
    (props.exportBlockedReason ? 1 : 0) +
    (showsWorkHistoryWarning ? 1 : 0) +
    (props.setAsideProposalNote ? 1 : 0);
  const showApprovedBackAction = !(
    !props.hasUnsavedChanges && Boolean(props.onPrepareApplication)
  );

  function openAttentionPanel() {
    // On compact widths the notices live in the Tools tab, so the chip has to
    // switch tabs before the panel exists to scroll to.
    props.onSetMobileStudioTab("editor");

    window.requestAnimationFrame(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          RESUME_STUDIO_ATTENTION_PANEL_SELECTOR,
        ),
      );
      const target =
        candidates.find((candidate) => candidate.getClientRects().length > 0) ??
        candidates[0] ??
        null;

      target?.scrollIntoView({
        behavior: getJobFinderScrollBehavior(),
        block: "start",
      });
      target?.focus({ preventScroll: true });
    });
  }

  const attentionPanel = (
    <ResumeStudioAttentionPanel
      approvalBlockedReason={
        showsWorkHistoryWarning ? props.approvalBlockedReason : null
      }
      attentionItemCount={attentionItemCount}
      {...(props.claimConfirmationPanel
        ? { claimConfirmationPanel: props.claimConfirmationPanel }
        : {})}
      exportBlockedReason={props.exportBlockedReason}
      {...(props.exportBlockedActionLabel
        ? { exportBlockedActionLabel: props.exportBlockedActionLabel }
        : {})}
      focusAnnouncement={validationFocusAnnouncement}
      {...(props.onDismissSetAsideProposalNote
        ? {
            onDismissSetAsideProposalNote: props.onDismissSetAsideProposalNote,
          }
        : {})}
      onReviewBlockingIssues={props.onReviewBlockingIssues}
      {...(props.onReviewSetAsideProposal
        ? { onReviewSetAsideProposal: props.onReviewSetAsideProposal }
        : {})}
      onReviewWorkHistoryDecisions={focusWorkHistoryDecisions}
      pdfStatusMessage={
        props.originalResume
          ? "No application PDF is built here while the job uses your original file."
          : props.canClearApproval
            ? `Application PDF ready${describeApprovedPageCount(
                props.approvedExportPageCount ?? null,
              )}. Download a copy if you want one.`
            : null
      }
      {...(props.setAsideProposalNote
        ? { setAsideProposalNote: props.setAsideProposalNote }
        : {})}
      validationIssueList={
        validationIssues.length > 0 ? (
          <ResumeValidationIssueList
            issues={validationIssues}
            {...(props.canRestoreValidationIssuePreviousText
              ? {
                  canRestorePreviousText:
                    props.canRestoreValidationIssuePreviousText,
                }
              : {})}
            {...(props.onAskAiFix ? { onAskAiFix: props.onAskAiFix } : {})}
            {...(props.canApproveClaim
              ? { canApproveClaim: props.canApproveClaim }
              : {})}
            {...(props.onApproveClaim
              ? { onApproveClaim: props.onApproveClaim }
              : {})}
            {...(props.onClaimResumeIdentity
              ? { onClaimResumeIdentity: props.onClaimResumeIdentity }
              : {})}
            onFixIssue={focusValidationIssue}
            {...(props.onRestoreValidationIssuePreviousText
              ? {
                  onRestorePreviousText:
                    props.onRestoreValidationIssuePreviousText,
                }
              : {})}
          />
        ) : null
      }
    />
  );

  const clearApprovalSlot = props.canClearApproval ? (
    <Button
      className="border border-(--control-border)"
      pending={props.isWorkspacePending}
      onClick={props.onClearApproval}
      size="compact"
      type="button"
      variant="ghost"
    >
      <ShieldOff className="size-4" />
      Clear approval
    </Button>
  ) : null;

  return (
    <div className="surface-panel-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border)">
      {/* One compact sticky row. The pinned stack that used to sit here — the
          next-step banner, the blocked-claims warning, the work-history
          warning and the validation list — cost ~270px of an 860px window and
          could not be scrolled away, so the preview and the editor were
          permanently squeezed. The notices moved into the tools column, inside
          its own scroll region, and this row keeps only the state, the one
          primary action, and a chip that opens them. */}
      <section
        aria-labelledby="resume-next-step-title"
        className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-primary/40 bg-primary/10 px-5 py-1.5"
        data-resume-studio-compact-header
        data-resume-workspace-top-actions
      >
        {props.originalResume ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            data-resume-studio-original-notice
          >
            <Badge variant="outline">
              {props.originalResume.writing
                ? `Writing ${props.originalResume.levelLabel}`
                : "Original resume"}
            </Badge>
            <strong
              aria-live="polite"
              className="min-w-0 text-(length:--text-body) leading-5 text-(--text-headline)"
              id="resume-next-step-title"
            >
              {props.originalResume.writing
                ? `Writing an editable ${props.originalResume.levelLabel} resume for this job. This takes a few minutes.`
                : "This job sends your original file, shown below, unchanged."}
            </strong>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="outline">
              {props.rewriteFailed
                ? "Rewrite failed"
                : props.canClearApproval && props.hasUnsavedChanges
                  ? "Unsaved changes"
                  : props.canClearApproval
                    ? "Approved"
                    : approvalBlockedByValidation
                      ? "Needs fixes"
                      : approvalBlockedByDecisions
                        ? "Needs decisions"
                        : props.exportBlockedReason
                          ? "Lines to confirm"
                          : canApproveResume
                            ? props.hasUnsavedChanges
                              ? "Unsaved changes"
                              : "Ready to approve"
                            : "Choose template"}
            </Badge>
            <strong
              className="min-w-0 text-(length:--text-body) leading-5 text-(--text-headline)"
              id="resume-next-step-title"
            >
              {props.rewriteFailed
                ? "Your previous resume was kept. Try the rewrite again."
                : props.canClearApproval && props.hasUnsavedChanges
                  ? "Saving reopens approval for this resume."
                  : props.canClearApproval
                    ? "Resume approved. Continue when you’re ready."
                    : canApproveResume
                      ? props.hasUnsavedChanges
                        ? "Approve when ready — your edits will be saved first."
                        : "Approve the resume shown in the preview."
                      : approvalBlockedByValidation
                        ? "Fix the first validation error before approval."
                        : approvalBlockedByDecisions
                          ? "Choose whether to leave each hidden role off this resume before approving."
                          : props.exportBlockedReason
                            ? "Keep or remove the flagged lines, then approve."
                            : "Choose an apply-safe template before approval."}
            </strong>
            {/* Compact widths used to carry a second, contiguous approval band
              directly under this row — 53px of state plus 63px repeating the
              same fact and owning `Clear approval`. This row is the single
              owner there now, so the one thing the second band said that this
              one did not says it here. */}
            {/* With unsaved edits the title already says what saving does;
                the generic status line ("saved when you approve") did not fit
                a resume that has no Approve button in this state. */}
            {!isDesktopStudio &&
            props.canClearApproval &&
            !props.hasUnsavedChanges ? (
              <span
                className="min-w-0 text-(length:--text-body) leading-6 text-foreground"
                data-resume-studio-compact-approval-note
              >
                Any new edit needs approval again.
              </span>
            ) : null}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {/* The collapsed Assistant launcher lands here, portalled in by
              `ResumeGuidedEditsPopup`. It used to be a pill fixed to the
              window's bottom-right corner, resting over the tools column; no
              padding or height reservation could keep it off live content at
              every scroll position, so it became an ordinary button in the
              row that already owns this screen's actions. Empty span, no box,
              until the Assistant mounts. */}
          <span
            className="contents"
            data-resume-studio-assistant-launcher-slot
          />
          {props.originalResume ? (
            <Button
              disabled={
                props.isWorkspacePending ||
                Boolean(props.originalResume.writing)
              }
              onClick={props.originalResume.onWriteEditableResume}
              pending={
                props.isWorkspacePending ||
                Boolean(props.originalResume.writing)
              }
              type="button"
              variant="primary"
            >
              {props.originalResume.writing
                ? "Writing…"
                : `Write an editable ${props.originalResume.levelLabel} resume`}
              <ArrowRight className="size-4" />
            </Button>
          ) : null}
          {!props.originalResume && attentionItemCount > 0 ? (
            <Button
              data-resume-studio-attention-chip
              onClick={openAttentionPanel}
              size="compact"
              type="button"
              variant="secondary"
            >
              <TriangleAlert className="size-4" />
              {attentionItemCount === 1
                ? "1 item needs attention"
                : `${attentionItemCount} items need attention`}
            </Button>
          ) : null}
          {props.canClearApproval &&
          !props.hasUnsavedChanges &&
          props.onPrepareApplication ? (
            <Button
              disabled={
                props.isWorkspacePending || isExportPending || isApplyPending
              }
              onClick={props.onPrepareApplication}
              pending={
                props.isWorkspacePending || isExportPending || isApplyPending
              }
              type="button"
              variant="primary"
            >
              Apply
              <ArrowRight className="size-4" />
            </Button>
          ) : null}
          {/* One route back. `← Back to Shortlisted` already sits ~100px away
              in the workspace header, so a second `Continue to Shortlisted →`
              beside `Apply →` read as forward progress to a
              different place. It only appears when there is no Prepare action
              to offer, and then it points back. */}
          {/* Unsaved edits to an approved resume: the next step is saving
              them, which reopens approval (N-048). */}
          {!props.originalResume &&
          props.canClearApproval &&
          props.hasUnsavedChanges ? (
            <Button
              disabled={props.isWorkspacePending || isExportPending}
              onClick={props.onSaveDraft}
              pending={props.isWorkspacePending}
              type="button"
              variant="primary"
            >
              <Save className="size-4" />
              Save draft
            </Button>
          ) : props.canClearApproval ? (
            showApprovedBackAction ? (
              <Button
                disabled={props.isWorkspacePending || isExportPending}
                onClick={props.onContinueToShortlisted}
                type="button"
                variant="secondary"
              >
                <ArrowLeft className="size-4" />
                Back to Shortlisted
              </Button>
            ) : null
          ) : null}
          {/* Below xl this row owns approval outright, so it owns the way out
              of it too. On desktop the tools column's status row still owns
              `Clear approval`, and exactly one copy renders either way. */}
          {isDesktopStudio ? null : clearApprovalSlot}
          {reviewFlow ? (
            <>
              <span
                className="text-(length:--text-small) tabular-nums text-foreground-soft"
                data-resume-review-progress
              >
                {reviewFlow.reviewed} of {reviewFlow.total} reviewed
              </span>
              {reviewFlow.onSkip ? (
                <Button
                  onClick={reviewFlow.onSkip}
                  size="compact"
                  title={
                    reviewFlow.nextTitle
                      ? `Leave this one for later and open ${reviewFlow.nextTitle}`
                      : "Leave this one for later"
                  }
                  type="button"
                  variant="ghost"
                >
                  Skip
                </Button>
              ) : null}
            </>
          ) : null}
          {props.canClearApproval || props.originalResume ? null : (
            <Button
              {...(reviewFlow && canApproveResume
                ? {
                    "aria-keyshortcuts": getJobFinderAriaKeyshortcuts(
                      RESUME_REVIEW_APPROVE_AND_NEXT_COMBO,
                      isMacPlatform() ? "darwin" : "win32",
                    ),
                    title: reviewFlow.nextTitle
                      ? `Approve, then open ${reviewFlow.nextTitle} (${formatJobFinderShortcutCombo(RESUME_REVIEW_APPROVE_AND_NEXT_COMBO, isMacPlatform() ? "darwin" : "win32")})`
                      : `Approve the last resume waiting for review (${formatJobFinderShortcutCombo(RESUME_REVIEW_APPROVE_AND_NEXT_COMBO, isMacPlatform() ? "darwin" : "win32")})`,
                  }
                : {})}
              data-resume-approve-and-next={reviewFlow ? "" : undefined}
              disabled={
                props.isWorkspacePending ||
                isExportPending ||
                (canApproveResume && Boolean(props.exportBlockedReason))
              }
              onClick={
                canApproveResume
                  ? reviewFlow
                    ? () => reviewFlow.onApproveAndNext()
                    : props.onApproveCurrentPdf
                  : firstBlockingIssue
                    ? () => focusValidationIssue(firstBlockingIssue)
                    : approvalBlockedByDecisions
                      ? focusWorkHistoryDecisions
                      : props.exportBlockedReason
                        ? props.onReviewBlockingIssues
                        : focusTemplateChooser
              }
              pending={props.isWorkspacePending || isExportPending}
              type="button"
              variant="primary"
            >
              {isExportPending
                ? "Exporting PDF…"
                : canApproveResume
                  ? reviewFlow?.nextTitle
                    ? "Approve and next"
                    : "Approve resume"
                  : approvalBlockedByValidation
                    ? "Fix approval blocker"
                    : approvalBlockedByDecisions
                      ? "Review hidden roles"
                      : props.exportBlockedReason
                        ? (props.exportBlockedActionLabel ?? "Review lines")
                        : "Choose an apply-safe template"}
              <ArrowRight className="size-4" />
              {reviewFlow && canApproveResume ? (
                <kbd
                  aria-hidden="true"
                  className="ml-1 rounded-sm border border-current/30 px-1 font-sans text-(length:--text-tiny) font-medium opacity-80"
                >
                  {formatJobFinderShortcutCombo(
                    RESUME_REVIEW_APPROVE_AND_NEXT_COMBO,
                    isMacPlatform() ? "darwin" : "win32",
                  )}
                </kbd>
              ) : null}
            </Button>
          )}
        </div>
      </section>

      {reviewFlow && reviewFlow.failures.length > 0 ? (
        // An approval that failed behind the person stays in "To review";
        // this line names it until it is approved, with the way back to it.
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--warning-border) bg-(--warning-surface) px-5 py-1.5 text-(length:--text-small) text-(--warning-text)"
          data-resume-review-failures
          role="alert"
        >
          {reviewFlow.failures.slice(0, 2).map((failure) => (
            <span className="flex min-w-0 items-center gap-2" key={failure.jobId}>
              <span className="min-w-0 truncate" title={failure.reason}>
                Not approved: {failure.title}. {failure.reason}
              </span>
              <Button
                onClick={() => reviewFlow.onOpenJob(failure.jobId)}
                size="compact"
                type="button"
                variant="secondary"
              >
                Open it
              </Button>
            </span>
          ))}
          {reviewFlow.failures.length > 2 ? (
            <span>+{reviewFlow.failures.length - 2} more</span>
          ) : null}
        </div>
      ) : null}

      {/* Compact chrome is one status line. The "Resume Studio / Review and
          refine your resume." block and the Save/Download toolbar used to sit
          here as a second permanent band, costing ~75px of a 640px window that
          the tab content needed; desktop already keeps them inside the tools
          column's own scroll region, so the Tools tab now does the same. */}
      {/* After approval this band was a second contiguous approval row under
          the sticky one — 116px of chrome for one fact. The sticky row above
          owns the approved state, its warning and `Clear approval` at compact
          widths, so this band only renders while there is a different status
          to report. */}
      {props.canClearApproval ||
      isDesktopStudio ||
      (!studioStatusText && !props.approvalStateLabel) ? null : (
        <div
          className="grid shrink-0 gap-2.5 border-b border-(--surface-panel-border) px-4 py-2"
          data-resume-studio-compact-status
        >
          <StudioStatusRow
            approvalStateLabel={props.approvalStateLabel}
            clearApprovalSlot={null}
            live={!isDesktopStudio}
            message={studioStatusText}
          />
        </div>
      )}

      {/* The studio body: the preview/tools panes, and — while the Assistant
          is open — the Assistant docked as a right-hand column. It opens where
          a chat is expected (the right edge, running to the bottom corner)
          and the panes beside it narrow to make room, so it never rests over
          the tools column's Save / template / editor controls, the preview,
          or the approval row above. `ResumeGuidedEditsPopup` portals the
          panel into the dock slot; closed, the slot renders nothing. */}
      <div className="flex min-h-0 min-w-0 flex-1" data-resume-studio-body>
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-resume-studio-panes
          ref={studioPanesRef}
        >
          {/* When the panes lack room the studio is a bounded tab surface. The
          Assistant is not one of these tabs: it is the same floating panel the
          desktop layout uses, so switching tabs never swaps it for a different
          layout and exactly one transcript is mounted at any width.

          The available width is measured before choosing a layout, so only one
          of the two layouts is ever in the React tree. Rendering both mounted every pane
          twice: two live `<iframe srcDoc>` preview documents parsed on every
          draft revision, two editor trees, and a duplicate
          `id="resume-proof-details"` whose hidden copy came first in document
          order, which is what made "Review blocked claims" inert at >= 1280px. */}
          {isDesktopStudio ? null : (
            <div
              className="min-h-0 min-w-0 flex-1"
              data-resume-studio-compact-layout
            >
              <Tabs
                className="h-full min-h-0"
                onValueChange={(value) =>
                  props.onSetMobileStudioTab(value as ResumeStudioMobileTab)
                }
                value={props.originalResume ? "preview" : props.mobileStudioTab}
              >
                {props.originalResume ? null : (
                  <TabsList
                    className="grid w-full grid-cols-2 border-b border-(--surface-panel-border) bg-transparent"
                    /* Below xl this strip is the only route to the editor, the
                 template chooser and the approval controls, so the floating
                 Assistant treats it as a no-cover zone and anchors under it.
                 The marker exists so that placement can measure it. */
                    data-resume-studio-compact-tabs
                    variant="line"
                  >
                    <TabsTrigger value="preview">Preview</TabsTrigger>
                    <TabsTrigger value="editor">Tools</TabsTrigger>
                  </TabsList>
                )}
                <div className="min-h-0 flex-1 overflow-hidden p-4">
                  <TabsContent
                    className="min-h-0 h-full overflow-hidden"
                    value="preview"
                  >
                    {props.originalResume
                      ? props.originalResume.filePanel
                      : props.previewPane}
                  </TabsContent>
                  {/* Compact widths sit below the locked-pane breakpoint, so this is
                an ordinary scroll region rather than a wheel-chain owner. */}
                  {props.originalResume ? null : (
                    <TabsContent
                      className="min-h-0 h-full overflow-y-auto overflow-x-hidden"
                      value="editor"
                    >
                      <div className="grid min-h-0 min-w-0 grid-cols-1 gap-4">
                        <div className="grid gap-2.5">
                          <StudioToolbar
                            canDownloadPdf={canDownloadPdf}
                            isApproved={props.canClearApproval}
                            isExportPending={isExportPending}
                            isWorkspacePending={props.isWorkspacePending}
                            onDownloadPdf={props.onExportPdf}
                            onSaveDraft={props.onSaveDraft}
                          />
                        </div>
                        {isDesktopStudio ? null : attentionPanel}
                        <div
                          aria-label="Apply-safe template choices"
                          className="min-h-(--size-resume-workspace-panel) scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-resume-template-chooser
                          ref={mobileTemplatePanelRef}
                          tabIndex={-1}
                        >
                          {props.templatePanel}
                        </div>
                        <div className="min-h-(--size-resume-workspace-panel)">
                          {props.editorPanel}
                        </div>
                        <StudioHistoryDisclosure>
                          {props.historyPanel}
                        </StudioHistoryDisclosure>
                        {props.supportingDetailsPanel}
                      </div>
                    </TabsContent>
                  )}
                </div>
              </Tabs>
            </div>
          )}

          {/* Two columns. The Assistant is not a track in this grid: it docks
          beside the whole studio body (see the dock slot), so this grid only
          narrows while it is open and never re-orders. A floating panel that
          rested over the tools column hid Save, the template chooser and the
          editor controls the person was using. */}
          {isDesktopStudio ? (
            <div
              className="hidden min-h-[20rem] min-w-0 flex-1 p-2.5 xl:grid xl:h-full xl:min-h-0"
              data-resume-studio-desktop-grid
            >
              <div
                className={cn(
                  "grid h-full min-h-[20rem] min-w-0 gap-2.5 xl:min-h-0",
                  // With the Assistant docked the tools column may narrow further
                  // so the preview keeps a readable share of what is left.
                  props.assistantDocked
                    ? "xl:grid-cols-[minmax(0,1fr)_minmax(19rem,0.8fr)]"
                    : "xl:grid-cols-[minmax(0,1.15fr)_minmax(26rem,0.85fr)] assistant-docked:xl:grid-cols-[minmax(0,1fr)_minmax(19rem,0.8fr)]",
                )}
                data-resume-studio-grid-columns="preview-tools"
              >
                <div
                  className="h-full min-h-[18rem] min-w-0 overflow-hidden xl:min-h-0"
                  data-resume-studio-preview-pane="true"
                >
                  {props.originalResume
                    ? props.originalResume.filePanel
                    : props.previewPane}
                </div>
                {props.originalResume ? null : (
                  <div
                    aria-label="Resume studio tools"
                    /* This column runs the FULL studio height, exactly like the
               preview column beside it, and reserves nothing at its end.

               It carried two failed reservations before. Shortening it by the
               launcher's band (`xl:h-[calc(100%-3.5rem)]`) left an empty dark
               strip across the bottom-right under "Edit resume". Replacing
               that with `pb-14` fixed only the END of the scroll: mid-scroll
               the template card and the fallback disclosure still passed under
               the fixed pill. No reservation can hold for a scrolling column,
               so the collapsed launcher stopped floating over this column at
               all — it is an ordinary button in the sticky header above. */
                    className="flex h-full min-h-[18rem] min-w-0 flex-col gap-2.5 overflow-y-auto overflow-x-hidden pr-1 xl:min-h-0"
                    data-locked-pane-scroll-region
                    data-resume-studio-tools-pane="true"
                    data-resume-workspace-scroll-region
                    role="region"
                    tabIndex={0}
                  >
                    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-2.5">
                      {/* No eyebrow or heading here: the job title above names the
                    screen and the status banner names the step. The column
                    opens on its controls, with the status as plain text
                    beside them rather than a boxed row of its own. */}
                      <StudioToolbar
                        canDownloadPdf={canDownloadPdf}
                        isApproved={props.canClearApproval}
                        isExportPending={isExportPending}
                        isWorkspacePending={props.isWorkspacePending}
                        onDownloadPdf={props.onExportPdf}
                        onSaveDraft={props.onSaveDraft}
                      />

                      <StudioStatusRow
                        approvalStateLabel={props.approvalStateLabel}
                        clearApprovalSlot={
                          isDesktopStudio ? clearApprovalSlot : null
                        }
                        inline
                        live={isDesktopStudio}
                        message={studioStatusText}
                      />
                    </div>
                    {isDesktopStudio ? attentionPanel : null}
                    <div
                      aria-label="Apply-safe template choices"
                      className="min-h-0 min-w-0 shrink-0 scroll-mt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-resume-template-chooser
                      ref={desktopTemplatePanelRef}
                      tabIndex={-1}
                    >
                      {props.templatePanel}
                    </div>
                    <div className="min-h-0 min-w-0 shrink-0">
                      {props.editorPanel}
                    </div>
                    <StudioHistoryDisclosure>
                      {props.historyPanel}
                    </StudioHistoryDisclosure>
                    {props.supportingDetailsPanel}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
        <div
          className={cn(
            "min-h-0 shrink-0",
            props.assistantDocked
              ? "flex w-(--resume-assistant-dock-width) py-2.5 pr-2.5"
              : "hidden",
          )}
          data-resume-studio-assistant-dock-slot
          data-resume-studio-assistant-docked={
            props.assistantDocked ? "true" : "false"
          }
        />
      </div>
    </div>
  );
}
