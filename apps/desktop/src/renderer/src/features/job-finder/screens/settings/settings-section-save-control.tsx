import { useId } from "react";
import { Button } from "@renderer/components/ui/button";
import {
  hasOutstandingSectionChanges,
  type SettingsSectionSaveState,
} from "./settings-section-save";

/**
 * One save-feedback pattern for every settings section.
 *
 * Before this, `No unsaved changes.` sat under exactly one section's button
 * and nothing under the others, so a user could not tell from a quiet section
 * whether their edit had committed. Every section now renders the same four
 * states from the same component:
 *
 * - saving  -> no line; the pending button is the state
 * - failed  -> the failure sentence, announced, with a Retry button
 * - dirty   -> "Not saved yet."
 * - saved   -> the section's own confirmation, announced
 * - clean   -> "No unsaved changes." for screen readers only (the stated
 *              reason the save is off); on screen the greyed button says it
 *
 * The saved confirmation was previously computed by every section and then
 * dropped on the floor: a committed save flipped straight back to "No unsaved
 * changes.", which is exactly what an untouched section says, so nothing in
 * Settings ever told a user their change had landed. It is now the state that
 * shows until the next edit.
 *
 * The disabled save is described by that same line through `aria-describedby`,
 * so a greyed button always has a reason attached to it.
 */
export function SettingsSectionSaveControl({
  hasUnsavedChanges,
  isSaveDisabled = false,
  onSave,
  saveState,
  subject,
  effect,
}: {
  hasUnsavedChanges: boolean;
  isSaveDisabled?: boolean;
  onSave: () => void;
  saveState: SettingsSectionSaveState;
  /** Lowercase noun phrase naming what commits, for example "appearance". */
  subject: string;
  /**
   * When a committed value is felt, for example "Applies from your next
   * search." A quiet section otherwise leaves the user guessing whether a
   * saved change reaches the run already in progress (it does not: runs read
   * settings when they start).
   */
  effect?: string;
}) {
  const feedbackId = useId();
  const isSavePending = saveState.status === "saving";
  const hasFailed = saveState.status === "failed";
  const hasSaved =
    saveState.status === "saved" && Boolean(saveState.message?.trim());
  const isOutstanding = hasOutstandingSectionChanges(
    hasUnsavedChanges,
    saveState,
  );
  const buttonLabel = isSavePending
    ? `Saving ${subject}`
    : hasFailed
      ? `Retry ${subject}`
      : `Save ${subject}`;

  return (
    <div className="grid min-w-0 max-w-full justify-items-end gap-1.5">
      <Button
        aria-describedby={isSavePending ? undefined : feedbackId}
        disabled={!isOutstanding || isSavePending || isSaveDisabled}
        onClick={onSave}
        pending={isSavePending}
        type="button"
        variant="primary"
      >
        {buttonLabel}
      </Button>
      {isSavePending ? null : hasFailed ? (
        <p
          className="min-w-0 max-w-80 break-words text-right text-xs leading-4 text-destructive"
          data-settings-save-state="failed"
          id={feedbackId}
          role="status"
        >
          {saveState.message}
        </p>
      ) : hasSaved ? (
        <p
          className="min-w-0 max-w-80 break-words text-right text-xs leading-4 text-(--success-text)"
          data-settings-save-state="saved"
          id={feedbackId}
          role="status"
        >
          {saveState.message}
        </p>
      ) : (
        <p
          className={
            isOutstanding
              ? "min-w-0 max-w-80 break-words text-right text-xs leading-4 text-foreground-soft"
              : "sr-only"
          }
          data-settings-save-state={isOutstanding ? "dirty" : "clean"}
          id={feedbackId}
        >
          {isOutstanding ? "Not saved yet." : "No unsaved changes."}
        </p>
      )}
      {/* When a change takes effect matters while there is one to save. */}
      {effect && !isSavePending && isOutstanding ? (
        <p
          className="min-w-0 max-w-80 break-words text-right text-xs leading-4 text-foreground-muted"
          data-settings-save-effect
        >
          {effect}
        </p>
      ) : null}
    </div>
  );
}
