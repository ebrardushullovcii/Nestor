import { FAILURE_SENTENCES } from "../../lib/describe-failure";
import { ResumeWorkspaceLanguagePicker } from "./resume-workspace-language-picker";
import { OriginalResumeFilePanel } from "./original-resume-file-panel";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  ResumeDraft,
  ResumeDraftPatch,
  ResumeValidationIssue,
  WorkHistoryReviewSuggestion,
} from "@nordri/contracts";
import {
  getResumePreviewTargetContext,
  resumeComparisonNeedsRefresh,
  buildResumeIssueApprovalContentHash,
  isBlockingResumeClaimAssessment,
  isResumeClaimAssessmentApprovable,
  isBlockingResumeValidationIssue,
} from "@nordri/contracts";
import {
  getResumeTemplateDeliveryLane,
  isResumeTemplateApprovalEligible,
} from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import { EmptyState } from "../../components/empty-state";
import { LockedScreenLayout } from "../../components/locked-screen-layout";
import { buildResumeClaimConfirmationCommandInput } from "./resume-claim-confirmation-panel";
import { ResumeWorkspaceEditorPanel } from "./resume-workspace-editor-panel";
import { ResumeWorkspaceHeader } from "./resume-workspace-header";
import { ResumeWorkspaceContextDisclosure } from "./resume-workspace-context-disclosure";
import { ResumeStrategyContextPanel } from "./resume-strategy-context-panel";
import { ResumeWorkspaceSidebar } from "./resume-workspace-sidebar";
import {
  useAssistant,
  useAssistantContextSource,
} from "../../assistant/assistant-provider";
import { ResumeStudioPreviewPane } from "./resume-studio-preview-pane";
import {
  ResumeWorkspaceStudioShell,
  type ResumeStudioMobileTab,
} from "./resume-workspace-studio-shell";
import { getJobFinderScrollBehavior } from "../../lib/job-finder-scroll-behavior";
import { ResumeWorkspaceTemplatePanel } from "./resume-workspace-template-panel";
import { ResumeVersionHistoryPanel } from "./resume-version-history-panel";
import {
  cloneDraft,
  describeAcceptedAssistantEdits,
  describeResumeExportClaimBlock,
  describeResumeGenerationPath,
  findLatestAssistantEditRevisionId,
  resumeExportClaimBlockActionLabel,
} from "./resume-workspace-utils";
import {
  createResumeDraftPatch,
  orderResumeEntriesNewestFirst,
} from "./resume-section-editor-helpers";
import {
  buildResumeThemeRecommendationContext,
  buildWorkspaceStatusCopy,
  getAvailableExportToApprove,
  getSelectedTheme,
} from "./resume-workspace-screen-helpers";
import { buildResumeValidationAiPrompt } from "./resume-validation-issue-list";
import { findResumeValidationRestoreCandidate } from "./resume-validation-restore";
import {
  listUnresolvedWorkHistoryOmissionSuggestions,
  type ResumeWorkHistoryDecisionRequest,
} from "./resume-workspace-work-history-decisions";
import { useResumeWorkspaceSelection } from "./use-resume-workspace-selection";
import { useResumeWorkspacePreview } from "./use-resume-workspace-preview";
import type { ResumeWorkspaceScreenProps } from "./resume-workspace-screen.types";

/** The shell's own bottom padding below the route (`pb-3`). */
const STUDIO_BOTTOM_GUTTER = 12;
/**
 * Used only until the first measurement lands: the ≥1440 shell header, one
 * workspace title row, and the bottom gutter. A short first paint is
 * recoverable; an overlong one clips.
 */
const STUDIO_FALLBACK_TITLE_ROW = 72;
const STUDIO_FALLBACK_TOP_OFFSET =
  56 + STUDIO_FALLBACK_TITLE_ROW + STUDIO_BOTTOM_GUTTER;

/** Editable content, excluding server-owned approval and review metadata. */
function draftContentKey(draft: ResumeDraft): string {
  return JSON.stringify({
    id: draft.id,
    jobId: draft.jobId,
    templateId: draft.templateId,
    language: draft.language ?? null,
    writtenLanguage: draft.writtenLanguage ?? null,
    listingLanguage: draft.listingLanguage ?? null,
    identity: draft.identity,
    sections: draft.sections,
    targetPageCount: draft.targetPageCount,
  });
}

