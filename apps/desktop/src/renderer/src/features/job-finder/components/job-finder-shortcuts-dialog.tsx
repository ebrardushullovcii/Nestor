import { Button } from "@renderer/components/ui/button";
import { X } from "lucide-react";
import { useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { usePresence } from "@renderer/components/ui/use-presence";

import type { JobFinderPlatform } from "../lib/job-finder-shortcuts";
import {
  buildJobFinderShortcutHelp,
  groupJobFinderShortcutHelp,
} from "../lib/job-finder-shortcuts";
import { useModalFocusTrap } from "./profile/use-modal-focus-trap";

export const JOB_FINDER_SHORTCUTS_DIALOG_LABEL = "Keyboard shortcuts";

/**
 * The keyboard-shortcut reference used to live inside the sidebar More menu,
 * where roughly 270px of non-navigation content stopped the menu from showing
 * its own seven destinations without scrolling. It is reference material, not a
 * destination, so it lives here instead — reachable from `?`, from the More
 * menu's single footer entry, and from the dialog itself.
 *
 * Rows are a strict two-column list: the action on the left, its keycaps on the
 * right with each key as its own `kbd` joined by "+" ("⌘ + K"), and one muted scope
 * line under the action. Every row is the same height.
 */
export function JobFinderShortcutsDialog(props: {
  onClose: () => void;
  open: boolean;
  platform: JobFinderPlatform;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusTrap(props.open, dialogRef, props.onClose);

  const groups = useMemo(
    () =>
      groupJobFinderShortcutHelp(buildJobFinderShortcutHelp(props.platform)),
    [props.platform],
  );

  const presence = usePresence(props.open);
  if (!presence.mounted) {
    return null;
  }

  return createPortal(
    <div
      aria-hidden={presence.exiting || undefined}
      className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-(--modal-scrim) px-4 py-6 backdrop-blur-sm"
      data-scrim-motion={presence.motion}
      inert={presence.exiting || undefined}
      onClick={presence.exiting ? undefined : props.onClose}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal={presence.exiting ? undefined : "true"}
        className="surface-panel-shell grid max-h-[calc(100dvh-3rem)] w-full max-w-xl grid-rows-[auto_auto_minmax(0,1fr)] gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-5 shadow-(--modal-shadow)"
        data-dialog-motion={presence.motion}
        data-job-finder-shortcuts-dialog
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role={presence.exiting ? undefined : "dialog"}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            className="text-(--text-headline)"
            data-title-role="dialog"
            id={titleId}
          >
            {JOB_FINDER_SHORTCUTS_DIALOG_LABEL}
          </h2>
          {/* One close affordance shape across every Job Finder dialog. */}
          <Button
            aria-label="Close"
            className="shrink-0"
            onClick={props.onClose}
            ref={closeRef}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <p
          className="text-(length:--text-small) leading-5 text-foreground-soft"
          id={descriptionId}
        >
          These work while you are using Job Finder. None of them changes your
          profile, your resume, or an application.
        </p>
        <div
          className="grid min-h-0 content-start gap-5 overflow-y-auto overscroll-contain pr-1"
          data-job-finder-shortcuts-list
        >
          {groups.map(({ group, entries }) => (
            <section
              aria-labelledby={`${titleId}-${group}`}
              className="grid gap-1"
              data-job-finder-shortcut-group={group}
              key={group}
            >
              <h3
                className="border-b border-(--surface-panel-border) pb-1.5 text-(length:--text-small) font-semibold text-(--text-headline)"
                id={`${titleId}-${group}`}
              >
                {group}
              </h3>
              <ul className="m-0 grid list-none p-0">
                {entries.map((entry) => (
                  <li
                    className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-(--surface-panel-border)/60 px-1 py-1.5 last:border-b-0"
                    data-job-finder-shortcut-row
                    key={entry.rowId}
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-(length:--text-item) text-foreground">
                        {entry.label}
                      </span>
                      <span className="text-(length:--text-tiny) leading-4 text-foreground-muted">
                        {entry.scope}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {entry.combos.map((keycaps, comboIndex) => (
                        <span
                          className="flex items-center gap-1"
                          key={keycaps.join("+")}
                        >
                          {comboIndex > 0 ? (
                            <span className="text-(length:--text-tiny) text-foreground-muted">
                              or
                            </span>
                          ) : null}
                          {/* A modifier and its key are two physical keys,
                              so they are two caps joined by a muted "+", the
                              one way shortcuts are written in the app. */}
                          {keycaps.map((keycap, keycapIndex) => (
                            <span
                              className="flex items-center gap-1"
                              key={`${keycapIndex}:${keycap}`}
                            >
                              {keycapIndex > 0 ? (
                                <span
                                  aria-hidden="true"
                                  className="text-(length:--text-tiny) text-foreground-muted"
                                >
                                  +
                                </span>
                              ) : null}
                              <kbd className="inline-flex min-w-7 items-center justify-center rounded-(--radius-small) border border-(--surface-panel-border) bg-(--input) px-1.5 py-0.5 text-(length:--text-tiny) font-medium text-foreground">
                                {keycap}
                              </kbd>
                            </span>
                          ))}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
