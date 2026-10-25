import { useEffect } from "react";
import {
  isEditableShortcutTarget,
  isImeComposingEvent,
} from "./job-finder-shortcuts";

/** `MouseEvent.button` values of the mouse's side buttons. */
const MOUSE_BACK_BUTTON = 3;
const MOUSE_FORWARD_BUTTON = 4;

export interface HistoryNavigationKeyLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

/** -1 for Alt+Left, 1 for Alt+Right, otherwise null. */
export function historyStepForKey(
  event: HistoryNavigationKeyLike,
): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
}

/** -1 for the mouse's back button, 1 for forward, otherwise null. */
export function historyStepForMouseButton(button: number): -1 | 1 | null {
  if (button === MOUSE_BACK_BUTTON) return -1;
  if (button === MOUSE_FORWARD_BUTTON) return 1;
  return null;
}

/**
 * The mouse's back and forward buttons and Alt+Left / Alt+Right move between
 * screens like a browser. Keys inside text fields keep their text meaning.
 */
export function useHistoryNavigationShortcuts(
  onStep: (step: -1 | 1) => void,
): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) return;
      const step = historyStepForKey(event);
      if (step === null || isEditableShortcutTarget(event.target)) return;
      event.preventDefault();
      onStep(step);
    };
    // The side buttons would otherwise also start a text selection or an
    // autoscroll on some mice; the step runs once, on release.
    const handleMouseDown = (event: MouseEvent) => {
      if (historyStepForMouseButton(event.button) !== null) {
        event.preventDefault();
      }
    };
    const handleMouseUp = (event: MouseEvent) => {
      const step = historyStepForMouseButton(event.button);
      if (step === null) return;
      event.preventDefault();
      onStep(step);
    };
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onStep]);
}
