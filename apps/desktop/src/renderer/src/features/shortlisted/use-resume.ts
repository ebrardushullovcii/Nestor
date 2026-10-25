import type {
  JobDetail,
  ResumeCommandOutputs,
  ResumeDraft,
  StoredResume,
} from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/** How long after the last edit the draft saves itself. */
const SAVE_DELAY_MS = 800;
/** How long after the last edit the preview renders again. */
const PREVIEW_DELAY_MS = 250;

export type SaveStatus = "saved" | "saving" | "failed";

export function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (\w*Error: )?/u,
        "",
      )
    : "Something went wrong.";
}

/**
 * One shortlisted job's resume in the editor: the saved resume, the draft as
 * the person is editing it, autosave, and a live preview of every edit.
 */
export function useResume(jobId: number | null) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [resume, setResume] = useState<StoredResume | null>(null);
  const [templates, setTemplates] = useState<
    ResumeCommandOutputs["get_resume"]["templates"]
  >([]);
  const [draft, setDraft] = useState<ResumeDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    html: string;
    pageCount: number | null;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const latest = useRef({ jobId, resume, draft, dirty });
  latest.current = { jobId, resume, draft, dirty };

  const load = useCallback(async (id: number) => {
    const view = await window.nestor.resumes.run("get_resume", { jobId: id });
    if (latest.current.jobId !== id) return;
    setJob(view.job);
    setResume(view.resume);
    setTemplates(view.templates);
    if (!latest.current.dirty) setDraft(view.resume?.draft ?? null);
  }, []);

  // A new job starts from what is saved.
  useEffect(() => {
    setJob(null);
    setResume(null);
    setDraft(null);
    setDirty(false);
    setPreview(null);
    setSaveError(null);
    setSaveStatus("saved");
    if (jobId !== null) void load(jobId);
  }, [jobId, load]);

  /** Something else changed this job: show it, unless the person is typing. */
  const refresh = useCallback(() => {
    if (latest.current.jobId !== null) void load(latest.current.jobId);
  }, [load]);

  // Writing finishing, an approval elsewhere or the Assistant's edit.
  useEffect(
    () =>
      window.nestor.jobs.onChange((change) => {
        const id = latest.current.jobId;
        if (id !== null && (change.ids === null || change.ids.includes(id)))
          refresh();
      }),
    [refresh],
  );

  const save = useCallback(async () => {
    const { jobId: id, resume: saved, draft: current } = latest.current;
    if (id === null || !saved || !current) return;
    setSaveStatus("saving");
    try {
      const next = await window.nestor.resumes.run("save_resume", {
        jobId: id,
        draft: current,
        expectedUpdatedAt: saved.updatedAt,
      });
      if (latest.current.jobId !== id) return;
      setResume(next);
      // Edits made while saving are saved by the next round.
      if (latest.current.draft === current) setDirty(false);
      setSaveStatus("saved");
      setSaveError(null);
    } catch (error) {
      setSaveStatus("failed");
      setSaveError(describeError(error));
      if (/changed since you opened it/u.test(describeError(error))) {
        setDirty(false);
        void load(id);
      }
    }
  }, [load]);

  useEffect(() => {
    if (!dirty || saveStatus === "saving") return;
    const timer = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, draft, save, saveStatus]);

  useEffect(() => {
    if (jobId === null || !draft) return;
    const timer = setTimeout(() => {
      window.nestor.resumes.preview(jobId, draft).then(
        (next) => {
          if (latest.current.jobId !== jobId) return;
          setPreview(next);
          setPreviewError(null);
        },
        (error: unknown) => {
          const message = describeError(error);
          if (!/superseded|aborted/iu.test(message)) setPreviewError(message);
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [jobId, draft]);

  const edit = useCallback((next: ResumeDraft) => {
    setDraft(next);
    setDirty(true);
  }, []);

  /** Saves a pending edit now, before approving or downloading. */
  const flush = useCallback(async () => {
    if (latest.current.dirty) await save();
  }, [save]);

  return {
    job,
    resume,
    templates,
    draft,
    dirty,
    saveStatus,
    saveError,
    preview,
    previewError,
    edit,
    flush,
    refresh,
    setResume,
  };
}
