import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Below this much page width beside it, the assistant switches to page/chat. */
export const ASSISTANT_NARROW_CONTENT_MIN_WIDTH = 520;
/**
 * The sidebar can be expanded from this window width; below it the shell
 * always shows the icon rail, so there is nothing to fold.
 */
export const SIDE_MENU_RAIL_MIN_WIDTH = 1200;
/** The expanded side menu (13.5rem). */
const EXPANDED_SIDE_MENU_WIDTH = 216;

function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined"
      ? SIDE_MENU_RAIL_MIN_WIDTH
      : window.innerWidth,
  );
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return width;
}

/**
 * Folds the side menu while the assistant is docked beside the page, so the
 * page keeps room, and opens it again when the assistant closes.
 *
 * The fold is never saved as the person's own preference. It is undone only
 * if it was this hook that folded the menu and the person has not folded or
 * opened it themselves since; their own toggle always wins until the
 * assistant closes.
 */
export function useAssistantSideMenuCollapse(input: {
  assistantOpen: boolean;
  assistantWidth: number;
  enabled: boolean;
  isSideMenuCollapsed: boolean;
  /** Changes the menu without saving it as the person's preference. */
  setSideMenuCollapsed: (collapsed: boolean) => void;
}): { notePersonToggledSideMenu: () => void } {
  const {
    assistantOpen,
    assistantWidth,
    enabled,
    isSideMenuCollapsed,
    setSideMenuCollapsed,
  } = input;
  const windowWidth = useWindowWidth();
  const foldedByAssistant = useRef(false);
  const personToggledWhileOpen = useRef(false);

  const railVisible = windowWidth >= SIDE_MENU_RAIL_MIN_WIDTH;
  const docked =
    windowWidth - EXPANDED_SIDE_MENU_WIDTH - assistantWidth >=
    ASSISTANT_NARROW_CONTENT_MIN_WIDTH;

  // Before paint, in the frame the assistant docks or leaves: the menu folds
  // and opens on the same timing as the panel slides, never a frame ahead.
  useLayoutEffect(() => {
    if (!assistantOpen || !enabled) {
      if (!assistantOpen) personToggledWhileOpen.current = false;
      if (foldedByAssistant.current) {
        foldedByAssistant.current = false;
        if (isSideMenuCollapsed) setSideMenuCollapsed(false);
      }
      return;
    }
    if (
      foldedByAssistant.current ||
      personToggledWhileOpen.current ||
      isSideMenuCollapsed ||
      !railVisible ||
      !docked
    ) {
      return;
    }
    foldedByAssistant.current = true;
    setSideMenuCollapsed(true);
  }, [
    assistantOpen,
    docked,
    enabled,
    isSideMenuCollapsed,
    railVisible,
    setSideMenuCollapsed,
  ]);

  const notePersonToggledSideMenu = useCallback(() => {
    foldedByAssistant.current = false;
    if (assistantOpen) personToggledWhileOpen.current = true;
  }, [assistantOpen]);

  return { notePersonToggledSideMenu };
}
