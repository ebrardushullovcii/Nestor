import type { ChangeEventHandler } from "react";
import { Button } from "@renderer/components/ui/button";
import { CheckboxField } from "../checkbox-field";
import { FieldLabel } from "@renderer/components/ui/field";
import { ProfileInput, ProfileTextarea } from "./profile-form-primitives";
import { formatDuration } from "@renderer/features/job-finder/lib/job-finder-utils";
import type {
  SourceAccessPrompt,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import type {
  LearnedInstructionIntelligenceSummary,
  LearnedInstructionField,
  LearnedInstructionSection,
} from "./profile-source-debug-instruction-utils";
import { describeLearnedInstructionUsage } from "./profile-source-debug-instruction-utils";
import { ProfileLearnedInstructionsPanel } from "./profile-learned-instructions-panel";

interface DiscoveryTargetActionHeaderProps {
  accessibleLabel: string;
  canRunDiscovery: boolean;
  canRunSourceDebug: boolean;
  displayName: string;
  index: number;
  isBrowserSessionPending: boolean;
  isLastTarget: boolean;
  isSourceDebugPending: boolean;
  isTargetDiscoveryPending: boolean;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onOpenBrowserSession: () => void;
  onRemove: () => void;
  onRunDiscovery: (() => void) | undefined;
  onRunSourceDebug: () => void;
  sourceAccessPrompt: SourceAccessPrompt | null;
}

export function DiscoveryTargetActionHeader(
  props: DiscoveryTargetActionHeaderProps,
) {
  const {
    accessibleLabel,
    canRunDiscovery,
    canRunSourceDebug,
    displayName,
    index,
    isBrowserSessionPending,
    isLastTarget,
    isSourceDebugPending,
    isTargetDiscoveryPending,
    onMoveDown,
    onMoveUp,
    onOpenBrowserSession,
    onRemove,
    onRunDiscovery,
    onRunSourceDebug,
    sourceAccessPrompt,
  } = props;

  return (
    <header className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="grid gap-1">
        <h3 className="font-semibold text-(--text-headline)">{displayName}</h3>
        <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
          Source {index + 1}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2 lg:justify-end">
        {sourceAccessPrompt ? (
          <Button
            aria-label={`${sourceAccessPrompt.actionLabel} for ${displayName}`}
            onClick={onOpenBrowserSession}
            pending={isBrowserSessionPending}
            type="button"
            size="sm"
            variant={
              sourceAccessPrompt.state === "prompt_login_required"
                ? "primary"
                : "secondary"
            }
          >
            {sourceAccessPrompt.actionLabel}
          </Button>
        ) : null}
        {onRunDiscovery ? (
          <Button
            aria-label={`Run search now for ${accessibleLabel}`}
            disabled={!canRunDiscovery}
            pending={isTargetDiscoveryPending}
            onClick={onRunDiscovery}
            type="button"
            size="sm"
            variant="primary"
          >
            Search now
          </Button>
        ) : null}
        <Button
          aria-label={`Check this source for ${accessibleLabel}`}
          disabled={!canRunSourceDebug}
          pending={isSourceDebugPending}
          onClick={onRunSourceDebug}
          type="button"
          size="sm"
          variant="secondary"
        >
          Check source
        </Button>
        <Button
          aria-label={`Move ${accessibleLabel} up`}
          disabled={index === 0}
          onClick={onMoveUp}
          type="button"
          size="sm"
          variant="ghost"
        >
          Move up
        </Button>
        <Button
          aria-label={`Move ${accessibleLabel} down`}
          disabled={isLastTarget}
          onClick={onMoveDown}
          type="button"
          size="sm"
          variant="ghost"
        >
          Move down
        </Button>
        <Button
          title="Saved jobs stay in your plans with their original source name."
          aria-label={`Remove ${accessibleLabel}`}
          onClick={onRemove}
          type="button"
          size="sm"
          variant="ghost"
        >
          Remove
        </Button>
      </div>
    </header>
  );
}

export function DiscoveryTargetAccessPrompt(props: {
  sourceAccessPrompt: SourceAccessPrompt;
  signInToneClassName: string;
}) {
  const { sourceAccessPrompt, signInToneClassName } = props;

  return (
    <div
      aria-live="polite"
      // Required sign-in blocks the source, so it is a tinted box; a
      // recommended one is a plain hint (ADR 0042).
      className={
        sourceAccessPrompt.state === "prompt_login_required"
          ? `grid gap-2 rounded-(--radius-field) border px-3 py-3 ${signInToneClassName}`
          : "grid gap-1 text-foreground-soft"
      }
      role="status"
    >
      <p className="text-(length:--text-field-label) font-medium tracking-(--tracking-label)">
        {sourceAccessPrompt.state === "prompt_login_required"
          ? "Sign-in required"
          : "Sign-in recommended"}
      </p>
      <p className="text-(length:--text-field) leading-6">
        {sourceAccessPrompt.summary}
      </p>
      {sourceAccessPrompt.detail ? (
        <p className="text-(length:--text-description) leading-6 opacity-90">
          {sourceAccessPrompt.detail}
        </p>
      ) : null}
      {sourceAccessPrompt.rerunLabel ? (
        <p className="text-(length:--text-small) leading-6 opacity-80">
          {`After sign-in: ${sourceAccessPrompt.rerunLabel}.`}
        </p>
      ) : null}
    </div>
  );
}

interface DiscoveryTargetFormFieldsProps {
  customInstructions: string;
  labelValue: string;
  instructionStatusSummary: string;
  instructionsId: string;
  labelId: string;
  latestDebugRun: SourceDebugRunRecord | null;
  latestDebugRunLabel: string | null;
  onCustomInstructionsChange: ChangeEventHandler<HTMLTextAreaElement>;
  onLabelChange: ChangeEventHandler<HTMLInputElement>;
  onReviewLatestRun: () => void;
  onStartingUrlChange: ChangeEventHandler<HTMLInputElement>;
  startingUrl: string;
  startingUrlId: string;
  targetEnabled: boolean;
  onToggleEnabled: (checked: boolean) => void;
  isSourceDebugPending: boolean;
  reviewCheckAriaLabel: string;
}

export function DiscoveryTargetFormFields(
  props: DiscoveryTargetFormFieldsProps,
) {
  const {
    customInstructions,
    labelValue,
    instructionStatusSummary,
    instructionsId,
    isSourceDebugPending,
    labelId,
    latestDebugRun,
    latestDebugRunLabel,
    onCustomInstructionsChange,
    onLabelChange,
    onReviewLatestRun,
    onStartingUrlChange,
    onToggleEnabled,
    reviewCheckAriaLabel,
    startingUrl,
    startingUrlId,
    targetEnabled,
  } = props;
  const trimmedLatestDebugRunLabel = latestDebugRunLabel?.trim() || null;
  const latestDebugRunSummary = latestDebugRun
    ? latestDebugRun.manualPrerequisiteSummary?.trim() ||
      latestDebugRun.finalSummary?.trim() ||
      null
    : null;

  return (
    <>
      <div className="grid gap-(--gap-content) md:col-span-2 lg:grid-cols-2 lg:items-start">
        <div className="grid h-full min-w-0 content-start gap-(--gap-field)">
          <FieldLabel htmlFor={labelId}>Source name</FieldLabel>
          <ProfileInput
            id={labelId}
            onChange={onLabelChange}
            placeholder="LinkedIn or Stripe Careers"
            value={labelValue}
          />
        </div>
        <div className="grid h-full min-w-0 content-start gap-(--gap-field) lg:col-start-1">
          <FieldLabel htmlFor={startingUrlId}>Starting page URL</FieldLabel>
          <ProfileInput
            id={startingUrlId}
            onChange={onStartingUrlChange}
            placeholder="https://jobs.example.com/search"
            value={startingUrl}
          />
          <p className="text-(length:--text-small) leading-5 text-foreground-muted">
            Paste the public page that lists this company or board's open jobs.
            For example: https://job-boards.greenhouse.io/company
          </p>
        </div>
        <div className="grid h-full min-w-0 content-start gap-(--gap-field) lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <FieldLabel htmlFor={instructionsId}>Source notes</FieldLabel>
          <ProfileTextarea
            className="min-h-(--textarea-tall)"
            id={instructionsId}
            onChange={onCustomInstructionsChange}
            placeholder="Optional: add notes like 'skip contract roles' or 'focus on remote jobs'."
            rows={4}
            value={customInstructions}
          />
        </div>
        <div className="grid gap-2 lg:col-start-2">
          <CheckboxField
            checked={targetEnabled}
            label="Include this source in searches"
            onCheckedChange={onToggleEnabled}
          />
          <p
            aria-live="polite"
            aria-atomic="true"
            className="text-(length:--text-description) leading-6 text-foreground-soft"
            role="status"
          >
            <strong>{instructionStatusSummary}</strong>
          </p>
        </div>
        {latestDebugRun ? (
          <div className="surface-card-tint grid h-full min-w-0 content-start gap-1 rounded-(--radius-field) border border-(--surface-panel-border) p-3 md:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
                Last source check
              </p>
              <Button
                aria-label={reviewCheckAriaLabel}
                pending={isSourceDebugPending}
                onClick={onReviewLatestRun}
                type="button"
                variant="ghost"
              >
                Review check
              </Button>
            </div>
            <div aria-live="polite" className="grid gap-1" role="status">
              {trimmedLatestDebugRunLabel ? (
                <p className="text-(length:--text-field) leading-6 text-foreground">
                  {trimmedLatestDebugRunLabel}
                </p>
              ) : null}
              {latestDebugRunSummary ? (
                <p className="text-(length:--text-description) leading-6 text-foreground-soft">
                  {latestDebugRunSummary}
                </p>
              ) : null}
              {latestDebugRun.timing ? (
                <p className="text-(length:--text-small) leading-6 text-foreground-muted">
                  {`Duration: ${formatDuration(latestDebugRun.timing.totalDurationMs)}`}
                  {latestDebugRun.timing.longestGapMs > 10000
                    ? ` · Longest quiet gap: ${formatDuration(latestDebugRun.timing.longestGapMs)}`
                    : ""}
                  {latestDebugRun.timing.finalReviewMs != null
                    ? ` · AI review: ${formatDuration(latestDebugRun.timing.finalReviewMs)}`
                    : ""}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

interface DiscoveryTargetInstructionsProps {
  editingInstruction: {
    field: LearnedInstructionField;
    normalizedKey: string;
  } | null;
  editingInstructionValue: string;
  intelligenceSummaries: readonly LearnedInstructionIntelligenceSummary[];
  instructionArtifact: Parameters<typeof describeLearnedInstructionUsage>[0];
  latestDebugRun: Parameters<typeof describeLearnedInstructionUsage>[1];
  isEditingInstructionPending: boolean;
  isInstructionEditPending: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => boolean;
  isInstructionRemovePending: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => boolean;
  isInstructionSavePending: boolean;
  onBeginEditingInstruction: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => void;
  onCancelEditingInstruction: () => void;
  onChangeEditingInstructionValue: (value: string) => void;
  onPersistEditedInstruction: () => void;
  onRemoveInstructionLine: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => void;
  sections: readonly LearnedInstructionSection[];
  targetId: string;
}

export function DiscoveryTargetInstructions(
  props: DiscoveryTargetInstructionsProps,
) {
  return (
    <ProfileLearnedInstructionsPanel
      editingInstruction={props.editingInstruction}
      editingInstructionValue={props.editingInstructionValue}
      intelligenceSummaries={props.intelligenceSummaries}
      instructionArtifactDescription={describeLearnedInstructionUsage(
        props.instructionArtifact,
        props.latestDebugRun,
      )}
      isEditingInstructionPending={props.isEditingInstructionPending}
      isInstructionEditPending={props.isInstructionEditPending}
      isInstructionRemovePending={props.isInstructionRemovePending}
      isInstructionSavePending={props.isInstructionSavePending}
      onBeginEditingInstruction={props.onBeginEditingInstruction}
      onCancelEditingInstruction={props.onCancelEditingInstruction}
      onChangeEditingInstructionValue={props.onChangeEditingInstructionValue}
      onPersistEditedInstruction={props.onPersistEditedInstruction}
      onRemoveInstructionLine={props.onRemoveInstructionLine}
      sections={props.sections}
      targetId={props.targetId}
    />
  );
}
