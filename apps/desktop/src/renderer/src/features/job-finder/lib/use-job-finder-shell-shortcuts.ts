import { useEffect, useState } from "react";
import {
  eventMatchesJobFinderShortcut,
  isEditableShortcutTarget,
  isImeComposingEvent,
  isInteractiveShortcutTarget,
} from "./job-finder-shortcuts";
import { useHasOpenJobFinderOverlays } from "./job-finder-overlay-ownership";
import { focusVisibleListSearch } from "./list-search-focus";

const WIDE_LAYOUT_MEDIA_QUERY = "(min-width: 1440px)";

function getInitialWideLayout(): boolean {
  try {
    return window.matchMedia?.(WIDE_LAYOUT_MEDIA_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

export interface UseJobFinderShellShortcutsInput {
  isOverlayOpen: boolean;
  isSearchOpen: boolean;
  onOpenGlobalSearch: () => void;
  onOpenShortcuts: () => void;
  /** Cmd/Ctrl+I shows or hides the assistant sidebar, anywhere. */
  onToggleAssistant?: () => void;
  onToggleSidebar: () => void;
}

/**
 * Shell-level keyboard shortcuts. Cmd/Ctrl+K opens or focuses the global
 * search; Cmd/Ctrl+B toggles the sidebar and only fires at the wide layout
 * breakpoint while no modal or popover owns the surface. The "/" alias only
 * fires outside editable, interactive, and modal contexts. Overlay surfaces
 * register with the shared LIFO ownership stack, so Task Center, menus,
 * dialogs, and screen modals block both aliases without prop threading, while
 * Cmd/Ctrl+K stays available as the summon. "?" opens the keyboard-shortcut
 * reference under the same non-editable, non-overlay conditions as "/". Every
 * handler respects defaultPrevented and IME composition.
 */
export function useJobFinderShellShortcuts(
  input: UseJobFinderShellShortcutsInput,
): boolean {
  const [isWideLayout, setIsWideLayout] = useState(getInitialWideLayout);
  const {
    isOverlayOpen,
    isSearchOpen,
    onOpenGlobalSearch,
    onOpenShortcuts,
    onToggleAssistant,
    onToggleSidebar,
  } = input;
  const hasRegisteredOverlays = useHasOpenJobFinderOverlays();
  const isAnyOverlayOpen = isOverlayOpen || hasRegisteredOverlays;

  useEffect(() => {
    const mediaQueryList = window.matchMedia?.(WIDE_LAYOUT_MEDIA_QUERY);
    if (!mediaQueryList) {
      return;
    }
    const handleChange = (event: MediaQueryListEvent) => {
      setIsWideLayout(event.matches);
    };
    setIsWideLayout(mediaQueryList.matches);
    mediaQueryList.addEventListener?.("change", handleChange);
    return () => {
      mediaQueryList.removeEventListener?.("change", handleChange);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }

      if (eventMatchesJobFinderShortcut(event, "mod+k")) {
        event.preventDefault();
        onOpenGlobalSearch();
        return;
      }

      if (onToggleAssistant && eventMatchesJobFinderShortcut(event, "mod+i")) {
        event.preventDefault();
        onToggleAssistant();
        return;
      }

      if (
        eventMatchesJobFinderShortcut(event, "/") &&
        !isAnyOverlayOpen &&
        !isEditableShortcutTarget(event.target)
      ) {
        // On a list, "/" goes to that list's own search, also from a focused
        // row; elsewhere it opens the workspace search.
        if (focusVisibleListSearch()) {
          event.preventDefault();
          return;
        }
        if (!isInteractiveShortcutTarget(event.target)) {
          event.preventDefault();
          onOpenGlobalSearch();
          return;
        }
      }

      if (
        eventMatchesJobFinderShortcut(event, "?") &&
        !isAnyOverlayOpen &&
        !isEditableShortcutTarget(event.target) &&
        !isInteractiveShortcutTarget(event.target)
      ) {
        event.preventDefault();
        onOpenShortcuts();
        return;
      }

      if (
        eventMatchesJobFinderShortcut(event, "mod+b") &&
        !isSearchOpen &&
        !isAnyOverlayOpen &&
        isWideLayout &&
        !isEditableShortcutTarget(event.target)
      ) {
        event.preventDefault();
        onToggleSidebar();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    isAnyOverlayOpen,
    isSearchOpen,
    isWideLayout,
    onOpenGlobalSearch,
    onOpenShortcuts,
    onToggleAssistant,
    onToggleSidebar,
  ]);

  return isWideLayout;
}
