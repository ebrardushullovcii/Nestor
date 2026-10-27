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
  const saving = useRef(new Map<number, Promise<boolean>>());
  const loadSequence = useRef(0);
  const conflicted = useRef(false);
  const unsaved = useRef(
    new Map<number, { resume: StoredResume; draft: ResumeDraft }>(),
  );
  latest.current = { jobId, resume, draft, dirty };

  const load = useCallback(async (id: number) => {
    const sequence = ++loadSequence.current;
    const view = await window.nestor.resumes.run("get_resume", { jobId: id });
    if (sequence !== loadSequence.current || latest.current.jobId !== id)
      return;
    if (saving.current.has(id)) return;
    if (
      latest.current.resume &&
      view.resume &&
      view.resume.updatedAt < latest.current.resume.updatedAt
    )
      return;
    setJob(view.job);
    setTemplates(view.templates);
    const retained = unsaved.current.get(id);
    if (!latest.current.dirty && retained) {
      latest.current = { jobId: id, ...retained, dirty: true };
      setResume(retained.resume);
      setDraft(retained.draft);
      setDirty(true);
    }
    if (latest.current.dirty) {
      if (view.resume?.updatedAt !== latest.current.resume?.updatedAt) {
        conflicted.current = true;
        setSaveStatus("failed");
        setSaveError(
          "The saved resume changed elsewhere. Your typing is kept. Save your edits to replace the saved content, or load the saved resume.",
        );
      }
    } else {
      setResume(view.resume);
      setDraft(view.resume?.draft ?? null);
    }
  }, []);

  // A new job starts from what is saved.
  useEffect(() => {
    latest.current = { jobId, resume: null, draft: null, dirty: false };
    setJob(null);
    setResume(null);
    setDraft(null);
    setDirty(false);
    setPreview(null);
    setSaveError(null);
    setSaveStatus("saved");
    conflicted.current = false;
    if (jobId !== null) void load(jobId);
  }, [jobId, load]);

  /** Something else changed this job: show it, unless the person is typing. */
  const refresh = useCallback(() => {
    return latest.current.jobId !== null
      ? load(latest.current.jobId)
      : Promise.resolve();
  }, [load]);

  // Writing finishing, an approval elsewhere or the Assistant's edit.
  useEffect(
    () =>
      window.nestor.jobs.onChange((change) => {
        const id = latest.current.jobId;
        if (id !== null && (change.ids === null || change.ids.includes(id)))
          void refresh();
      }),
    [refresh],
  );

  const save = useCallback(async () => {
    if (conflicted.current) return false;
    const { jobId: id, resume: saved, draft: current } = latest.current;
    if (id === null || !saved || !current) return false;
    const pending = saving.current.get(id);
    if (pending) return pending;
    setSaveStatus("saving");
    const work = async () => {
      try {
        const next = await window.nestor.resumes.run("save_resume", {
          jobId: id,
          draft: current,
          expectedUpdatedAt: saved.updatedAt,
          allowRemoval: true,
        });
        const retained = unsaved.current.get(id);
        if (retained?.draft === current) unsaved.current.delete(id);
        else if (retained)
          unsaved.current.set(id, { ...retained, resume: next });
        if (latest.current.jobId !== id) return false;
        setResume(next);
        // Edits made while saving are saved by the next round.
        const finished = latest.current.draft === current;
        latest.current = { ...latest.current, resume: next, dirty: !finished };
        if (finished) setDirty(false);
        setSaveStatus("saved");
        setSaveError(null);
        return finished;
      } catch (error) {
        if (latest.current.jobId !== id) return false;
        setSaveStatus("failed");
        setSaveError(describeError(error));
        conflicted.current = true;
        return false;
      }
    };
    const pendingSave = work();
    saving.current.set(id, pendingSave);
    try {
      return await pendingSave;
    } finally {
      saving.current.delete(id);
    }
  }, []);

  useEffect(() => {
    if (!dirty || saveStatus !== "saved") return;
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
    if (latest.current.jobId !== null && latest.current.resume)
      unsaved.current.set(latest.current.jobId, {
        resume: latest.current.resume,
        draft: next,
      });
    latest.current = { ...latest.current, draft: next, dirty: true };
    setDraft(next);
    setDirty(true);
  }, []);

  /** Saves a pending edit now, before approving or downloading. */
  const flush = useCallback(async () => {
    if (latest.current.dirty && !(await save()))
      throw new Error(
        "Resume edits are not saved. Your typing is kept; save or resolve it before continuing.",
      );
  }, [save]);

  const saveMyEdits = useCallback(async () => {
    const id = latest.current.jobId;
    if (id === null) return;
    const view = await window.nestor.resumes.run("get_resume", { jobId: id });
    if (latest.current.jobId !== id) return;
    latest.current = { ...latest.current, resume: view.resume };
    conflicted.current = false;
    await save();
  }, [save]);

  const loadSaved = useCallback(() => {
    if (latest.current.jobId !== null)
      unsaved.current.delete(latest.current.jobId);
    latest.current = { ...latest.current, dirty: false };
    conflicted.current = false;
    setDirty(false);
    setSaveError(null);
    setSaveStatus("saved");
    void refresh();
  }, [refresh]);

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
    saveMyEdits,
    loadSaved,
    refresh,
  };
}
