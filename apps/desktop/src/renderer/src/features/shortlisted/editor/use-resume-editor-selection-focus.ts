import { useEffect, useRef } from "react";

export function useResumeEditorSelectionFocus(input: {
  isSelected: boolean;
  selectionScrollKey?: number;
  selectedEntryId: string | null;
  selectedTargetId: string | null;
}) {
  const {
    isSelected,
    selectedEntryId,
    selectedTargetId,
    selectionScrollKey = 0,
  } = input;
  const sectionRef = useRef<HTMLElement | null>(null);
  const entryRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const entryTarget = selectedEntryId
      ? (entryRefs.current[selectedEntryId] ?? null)
      : null;
    const target = entryTarget
      ? entryTarget
      : selectedTargetId || isSelected
        ? sectionRef.current
        : null;

    if (!target) {
      return;
    }

    if (selectionScrollKey === 0) {
      return;
    }

    const firstTextControl = target.querySelector<HTMLElement>(
      "textarea:not([disabled]), input:not([disabled])",
    );
    const targetedControl = selectedTargetId
      ? target.querySelector<HTMLElement>(
          `[data-resume-editor-target="${selectedTargetId}"]`,
        )
      : null;
    const firstControl =
      targetedControl ??
      firstTextControl ??
      target.querySelector<HTMLElement>("button:not([disabled])");

    const activeElement = document.activeElement;
    if (targetedControl && activeElement !== targetedControl) {
      targetedControl.focus({ preventScroll: true });
    } else if (!activeElement || !target.contains(activeElement)) {
      firstControl?.focus({ preventScroll: true });
    }

    const scrollRegion =
      target.closest<HTMLElement>("[data-resume-workspace-scroll-region]") ??
      target.closest<HTMLElement>("[data-resume-editor-scroll-region]") ??
      target.closest<HTMLElement>("[data-resume-preview-scroll-region]");
    if (!scrollRegion) {
      return;
    }

    const scrollRegionRect = scrollRegion.getBoundingClientRect();
    const scrollTarget = targetedControl ?? target;
    const targetRect = scrollTarget.getBoundingClientRect();
    const regionTop = scrollRegion.scrollTop;
    const regionBottom = regionTop + scrollRegion.clientHeight;
    const targetTop =
      scrollRegion.scrollTop + (targetRect.top - scrollRegionRect.top);
    const targetBottom =
      scrollRegion.scrollTop + (targetRect.bottom - scrollRegionRect.top);

    if (!selectedEntryId && !selectedTargetId) {
      const sectionAnchorTop = Math.max(0, targetTop - 72);
      if (sectionAnchorTop !== regionTop) {
        scrollRegion.scrollTop = sectionAnchorTop;
      }
      return;
    }

    if (targetTop < regionTop) {
      scrollRegion.scrollTop = Math.max(0, targetTop - 24);
      return;
    }

    if (targetBottom > regionBottom) {
      scrollRegion.scrollTop = targetBottom - scrollRegion.clientHeight + 24;
    }
  }, [isSelected, selectedEntryId, selectedTargetId, selectionScrollKey]);

  return {
    entryRefs,
    sectionRef,
  };
}
