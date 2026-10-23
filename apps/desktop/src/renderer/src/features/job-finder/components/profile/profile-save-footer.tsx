import { useEffect, useId } from "react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import {
  eventMatchesJobFinderShortcut,
  formatJobFinderShortcutCombo,
  getJobFinderAriaKeyshortcuts,
  PROFILE_SAVE_COMBO,
  type JobFinderPlatform,
} from "../../lib/job-finder-shortcuts";

function currentPlatform(): JobFinderPlatform {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "darwin"
    : "win32";
}

interface ProfileSaveFooterProps {
  actionMessage: string | null;
  hasUnsavedChanges: boolean;
  /**
   * False when the only difference from the saved profile is what an import
   * filled in. "Unsaved changes" there accused the person of leaving work
   * behind before they had typed anything.
   */
  hasUserEdits?: boolean;
  isSavePending: boolean;
  onSave: () => void;
  validationMessage: string | null;
}

export function ProfileSaveFooter({
  actionMessage,
  hasUnsavedChanges,
  hasUserEdits,
  isSavePending,
  onSave,
  validationMessage,
}: ProfileSaveFooterProps) {
  const saveStateId = useId();
  // Ctrl+S saves, as in any desktop editor; with nothing to save it does
  // nothing and the browser's own "Save page" never opens.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!eventMatchesJobFinderShortcut(event, PROFILE_SAVE_COMBO)) return;
      event.preventDefault();
      if (hasUnsavedChanges && !isSavePending) onSave();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasUnsavedChanges, isSavePending, onSave]);

  return (
    <div
      className="border-t border-(--surface-panel-border) bg-(--surface-fill-soft) px-4 py-2 sm:px-5"
      data-profile-workspace-actions
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid gap-1">
          {/* Same two states as every guided-setup footer: report what is
              true, do not instruct. The state is carried by a dot and its
              own colour as well as the words, so a glance at the footer
              answers "is my work saved?" without reading a muted sentence -
              and it is the stated reason the clean Save is disabled. */}
          <p
            className={cn(
              "flex items-center gap-2 text-(length:--text-description) leading-5",
              hasUnsavedChanges
                ? "font-medium text-(--warning-text)"
                : "text-foreground-muted",
            )}
            data-profile-save-state={hasUnsavedChanges ? "dirty" : "clean"}
            id={saveStateId}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                hasUnsavedChanges
                  ? "bg-(--warning-text)"
                  : "bg-(--disabled-foreground)",
              )}
            />
            {/* A save of a big profile takes seconds; "Unsaved changes" all
                that time read as if the press (or a quick tick) did nothing. */}
            {hasUnsavedChanges
              ? isSavePending
                ? "Saving…"
                : hasUserEdits === false
                  ? "Imported details on this page are not saved yet."
                  : "Unsaved changes on this page."
              : "No unsaved changes."}
          </p>
          {/* When a saved profile is felt: the next tailored draft and
              application read it, and nothing already drafted moves. It is
              said while there is something to save; a clean footer is one
              line. */}
          {hasUnsavedChanges ? (
            <p
              className="text-(length:--text-description) leading-5 text-foreground-muted"
              data-profile-save-effect
            >
              Saved changes reach new tailored drafts and applications; drafts
              you already have stay as they are until you re-tailor them.
            </p>
          ) : null}
          {validationMessage ? (
            <p
              aria-atomic="true"
              aria-live="polite"
              className="text-(length:--text-description) leading-5 text-foreground-muted"
              role="status"
            >
              {validationMessage}
            </p>
          ) : null}
          {actionMessage ? (
            <p
              aria-atomic="true"
              aria-live="polite"
              className="text-(length:--text-description) leading-5 text-primary"
              role="status"
            >
              {actionMessage}
            </p>
          ) : null}
        </div>

        {/* The live-region messages (validation, last action) stay out of
            aria-describedby: they would be announced a second time when
            focus lands on the control. The plain save-state line is not a
            live region, so a disabled Save can point at it and always carry
            a visible, announced reason. The shared Button owns the pending
            semantics (aria-busy + aria-disabled while isSavePending keeps
            focus on the control), and the clean state keeps native disabled
            semantics. */}
        <div className="flex items-center gap-2 sm:shrink-0">
          {/* The collapsed Assistant launcher lands here, portalled in by
              `ProfileCopilotRail`, so it is a sibling of Save rather than a
              pill floating over the page. Same slot pattern, same button and
              same label as the Resume Studio header, so the two screens are
              indistinguishable. Empty span, no box, until the rail mounts. */}
          <span className="contents" data-profile-assistant-launcher-slot />
          <Button
            aria-describedby={hasUnsavedChanges ? undefined : saveStateId}
            aria-keyshortcuts={getJobFinderAriaKeyshortcuts(
              PROFILE_SAVE_COMBO,
              currentPlatform(),
            )}
            className="w-full sm:w-auto sm:shrink-0"
            disabled={!hasUnsavedChanges}
            pending={isSavePending}
            onClick={onSave}
            type="button"
            variant="primary"
          >
            Save changes
            <kbd
              aria-hidden="true"
              className="ml-1 rounded-sm border border-current/30 px-1 font-sans text-(length:--text-tiny) font-medium opacity-80"
            >
              {formatJobFinderShortcutCombo(
                PROFILE_SAVE_COMBO,
                currentPlatform(),
              )}
            </kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
