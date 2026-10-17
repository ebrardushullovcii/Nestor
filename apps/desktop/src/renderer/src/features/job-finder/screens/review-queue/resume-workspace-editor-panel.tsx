import { useState, type ReactNode } from "react";
import type {
  ResumeCoverageClaimChange,
  ResumeCoverageComparison,
  ResumeCoverageRoleComparison,
  ResumeDraft,
  ResumeDraftPatch,
  WorkHistoryReviewSuggestion,
} from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import { ResumeCoverageComparisonPanel } from "./resume-coverage-comparison-panel";
import { ResumeMissingSkillChips } from "./resume-missing-skill-chips";
import {
  ResumeJobKeywordEvidencePanel,
  type ResumeKeywordEvidenceJob,
} from "./resume-job-keyword-evidence";
import { ResumeIdentityEditor } from "./resume-identity-editor";
import { ResumeSectionEditor } from "./resume-section-editor";
import { ResumeWorkHistoryDecisions } from "./resume-workspace-work-history-decisions";
import { createResumeDraftPatch } from "./resume-section-editor-helpers";
import {
  type AcceptedAssistantEditSummary,
  describeResumeDraftProvenance,
  describeResumeGenerationPath,
  type ResumeGenerationPathInput,
} from "./resume-workspace-utils";

type ResumeDraftSection = ResumeDraft["sections"][number];
type DraftAcknowledgments = ResumeDraft["workHistoryReviewAcknowledgments"];

interface ResumeWorkspaceEditorPanelProps {
  actionMessage: string | null;
  onRetryAction?: (() => void) | undefined;
  /**
   * The file the message names, when an export just wrote one. C6 landed the
   * path sentence and left the person to find the file by hand.
   */
  actionSavedFilePath?: string | null;
  onOpenSavedFolder?: (path: string) => void;
  coverageComparison: ResumeCoverageComparison | null;
  draft: ResumeDraft;
  hasUnsavedChanges: boolean;
  isWorkspacePending: boolean;
  job?: ResumeKeywordEvidenceJob | null;
  jobId: string;
  onAcknowledgeWorkHistoryOmission: (
    suggestion: WorkHistoryReviewSuggestion,
  ) => void;
  onApplyPatch: (
    patch: ResumeDraftPatch,
    revisionReason?: string | null,
  ) => void;
  onDraftChange: (draft: ResumeDraft) => void;
  onIncludeWorkHistoryRole?: (suggestion: WorkHistoryReviewSuggestion) => void;
  onRemoveWorkHistoryOmissionAcknowledgment: (acknowledgmentId: string) => void;
  onSectionChange: (section: ResumeDraftSection) => void;
  onSelectEntry: (sectionId: string, entryId: string) => void;
  onSelectSection: (sectionId: string) => void;
  runWithSavedDraft: (
    next: () => void | Promise<void>,
    successMessage?: string | null,
  ) => void;
  /**
   * Accepted assistant proposals, folded into the single provenance statement
   * so the one place a user checks "did the AI actually help me" agrees with
   * both the preview beside it and the draft-origin sentence.
   */
  acceptedAssistantEdits?: AcceptedAssistantEditSummary | null;
  /** Undo control for the newest accepted assistant edit, if one exists. */
  undoAiEditAction?: ReactNode;
  onOpenAssistant?: () => void;
  selectionScrollKey?: number;
  selectedEntryId: string | null;
  selectedSectionId: string | null;
  selectedTargetId: string | null;
  showGeneratedLineMarkers?: boolean;
  tailoredAssetGeneration?: ResumeGenerationPathInput | null;
  tailoredAssetNotes?: readonly string[];
  workHistoryAcknowledgments: DraftAcknowledgments;
  workHistoryReviewSuggestions: readonly WorkHistoryReviewSuggestion[];
}

