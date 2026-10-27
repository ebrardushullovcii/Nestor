import {
  ResumeViewModeSchema,
  RESUME_VIEW_MODE_OPTIONS,
  type ResumeViewMode,
  type ResumeLevel,
  type StoredResume,
} from "@nestor/contracts";
import { Download, ExternalLink, RotateCcw, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { LIST_DETAIL_REGION_ID } from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";
import { useKeptRouteHidden } from "@renderer/features/job-finder/lib/kept-route-visibility";

import { ResumeEditor } from "./resume-editor";
import { ResumePreview } from "./resume-preview";
import { describeResume, LEVEL_LABEL, LEVELS } from "./resume-format";
import { describeError, type useResume } from "./use-resume";

/**
 * One shortlisted job's resume: its level, where writing is, the editor with
 * a live preview, and the one main action, approving it for Apply.
 */
export function ResumePane(props: {
  view: ReturnType<typeof useResume>;
  onApprove: () => void;
  approving: boolean;
  onApply: () => void;
  applying: boolean;
  onMoveBack: () => void;
}) {
  const { view } = props;
  const { job, resume, draft } = view;
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ResumeViewMode>("read");
  const [explicitMode, setExplicitMode] = useState(false);
  const consumedMode = useRef<{ key: string; waiting: boolean } | null>(null);
  const hidden = useKeptRouteHidden();
  const [searchParams, setSearchParams] = useSearchParams();
  const { key: navigationKey } = useLocation();
  const parsedMode = ResumeViewModeSchema.safeParse(
    searchParams.get("resumeMode"),
  );
  const requestedMode = parsedMode.success ? parsedMode.data : null;
  useEffect(() => {
    consumedMode.current = null;
    setExplicitMode(false);
  }, [job?.id]);
  useEffect(() => {
    if (hidden) return;
    if (!requestedMode) {
      if (consumedMode.current?.waiting)
        consumedMode.current = { key: navigationKey, waiting: false };
      else if (
        consumedMode.current &&
        consumedMode.current.key !== navigationKey
      ) {
        consumedMode.current = null;
        setExplicitMode(false);
      }
      return;
    }
    if (!draft || String(job?.id) !== searchParams.get("jobId")) return;
    setMode(requestedMode);
    setExplicitMode(true);
    consumedMode.current = { key: navigationKey, waiting: true };
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("resumeMode");
        return next;
      },
      { replace: true },
    );
  }, [
    requestedMode,
    navigationKey,
    job?.id,
    draft,
    searchParams,
    setSearchParams,
    hidden,
  ]);

  if (!job) {
    return (
      <section
        className="grid min-h-0 place-items-center p-8 text-sm text-foreground-soft"
        id={LIST_DETAIL_REGION_ID}
      >
        Pick a job to see its resume.
      </section>
    );
  }

  const status = describeResume(resume);
  const level = resume?.level ?? null;
  const ready = resume?.state === "ready";
  const approved = Boolean(resume?.approvedAt);

  const run = async (work: () => Promise<StoredResume | null>) => {
    setBusy(true);
    try {
      const next = await work();
      if (next) await view.refresh();
      return next;
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const changeLevel = async (next: ResumeLevel) => {
    if (next === level) return;
    try {
      await view.flush();
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
      return;
    }
    const wasApproved = approved;
    const changed = await run(() =>
      window.nestor.resumes.run("set_resume_level", {
        jobId: job.id,
        level: next,
      }),
    );
    if (!changed) return;
    showToast({
      id: `resume-level-${job.id}`,
      title:
        next === "original"
          ? "Using your original resume"
          : `Rewriting at ${LEVEL_LABEL[next]}`,
      ...(wasApproved
        ? {
            description:
              "Its approval comes off until you approve the new one.",
          }
        : {}),
      action: {
        label: "Undo",
        onClick: () =>
          void run(() =>
            window.nestor.resumes.run("undo_resume_level", {
              jobId: job.id,
              ...(changed.levelChangeId
                ? { changeId: changed.levelChangeId }
                : {}),
            }),
          ).then((undone) => {
            if (undone) void view.refresh();
          }),
      },
    });
  };

  const download = async () => {
    try {
      await view.flush();
      const { outputPath } = await window.nestor.resumes.exportPdf(job.id);
      showToast(
        outputPath
          ? { title: "Saved your resume PDF", description: outputPath }
          : { title: "Download cancelled. Nothing was saved." },
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    }
  };

  return (
    <section
      aria-label={`Resume for ${job.title}`}
      data-job-detail-id={job.id}
      data-resume-mode={draft ? mode : undefined}
      className="flex min-h-0 min-w-0 flex-col gap-3"
      id={LIST_DETAIL_REGION_ID}
    >
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-(length:--text-title) text-(--text-headline)">
            {job.title}
          </h2>
          <p className="truncate text-sm text-foreground-soft">
            {[job.company, job.location].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Button
          onClick={() => openUrlInJobFinderBrowser(job.url)}
          size="toolbar"
          variant="ghost"
        >
          <ExternalLink aria-hidden />
          Listing
        </Button>
        <Button onClick={props.onMoveBack} size="toolbar" variant="ghost">
          <Undo2 aria-hidden />
          Move back
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<ResumeLevel>
          label="Resume level"
          onValueChange={(next) => void changeLevel(next)}
          options={LEVELS.map((value) => ({
            value,
            label: LEVEL_LABEL[value],
            disabled: busy,
          }))}
          value={level ?? "tailored"}
        />
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        <span className="text-xs text-foreground-muted">
          {view.saveStatus === "failed"
            ? view.saveError
            : view.dirty || view.saveStatus === "saving"
              ? "Saving…"
              : null}
        </span>
        {view.saveStatus === "failed" && (
          <div className="flex gap-2">
            <Button
              size="toolbar"
              variant="outline"
              onClick={() => void view.saveMyEdits()}
            >
              Save my edits
            </Button>
            <Button size="toolbar" variant="ghost" onClick={view.loadSaved}>
              Load saved resume
            </Button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {draft ? (
            <Button
              onClick={() => void download()}
              size="toolbar"
              variant="outline"
            >
              <Download aria-hidden />
              PDF
            </Button>
          ) : null}
          {resume?.state === "failed" ? (
            <Button
              onClick={() =>
                void run(() =>
                  window.nestor.resumes.run("rewrite_resume", {
                    jobId: job.id,
                  }),
                )
              }
              size="toolbar"
              variant="outline"
            >
              <RotateCcw aria-hidden />
              Write again
            </Button>
          ) : null}
          {approved ? (
            <Button
              disabled={props.applying}
              onClick={props.onApply}
              pending={props.applying}
              size="toolbar"
              variant="outline"
            >
              Apply
            </Button>
          ) : (
            <Button
              disabled={!ready || props.approving}
              onClick={props.onApprove}
              pending={props.approving}
              size="toolbar"
              title="Ctrl+Enter approves this one and opens the next"
            >
              Approve
            </Button>
          )}
        </div>
      </div>

      {status.detail ? (
        <p
          className={cn(
            "text-sm",
            resume?.state === "failed"
              ? "text-(--warning-text)"
              : "text-foreground-soft",
          )}
          role="status"
        >
          {status.detail}
        </p>
      ) : null}

      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <SegmentedControl<ResumeViewMode>
            className={cn("self-start", !explicitMode && "2xl:hidden")}
            label="Read or edit the resume"
            onValueChange={(next) => {
              consumedMode.current = null;
              setMode(next);
              setExplicitMode(false);
            }}
            options={RESUME_VIEW_MODE_OPTIONS}
            value={mode}
          />
          <div className="flex min-h-0 flex-1 gap-4">
            <ResumeEditor
              className={cn(
                !explicitMode && "2xl:flex",
                mode === "read" && "hidden",
              )}
              disabled={busy || resume?.state === "writing"}
              draft={draft}
              onChange={view.edit}
              templates={view.templates}
            />
            <div
              data-resume-pane="read"
              className={cn(
                "flex min-h-0 min-w-0 flex-1",
                !explicitMode && "2xl:flex",
                mode === "edit" && "hidden",
              )}
            >
              <ResumePreview error={view.previewError} preview={view.preview} />
            </div>
          </div>
        </div>
      ) : level === "original" ? (
        <p className="rounded-(--radius-field) border border-(--surface-panel-border) p-4 text-sm text-foreground-soft">
          Original sends your imported resume file exactly as it is. Pick
          another level to have one written for this job.
        </p>
      ) : (
        <ResumeSkeleton />
      )}
    </section>
  );
}

function ResumeSkeleton() {
  return (
    <div aria-hidden className="grid gap-3">
      {[72, 48, 88, 64, 80].map((width) => (
        <div
          className="h-4 animate-pulse rounded bg-(--surface-well)"
          key={width}
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}
