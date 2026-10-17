import { useCallback, useEffect, useState } from "react";
import type { ResumeDraft } from "@nestor/contracts";
import { getResumePreviewTargetContext } from "@nestor/contracts";

export function useResumeWorkspaceSelection(input: {
  draft: ResumeDraft | null;
}) {
  const { draft } = input;
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    null,
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [selectionScrollKey, setSelectionScrollKey] = useState(0);

  useEffect(() => {
    if (!draft) {
      setSelectedSectionId(null);
      setSelectedEntryId(null);
      setSelectedTargetId(null);
      setSelectionScrollKey(0);
      return;
    }

    setSelectedSectionId((current) => {
      if (current && draft.sections.some((section) => section.id === current)) {
        return current;
      }

      if (selectedTargetId) {
        const targetContext = getResumePreviewTargetContext(selectedTargetId);
        if (targetContext.sectionId === null) {
          return current ?? null;
        }
        const targetSectionAvailable =
          targetContext.sectionId !== null &&
          draft.sections.some(
            (section) => section.id === targetContext.sectionId,
          );

        return targetSectionAvailable
          ? targetContext.sectionId
          : (draft.sections[0]?.id ?? null);
      }

      return draft.sections[0]?.id ?? null;
    });
  }, [draft, selectedTargetId]);

  useEffect(() => {
    if (!draft) {
      return;
    }

    if (!selectedSectionId) {
      setSelectedEntryId(null);
      return;
    }

    const selectedSection =
      draft.sections.find((section) => section.id === selectedSectionId) ??
      null;

    if (!selectedSection) {
      setSelectedEntryId(null);
      return;
    }

    setSelectedEntryId((current) => {
      if (
        current &&
        selectedSection.entries.some((entry) => entry.id === current)
      ) {
        return current;
      }

      return null;
    });
  }, [draft, selectedSectionId]);

  useEffect(() => {
    if (!selectedTargetId) {
      return;
    }

    const context = getResumePreviewTargetContext(selectedTargetId);

    if (context.sectionId) {
      setSelectedSectionId(context.sectionId);
    }

    setSelectedEntryId(context.entryId);
  }, [selectedTargetId]);

  const handlePreviewTargetSelect = useCallback(
    (selection: {
      sectionId: string | null;
      entryId: string | null;
      targetId: string | null;
    }) => {
      setSelectionScrollKey((current) => current + 1);
      setSelectedTargetId(selection.targetId);
      setSelectedSectionId(selection.sectionId);
      setSelectedEntryId(selection.entryId);
    },
    [],
  );

  const handleSelectSection = useCallback((sectionId: string) => {
    setSelectionScrollKey((current) => current + 1);
    setSelectedSectionId(sectionId);
    setSelectedEntryId(null);
    setSelectedTargetId(null);
  }, []);

  const handleSelectEntry = useCallback(
    (sectionId: string, entryId: string) => {
      setSelectionScrollKey((current) => current + 1);
      setSelectedSectionId(sectionId);
      setSelectedEntryId(entryId);
      setSelectedTargetId(null);
    },
    [],
  );

  return {
    handlePreviewTargetSelect,
    handleSelectEntry,
    handleSelectSection,
    selectedEntryId,
    selectedSectionId,
    selectedTargetId,
    selectionScrollKey,
  };
}
