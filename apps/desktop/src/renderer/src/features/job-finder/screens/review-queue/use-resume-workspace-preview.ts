import { useCallback, useEffect, useRef, useState } from "react";
import type { JobFinderResumePreview, ResumeDraft } from "@nestor/contracts";
import { cloneDraft } from "./resume-workspace-utils";
import { getPreviewErrorMessage } from "./resume-workspace-screen-helpers";

interface ResumePreviewLineage {
  jobId: string;
  draftId: string;
}

function getDraftLineage(draft: ResumeDraft): ResumePreviewLineage {
  return { jobId: draft.jobId, draftId: draft.id };
}

/**
 * What the preview is drawn from: the draft without the fields a save
 * changes (time, status, approval). A save a second after typing used to
 * render the same text again, twice, each a main-process render.
 */
function getPreviewContentKey(draft: ResumeDraft): string {
  return JSON.stringify({
    ...draft,
    updatedAt: null,
    status: null,
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
  });
}

function isSameLineage(
  lineage: ResumePreviewLineage | null,
  target: ResumePreviewLineage,
): boolean {
  return (
    lineage !== null &&
    lineage.jobId === target.jobId &&
    lineage.draftId === target.draftId
  );
}

export function useResumeWorkspacePreview(input: {
  draft: ResumeDraft | null;
  hasUnsavedChanges: boolean;
  onPreviewDraft: (
    draft: ResumeDraft,
    requestId?: string,
  ) => Promise<JobFinderResumePreview>;
}) {
  const { draft, hasUnsavedChanges, onPreviewDraft } = input;
  const [preview, setPreview] = useState<JobFinderResumePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  // Lineage of the preview currently held in state. Mirrored in a ref so the
  // refresh callback can decide stale-while-revalidate retention without a
  // state dependency that would recreate it on every revision.
  const previewLineageRef = useRef<ResumePreviewLineage | null>(null);
  const previewRequestRef = useRef(0);
  const previewTimeoutRef = useRef<number | null>(null);
  // Content key of the preview on screen or being rendered.
  const previewContentKeyRef = useRef<string | null>(null);

  const refreshPreview = useCallback(
    (targetDraft: ResumeDraft) => {
      const requestId = previewRequestRef.current + 1;
      previewRequestRef.current = requestId;
      const targetLineage = getDraftLineage(targetDraft);
      previewContentKeyRef.current = getPreviewContentKey(targetDraft);

      // Stale-while-revalidate: keep the last good frame for this exact job and
      // draft on screen while the next revision renders; anything else (cold
      // start, retry after failure, foreign draft) must not linger.
      if (!isSameLineage(previewLineageRef.current, targetLineage)) {
        previewLineageRef.current = null;
        setPreview(null);
      }
      setPreviewStatus("loading");
      setPreviewError(null);

      void onPreviewDraft(
        cloneDraft(targetDraft),
        `resume_preview_${requestId}`,
      )
        .then((nextPreview) => {
          if (previewRequestRef.current !== requestId) {
            return;
          }

          if (nextPreview.draftId !== targetDraft.id) {
            // A response rendered for another draft must never be shown.
            previewLineageRef.current = null;
            setPreview(null);
            setPreviewStatus("error");
            setPreviewError(
              "The preview response did not match the current draft.",
            );
            return;
          }

          previewLineageRef.current = targetLineage;
          setPreview(nextPreview);
          setPreviewStatus("ready");
          setPreviewError(null);
        })
        .catch((error) => {
          if (previewRequestRef.current !== requestId) {
            return;
          }

          // The previously shown frame no longer reflects this revision, so drop
          // it instead of presenting stale content as current.
          previewLineageRef.current = null;
          previewContentKeyRef.current = null;
          setPreview(null);
          setPreviewStatus("error");
          setPreviewError(getPreviewErrorMessage(error));
        });
    },
    [onPreviewDraft],
  );

  useEffect(() => {
    if (!draft) {
      if (previewTimeoutRef.current !== null) {
        window.clearTimeout(previewTimeoutRef.current);
        previewTimeoutRef.current = null;
      }
      previewRequestRef.current += 1;
      previewLineageRef.current = null;
      previewContentKeyRef.current = null;
      setPreview(null);
      setPreviewError(null);
      setPreviewStatus("idle");
      return;
    }

    const targetLineage = getDraftLineage(draft);
    if (
      isSameLineage(previewLineageRef.current, targetLineage) &&
      previewContentKeyRef.current === getPreviewContentKey(draft)
    ) {
      // Only the save's own fields changed; the frame (or the render in
      // flight) already shows this text.
      return;
    }
    if (!isSameLineage(previewLineageRef.current, targetLineage)) {
      // Job or draft switched: drop any foreign preview immediately instead of
      // leaving it visible until the debounced refresh lands.
      previewLineageRef.current = null;
      setPreview(null);
      setPreviewError(null);
      setPreviewStatus("loading");
    }

    previewRequestRef.current += 1;
    previewTimeoutRef.current = window.setTimeout(
      () => {
        refreshPreview(draft);
      },
      hasUnsavedChanges ? 250 : 100,
    );

    return () => {
      if (previewTimeoutRef.current !== null) {
        window.clearTimeout(previewTimeoutRef.current);
        previewTimeoutRef.current = null;
      }
    };
  }, [draft, hasUnsavedChanges, refreshPreview]);

  const resetPreview = useCallback(() => {
    if (previewTimeoutRef.current !== null) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    previewRequestRef.current += 1;
    previewLineageRef.current = null;
    previewContentKeyRef.current = null;
    setPreview(null);
    setPreviewError(null);
    setPreviewStatus("idle");
  }, []);

  return {
    preview,
    previewError,
    previewStatus,
    refreshPreview,
    resetPreview,
  };
}
