import { useMemo, useState } from "react";
import type {
  EditableSourceInstructionArtifact,
  JobSite,
  SourceInstructionArtifact,
  UpdateJobSiteInput,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "../open-outside-links";
import {
  DiscoveryTargetFormFields,
  DiscoveryTargetInstructions,
} from "./profile-discovery-target-row-sections";
import {
  buildLearnedInstructionIntelligenceSummaries,
  buildLearnedInstructionSections,
  normalizeEditableInstructionInput,
  updateArtifactInstructionSection,
  type LearnedInstructionField,
  type LearnedInstructionSection,
} from "./profile-source-debug-instruction-utils";

export interface SiteDebugActions {
  isSourceDebugPending: (id: string) => boolean;
  isSourceInstructionPending: (id: string) => boolean;
  onRunSourceDebug: (id: string) => void;
  onSaveSourceInstructionArtifact: (
    id: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
}

export function ProfileDiscoveryTargetRow(
  props: SiteDebugActions & {
    target: JobSite;
    instructionArtifact: SourceInstructionArtifact | null;
    onRemoved: () => void;
  },
) {
  const site = props.target,
    targetId = String(site.id);
  const { showToast } = useToast();
  const [draft, setDraft] = useState<
    Partial<Pick<JobSite, "label" | "url" | "customInstructions">>
  >({});
  const [error, setError] = useState<string | null>(null);
  const update = async (patch: Omit<UpdateJobSiteInput, "id">) => {
    try {
      await window.nestor.jobs.run("update_site", { id: site.id, ...patch });
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not save this site.",
      );
      throw reason;
    }
  };
  const saveDraft = async () => {
    if (Object.keys(draft).length === 0) return;
    const patch = { ...draft };
    try {
      await update(patch);
      setDraft((current) => {
        const next = { ...current };
        if (current.label === patch.label) delete next.label;
        if (current.url === patch.url) delete next.url;
        if (current.customInstructions === patch.customInstructions)
          delete next.customInstructions;
        return next;
      });
    } catch {
      /* The field and its error stay visible for correction. */
    }
  };
  const learnedInstructionSections = useMemo(
    () => buildLearnedInstructionSections(props.instructionArtifact),
    [props.instructionArtifact],
  );
  const learnedInstructionIntelligenceSummaries = useMemo(
    () =>
      buildLearnedInstructionIntelligenceSummaries(props.instructionArtifact),
    [props.instructionArtifact],
  );
  const [editingInstruction, setEditingInstruction] = useState<{
    field: LearnedInstructionField;
    normalizedKey: string;
  } | null>(null);
  const [editingInstructionValue, setEditingInstructionValue] = useState("");
  const [pendingInstructionAction, setPendingInstructionAction] = useState<{
    field: LearnedInstructionField;
    kind: "edit" | "remove";
    normalizedKey: string;
  } | null>(null);
  const isInstructionSavePending = props.isSourceInstructionPending(targetId);
  const isTargetSourceDebugPending = props.isSourceDebugPending(targetId);
  const saveInstructionArtifact = (
    artifact: EditableSourceInstructionArtifact,
  ) => props.onSaveSourceInstructionArtifact(targetId, artifact);
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

  return (
    <section
      aria-label="Site details"
      className="surface-panel-shell flex min-h-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)"
    >
      <header className="grid gap-3 border-b border-(--surface-panel-border) px-5 py-4">
        <h2 className="font-display text-lg font-semibold">{site.label}</h2>
        <p className="break-all text-sm text-foreground-soft">{site.url}</p>
        <p className="text-xs text-foreground-muted">
          {site.lastSearchedAt
            ? `Last searched ${new Date(site.lastSearchedAt).toLocaleString()}`
            : "Not searched yet"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openUrlInJobFinderBrowser(site.url)}
          >
            Open site
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onRunSourceDebug(targetId)}
            pending={isTargetSourceDebugPending}
          >
            Check source
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void window.nestor.jobs
                .run("remove_site", { id: site.id })
                .then(() => {
                  props.onRemoved();
                  showToast({
                    title: "Site removed",
                    description: "Its saved jobs stay in your list.",
                  });
                })
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Could not remove this site.",
                  ),
                );
            }}
          >
            Remove
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
        {error ? (
          <p role="alert" className="text-sm text-(--warning-text)">
            {error}
          </p>
        ) : null}
        <div
          onBlur={() => {
            void saveDraft();
          }}
        >
          <DiscoveryTargetFormFields
            customInstructions={
              draft.customInstructions ?? site.customInstructions ?? ""
            }
            labelValue={draft.label ?? site.label}
            instructionStatusSummary={
              site.instructionStatus === "missing"
                ? "No saved guidance yet"
                : site.instructionStatus === "validated"
                  ? "Guidance ready"
                  : site.instructionStatus === "draft"
                    ? "Draft guidance saved"
                    : "Guidance needs review"
            }
            instructionsId={`site-${site.id}-notes`}
            labelId={`site-${site.id}-label`}
            onCustomInstructionsChange={(event) =>
              setDraft((current) => ({
                ...current,
                customInstructions: event.target.value,
              }))
            }
            onLabelChange={(event) =>
              setDraft((current) => ({ ...current, label: event.target.value }))
            }
            onStartingUrlChange={(event) =>
              setDraft((current) => ({ ...current, url: event.target.value }))
            }
            startingUrl={draft.url ?? site.url}
            startingUrlId={`site-${site.id}-url`}
            targetEnabled={site.enabled}
            onToggleEnabled={(enabled) => {
              void update({ enabled }).catch(() => undefined);
            }}
          />
        </div>
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
          onBeginEditingInstruction={beginEditingInstruction}
          onCancelEditingInstruction={cancelEditingInstruction}
          onChangeEditingInstructionValue={setEditingInstructionValue}
          onPersistEditedInstruction={persistEditedInstruction}
          onRemoveInstructionLine={removeInstructionLine}
          sections={learnedInstructionSections}
          targetId={targetId}
        />
      </div>
    </section>
  );
}