export function ResumeWorkspaceScreen(props: ResumeWorkspaceScreenProps) {
  const [draft, setDraft] = useState<ResumeDraft | null>(
    props.workspace ? cloneDraft(props.workspace.draft) : null,
  );
  const [mobileStudioTab, setMobileStudioTab] =
    useState<ResumeStudioMobileTab>("preview");
  // The app-wide assistant sidebar (ADR 0037) replaces the studio's own
  // assistant; the studio publishes its draft, selection and saved revision.
  const assistant = useAssistant();
  // The level an Original job is being moved to by the studio's one-press
  // route. The job stops being Original as soon as the level is saved, but
  // until the new resume is written the header keeps saying what is happening
  // instead of offering approval of the old draft.
  const [writingEditableLevel, setWritingEditableLevel] = useState<
    string | null
  >(null);
  const writingEditableSawPending = useRef(false);
  useEffect(() => {
    if (writingEditableLevel === null) {
      writingEditableSawPending.current = false;
      return;
    }
    if (props.isWorkspacePending) {
      writingEditableSawPending.current = true;
      return;
    }
    if (writingEditableSawPending.current) {
      setWritingEditableLevel(null);
    }
  }, [props.isWorkspacePending, writingEditableLevel]);
  const startEditableResumeRoute = (pendingRequest: string | null) => {
    if (!props.originalResumeRoute) {
      return;
    }
    setWritingEditableLevel(props.originalResumeRoute.levelLabel);
    props.originalResumeRoute.onWriteEditableResume(
      props.jobId,
      pendingRequest,
    );
  };
  // An approval freezes one exact artifact. A Guided edits proposal that is
  // still pending at that moment would silently invalidate the approval the
  // moment it were accepted, so approval sets it aside and says so.
  const [languageRequest, setLanguageRequest] = useState<{
    language: string | null;
  } | null>(null);
  const [setAsideProposalNote, setSetAsideProposalNote] = useState<
    string | null
  >(null);

  // The studio content area must end at the window bottom, not below it. A
  // fixed `100dvh - 4.25rem` height assumed one shell-header height and
  // ignored the workspace header above the studio, so the studio's own bottom
  // edge — the Assistant composer, the tools pane's last control — sat past
  // the viewport until the user scrolled the header away (60px too tall at a
  // 1280 window, where the shell header is taller still). Both offsets are
  // measured instead: the route scroll area's distance from the viewport top
  // is the shell chrome, and the locked layout's top row is the workspace
  // header. Neither depends on this element's own height, so there is no
  // measurement feedback loop.
  const [studioTopContentNode, setStudioTopContentNode] =
    useState<HTMLDivElement | null>(null);
  const [studioTopOffset, setStudioTopOffset] = useState(
    STUDIO_FALLBACK_TOP_OFFSET,
  );

  useEffect(() => {
    const anchor = studioTopContentNode;

    if (!anchor) {
      return;
    }

    // The locked layout wraps `topContent` in its own padded row; measuring
    // that row counts the padding the studio also has to give back.
    const topRow = anchor.parentElement ?? anchor;

    const updateOffset = () => {
      const scrollArea = topRow.closest<HTMLElement>(
        "[data-locked-screen-scroll-area]",
      );
      const shellChrome = scrollArea
        ? Math.max(0, scrollArea.getBoundingClientRect().top)
        : 0;

      // Every band that sits above the studio at scroll 0 has to come out of
      // the studio's height, or the pane container simply ends below the fold.
      // Subtracting only the shell chrome and the bottom gutter left the
      // container exactly `titleRow - gutter` past the window bottom — 41px at
      // both 1440x920 and 1280x720 — so the route grew a scroll whose entire
      // range existed to reveal a pane's bottom border. The title row is a
      // real, permanent band at the position the user arrives in, so it is
      // subtracted; scrolling it away leaves the studio short by that much
      // rather than clipped, which is the recoverable direction. Neither term
      // depends on this element's own height, so there is still no measurement
      // feedback loop.
      const titleRow = Math.max(0, topRow.getBoundingClientRect().height);

      setStudioTopOffset(
        Math.ceil(shellChrome + titleRow + STUDIO_BOTTOM_GUTTER),
      );
    };

    updateOffset();

    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(updateOffset)
        : null;
    observer?.observe(topRow);
    // The shell header owns the only remaining permanent band above the
    // studio, so its height is what has to be watched.
    const scrollArea = topRow.closest<HTMLElement>(
      "[data-locked-screen-scroll-area]",
    );
    if (scrollArea) {
      observer?.observe(scrollArea);
    }
    window.addEventListener("resize", updateOffset);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateOffset);
    };
  }, [studioTopContentNode]);

  const workspaceDraftRevisionKey = props.workspace
    ? `${props.workspace.draft.id}:${props.workspace.draft.updatedAt}`
    : null;

  // A newer saved draft replaces the screen's copy, unless the person has
  // unsaved edits of their own: those are kept and a notice offers the saved
  // version (the assistant may have changed it; ADR 0037).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const persistedDraftRef = useRef<ResumeDraft | null>(
    props.workspace?.draft ?? null,
  );
  const [backgroundDraft, setBackgroundDraft] = useState<ResumeDraft | null>(
    null,
  );
  const [ownSave, setOwnSave] = useState<{
    draftId: string;
    updatedAt: string;
    submittedContentKey: string;
  } | null>(null);
  const acknowledgeSave = useCallback(
    (submittedDraft: ResumeDraft, updatedAt: string) => {
      setOwnSave({
        draftId: submittedDraft.id,
        updatedAt,
        submittedContentKey: draftContentKey(submittedDraft),
      });
    },
    [],
  );
  useEffect(() => {
    const persistedDraft = props.workspace?.draft ?? null;
    const previousPersisted = persistedDraftRef.current;
    persistedDraftRef.current = persistedDraft;
    if (!persistedDraft) {
      setDraft(null);
      setBackgroundDraft(null);
      return;
    }
    const currentDraft = draftRef.current;
    // Saving trims text and normalizes ordering and section inclusion.
    // The successful save's revision identifies that result, not a comparison
    // with the unnormalized editor contents. Later revisions remain conflicts.
    if (
      ownSave?.draftId === persistedDraft.id &&
      ownSave.updatedAt === persistedDraft.updatedAt &&
      currentDraft?.id === persistedDraft.id
    ) {
      setBackgroundDraft(null);
      setDraft(
        draftContentKey(currentDraft) === ownSave.submittedContentKey
          ? cloneDraft(persistedDraft)
          : {
              ...cloneDraft(persistedDraft),
              templateId: currentDraft.templateId,
              identity: currentDraft.identity,
              sections: currentDraft.sections,
              targetPageCount: currentDraft.targetPageCount,
            },
      );
      return;
    }
    if (
      currentDraft &&
      currentDraft.id === persistedDraft.id &&
      currentDraft.updatedAt === persistedDraft.updatedAt
    ) {
      return;
    }
    if (
      currentDraft &&
      previousPersisted &&
      currentDraft.id === persistedDraft.id &&
      previousPersisted.id === persistedDraft.id
    ) {
      const currentKey = draftContentKey(currentDraft);
      const hadUnsavedEdits = currentKey !== draftContentKey(previousPersisted);
      const isOwnSave = currentKey === draftContentKey(persistedDraft);
      if (hadUnsavedEdits && !isOwnSave) {
        setBackgroundDraft(persistedDraft);
        return;
      }
    }
    setBackgroundDraft(null);
    setDraft(cloneDraft(persistedDraft));
  }, [workspaceDraftRevisionKey, props.workspace?.draft, ownSave]);

  const {
    handlePreviewTargetSelect,
    handleSelectEntry,
    handleSelectSection,
    selectionScrollKey,
    selectedEntryId,
    selectedSectionId,
    selectedTargetId,
  } = useResumeWorkspaceSelection({ draft });

  const serializedDraft = useMemo(
    () => (draft ? JSON.stringify(draft) : null),
    [draft],
  );
  const serializedWorkspaceDraft = useMemo(
    () => (props.workspace ? JSON.stringify(props.workspace.draft) : null),
    [props.workspace],
  );
  const hasUnsavedChanges =
    serializedDraft !== null && serializedWorkspaceDraft !== null
      ? serializedDraft !== serializedWorkspaceDraft
      : false;
  const lastDirtyValueRef = useRef<boolean | null>(null);

  useAssistantContextSource("resume-studio", () => {
    if (!draft) return null;
    const bulletMatch = selectedTargetId
      ? /:bullet:([^:]+)$/u.exec(selectedTargetId)
      : null;
    let bulletId: string | null = null;
    if (bulletMatch?.[1]) {
      try {
        bulletId = decodeURIComponent(bulletMatch[1]);
      } catch {
        bulletId = bulletMatch[1];
      }
    }
    const hasSelection = Boolean(
      selectedSectionId || selectedEntryId || bulletId,
    );
    return {
      focus: {
        kind: "job",
        id: props.jobId,
        label: props.workspace?.job.title ?? null,
      },
      editor: {
        editor: "resume",
        jobId: props.jobId,
        draftId: draft.id,
        savedRevision: props.workspace?.draft.updatedAt ?? null,
        draftVersion: hasUnsavedChanges ? 1 : 0,
        hasUnsavedEdits: hasUnsavedChanges,
        mode: props.originalResumeRoute ? "original" : "editable",
        selection: hasSelection
          ? {
              sectionId: selectedSectionId ?? null,
              entryId: selectedEntryId ?? null,
              bulletIds: bulletId ? [bulletId] : [],
              text: null,
            }
          : null,
      },
    };
  });

  useEffect(() => {
    if (lastDirtyValueRef.current === hasUnsavedChanges) {
      return;
    }

    lastDirtyValueRef.current = hasUnsavedChanges;
    props.onDirtyChange(hasUnsavedChanges);
  }, [hasUnsavedChanges, props.onDirtyChange]);

  const availableExportToApprove = getAvailableExportToApprove({
    draft,
    hasUnsavedChanges,
    workspace: props.workspace,
  });
  // Approval promises "Job Finder creates and verifies the application PDF in
  // the background"; the exact artifact it produced is what resolves that
  // promise, so the studio can stop describing work that already finished.
  const approvedExport =
    draft?.approvedExportId && props.workspace
      ? (props.workspace.exports.find(
          (artifact) => artifact.id === draft.approvedExportId,
        ) ?? null)
      : null;
  // Exactly the rule the export/approval validator and the Guided Edits
  // proposal gate use, so the studio can never disagree with either of them.
  const blockingClaimAssessments = props.workspace
    ? (props.workspace.validation?.claimAssessments.filter((assessment) =>
        isBlockingResumeClaimAssessment({
          assessment,
          draft: props.workspace!.draft,
        }),
      ) ?? [])
    : [];
  const visibleValidationIssues = props.workspace?.validation?.issues ?? [];
  const hasBlockingValidationIssues = visibleValidationIssues.some(
    isBlockingResumeValidationIssue,
  );
  const exportBlockedReason =
    !hasUnsavedChanges && blockingClaimAssessments.length > 0
      ? describeResumeExportClaimBlock({
          blockingAssessments: blockingClaimAssessments,
        })
      : null;
  const exportBlockedActionLabel = resumeExportClaimBlockActionLabel({
    blockingAssessments: blockingClaimAssessments,
  });
  const unresolvedWorkHistorySuggestions = props.workspace
    ? listUnresolvedWorkHistoryOmissionSuggestions({
        acknowledgments: props.workspace.draft.workHistoryReviewAcknowledgments,
        draftId: props.workspace.draft.id,
        suggestions: props.workspace.workHistoryReviewSuggestions,
      })
    : [];
  const unresolvedWorkHistoryCount = unresolvedWorkHistorySuggestions.length;
  // Hidden roles never block approval: a role left hidden is off this
  // resume, and the decisions panel offers to add any of them back.
  void unresolvedWorkHistoryCount;
  const approvalBlockedReason: string | null = null;

  const runWithSavedDraft = useCallback(
    (next: () => void | Promise<void>, successMessage?: string | null) => {
      if (hasUnsavedChanges) {
        const currentDraft = draft;
        if (!currentDraft) {
          return;
        }
        props.onSaveDraftAndThen(
          cloneDraft(currentDraft),
          next,
          successMessage ?? "Changes saved.",
          (updatedAt) => acknowledgeSave(currentDraft, updatedAt),
        );
        return;
      }

      try {
        const result = next();
        void Promise.resolve(result).catch((error: unknown) => {
          console.error("Resume workspace follow-up action failed.", error);
        });
      } catch (error) {
        console.error("Resume workspace follow-up action failed.", error);
      }
    },
    [draft, hasUnsavedChanges, props.onSaveDraftAndThen, acknowledgeSave],
  );

  const runWithSavedDraftAsync = useCallback(
    (next: () => Promise<void> | void, successMessage?: string | null) => {
      runWithSavedDraft(() => next(), successMessage);
    },
    [runWithSavedDraft],
  );

  const withDraftPatch = useCallback(
    (patch: ResumeDraftPatch): ResumeDraftPatch => {
      return {
        ...patch,
        draftId: draft?.id ?? patch.draftId,
      };
    },
    [draft],
  );

  const handleApplyPatch = useCallback(
    (patch: ResumeDraftPatch, revisionReason?: string | null) => {
      const scopedPatch = withDraftPatch(patch);

      if (scopedPatch.origin === "assistant") {
        props.onApplyPatch(scopedPatch, revisionReason);
        return;
      }

      // Any user-directed patch revises the studio draft — content patches
      // land through the saved-workspace refresh, order patches below also
      // mutate the local draft — so retire any exact-request retry captured
      // before this edit. Signalling first lets this patch's own save capture
      // its post-edit epoch and keep a truthful Retry if it fails.
      props.onDraftEdited?.();
      if (scopedPatch.operation !== "toggle_include")
        props.onApplyPatch(scopedPatch, revisionReason);

      if (
        scopedPatch.operation !== "move_entry" &&
        scopedPatch.operation !== "reset_entry_order" &&
        scopedPatch.operation !== "toggle_include"
      ) {
        return;
      }

      setDraft((currentDraft) => {
        if (!currentDraft || currentDraft.id !== scopedPatch.draftId) {
          return currentDraft;
        }

        return {
          ...currentDraft,
          sections: currentDraft.sections.map((section) => {
            if (section.id !== scopedPatch.targetSectionId) {
              return section;
            }

            if (scopedPatch.operation === "toggle_include") {
              const entries = section.entries.map((entry) => {
                if (entry.id !== scopedPatch.targetEntryId) return entry;
                if (scopedPatch.targetBulletId)
                  return {
                    ...entry,
                    bullets: entry.bullets.map((bullet) =>
                      bullet.id === scopedPatch.targetBulletId
                        ? {
                            ...bullet,
                            included:
                              scopedPatch.newIncluded ?? !bullet.included,
                          }
                        : bullet,
                    ),
                  };
                return {
                  ...entry,
                  included: scopedPatch.newIncluded ?? !entry.included,
                  origin: "user_edited" as const,
                };
              });
              return {
                ...section,
                entries,
                included:
                  scopedPatch.targetEntryId || scopedPatch.targetBulletId
                    ? entries.some(
                        (entry) =>
                          entry.id === scopedPatch.targetEntryId &&
                          entry.included,
                      )
                      ? true
                      : section.included
                    : (scopedPatch.newIncluded ?? !section.included),
                bullets: section.bullets.map((bullet) =>
                  bullet.id === scopedPatch.targetBulletId
                    ? {
                        ...bullet,
                        included: scopedPatch.newIncluded ?? !bullet.included,
                      }
                    : bullet,
                ),
              };
            }

            if (scopedPatch.operation === "reset_entry_order") {
              return {
                ...section,
                entryOrderMode: "chronology",
                entries: orderResumeEntriesNewestFirst(section.entries),
              };
            }

            if (!scopedPatch.targetEntryId || !scopedPatch.anchorEntryId) {
              return section;
            }

            const withoutTarget = section.entries.filter(
              (entry) => entry.id !== scopedPatch.targetEntryId,
            );
            const movedEntry = section.entries.find(
              (entry) => entry.id === scopedPatch.targetEntryId,
            );
            const anchorIndex = withoutTarget.findIndex(
              (entry) => entry.id === scopedPatch.anchorEntryId,
            );

            if (!movedEntry || anchorIndex === -1) {
              return section;
            }

            const insertionIndex =
              scopedPatch.position === "after" ? anchorIndex + 1 : anchorIndex;
            const entries = [...withoutTarget];
            entries.splice(insertionIndex, 0, movedEntry);

            return {
              ...section,
              entryOrderMode: "manual",
              entries: entries.map((entry, index) => ({
                ...entry,
                sortOrder: index,
              })),
            };
          }),
        };
      });
    },
    [props.onApplyPatch, props.onDraftEdited, withDraftPatch],
  );

  const { preview, previewError, previewStatus, refreshPreview } =
    useResumeWorkspacePreview({
      draft: props.originalResumeRoute ? null : draft,
      hasUnsavedChanges,
      onPreviewDraft: props.onPreviewDraft,
    });

  const handlePreviewSelection = useCallback(
    (selection: {
      sectionId: string | null;
      entryId: string | null;
      targetId: string | null;
    }) => {
      handlePreviewTargetSelect(selection);
      setMobileStudioTab("editor");
    },
    [handlePreviewTargetSelect],
  );

  const handleValidationIssueSelection = useCallback(
    (_issue: ResumeValidationIssue, targetId: string | null) => {
      if (targetId) {
        const targetContext = getResumePreviewTargetContext(targetId);
        handlePreviewTargetSelect({
          entryId: targetContext.entryId,
          sectionId: targetContext.sectionId,
          targetId,
        });
      } else {
        // Validation notes without a field target (for example work-history
        // review or page overflow) should not leave the previous field
        // selected while the editor is being opened.
        handlePreviewTargetSelect({
          entryId: null,
          sectionId: null,
          targetId: null,
        });
      }

      setMobileStudioTab("editor");
    },
    [handlePreviewTargetSelect],
  );

  // A blocker row's "Approve as accurate": the same confirmation record the
  // stretch-claim panel writes, bound to the saved draft's exact wording. It
  // needs the saved draft, so it is offered only while nothing is unsaved.
  const findApprovableAssessment = useCallback(
    (issue: ResumeValidationIssue) => {
      const prefix = "issue_claim_grounding_";
      if (!issue.id.startsWith(prefix)) return null;
      const assessmentId = issue.id.slice(prefix.length);
      const assessment =
        props.workspace?.validation?.claimAssessments.find(
          (candidate) => candidate.id === assessmentId,
        ) ?? null;
      return assessment && isResumeClaimAssessmentApprovable(assessment)
        ? assessment
        : null;
    },
    [props.workspace],
  );
  // Every blocker can be approved by the person. A claim blocker is approved
  // through the claim confirmation bound to its assessment; any other
  // blocker through an issue approval bound to its flagged wording.
  const canApproveClaim = useCallback(
    (issue: ResumeValidationIssue) =>
      Boolean(props.onSetResumeClaimConfirmation) &&
      !hasUnsavedChanges &&
      isBlockingResumeValidationIssue(issue) &&
      (issue.id.startsWith("issue_claim_grounding_")
        ? findApprovableAssessment(issue) !== null
        : true),
    [
      findApprovableAssessment,
      hasUnsavedChanges,
      props.onSetResumeClaimConfirmation,
    ],
  );
  const handleApproveClaim = useCallback(
    (issue: ResumeValidationIssue) => {
      const setConfirmation = props.onSetResumeClaimConfirmation;
      const workspace = props.workspace;
      if (!setConfirmation || !workspace) return;
      if (issue.id.startsWith("issue_claim_grounding_")) {
        const assessment = findApprovableAssessment(issue);
        if (!assessment) return;
        const commandInput = buildResumeClaimConfirmationCommandInput({
          claimAssessments: workspace.validation?.claimAssessments ?? [],
          draft: workspace.draft,
          jobId: props.jobId,
          request: { intent: "add", target: assessment },
        });
        if (!commandInput) return;
        void setConfirmation(commandInput);
        return;
      }
      void setConfirmation({
        intent: "approve_issue",
        jobId: props.jobId,
        draftId: workspace.draft.id,
        expectedDraftUpdatedAt: workspace.draft.updatedAt,
        issueId: issue.id,
        approvedContentHash: buildResumeIssueApprovalContentHash(issue),
      });
    },
    [
      findApprovableAssessment,
      props.jobId,
      props.onSetResumeClaimConfirmation,
      props.workspace,
    ],
  );
  const handleAskAiFix = useCallback(
    (issue: Parameters<typeof buildResumeValidationAiPrompt>[0]) => {
      // The sidebar sits beside the studio: opening it leaves the studio
      // exactly where the person left it.
      runWithSavedDraftAsync(
        () =>
          assistant?.openWith({
            text: buildResumeValidationAiPrompt(issue),
            sendNow: true,
          }),
        "Saved your draft before sending this request.",
      );
    },
    [assistant, runWithSavedDraftAsync],
  );

  // A blocked generated claim usually replaced text the user already had. The
  // exact same locator lookup powers the button's availability and its action,
  // so a visible "Restore previous text" always has something to restore.
  const resolveValidationRestoreCandidate = useCallback(
    (issue: ResumeValidationIssue) => {
      const savedDraft = props.workspace?.draft ?? null;

      if (!savedDraft) {
        return null;
      }

      return findResumeValidationRestoreCandidate({
        draft: savedDraft,
        issue,
        revisions: props.workspace?.revisions ?? [],
      });
    },
    [props.workspace?.draft, props.workspace?.revisions],
  );

  const canRestoreValidationIssuePreviousText = useCallback(
    (issue: ResumeValidationIssue) =>
      resolveValidationRestoreCandidate(issue) !== null,
    [resolveValidationRestoreCandidate],
  );

  const restoreValidationIssuePreviousText = useCallback(
    (issue: ResumeValidationIssue) => {
      const candidate = resolveValidationRestoreCandidate(issue);

      if (!candidate) {
        return;
      }

      runWithSavedDraft(() => {
        props.onDraftEdited?.();
        props.onApplyPatch(
          candidate.patch,
          "Restored the previous text for a blocked claim.",
        );
      }, "Saved your draft before restoring the previous text.");
    },
    [
      props.onApplyPatch,
      props.onDraftEdited,
      resolveValidationRestoreCandidate,
      runWithSavedDraft,
    ],
  );

  const acknowledgeWorkHistoryOmission = useCallback(
    (suggestion: WorkHistoryReviewSuggestion) => {
      const decision: ResumeWorkHistoryDecisionRequest = {
        intent: "acknowledge",
        suggestion: {
          id: suggestion.id,
          profileRecordId: suggestion.profileRecordId,
          kind: suggestion.kind,
          action: suggestion.action,
          messageContentHash: suggestion.messageContentHash,
        },
      };

      runWithSavedDraftAsync(
        () => props.onSetWorkHistoryReviewAcknowledgment(props.jobId, decision),
        "Saved your draft before recording this decision.",
      );
    },
    [
      props.jobId,
      props.onSetWorkHistoryReviewAcknowledgment,
      runWithSavedDraftAsync,
    ],
  );

  const removeWorkHistoryOmissionAcknowledgment = useCallback(
    (acknowledgmentId: string) => {
      runWithSavedDraftAsync(
        () =>
          props.onSetWorkHistoryReviewAcknowledgment(props.jobId, {
            intent: "remove",
            acknowledgmentId,
          }),
        "Saved your draft before updating this decision.",
      );
    },
    [
      props.jobId,
      props.onSetWorkHistoryReviewAcknowledgment,
      runWithSavedDraftAsync,
    ],
  );

  // "Add this role back": show the hidden entry again, which retires the
  // suggestion, and drop a leave-off decision if one was recorded for it.
  const includeWorkHistoryRole = useCallback(
    (suggestion: WorkHistoryReviewSuggestion) => {
      const currentDraft = props.workspace?.draft;
      if (!currentDraft) return;
      const located = currentDraft.sections
        .flatMap((section) =>
          section.entries.map((entry) => ({ section, entry })),
        )
        .find(({ section, entry }) =>
          suggestion.entryId
            ? entry.id === suggestion.entryId &&
              (suggestion.sectionId === null ||
                section.id === suggestion.sectionId)
            : entry.profileRecordId === suggestion.profileRecordId,
        );
      if (!located) return;
      const acknowledgment = currentDraft.workHistoryReviewAcknowledgments.find(
        (candidate) =>
          candidate.draftId === currentDraft.id &&
          candidate.profileRecordId === suggestion.profileRecordId &&
          candidate.kind === suggestion.kind &&
          candidate.action === suggestion.action,
      );
      if (acknowledgment) {
        removeWorkHistoryOmissionAcknowledgment(acknowledgment.id);
      }
      if (!located.entry.included) {
        handleApplyPatch(
          createResumeDraftPatch({
            entryId: located.entry.id,
            idPrefix: `resume_patch_entry_include_${located.entry.id}`,
            newIncluded: true,
            operation: "toggle_include",
            sectionId: located.section.id,
          }),
          "Added a hidden role back to the resume",
        );
      }
    },
    [
      handleApplyPatch,
      props.workspace,
      removeWorkHistoryOmissionAcknowledgment,
    ],
  );

  const pendingAssistantProposalIds = props.assistantMessages
    .filter(
      (message) =>
        message.role === "assistant" && message.proposalStatus === "pending",
    )
    .map((message) => message.id);

  function setAsidePendingAssistantProposals(): void {
    const resolveProposal = props.onResolveAssistantProposal;

    if (!resolveProposal || pendingAssistantProposalIds.length === 0) {
      setSetAsideProposalNote(null);
      return;
    }

    for (const proposalId of pendingAssistantProposalIds) {
      // Reject with no selected patches: nothing from the proposal is applied,
      // so the approved artifact stays exactly what the preview showed.
      void resolveProposal(props.jobId, proposalId, "reject", []);
    }

    // The set-aside proposal is not deleted: it stays in the Assistant thread
    // with its own "Not applied" result, so "See the suggestion" below can put
    // the user back in front of exactly what was discarded.
    setSetAsideProposalNote(
      pendingAssistantProposalIds.length === 1
        ? "1 pending suggestion was set aside because you approved the resume. It is still in the Assistant thread."
        : `${pendingAssistantProposalIds.length} pending suggestions were set aside because you approved the resume. They are still in the Assistant thread.`,
    );
  }

  if (!props.workspace || !draft) {
    return (
      <main className="grid min-h-full place-items-center px-6 py-10">
        <EmptyState
          title="Loading Resume Studio"
          description="Loading the saved draft, validation, and version history."
        />
      </main>
    );
  }

  const job = props.workspace.job;
  const recommendationContext = buildResumeThemeRecommendationContext({
    draft,
    workspace: props.workspace,
  });

  // The studio used to say "Job Finder used the built-in resume fallback
  // instead of the AI draft" while the preview beside it showed a paragraph
  // the assistant had just rewritten. The fallback sentence is now scoped to
  // the first draft, and accepted assistant edits get their own line with the
  // Undo that restores the pre-edit wording.
  const acceptedAssistantEdits = describeAcceptedAssistantEdits(
    props.assistantMessages,
    props.workspace.revisions,
  );
  const latestAssistantEditRevisionId = findLatestAssistantEditRevisionId(
    props.workspace.revisions,
  );
  // The editor panel owns the single provenance statement; the screen only
  // supplies the accepted-edit facts and the Undo that removes the newest AI
  // edit. Undo keeps every edit made after it; restoring the whole earlier
  // draft is Version history's job.
  const undoAiEditAction =
    acceptedAssistantEdits && latestAssistantEditRevisionId ? (
      <Button
        data-resume-undo-ai-edit
        disabled={props.isWorkspacePending}
        onClick={() =>
          runWithSavedDraftAsync(
            () =>
              props.onUndoAiEdit(props.jobId, latestAssistantEditRevisionId),
            "Saved your draft before undoing the AI edit.",
          )
        }
        size="sm"
        type="button"
        variant="outline"
      >
        Undo
      </Button>
    ) : null;

  const openAssistant = () => {
    assistant?.openWith();
  };

  const writeLanguage = (language: string | null) => {
    const nextDraft = { ...draft, language };
    setLanguageRequest({ language });
    props.onDraftEdited?.();
    props.onSaveDraftAndThen(
      nextDraft,
      () => undefined,
      null,
      (updatedAt) => {
        setLanguageRequest(null);
        setDraft(nextDraft);
        acknowledgeSave(nextDraft, updatedAt);
      },
    );
  };

  const rewriteFailed =
    !props.isWorkspacePending &&
    !!(
      (languageRequest && props.actionMessage) ||
      props.workspace.tailoredAsset?.failureMessage
    );
  const comparisonNeedsRefresh = resumeComparisonNeedsRefresh(draft);

  const editorPanel = (
    <ResumeWorkspaceEditorPanel
      actionMessage={
        rewriteFailed || languageRequest ? null : (props.actionMessage ?? null)
      }
      actionSavedFilePath={props.actionSavedFilePath ?? null}
      {...(props.onRevealSavedFile
        ? { onOpenSavedFolder: props.onRevealSavedFile }
        : {})}
      acceptedAssistantEdits={acceptedAssistantEdits}
      {...(undoAiEditAction ? { undoAiEditAction } : {})}
      onOpenAssistant={openAssistant}
      coverageComparison={
        comparisonNeedsRefresh
          ? null
          : (props.workspace.validation?.coverageComparison ?? null)
      }
      draft={draft}
      hasUnsavedChanges={hasUnsavedChanges}
      isWorkspacePending={props.isWorkspacePending}
      job={props.workspace.job}
      jobId={props.jobId}
      onDraftChange={(nextDraft) => {
        // Direct user edits to identity fields revise the draft.
        props.onDraftEdited?.();
        setDraft(nextDraft);
      }}
      onSectionChange={(nextSection) => {
        // Direct user edits to a section revise the draft.
        props.onDraftEdited?.();
        setDraft((currentDraft) =>
          currentDraft
            ? {
                ...currentDraft,
                sections: currentDraft.sections.map((entry) =>
                  entry.id === nextSection.id ? nextSection : entry,
                ),
              }
            : currentDraft,
        );
      }}
      onSelectEntry={handleSelectEntry}
      onSelectSection={handleSelectSection}
      runWithSavedDraft={runWithSavedDraft}
      selectionScrollKey={selectionScrollKey}
      selectedEntryId={selectedEntryId}
      selectedSectionId={selectedSectionId}
      selectedTargetId={selectedTargetId}
      onApplyPatch={handleApplyPatch}
      showGeneratedLineMarkers={
        props.workspace.effectiveTailoringStrength === "aggressive" &&
        (draft.generationMethod === "ai" ||
          Boolean(describeResumeGenerationPath(props.workspace.tailoredAsset)))
      }
      tailoredAssetGeneration={props.workspace.tailoredAsset ?? null}
      tailoredAssetNotes={props.workspace.tailoredAsset?.notes ?? []}
      workHistoryAcknowledgments={
        props.workspace.draft.workHistoryReviewAcknowledgments
      }
      workHistoryReviewSuggestions={
        props.workspace.workHistoryReviewSuggestions
      }
      onAcknowledgeWorkHistoryOmission={acknowledgeWorkHistoryOmission}
      onIncludeWorkHistoryRole={includeWorkHistoryRole}
      onRemoveWorkHistoryOmissionAcknowledgment={
        removeWorkHistoryOmissionAcknowledgment
      }
    />
  );

  const selectedTheme = getSelectedTheme(
    props.availableResumeTemplates,
    draft.templateId,
  );
  const selectedTemplateApprovalEligible = selectedTheme
    ? isResumeTemplateApprovalEligible(selectedTheme)
    : false;
  const selectedTemplateLane = selectedTheme
    ? getResumeTemplateDeliveryLane(selectedTheme)
    : "apply_safe";
  const fallbackThemeLabel = draft.templateId || "Archived template";

  const previewPane = (
    <ResumeStudioPreviewPane
      aiEditedTargetIds={acceptedAssistantEdits?.changedTargetIds ?? []}
      isDirty={hasUnsavedChanges}
      isPending={props.isWorkspacePending}
      onRetry={() => refreshPreview(draft)}
      onRevealSuggestions={() => setMobileStudioTab("editor")}
      onSelectTarget={handlePreviewSelection}
      preview={preview}
      previewError={previewError}
      previewStatus={previewStatus}
      selectedEntryId={selectedEntryId}
      selectedSectionId={selectedSectionId}
      selectedTargetId={selectedTargetId}
      selectionScrollKey={selectionScrollKey}
      templateLabel={selectedTheme?.label ?? fallbackThemeLabel}
    />
  );

  const templatePanel = (
    <ResumeWorkspaceTemplatePanel
      disabled={props.isWorkspacePending}
      recommendationContext={recommendationContext}
      selectedTemplateApprovalEligible={selectedTemplateApprovalEligible}
      selectedThemeId={draft.templateId}
      themes={props.availableResumeTemplates}
      onChange={(templateId) => {
        // Picking a template revises the draft's presentation settings.
        props.onDraftEdited?.();
        setDraft((currentDraft) =>
          currentDraft
            ? {
                ...currentDraft,
                templateId,
              }
            : currentDraft,
        );
      }}
    />
  );
  const historyPanel = (
    <ResumeVersionHistoryPanel
      currentDraft={draft}
      isPending={props.isWorkspacePending}
      onRestore={(revisionId) =>
        runWithSavedDraftAsync(
          () => props.onRestoreRevision(props.jobId, revisionId),
          "Saved your current edits before restoring the earlier draft.",
        )
      }
      revisions={props.workspace.revisions}
    />
  );
  // A stretch was accepted by choosing Aggressive (ADR 0018), so there is
  // no list of lines to confirm.
  const claimConfirmationPanel = null;
  const { approvalStateLabel, studioStatusMessage } = buildWorkspaceStatusCopy({
    approvalBlockedReason,
    availableExportToApprove,
    draft,
    hasUnsavedChanges,
    selectedTemplateApprovalEligible,
    selectedTemplateLane,
  });
  const prepareApplication = props.onPrepareApplication;

  return (
    <LockedScreenLayout
      contentClassName="overflow-hidden"
      topClassName="grid gap-1.5 pb-1"
      topContent={
        <div className="min-w-0" ref={setStudioTopContentNode}>
          <ResumeWorkspaceHeader
            draft={draft}
            jobCompany={job.company}
            jobLocation={job.location}
            jobCanonicalUrl={job.canonicalUrl}
            jobTitle={job.title}
            onBack={props.onBack}
          />
          {!props.originalResumeRoute ? (
            <ResumeWorkspaceLanguagePicker
              key={props.jobId}
              language={
                languageRequest
                  ? languageRequest.language
                  : (draft.language ?? null)
              }
              writtenLanguage={draft.writtenLanguage ?? null}
              listingLanguage={draft.listingLanguage ?? null}
              disabled={props.isWorkspacePending || backgroundDraft !== null}
              onWrite={writeLanguage}
            />
          ) : null}
          {rewriteFailed ? (
            <div
              role="alert"
              data-resume-rewrite-failure
              className="mt-2 flex flex-wrap items-center gap-2 px-5 text-sm"
            >
              <p>{FAILURE_SENTENCES.assistant_unavailable}</p>
              <Button
                size="compact"
                variant="outline"
                type="button"
                onClick={() =>
                  languageRequest
                    ? writeLanguage(languageRequest.language)
                    : props.onRegenerateDraft(props.jobId)
                }
              >
                Try again
              </Button>
            </div>
          ) : languageRequest && props.isWorkspacePending ? (
            <p role="status" className="mt-2 px-5 text-sm">
              {props.actionMessage}
            </p>
          ) : null}
          {comparisonNeedsRefresh && !languageRequest && !rewriteFailed ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 px-5 text-sm">
              <p>
                This older draft needs a rewrite to compare it with your saved
                facts.
              </p>
              <Button
                disabled={props.isWorkspacePending}
                size="compact"
                variant="outline"
                type="button"
                onClick={() => props.onRegenerateDraft(props.jobId)}
              >
                Rewrite to refresh the comparison
              </Button>
            </div>
          ) : null}
          {backgroundDraft ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-3 rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel) px-3 py-2 text-(length:--text-small)"
              data-resume-background-change
              role="status"
            >
              <span className="min-w-0 flex-1">
                This resume was changed in the background (for example by the
                assistant). Your unsaved edits are kept here; saving them is
                refused until you load the saved version.
              </span>
              <Button
                onClick={() => {
                  setDraft(cloneDraft(backgroundDraft));
                  setBackgroundDraft(null);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Load the saved version
              </Button>
            </div>
          ) : null}
        </div>
      }
    >
      <section
        className="grid h-(--resume-studio-height) min-h-96 min-w-0 grid-rows-[minmax(0,1fr)] items-stretch overflow-hidden"
        data-resume-studio-content-area
        style={
          {
            "--resume-studio-height": `calc(100dvh - ${studioTopOffset}px)`,
          } as CSSProperties
        }
      >
        <ResumeWorkspaceStudioShell
          approvalBlockedReason={approvalBlockedReason}
          approvalStateLabel={approvalStateLabel}
          approvedExportPageCount={approvedExport?.pageCount ?? null}
          canApproveResume={Boolean(
            selectedTemplateApprovalEligible &&
            !approvalBlockedReason &&
            !exportBlockedReason &&
            !hasBlockingValidationIssues,
          )}
          canClearApproval={Boolean(draft.approvedExportId)}
          canRestoreValidationIssuePreviousText={
            canRestoreValidationIssuePreviousText
          }
          onRestoreValidationIssuePreviousText={
            restoreValidationIssuePreviousText
          }
          {...(setAsideProposalNote === null ? {} : { setAsideProposalNote })}
          onDismissSetAsideProposalNote={() => setSetAsideProposalNote(null)}
          onReviewSetAsideProposal={openAssistant}
          claimConfirmationPanel={claimConfirmationPanel}
          editorPanel={editorPanel}
          exportBlockedReason={exportBlockedReason}
          hasUnsavedChanges={hasUnsavedChanges}
          historyPanel={historyPanel}
          {...(props.isExportPending === undefined
            ? {}
            : { isExportPending: props.isExportPending })}
          {...(props.isApplyPending === undefined
            ? {}
            : { isApplyPending: props.isApplyPending })}
          isWorkspacePending={props.isWorkspacePending}
          mobileStudioTab={mobileStudioTab}
          onApproveCurrentPdf={() => {
            setAsidePendingAssistantProposals();
            runWithSavedDraftAsync(
              () =>
                availableExportToApprove
                  ? props.onApproveResume(
                      props.jobId,
                      availableExportToApprove.id,
                    )
                  : props.onApproveCurrentResume(props.jobId),
              "Saved your edits before approving this resume.",
            );
          }}
          onAskAiFix={handleAskAiFix}
          canApproveClaim={canApproveClaim}
          onApproveClaim={handleApproveClaim}
          onContinueToShortlisted={props.onBack}
          onClearApproval={() =>
            runWithSavedDraftAsync(
              () => props.onClearResumeApproval(props.jobId),
              "Saved your draft before clearing approval.",
            )
          }
          onExportPdf={() =>
            runWithSavedDraft(
              () => props.onExportPdf(props.jobId),
              "Saved your draft before exporting the PDF.",
            )
          }
          {...(props.onClaimResumeIdentity
            ? { onClaimResumeIdentity: props.onClaimResumeIdentity }
            : {})}
          {...(prepareApplication
            ? {
                onPrepareApplication: () =>
                  runWithSavedDraftAsync(
                    prepareApplication,
                    "Saved your draft before preparing the application.",
                  ),
              }
            : {})}
          onReviewBlockingIssues={() => {
            // The compact layout mounts Tools only once its tab is chosen, so
            // "Review N lines" used to find nothing and leave Preview showing.
            setMobileStudioTab("editor");
            const reveal = (attempt: number) => {
              // The first line still waiting on the person: an undecided
              // stretch row, or a blocker row that offers Approve as accurate.
              const undecidedRow = document.querySelector<HTMLElement>(
                "[data-resume-claim-confirmation-row]:not([data-resume-claim-kept])",
              );
              const approvableIssue = document
                .querySelector<HTMLElement>("[data-resume-validation-approve]")
                ?.closest<HTMLElement>("[data-resume-validation-issue]");
              const target =
                undecidedRow?.closest<HTMLElement>(
                  "[data-resume-claim-confirmations]",
                ) ??
                approvableIssue ??
                document.querySelector<HTMLElement>(
                  "[data-resume-claim-confirmations]",
                );
              if (target) {
                target.scrollIntoView({
                  behavior: getJobFinderScrollBehavior(),
                  block: "start",
                });
                target.focus({ preventScroll: true });
                return;
              }
              const details = document.getElementById(
                "resume-proof-details",
              ) as HTMLDetailsElement | null;
              if (details) {
                details.open = true;
                details.scrollIntoView({
                  behavior: getJobFinderScrollBehavior(),
                  block: "start",
                });
                details.querySelector("summary")?.focus();
                return;
              }
              // Nothing mounted yet: Tools is still opening.
              if (attempt < 3) {
                requestAnimationFrame(() => reveal(attempt + 1));
              }
            };
            reveal(0);
          }}
          exportBlockedActionLabel={exportBlockedActionLabel}
          onSaveDraft={() =>
            props.onSaveDraft(draft, (updatedAt) =>
              acknowledgeSave(draft, updatedAt),
            )
          }
          onSelectValidationIssue={handleValidationIssueSelection}
          onSetMobileStudioTab={setMobileStudioTab}
          {...(props.originalResumeRoute || writingEditableLevel
            ? {
                originalResume: {
                  filePanel: (
                    <OriginalResumeFilePanel
                      source={props.originalResumeRoute?.source}
                    />
                  ),
                  levelLabel:
                    writingEditableLevel ??
                    props.originalResumeRoute?.levelLabel ??
                    "",
                  writing: writingEditableLevel !== null,
                  // The old resume chat is retired (ADR 0037); nothing is
                  // re-sent to it.
                  onWriteEditableResume: () => startEditableResumeRoute(null),
                },
              }
            : {})}
          previewPane={previewPane}
          selectedTemplateApprovalEligible={selectedTemplateApprovalEligible}
          supportingDetailsPanel={
            <ResumeWorkspaceContextDisclosure>
              <ResumeWorkspaceSidebar
                hasUnsavedChanges={hasUnsavedChanges}
                workspace={props.workspace}
              />
              <ResumeStrategyContextPanel
                context={props.workspace.strategyContext ?? null}
                effectiveTailoringStrength={
                  props.workspace.effectiveTailoringStrength
                }
              />
            </ResumeWorkspaceContextDisclosure>
          }
          studioStatusMessage={
            props.workspace.listingCheckState === "checking"
              ? "Checking listing fit in the background. You can edit your resume now."
              : props.workspace.listingCheckState === "failed"
                ? "Listing fit could not be checked. Your saved resume is available."
                : rewriteFailed
                  ? ""
                  : studioStatusMessage
          }
          templatePanel={templatePanel}
          validationIssues={visibleValidationIssues}
        />
      </section>
    </LockedScreenLayout>
  );
}