export function ResumeWorkspaceEditorPanel(
  props: ResumeWorkspaceEditorPanelProps,
) {
  const helperMessage = props.hasUnsavedChanges
    ? "Live preview already shows these unsaved edits. Save before export or approval."
    : "Click the live page to jump to the matching structured field.";
  // Only the section being reviewed is open, so a one-page resume can be
  // reviewed inside one screen of tools instead of a ten-viewport scroll
  // ladder. Any new selection — a preview click, a validation "Fix in editor",
  // an assistant target — opens its own section.
  //
  // The sync happens during render, not in an effect: the field-focus hook
  // runs on the same commit as the selection change, so a section opened one
  // commit later would leave focus on the section title instead of the exact
  // field the user clicked in the preview.
  const [expansion, setExpansion] = useState<{
    sectionId: string | null;
    selectedSectionId: string | null;
    selectionScrollKey: number;
  }>(() => ({
    sectionId: props.selectedSectionId ?? props.draft.sections[0]?.id ?? null,
    selectedSectionId: props.selectedSectionId,
    selectionScrollKey: props.selectionScrollKey ?? 0,
  }));
  const selectionScrollKey = props.selectionScrollKey ?? 0;
  if (
    props.selectedSectionId &&
    (props.selectedSectionId !== expansion.selectedSectionId ||
      selectionScrollKey !== expansion.selectionScrollKey)
  ) {
    setExpansion({
      sectionId: props.selectedSectionId,
      selectedSectionId: props.selectedSectionId,
      selectionScrollKey,
    });
  }
  const expandedSectionId = expansion.sectionId;
  const setExpandedSectionId = (
    next: string | null | ((current: string | null) => string | null),
  ) => {
    setExpansion((current) => ({
      ...current,
      sectionId: typeof next === "function" ? next(current.sectionId) : next,
    }));
  };
  const skillSuggestionSectionId = (() => {
    const skillSections = props.draft.sections.filter(
      (section) => section.kind === "skills",
    );
    if (skillSections.length === 0) {
      return null;
    }

    return (
      skillSections.find((section) => /additional/i.test(section.label))?.id ??
      skillSections[skillSections.length - 1]?.id ??
      null
    );
  })();
  const missingSkills = props.coverageComparison?.removedKeywords ?? [];
  const addSkillToSection = (skill: string) => {
    if (!skillSuggestionSectionId) {
      return;
    }

    props.runWithSavedDraft(
      () =>
        props.onApplyPatch(
          createResumeDraftPatch({
            idPrefix: `add_skill_${skill.replace(/[^a-z0-9]+/gi, "_")}`,
            newText: skill,
            operation: "insert_bullet",
            sectionId: skillSuggestionSectionId,
          }),
          `Added ${skill} back to the resume.`,
        ),
      "Saved your draft before adding this skill.",
    );
  };
  const generationPath = describeResumeGenerationPath(
    props.tailoredAssetGeneration ?? {
      generationMethod: "deterministic",
      generationReason: null,
      generationDetail: null,
      notes: props.tailoredAssetNotes ?? [],
    },
  );
  const deterministicFallbackMessage = generationPath?.message ?? null;
  const acceptedAssistantEdits = props.acceptedAssistantEdits ?? null;
  // One statement, not two stacked notes that read as a contradiction: who
  // wrote the first draft, then what the user has accepted since.
  const draftProvenanceMessage = describeResumeDraftProvenance({
    acceptedAssistantEdits,
    generationPath,
  });

  const restoreClaim = (
    role: ResumeCoverageRoleComparison,
    claim: ResumeCoverageClaimChange,
  ) => {
    if (!role.sectionId || !role.entryId) {
      return;
    }
    const sectionId = role.sectionId;
    const entryId = role.entryId;

    props.runWithSavedDraft(
      () =>
        props.onApplyPatch(
          createResumeDraftPatch({
            entryId,
            idPrefix: `restore_${claim.field}`,
            newText: claim.text,
            operation:
              claim.field === "summary"
                ? "replace_entry_summary"
                : "insert_bullet",
            sectionId,
          }),
          `Restored original ${claim.field} for ${role.title}.`,
        ),
      "Saved your draft before restoring the original content.",
    );
  };

  const restoreRole = (role: ResumeCoverageRoleComparison) => {
    if (!role.sectionId || !role.entryId) {
      return;
    }
    const sectionId = role.sectionId;
    const entryId = role.entryId;
    props.runWithSavedDraft(
      () =>
        props.onApplyPatch(
          createResumeDraftPatch({
            entryId,
            idPrefix: "restore_role",
            newIncluded: true,
            operation: "toggle_include",
            sectionId,
          }),
          `Restored ${role.title} to the resume.`,
        ),
      "Saved your draft before restoring the role.",
    );
  };

  return (
    <section className="surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) xl:overflow-visible">
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-1 content-start gap-2.5 overflow-x-hidden overflow-y-auto p-2.5 pr-2 [overflow-wrap:anywhere] xl:overflow-visible"
        data-resume-editor-scroll-region
        tabIndex={-1}
      >
        <div className="grid min-w-0 grid-cols-1 gap-1 border-b border-(--surface-panel-border) pb-2">
          {/* No size override: the published scale owns `h2`. Forcing this
              to 14px put it *under* its own 16px `h3` section headings.
              The subtitle that used to sit here said the heading again in
              schema words; the helper line below is the one that carries a
              fact. */}
          <h2 className="font-display text-(--text-headline)">Edit resume</h2>
          <p className="text-(length:--text-body) leading-6 text-foreground xl:hidden">
            {helperMessage}
          </p>
          {props.draft.generationMethod === "ai" ? (
            <div
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3 py-2 text-(length:--text-body) leading-6 text-foreground"
              data-resume-ai-assistance-disclosure
              role="note"
            >
              This draft was created with AI assistance. Review the full draft
              against your experience and saved evidence before approval.
            </div>
          ) : null}
          {draftProvenanceMessage ? (
            <div
              className={
                deterministicFallbackMessage
                  ? "flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-body) leading-6 text-(--warning-text)"
                  : "flex flex-wrap items-start justify-between gap-x-3 gap-y-2 text-(length:--text-body) leading-6 text-foreground-soft"
              }
              data-resume-draft-provenance
              {...(deterministicFallbackMessage
                ? { "data-resume-deterministic-fallback-disclosure": true }
                : {})}
              {...(acceptedAssistantEdits
                ? { "data-resume-applied-ai-edits": true }
                : {})}
              role="note"
            >
              <span className="min-w-0 flex-1">{draftProvenanceMessage}</span>
              <span className="flex shrink-0 flex-wrap items-center gap-2">
                {props.undoAiEditAction}
                {/* "Retry with AI" here was a second AI control with an
                    unstated blast radius. Trying the AI draft again now
                    belongs to the Assistant, which says what it replaces
                    before it runs. */}
                {generationPath?.canRetryWithAi && props.onOpenAssistant ? (
                  <Button
                    data-resume-open-assistant
                    disabled={props.isWorkspacePending}
                    onClick={props.onOpenAssistant}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Ask the Assistant
                  </Button>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
        <ResumeWorkHistoryDecisions
          acknowledgments={props.workHistoryAcknowledgments}
          disabled={props.isWorkspacePending}
          draftId={props.draft.id}
          sections={props.draft.sections}
          roles={props.coverageComparison?.roles ?? []}
          suggestions={props.workHistoryReviewSuggestions}
          onAcknowledge={props.onAcknowledgeWorkHistoryOmission}
          {...(props.onIncludeWorkHistoryRole
            ? { onIncludeRole: props.onIncludeWorkHistoryRole }
            : {})}
          onRemoveAcknowledgment={
            props.onRemoveWorkHistoryOmissionAcknowledgment
          }
        />
        <ResumeIdentityEditor
          disabled={props.isWorkspacePending}
          identity={props.draft.identity}
          selectedTargetId={props.selectedTargetId}
          onChange={(identity) =>
            props.onDraftChange({
              ...props.draft,
              identity,
            })
          }
        />
        {props.draft.sections.map((section) => (
          <ResumeSectionEditor
            key={section.id}
            disabled={props.isWorkspacePending}
            isExpanded={expandedSectionId === section.id}
            isSelected={props.selectedSectionId === section.id}
            onToggleExpanded={(sectionId) =>
              setExpandedSectionId((current) =>
                current === sectionId ? null : sectionId,
              )
            }
            {...(section.id === skillSuggestionSectionId
              ? {
                  skillSuggestions: (
                    <ResumeMissingSkillChips
                      disabled={props.isWorkspacePending}
                      onAddSkill={addSkillToSection}
                      skills={missingSkills}
                    />
                  ),
                }
              : {})}
            selectedEntryId={
              props.selectedSectionId === section.id
                ? props.selectedEntryId
                : null
            }
            selectedTargetId={
              props.selectedSectionId === section.id
                ? props.selectedTargetId
                : null
            }
            section={section}
            showGeneratedMarkers={Boolean(props.showGeneratedLineMarkers)}
            onChange={props.onSectionChange}
            onPatch={(patch, revisionReason) =>
              patch.origin === "user" && patch.operation === "toggle_include"
                ? props.onApplyPatch(patch, revisionReason)
                : props.runWithSavedDraft(
                    () => props.onApplyPatch(patch, revisionReason),
                    "Saved your draft before applying this update.",
                  )
            }
            onSelectEntry={props.onSelectEntry}
            onSelectSection={props.onSelectSection}
            workHistoryReviewSuggestions={props.workHistoryReviewSuggestions.filter(
              (suggestion) => suggestion.sectionId === section.id,
            )}
            {...(props.selectionScrollKey === undefined
              ? {}
              : { selectionScrollKey: props.selectionScrollKey })}
          />
        ))}
        <ResumeJobKeywordEvidencePanel
          draft={props.draft}
          fallbackMessage={deterministicFallbackMessage}
          job={props.job}
        />
        <ResumeCoverageComparisonPanel
          comparison={props.coverageComparison}
          disabled={props.isWorkspacePending}
          onRestoreClaim={restoreClaim}
          onRestoreRole={restoreRole}
        />
      </div>

      {/* The outcome of an export or a save is announced, not just drawn:
          a person who cannot see this strip was told nothing at all. */}
      <div
        aria-live="polite"
        className="border-t border-(--surface-panel-border) px-2.5 py-1.5"
        role="status"
      >
        {props.actionMessage ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 break-words text-(length:--text-small) leading-5 text-primary">
              {props.actionMessage}
            </p>
            {props.onRetryAction ? (
              <Button
                disabled={props.isWorkspacePending}
                onClick={props.onRetryAction}
                size="compact"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            ) : null}
            {props.actionSavedFilePath && props.onOpenSavedFolder ? (
              <Button
                onClick={() => {
                  props.onOpenSavedFolder?.(props.actionSavedFilePath ?? "");
                }}
                size="compact"
                type="button"
                variant="outline"
              >
                Open folder
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="h-action-message" />
        )}
      </div>
    </section>
  );
}
