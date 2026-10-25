import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Check, LoaderCircle, RotateCcw, X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import type { JobFinderSaveState } from "@renderer/pages/job-finder-save-state";
import { useBottomRightDock } from "./bounded-floating-surface";

export const SAVE_SUCCESS_VISIBLE_MS = 5_000;
export const SAVE_STATUS_DEFAULT_TOP_OFFSET_PX = 16;
export const SAVE_STATUS_SHELL_HEADER_GAP_PX = 16;
const SAVE_STATUS_VIEWPORT_GAP_PX = 16;

/**
 * Place the global save status below the shell header while keeping its
 * fixed-position lane inside a short viewport. The header is measured at
 * runtime because the shell intentionally has a second navigation row at
 * medium widths.
 */
/**
 * The lane's own bottom bound. It is a right-edge surface, so a long failed
 * message could grow all the way down through the bottom-right dock and cover
 * the Assistant launcher and the recovery notice sitting there. The dock
 * reports the top of its stack and the lane stops one gap above it.
 */
export function getSaveStatusMaxHeight(input: {
  dockStackTop: number;
  topOffset: number;
  viewportGap?: number;
  viewportHeight: number;
}): number {
  const viewportGap = input.viewportGap ?? SAVE_STATUS_VIEWPORT_GAP_PX;
  const viewportFloor = input.viewportHeight - viewportGap;
  const dockFloor = Number.isFinite(input.dockStackTop)
    ? input.dockStackTop - viewportGap
    : viewportFloor;

  return Math.max(0, Math.min(viewportFloor, dockFloor) - input.topOffset);
}

export function getSaveStatusTopOffset(input: {
  shellHeaderBottom?: number;
  viewportHeight?: number;
  defaultTopOffset?: number;
  gap?: number;
  viewportGap?: number;
}): number {
  const defaultTopOffset =
    input.defaultTopOffset ?? SAVE_STATUS_DEFAULT_TOP_OFFSET_PX;
  const gap = input.gap ?? SAVE_STATUS_SHELL_HEADER_GAP_PX;
  const viewportGap = input.viewportGap ?? SAVE_STATUS_VIEWPORT_GAP_PX;
  const shellHeaderBottom = input.shellHeaderBottom;
  const viewportHeight = input.viewportHeight;
  const requestedTop =
    typeof shellHeaderBottom === "number" && Number.isFinite(shellHeaderBottom)
      ? Math.max(defaultTopOffset, Math.ceil(shellHeaderBottom + gap))
      : defaultTopOffset;

  if (
    typeof viewportHeight !== "number" ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0
  ) {
    return requestedTop;
  }

  return Math.min(
    requestedTop,
    Math.max(defaultTopOffset, Math.floor(viewportHeight - viewportGap)),
  );
}

