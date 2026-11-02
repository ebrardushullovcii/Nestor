import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@renderer/lib/utils";
import { Button } from "./button";
import { usePresence } from "./use-presence";

/**
 * The one modal shell.
 *
 * Seven hand-rolled modals shipped three different scrims (two of them at a
 * different z layer, one of them not centred, one with `backdrop-blur-sm`
 * duplicated inside a single class string) and three different close
 * affordances (an icon Button, the same Button forced to `size-10`, and a raw
 * text button inside a panel using a literal Tailwind radius). This is one scrim, one
 * shell and exactly one close affordance.
 *
 * The trap is local on purpose: a primitive must not reach into Job Finder's
 * overlay-ownership hook. Callers that need app-level inertness compose that
 * around this shell.
 */
export const DIALOG_SCRIM_CLASS =
  "fixed inset-0 z-[140] grid place-items-center overflow-y-auto bg-(--modal-scrim) px-4 py-6 backdrop-blur-sm";

const DIALOG_WIDTH_CLASS = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
} as const;

export type DialogSize = keyof typeof DIALOG_WIDTH_CLASS;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ].filter(
    (element) =>
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.tabIndex >= 0,
  );
}

function Dialog({
  children,
  className,
  closeLabel = "Close",
  description,
  footer,
  initialFocus = "dialog",
  onClose,
  open,
  size = "md",
  title,
}: {
  children?: React.ReactNode;
  className?: string;
  closeLabel?: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * "dialog" focuses the labelled container so a screen reader announces the
   * dialog name and description rather than the first action.
   */
  initialFocus?: "dialog" | "first-focusable";
  onClose: () => void;
  open: boolean;
  size?: DialogSize;
  title: string;
}) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const onCloseRef = React.useRef(onClose);

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (initialFocus === "first-focusable") {
      (getFocusableElements(dialog)[0] ?? dialog).focus();
    } else {
      dialog.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last?.focus();
        return;
      }

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      // Focus goes back to whatever opened the dialog, never to <body>.
      if (opener && opener.isConnected) {
        opener.focus();
      }
    };
  }, [initialFocus, open]);

  // Arrives and leaves with a 160 ms fade and a 0.98 -> 1 scale.
  const presence = usePresence(open);
  // What the dialog showed when it closed, drawn while it leaves.
  const lastContent = React.useRef({ children, description, footer, title });
  if (open) lastContent.current = { children, description, footer, title };
  const shown = lastContent.current;

  if (!presence.mounted) {
    return null;
  }

  return createPortal(
    <div
      aria-hidden={presence.exiting || undefined}
      className={DIALOG_SCRIM_CLASS}
      data-scrim-motion={presence.motion}
      inert={presence.exiting || undefined}
      onClick={presence.exiting ? undefined : onClose}
    >
      <div
        aria-describedby={shown.description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal={presence.exiting ? undefined : "true"}
        className={cn(
          "surface-panel-shell grid w-full max-h-[calc(100dvh-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-5 shadow-(--modal-shadow)",
          DIALOG_WIDTH_CLASS[size],
          className,
        )}
        data-dialog-motion={presence.motion}
        data-slot="dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role={presence.exiting ? undefined : "dialog"}
        tabIndex={-1}
      >
        <div className="grid gap-2">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-(--text-headline)" id={titleId}>
              {shown.title}
            </h2>
            {/* The single close affordance for every dialog in the app. */}
            <Button
              aria-label={closeLabel}
              className="shrink-0"
              data-slot="dialog-close"
              onClick={onClose}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
          {shown.description ? (
            <p
              className="text-(length:--text-small) leading-5 text-foreground-soft"
              id={descriptionId}
            >
              {shown.description}
            </p>
          ) : null}
        </div>
        <div
          className="min-h-0 overflow-y-auto overscroll-contain"
          data-slot="dialog-body"
        >
          {shown.children}
        </div>
        {shown.footer ? (
          <div
            className="flex flex-wrap items-center justify-end gap-2"
            data-slot="dialog-footer"
          >
            {shown.footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export { Dialog };
