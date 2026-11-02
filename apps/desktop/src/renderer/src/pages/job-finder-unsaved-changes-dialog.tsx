import { Button } from "@renderer/components/ui/button";
import { useModalFocusTrap } from "@renderer/features/job-finder/components/profile/use-modal-focus-trap";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";

import { usePresence } from "@renderer/components/ui/use-presence";

/** What leaving would lose, named for the person. */
export type JobFinderLeaveConfirmation = {
  title: string;
  description: string;
  reasons: string[];
};

/**
 * App-owned replacement for the native browser/Electron leave prompt raised by
 * the router-level navigation guard. Names the exact unsaved scope and offers
 * only two outcomes: stay (keep every draft and the current focus) or leave
 * without saving (commit the held navigation once). Never uses
 * `window.confirm`; in-app navigation must always meet this dialog first.
 */
export function JobFinderUnsavedChangesDialog(props: {
  confirmation: JobFinderLeaveConfirmation | null;
  onLeaveWithoutSaving: () => void;
  onStay: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonsId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const open = props.confirmation !== null;
  // Escape, backdrop, and focus restore all resolve to staying so closing the
  // dialog can never discard a draft by accident.
  useModalFocusTrap(open, dialogRef, props.onStay);
  const presence = usePresence(open);
  // What the dialog asked when it closed, drawn while it leaves.
  const last = useRef(props.confirmation);
  if (props.confirmation) last.current = props.confirmation;

  if (!presence.mounted || !last.current) {
    return null;
  }

  const confirmation = last.current;

  return createPortal(
    <div
      aria-hidden={presence.exiting || undefined}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-(--modal-scrim) px-4 py-6 backdrop-blur-sm"
      data-scrim-motion={presence.motion}
      inert={presence.exiting || undefined}
      onClick={presence.exiting ? undefined : props.onStay}
    >
      <div
        aria-describedby={`${descriptionId} ${reasonsId}`}
        aria-labelledby={titleId}
        aria-modal={presence.exiting ? undefined : "true"}
        className="surface-panel-shell grid w-full max-w-lg gap-5 rounded-(--radius-field) border border-(--surface-panel-border) p-5 shadow-(--modal-shadow)"
        data-dialog-motion={presence.motion}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role={presence.exiting ? undefined : "dialog"}
        tabIndex={-1}
      >
        <div className="grid gap-2">
          <p className="text-(length:--text-tiny) tracking-(--tracking-label) text-foreground-muted">
            Unsaved changes
          </p>
          <h2 className="text-(--text-headline)" id={titleId}>
            {confirmation.title}
          </h2>
          <p
            className="text-(length:--text-item) leading-6 text-foreground-soft"
            id={descriptionId}
          >
            {confirmation.description}
          </p>
        </div>
        <ul className="grid gap-2" id={reasonsId}>
          {confirmation.reasons.map((reason) => (
            <li
              className="flex items-start gap-2 text-(length:--text-item) leading-6 text-foreground"
              key={reason}
            >
              <span
                aria-hidden="true"
                className="mt-2.5 size-1.5 shrink-0 rounded-full bg-destructive"
              />
              {reason}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          {/* Staying is the safe default, so it owns the first (initially
              focused) position in the dialog's tab order. */}
          <Button onClick={props.onStay} type="button" variant="secondary">
            Stay on this page
          </Button>
          <Button
            onClick={props.onLeaveWithoutSaving}
            type="button"
            variant="destructive"
          >
            Leave without saving
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