export function JobFinderSaveStatus(props: {
  layoutKey?: string;
  onDismissSaved?: (() => void) | undefined;
  onRetry: () => void;
  saveState: JobFinderSaveState;
}) {
  const [topOffset, setTopOffset] = useState(SAVE_STATUS_DEFAULT_TOP_OFFSET_PX);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  // Reads the dock without claiming a slot in it: the lane keeps its own
  // top-right position and only bounds its height against the corner.
  const dock = useBottomRightDock({
    active: false,
    height: 0,
    id: "job-finder-save-status",
    minTopOffset: 0,
    order: 0,
    width: 0,
  });
  const savedMessageKey =
    props.saveState.state === "idle"
      ? "idle"
      : `${props.saveState.version}:${props.saveState.attempt}:${props.saveState.message}:${props.saveState.savedAt ?? ""}`;
  const [dismissedSavedMessageKey, setDismissedSavedMessageKey] = useState<
    string | null
  >(null);
  const [autoDismissPaused, setAutoDismissPaused] = useState(false);
  const previousLayoutKeyRef = useRef(props.layoutKey);
  const dismissSavedMessage = useCallback(() => {
    setDismissedSavedMessageKey(savedMessageKey);
    props.onDismissSaved?.();
  }, [props.onDismissSaved, savedMessageKey]);

  useLayoutEffect(() => {
    const previousLayoutKey = previousLayoutKeyRef.current;
    previousLayoutKeyRef.current = props.layoutKey;

    // A successful confirmation belongs to the surface that produced it. Do
    // not carry it across route changes where a fixed toast can cover a new
    // action; in-flight and failed states remain available for recovery.
    if (
      previousLayoutKey !== undefined &&
      props.layoutKey !== undefined &&
      previousLayoutKey !== props.layoutKey &&
      props.saveState.state === "saved"
    ) {
      dismissSavedMessage();
    }
  }, [dismissSavedMessage, props.layoutKey, props.saveState.state]);

  useLayoutEffect(() => {
    const shellHeader = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header]",
    );
    if (!shellHeader) {
      return;
    }

    const updateTopOffset = () => {
      const nextOffset = getSaveStatusTopOffset({
        shellHeaderBottom: shellHeader.getBoundingClientRect().bottom,
        viewportHeight: window.innerHeight,
      });

      setTopOffset((current) =>
        current === nextOffset ? current : nextOffset,
      );
      setViewportHeight((current) =>
        current === window.innerHeight ? current : window.innerHeight,
      );
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updateTopOffset);

    updateTopOffset();
    resizeObserver?.observe(shellHeader);
    window.addEventListener("resize", updateTopOffset);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateTopOffset);
    };
  }, []);

  useEffect(() => {
    // Only idle and in-flight states clear the dismissal record. A dismissed
    // failure must stay dismissed for as long as that exact failure is the
    // current state; a later failure carries a different key and reappears.
    if (
      props.saveState.state === "idle" ||
      props.saveState.state === "saving"
    ) {
      setDismissedSavedMessageKey(null);
      return;
    }
    if (props.saveState.state !== "saved") {
      return;
    }
    if (autoDismissPaused) {
      return;
    }

    const savedAtMs = props.saveState.savedAt
      ? Date.parse(props.saveState.savedAt)
      : Number.NaN;
    const elapsedMs = Number.isFinite(savedAtMs)
      ? Math.max(0, Date.now() - savedAtMs)
      : 0;
    const remainingMs = Math.max(0, SAVE_SUCCESS_VISIBLE_MS - elapsedMs);

    const timeoutId = window.setTimeout(() => {
      dismissSavedMessage();
    }, remainingMs);

    return () => window.clearTimeout(timeoutId);
  }, [autoDismissPaused, dismissSavedMessage, props.saveState]);

  if (props.saveState.state === "idle") {
    return null;
  }

  // The dismissal key names the exact message, so this hides only the status
  // the user actually dismissed — a saved confirmation or an acknowledged
  // failure — and never a later one.
  if (dismissedSavedMessageKey === savedMessageKey) {
    return null;
  }

  const Icon =
    props.saveState.state === "saving"
      ? LoaderCircle
      : props.saveState.state === "saved"
        ? Check
        : AlertTriangle;

  return (
    <div className="pointer-events-none" data-save-status-lane>
      <div
        aria-atomic="true"
        aria-live="polite"
        className="pointer-events-auto fixed right-4 z-40 flex max-w-[min(26rem,calc(100vw-2rem))] items-center gap-3 overflow-auto rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-3 py-2.5 text-(length:--text-small) shadow-(--modal-shadow)"
        data-save-status={props.saveState.state}
        data-save-state={props.saveState.state}
        style={{
          maxHeight: `${getSaveStatusMaxHeight({
            dockStackTop: dock.stackTop,
            topOffset,
            viewportHeight:
              viewportHeight > 0
                ? viewportHeight
                : typeof window === "undefined"
                  ? 0
                  : window.innerHeight,
          })}px`,
          top: `${topOffset}px`,
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setAutoDismissPaused(false);
          }
        }}
        onFocusCapture={() => setAutoDismissPaused(true)}
        // Held while the pointer is on it, so an Undo is not pulled away
        // from under the cursor.
        onPointerEnter={() => setAutoDismissPaused(true)}
        onPointerLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) {
            setAutoDismissPaused(false);
          }
        }}
        role="status"
      >
        <Icon
          aria-hidden="true"
          className={
            props.saveState.state === "saving"
              ? "size-4 shrink-0 animate-spin motion-reduce:animate-none"
              : "size-4 shrink-0"
          }
        />
        <span className="min-w-0 flex-1 leading-5 text-foreground-soft">
          {props.saveState.message}
        </span>
        {props.saveState.canRetry ? (
          <Button
            aria-label={`Retry saving ${props.saveState.label}`}
            onClick={props.onRetry}
            size="sm"
            type="button"
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        ) : props.saveState.state === "failed" &&
          props.saveState.retryBlockedReason ? (
          <span
            className="max-w-56 text-right text-xs leading-4 text-destructive"
            data-save-retry-blocked="true"
          >
            {props.saveState.retryBlockedReason}
          </span>
        ) : null}
        {props.saveState.state === "saved" && props.saveState.undo ? (
          <Button
            aria-label={`Undo ${props.saveState.label} change`}
            onClick={() => {
              const undo =
                props.saveState.state === "saved"
                  ? props.saveState.undo
                  : undefined;
              dismissSavedMessage();
              undo?.();
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Undo
          </Button>
        ) : null}
        {/* A failed save has the same dismiss control as a successful one.
            Without it the toast — and the navigation and window-close guards
            that read the same failed state — stayed for the rest of the
            session unless that exact surface saved again. Dismissing only
            acknowledges the failure: a form that is still dirty keeps its own
            unsaved-changes protection.

            Settings is the exception. Its sections stage drafts in local state
            with no dirty flag behind the leave guards, so its failed state is
            the only thing protecting those drafts and must not be dismissible
            here; the controller mirrors this rule in
            `canAcknowledgeFailedSave` and releases a settings failure through
            the explicit "Leave without saving" decision instead. */}
        {props.saveState.state === "saved" ||
        (props.saveState.state === "failed" &&
          props.saveState.surface !== "settings") ? (
          <Button
            aria-label={
              props.saveState.state === "saved"
                ? `Dismiss ${props.saveState.label} saved message`
                : `Dismiss ${props.saveState.label} save error`
            }
            onClick={dismissSavedMessage}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
