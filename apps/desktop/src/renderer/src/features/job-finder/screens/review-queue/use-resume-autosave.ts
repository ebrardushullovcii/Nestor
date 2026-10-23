import { useCallback, useEffect, useRef, useState } from "react";
import type { ResumeDraft } from "@nestor/contracts";

export type ResumeAutosave = (
  draft: ResumeDraft,
  onSaved: (updatedAt: string) => void,
) => Promise<{ saved: true } | { saved: false; message: string }>;

/** How long after the last edit the draft saves itself. */
export const RESUME_AUTOSAVE_DELAY_MS = 1000;

export type ResumeAutosaveStatus = "saved" | "saving" | "failed";

/**
 * Saves Resume Studio edits about a second after the last one. One save runs
 * at a time; edits made while it runs are saved by the next one. A failed save
 * is not retried until the next edit (or `retry`), so a broken connection
 * does not save every second. Leaving the editor, or moving to another job's
 * draft, saves what is pending at once.
 *
 * The fields are never locked: the save has its own state here instead of
 * the job's pending scope.
 */
export function useResumeAutosave(input: {
  draft: ResumeDraft | null;
  /** The editor holds edits that are not saved yet. */
  unsaved: boolean;
  /** Absent: no autosave (the editor keeps its Save draft button). */
  save: ResumeAutosave | undefined;
  onSaved: (submitted: ResumeDraft, updatedAt: string) => void;
  /** The content key of `draft`, to tell a new edit from the failed one. */
  contentKey: string | null;
  delayMs?: number;
}): {
  status: ResumeAutosaveStatus;
  failure: string | null;
  retry: () => void;
} {
  const delayMs = input.delayMs ?? RESUME_AUTOSAVE_DELAY_MS;
  const latest = useRef(input);
  latest.current = input;
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{
    message: string;
    contentKey: string | null;
  } | null>(null);
  // Bumped when a save settles, so edits made meanwhile are picked up.
  const [round, setRound] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const saveNow = useCallback(
    (draft: ResumeDraft, contentKey: string | null) => {
      const save = latest.current.save;
      if (!save || inFlight.current) return;
      setSaving(true);
      inFlight.current = save(draft, (updatedAt) =>
        latest.current.onSaved(draft, updatedAt),
      ).then(
        (result) => {
          inFlight.current = null;
          if (!mounted.current) return;
          setSaving(false);
          setFailure(
            result.saved ? null : { message: result.message, contentKey },
          );
          setRound((value) => value + 1);
        },
        () => {
          inFlight.current = null;
          if (!mounted.current) return;
          setSaving(false);
          setFailure({
            message: "Your latest resume edits were not saved.",
            contentKey,
          });
          setRound((value) => value + 1);
        },
      );
    },
    [],
  );

  const { draft, unsaved, contentKey } = input;
  const enabled = Boolean(input.save);
  const failedOnThisContent =
    failure !== null && failure.contentKey === contentKey;
  useEffect(() => {
    if (!enabled || !unsaved || !draft || failedOnThisContent) return;
    const timer = window.setTimeout(() => saveNow(draft, contentKey), delayMs);
    return () => window.clearTimeout(timer);
  }, [
    contentKey,
    delayMs,
    draft,
    enabled,
    failedOnThisContent,
    round,
    saveNow,
    unsaved,
  ]);

  // What was on screen at the last commit, read when the editor closes or
  // switches drafts (cleanups run before this render's effects update it).
  const committed = useRef({ draft, unsaved });
  useEffect(() => {
    committed.current = { draft, unsaved };
  });
  const draftId = draft?.id ?? null;
  useEffect(
    () => () => {
      const pending = committed.current;
      const save = latest.current.save;
      if (!save || !pending.draft || !pending.unsaved) return;
      const pendingDraft = pending.draft;
      const run = () => {
        void save(pendingDraft, () => undefined);
      };
      if (inFlight.current) void inFlight.current.then(run);
      else run();
    },
    [draftId],
  );

  const retry = useCallback(() => {
    const { draft: current, contentKey: key } = latest.current;
    if (!current) return;
    setFailure(null);
    saveNow(current, key);
  }, [saveNow]);

  return {
    status: failedOnThisContent
      ? "failed"
      : saving || unsaved
        ? "saving"
        : "saved",
    failure: failedOnThisContent ? failure.message : null,
    retry,
  };
}
