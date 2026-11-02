import { FileText } from "lucide-react";
import { formatDate } from "@renderer/features/job-finder/lib/format-date";
import { useCallback, useEffect, useState } from "react";

import { useToast } from "@renderer/components/ui/toast";

/** The imported resume file the Original level sends as it is. */
export interface OriginalFile {
  id: string;
  fileName: string;
  fileType: string;
  byteSize: number;
  importedAt: string;
}

export interface OriginalResumeFileState {
  file: OriginalFile | null;
  /** Read once; null while reading or when there is no saved file. */
  status: "idle" | "loading" | "ready" | "missing";
  /** Opens a read-only copy in the device's default app. */
  open: () => Promise<void>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 * 1024)
    return `${Math.round(bytes / 1024).toLocaleString()} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The imported resume file, read when the Original level is showing: its
 * name, kind and size from the profile and the file library.
 */
export function useOriginalResumeFile(
  enabled: boolean,
): OriginalResumeFileState {
  const { showToast } = useToast();
  const [file, setFile] = useState<OriginalFile | null>(null);
  const [status, setStatus] =
    useState<OriginalResumeFileState["status"]>("idle");

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setStatus("loading");
    void (async () => {
      try {
        const overview = await window.nestor.jobs.run("get_profile", {});
        const listed = await window.nestor.jobFinder.listCandidateAssets({
          includeDeleted: false,
          resumeSourceId: overview.resume.id,
        });
        if (!live) return;
        setFile(listed.originalResumeFile ?? null);
        setStatus(listed.originalResumeFile ? "ready" : "missing");
      } catch {
        if (live) setStatus("missing");
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled]);

  const open = useCallback(async () => {
    if (!file) return;
    try {
      const result = await window.nestor.jobFinder.openCandidateAsset({
        assetId: file.id,
      });
      if (result.outcome !== "opened")
        showToast({
          title:
            result.outcome === "not_found"
              ? `${file.fileName} is no longer saved. Import your resume again in Profile.`
              : `${file.fileName} could not be opened on this device.`,
          tone: "warning",
        });
    } catch {
      showToast({
        title: `${file.fileName} could not be opened. Try again.`,
        tone: "warning",
      });
    }
  }, [file, showToast]);

  return { file, status, open };
}

/**
 * What Original sends, on the same desk the written levels use: the file
 * itself, named and sized, with the action that opens it. Job Finder does not
 * redraw the file, so the person reads it in the app that made it.
 */
export function OriginalResumeFile(props: { state: OriginalResumeFileState }) {
  const { file, status } = props.state;
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--resume-preview-frame) p-6"
      data-resume-original
    >
      <div
        className="grid w-full max-w-md justify-items-center gap-3 rounded-(--radius-small) bg-white px-8 py-10 text-center text-stone-800"
        style={{ boxShadow: "var(--resume-preview-shell-shadow)" }}
      >
        <FileText aria-hidden className="size-8 text-stone-500" />
        {file ? (
          <>
            <p className="max-w-full truncate text-(length:--text-item) font-semibold">
              {file.fileName}
            </p>
            <p className="text-sm text-stone-600">
              {file.fileType} · {formatSize(file.byteSize)} · imported{" "}
              {formatDate(file.importedAt)}
            </p>
          </>
        ) : (
          <p className="text-sm text-stone-600">
            {status === "loading"
              ? "Finding your imported resume…"
              : "Your imported resume file is not saved on this device."}
          </p>
        )}
        <p className="max-w-prose text-sm leading-6 text-stone-600">
          Original sends this file exactly as it is. Open file reads it in its
          own app; pick another level to have one written for this job.
        </p>
      </div>
    </div>
  );
}
