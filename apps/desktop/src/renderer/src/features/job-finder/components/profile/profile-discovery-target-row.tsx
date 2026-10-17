import { useToast } from "@renderer/components/ui/toast";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import type {
  EditableSourceInstructionArtifact,
  SourceAccessPrompt,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import { formatRunStateLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import type { SearchPreferencesEditorValues } from "../../lib/profile-editor";
import { ProfileSourceDebugReviewModal } from "./profile-source-debug-review-modal";
import {
  DiscoveryTargetAccessPrompt,
  DiscoveryTargetActionHeader,
  DiscoveryTargetFormFields,
  DiscoveryTargetInstructions,
} from "./profile-discovery-target-row-sections";
import {
  buildLearnedInstructionIntelligenceSummaries,
  type LearnedInstructionField,
  type LearnedInstructionSection,
  buildLearnedInstructionSections,
  hasValidAbsoluteStartingUrl,
  normalizeEditableInstructionInput,
  updateArtifactInstructionSection,
} from "./profile-source-debug-instruction-utils";
import { useProfileSourceDebugReview } from "./use-profile-source-debug-review";

type DiscoveryTargetValue =
  SearchPreferencesEditorValues["discoveryTargets"][number];

function formatInstructionStatusSummary(target: DiscoveryTargetValue): string {
  switch (target.instructionStatus) {
    case "validated":
      return target.lastVerifiedAt
        ? `Saved guidance ready - checked ${new Date(target.lastVerifiedAt).toLocaleString()}`
        : "Saved guidance ready";
    case "draft":
      return "Draft guidance saved";
    case "stale":
      return target.staleReason
        ? `Guidance needs review - ${target.staleReason}`
        : "Guidance needs review";
    case "unsupported":
      return "Not supported yet";
    default:
      return "No saved guidance yet";
  }
}

interface ProfileDiscoveryTargetRowProps {
  discoveryTargets: readonly DiscoveryTargetValue[];
  index: number;
  instructionArtifact: SourceInstructionArtifact | null;
  isBrowserSessionPending: (targetId: string) => boolean;
  isSourceDebugPending: (targetId: string) => boolean;
  isSourceInstructionPending: (targetId: string) => boolean;
  isSourceInstructionVerifyPending: (instructionId: string) => boolean;
  isTargetDiscoveryPending: (targetId: string) => boolean;
  onGetSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onRunSourceDebug: (targetId: string) => void;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  onVerifySourceInstructions: (targetId: string, instructionId: string) => void;
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  sourceAccessPrompt: SourceAccessPrompt | null;
  target: DiscoveryTargetValue;
  updateDiscoveryTargets: (
    nextTargets: SearchPreferencesEditorValues["discoveryTargets"],
  ) => void;
}

export function ProfileDiscoveryTargetRow(
  props: ProfileDiscoveryTargetRowProps,
) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const startingUrlId = `${baseId}-starting-url`;
  const instructionsId = `${baseId}-instructions`;
  const targetLabel = props.target.label.trim();
  const displayName = targetLabel || "New source";
  const accessibleLabel = targetLabel || `New source ${props.index + 1}`;
  const learnedInstructionSections = useMemo(
    () => buildLearnedInstructionSections(props.instructionArtifact),
    [props.instructionArtifact],
  );
  const learnedInstructionIntelligenceSummaries = useMemo(
    () =>
      buildLearnedInstructionIntelligenceSummaries(props.instructionArtifact),
    [props.instructionArtifact],
  );
  const {
    latestDebugRun,
    reviewDetails,
    reviewError,
    reviewLoading,
    reviewOpen,
    selectedRunId,
    targetRuns,
    handleCloseReview,
    handleLoadRun,
    handleReviewLatestRun,
    handleRerun,
    handleVerify,
  } = useProfileSourceDebugReview({
    getRunDetails: props.onGetSourceDebugRunDetails,
    onRunSourceDebug: props.onRunSourceDebug,
    onVerifySourceInstructions: props.onVerifySourceInstructions,
    recentSourceDebugRuns: props.recentSourceDebugRuns,
    targetId: props.target.id,
    targetLastDebugRunId: props.target.lastDebugRunId,
  });
  const latestDebugRunLabel = latestDebugRun
    ? `${formatRunStateLabel(latestDebugRun.state)}${latestDebugRun.completedAt ? ` • ${new Date(latestDebugRun.completedAt).toLocaleString()}` : ""}`
    : null;
  const [editingInstruction, setEditingInstruction] = useState<{
    field: LearnedInstructionField;
    normalizedKey: string;
  } | null>(null);
  const [editingInstructionValue, setEditingInstructionValue] = useState("");
  const isTargetDiscoveryPending = props.isTargetDiscoveryPending(
    props.target.id,
  );
  const isAnyTargetDiscoveryPending = props.discoveryTargets.some((target) =>
    props.isTargetDiscoveryPending(target.id),
  );
  const isTargetBrowserSessionPending = props.isBrowserSessionPending(
    props.target.id,
  );
  const isTargetSourceDebugPending = props.isSourceDebugPending(
    props.target.id,
  );
  const isInstructionSavePending = props.isSourceInstructionPending(
    props.target.id,
  );
  const [pendingInstructionAction, setPendingInstructionAction] = useState<{
    field: LearnedInstructionField;
    kind: "edit" | "remove";
    normalizedKey: string;
  } | null>(null);
  const sourceAccessPrompt = props.sourceAccessPrompt;
  const signInToneClassName =
    sourceAccessPrompt?.state === "prompt_login_required"
      ? "border-(--warning-border) bg-(--warning-surface) text-(--warning-text)"
      : "border-(--info-border) bg-(--info-surface) text-(--info-text)";
  const canRunSearchNow =
    !isAnyTargetDiscoveryPending &&
    props.target.enabled &&
    hasValidAbsoluteStartingUrl(props.target.startingUrl);
  const canRunSourceDebug = hasValidAbsoluteStartingUrl(
    props.target.startingUrl,
  );

  useEffect(() => {
    if (!isInstructionSavePending) {
      setPendingInstructionAction(null);
    }
  }, [isInstructionSavePending]);

  const updateTarget = (nextTarget: DiscoveryTargetValue) => {
    const existingTarget = props.discoveryTargets[props.index];
    const nextTargets = [...props.discoveryTargets];
    nextTargets[props.index] = {
      ...nextTarget,
      adapterKind:
        nextTarget.adapterKind ?? existingTarget?.adapterKind ?? "auto",
    };
    props.updateDiscoveryTargets(nextTargets);
  };

  const saveInstructionArtifact = (
    artifact: EditableSourceInstructionArtifact,
  ) => {
    props.onSaveSourceInstructionArtifact(props.target.id, artifact);
  };

  const beginEditingInstruction = (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => {
    setEditingInstruction({
      field: section.field,
      normalizedKey: line.normalizedKey,
    });
    setEditingInstructionValue(line.sourceText);
  };

  const cancelEditingInstruction = () => {
    setEditingInstruction(null);
    setEditingInstructionValue("");
  };

  const persistEditedInstruction = () => {
    if (!props.instructionArtifact || !editingInstruction) {
      return;
    }

    const nextValue = normalizeEditableInstructionInput(
      editingInstruction.field,
      editingInstructionValue,
    );
    if (!nextValue) {
      return;
    }

    saveInstructionArtifact(
      updateArtifactInstructionSection(
        props.instructionArtifact,
        editingInstruction.field,
        editingInstruction.normalizedKey,
        nextValue,
      ),
    );
    setPendingInstructionAction({
      field: editingInstruction.field,
      kind: "edit",
      normalizedKey: editingInstruction.normalizedKey,
    });
    cancelEditingInstruction();
  };

  const removeInstructionLine = (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => {
    if (!props.instructionArtifact) {
      return;
    }

    saveInstructionArtifact(
      updateArtifactInstructionSection(
        props.instructionArtifact,
        section.field,
        line.normalizedKey,
        null,
      ),
    );
    setPendingInstructionAction({
      field: section.field,
      kind: "remove",
      normalizedKey: line.normalizedKey,
    });

    if (
      editingInstruction?.field === section.field &&
      editingInstruction.normalizedKey === line.normalizedKey
    ) {
      cancelEditingInstruction();
    }
  };

  const moveTarget = useCallback(
    (direction: -1 | 1) => {
      const nextIndex = props.index + direction;
      const nextTargets = [...props.discoveryTargets];
      const currentTarget = nextTargets[props.index];
      const adjacentTarget = nextTargets[nextIndex];

      if (!currentTarget || !adjacentTarget) {
        return;
      }

      nextTargets[props.index] = adjacentTarget;
      nextTargets[nextIndex] = currentTarget;
      props.updateDiscoveryTargets(nextTargets);
    },
    [props.discoveryTargets, props.index, props.updateDiscoveryTargets],
  );

  const handleRunSourceDebug = useCallback(() => {
    props.onRunSourceDebug(props.target.id);
  }, [props.onRunSourceDebug, props.target.id]);

  const handleRunDiscoveryForTarget = useCallback(() => {
    props.onRunDiscoveryForTarget?.(props.target.id);
  }, [props.onRunDiscoveryForTarget, props.target.id]);

  const handleOpenBrowserSessionForTarget = useCallback(() => {
    props.onOpenBrowserSessionForTarget(props.target.id);
  }, [props.onOpenBrowserSessionForTarget, props.target.id]);

  const handleMoveTargetUp = useCallback(() => {
    moveTarget(-1);
  }, [moveTarget]);

  const handleMoveTargetDown = useCallback(() => {
    moveTarget(1);
  }, [moveTarget]);

  const { showToast } = useToast();
  const handleRemoveTarget = useCallback(() => {
    props.updateDiscoveryTargets(
      props.discoveryTargets.filter((entry) => entry.id !== props.target.id),
    );
    showToast({
      title: "Source removed",
      description:
        "Its saved jobs stay in your plans with their original source name.",
    });
  }, [
    props.discoveryTargets,
    props.target.id,
    props.updateDiscoveryTargets,
    showToast,
  ]);

  const handleToggleEnabled = useCallback(
    (checked: boolean) => {
      updateTarget({ ...props.target, enabled: checked });
    },
    [
      props.discoveryTargets,
      props.index,
      props.target,
      props.updateDiscoveryTargets,
    ],
  );

  const handleLabelChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateTarget({ ...props.target, label: event.target.value });
    },
    [
      props.discoveryTargets,
      props.index,
      props.target,
      props.updateDiscoveryTargets,
    ],
  );

  const handleStartingUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateTarget({ ...props.target, startingUrl: event.target.value });
    },
    [
      props.discoveryTargets,
      props.index,
      props.target,
      props.updateDiscoveryTargets,
    ],
  );

  const handleCustomInstructionsChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      updateTarget({ ...props.target, customInstructions: event.target.value });
    },
    [
      props.discoveryTargets,
      props.index,
      props.target,
      props.updateDiscoveryTargets,
    ],
  );

  return (
    <article className="surface-card-tint grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
      <DiscoveryTargetActionHeader
        accessibleLabel={accessibleLabel}
        canRunDiscovery={canRunSearchNow}
        canRunSourceDebug={canRunSourceDebug}
        displayName={displayName}
        index={props.index}
        isBrowserSessionPending={isTargetBrowserSessionPending}
        isLastTarget={props.index === props.discoveryTargets.length - 1}
        isSourceDebugPending={isTargetSourceDebugPending}
        isTargetDiscoveryPending={isTargetDiscoveryPending}
        onMoveDown={handleMoveTargetDown}
        onMoveUp={handleMoveTargetUp}
        onOpenBrowserSession={handleOpenBrowserSessionForTarget}
        onRemove={handleRemoveTarget}
        onRunDiscovery={
          props.onRunDiscoveryForTarget
            ? handleRunDiscoveryForTarget
            : undefined
        }
        onRunSourceDebug={handleRunSourceDebug}
        sourceAccessPrompt={sourceAccessPrompt}
      />

      {sourceAccessPrompt ? (
        <DiscoveryTargetAccessPrompt
          signInToneClassName={signInToneClassName}
          sourceAccessPrompt={sourceAccessPrompt}
        />
      ) : null}

      <div className="grid gap-(--gap-content) md:grid-cols-2">
        <DiscoveryTargetFormFields
          customInstructions={props.target.customInstructions}
          instructionStatusSummary={formatInstructionStatusSummary(
            props.target,
          )}
          instructionsId={instructionsId}
          isSourceDebugPending={isTargetSourceDebugPending}
          labelId={labelId}
          labelValue={props.target.label}
          latestDebugRun={latestDebugRun}
          latestDebugRunLabel={latestDebugRunLabel}
          onCustomInstructionsChange={handleCustomInstructionsChange}
          onLabelChange={handleLabelChange}
          onReviewLatestRun={handleReviewLatestRun}
          onStartingUrlChange={handleStartingUrlChange}
          onToggleEnabled={handleToggleEnabled}
          reviewCheckAriaLabel={`Review the latest source check for ${accessibleLabel}`}
          startingUrl={props.target.startingUrl}
          startingUrlId={startingUrlId}
          targetEnabled={props.target.enabled}
        />
        <DiscoveryTargetInstructions
          editingInstruction={editingInstruction}
          editingInstructionValue={editingInstructionValue}
          intelligenceSummaries={learnedInstructionIntelligenceSummaries}
          isEditingInstructionPending={
            isInstructionSavePending &&
            pendingInstructionAction?.kind === "edit" &&
            pendingInstructionAction.field === editingInstruction?.field &&
            pendingInstructionAction.normalizedKey ===
              editingInstruction?.normalizedKey
          }
          isInstructionEditPending={(section, line) =>
            isInstructionSavePending &&
            pendingInstructionAction?.kind === "edit" &&
            pendingInstructionAction.field === section.field &&
            pendingInstructionAction.normalizedKey === line.normalizedKey
          }
          isInstructionRemovePending={(section, line) =>
            isInstructionSavePending &&
            pendingInstructionAction?.kind === "remove" &&
            pendingInstructionAction.field === section.field &&
            pendingInstructionAction.normalizedKey === line.normalizedKey
          }
          isInstructionSavePending={isInstructionSavePending}
          instructionArtifact={props.instructionArtifact}
          latestDebugRun={latestDebugRun}
          onBeginEditingInstruction={beginEditingInstruction}
          onCancelEditingInstruction={cancelEditingInstruction}
          onChangeEditingInstructionValue={setEditingInstructionValue}
          onPersistEditedInstruction={persistEditedInstruction}
          onRemoveInstructionLine={removeInstructionLine}
          sections={learnedInstructionSections}
          targetId={props.target.id}
        />
      </div>
      <ProfileSourceDebugReviewModal
        details={reviewDetails}
        errorMessage={reviewError}
        isSourceDebugPending={isTargetSourceDebugPending}
        isVerifyPending={props.isSourceInstructionVerifyPending}
        loading={reviewLoading}
        onClose={handleCloseReview}
        onLoadRun={handleLoadRun}
        onRerun={handleRerun}
        onVerify={handleVerify}
        open={reviewOpen}
        recentRuns={targetRuns}
        selectedRunId={selectedRunId}
        targetLabel={displayName}
      />
    </article>
  );
}
