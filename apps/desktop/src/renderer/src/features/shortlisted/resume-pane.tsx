import {
  ResumeViewModeSchema,
  RESUME_VIEW_MODE_OPTIONS,
  type ResumeViewMode,
  type ResumeLevel,
  type ShortlistedApplication,
  type StoredResume,
} from "@nestor/contracts";
import {
  Download,
  ExternalLink,
  FileText,
  RotateCcw,
  ArrowLeftToLine,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import {
  DetailSheetBack,
  EmptyPane,
  type BesideList,
  LIST_DETAIL_REGION_ID,
  ListReadError,
  modShortcut,
} from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";
import { useKeptRouteHidden } from "@renderer/features/job-finder/lib/kept-route-visibility";
import { applyFailureLine } from "@renderer/features/applications/apply-failure";

import { ResumeEditor } from "./resume-editor";
import { ResumePaperSkeleton, ResumePreview } from "./resume-preview";
import { OriginalResumeFile, useOriginalResumeFile } from "./original-resume";
import {
  APPLICATION_BADGE,
  describeResume,
  LEVEL_HINT,
  LEVEL_LABEL,
  LEVELS,
} from "./resume-format";
import { openPreparedApplication } from "@renderer/features/applications/open-application";
import { describeError, type useResume } from "./use-resume";
import { savedFileToast } from "@renderer/features/job-finder/lib/saved-file-toast";

/**
 * One shortlisted job's resume: its level, where writing is, the editor with
 * a live preview, and the one main action, approving it for Apply.
 */
export function ResumePane(props: {
  view: ReturnType<typeof useResume>;
  /** Apply's open work on this job, which replaces Apply while it runs. */
  application?: ShortlistedApplication | null;
  onApprove: () => void;
  approving: boolean;
  onApply: () => void;
  applying: boolean;
  onMoveBack: () => void;
  /** Stacked under a sheet: closes the sheet back to the list. */
  onBack?: () => void;
  /** The list (or this job) is still loading: a skeleton, not "pick a job". */
  listLoading?: boolean;
  /** The list beside it: with nothing in it, there is nothing to pick. */
  list?: BesideList;
  /** Rows are ticked: the bulk bar holds the filled action; this one steps down. */
  bulkActive?: boolean;
}) {
  const { view } = props;
  const { job, resume, draft } = view;
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  // The level just chosen, while its rewrite is being asked for: the page
  // turns into a "Rewriting the Light resume…" skeleton at once.
  const [pendingLevel, setPendingLevel] = useState<ResumeLevel | null>(null);
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

  const originalFile = useOriginalResumeFile(resume?.level === "original");

  if (!job) {
    if (view.loadError)
      return (
        <section
          aria-label="Resume"
          className="surface-panel-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)"
          data-resume-read-error
          id={LIST_DETAIL_REGION_ID}
        >
          {props.onBack ? <DetailSheetBack onBack={props.onBack} /> : null}
          <div className="grid flex-1 place-items-center p-6">
            <ListReadError
              error={view.loadError}
              kept="The job stays shortlisted and its resume is unchanged."
              onRetry={() => void view.refresh()}
              what="This resume"
            />
          </div>
        </section>
      );
    if (props.listLoading) return <ResumePaneSkeleton onBack={props.onBack} />;
    return (
      <EmptyPane label="Resume" list={props.list}>
        Pick a job to see its resume.
      </EmptyPane>
    );
  }

  // Apply's failure is said where it happened: the pane's badge, the
  // reason, and its two ways on, never a silent return to Approved.
  const failedApply =
    props.application?.status === "failed" ? props.application : null;
  const status = failedApply
    ? { ...APPLICATION_BADGE.failed, detail: null }
    : describeResume(resume);
  const level = resume?.level ?? null;
  const ready = resume?.state === "ready";
  const approved = Boolean(resume?.approvedAt);
  // Being written (or rewritten at another level): the page is a skeleton
  // that names the level, and Approve waits for the page.
  const writing =
    pendingLevel !== null ||
    !resume ||
    resume.state === "writing" ||
    resume.state === "queued";
  const shownLevel = pendingLevel ?? level ?? "tailored";
  const writingLabel = resume?.providerWaiting
    ? "Waiting for the AI provider"
    : pendingLevel !== null
      ? pendingLevel === "original"
        ? "Switching to your original resume"
        : `Rewriting the ${LEVEL_LABEL[pendingLevel]} resume…`
      : resume?.state === "queued" || !resume
        ? `Waiting to write the ${LEVEL_LABEL[shownLevel]} resume`
        : `Writing the ${LEVEL_LABEL[shownLevel]} resume…`;
  // Approve once the page is written; while it is written the button stays
  // an outlined, disabled one, never a filled one that looks ready.
  const canApprove = ready && !writing;

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
    setPendingLevel(next);
    const changed = await run(() =>
      window.nestor.resumes.run("set_resume_level", {
        jobId: job.id,
        level: next,
      }),
    ).finally(() => setPendingLevel(null));
    if (!changed) return;
    showToast({
      id: `resume-level-${job.id}`,
      title:
        next === "original"
          ? "Using your original resume"
          : `Rewriting the ${LEVEL_LABEL[next]} resume…`,
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
          ? savedFileToast("Saved your resume PDF", outputPath, showToast)
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
      // The one detail frame (Find jobs, Applications, Needs you share it):
      // a bordered panel, with the paper's desk as the only level inside.
      className="@container/resume surface-panel-shell flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) p-4"
      id={LIST_DETAIL_REGION_ID}
    >
      {props.onBack ? <DetailSheetBack onBack={props.onBack} /> : null}
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          {/* Autosave says so beside the title, as a document editor does:
              on one line that never wraps, so a burst of typing moves
              nothing. In the toolbar row it pushed Resume/Edit · PDF ·
              Approve onto a second row for ~1 s (the editor jumped 44 px). */}
          <div className="flex min-w-0 items-baseline gap-3">
            <h2 className="min-w-0 truncate font-display text-(length:--text-title) text-(--text-headline)">
              {job.title}
            </h2>
            <span
              aria-live="polite"
              className="shrink-0 text-xs text-foreground-muted"
              data-resume-save-status
            >
              {view.saveStatus !== "failed" &&
              (view.dirty || view.saveStatus === "saving")
                ? "Saving…"
                : null}
            </span>
          </div>
          <p className="truncate text-sm text-foreground-soft">
            {[job.company, job.location].filter(Boolean).join(" · ")}
          </p>
        </div>
        {/* Icon only in a narrow pane, so the title keeps the width. */}
        <Button
          aria-label="Open the listing"
          onClick={() => openUrlInJobFinderBrowser(job.url)}
          size="toolbar"
          title="Open the listing"
          variant="ghost"
        >
          <ExternalLink aria-hidden />
          <span className="hidden @2xl/resume:inline">Listing</span>
        </Button>
        <Button
          aria-label="Move back to Find jobs"
          onClick={props.onMoveBack}
          size="toolbar"
          title="Move back to Find jobs"
          variant="ghost"
        >
          <ArrowLeftToLine aria-hidden />
          <span className="hidden @2xl/resume:inline">Move back</span>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<ResumeLevel>
          label="Resume level"
          onValueChange={(next) => void changeLevel(next)}
          options={LEVELS.map((value) => ({
            value,
            label: LEVEL_LABEL[value],
            title: LEVEL_HINT[value],
            disabled: busy,
          }))}
          value={level ?? "tailored"}
        />
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        {/* A failed save is not a passing state: its reason and its two
            ways out stay in this row until the person picks one. */}
        {view.saveStatus === "failed" ? (
          <span className="text-xs text-foreground-muted">
            {view.saveError}
          </span>
        ) : null}
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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* Read or edit sits in this row, not a row of its own, so a
              sheet at 1024 gives that height to the paper. While the page
              is written its room is held (not drawn: nothing to edit yet),
              so the page that arrives lands where the skeleton was. */}
          {writing && level !== "original" && pendingLevel !== "original" ? (
            <div
              aria-hidden="true"
              className={cn(
                "invisible",
                !explicitMode && "@min-[88rem]/resume:hidden",
              )}
              inert
            >
              <SegmentedControl<ResumeViewMode>
                label="Read or edit the resume"
                onValueChange={() => undefined}
                options={RESUME_VIEW_MODE_OPTIONS}
                value={mode}
              />
            </div>
          ) : draft ? (
            <SegmentedControl<ResumeViewMode>
              className={cn(!explicitMode && "@min-[88rem]/resume:hidden")}
              label="Read or edit the resume"
              onValueChange={(next) => {
                consumedMode.current = null;
                setMode(next);
                setExplicitMode(false);
              }}
              options={RESUME_VIEW_MODE_OPTIONS}
              value={mode}
            />
          ) : null}
          {draft ? (
            <Button
              onClick={() => void download()}
              size="toolbar"
              variant="outline"
            >
              <Download aria-hidden />
              PDF
            </Button>
          ) : level === "original" && pendingLevel === null ? (
            // Original sends the imported file itself, so the file action
            // opens that file instead of drawing a PDF of it.
            <Button
              disabled={!originalFile.file}
              onClick={() => void originalFile.open()}
              size="toolbar"
              title={originalFile.file?.fileName}
              variant="outline"
            >
              <FileText aria-hidden />
              Open file
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
          {failedApply ? (
            <>
              <Button
                disabled={props.applying}
                onClick={props.onApply}
                pending={props.applying}
                size="toolbar"
              >
                <RotateCcw aria-hidden />
                Try again
              </Button>
              <Button
                onClick={() =>
                  openUrlInJobFinderBrowser(job.applyUrl ?? job.url)
                }
                size="toolbar"
                title="Open the application page and apply yourself"
                variant="outline"
              >
                <ExternalLink aria-hidden />
                Apply by hand
              </Button>
            </>
          ) : props.application?.status === "ready" ? (
            <Button
              onClick={() => {
                const id = props.application?.id;
                if (id)
                  void openPreparedApplication(id, showToast).catch(
                    (error: unknown) =>
                      showToast({
                        title: describeError(error),
                        tone: "warning",
                      }),
                  );
              }}
              size="toolbar"
            >
              Review and send
            </Button>
          ) : props.application ? (
            <Button
              onClick={() =>
                void navigate(
                  props.application?.status === "needs_you"
                    ? "/job-finder/actions"
                    : `/job-finder/applications?jobId=${job.id}`,
                )
              }
              size="toolbar"
              variant="outline"
            >
              {/* The badge beside the level says where it stands; the
                  button only says where it goes. */}
              {props.application.status === "needs_you"
                ? "Answer in Needs you"
                : "Open in Applications"}
            </Button>
          ) : approved ? (
            <Button
              disabled={props.applying}
              onClick={props.onApply}
              pending={props.applying}
              size="toolbar"
              variant="outline"
            >
              Apply
            </Button>
          ) : writing && !props.approving ? null : (
            // While the page is still being written there is nothing to
            // approve: the status beside the level says so, and the
            // button arrives with the page.
            <Button
              disabled={!canApprove || props.approving}
              onClick={props.onApprove}
              pending={props.approving}
              size="toolbar"
              title={
                canApprove
                  ? `${modShortcut("Enter")} approves this one and opens the next`
                  : "You can approve it once the page is written"
              }
              variant={
                (canApprove || props.approving) && !props.bulkActive
                  ? "primary"
                  : "outline"
              }
            >
              {/* The level being approved is named on the button, so the
                  person never approves a level they did not mean. */}
              {`Approve ${LEVEL_LABEL[shownLevel]}`}
            </Button>
          )}
        </div>
      </div>

      {view.loadError ? (
        <ListReadError
          error={view.loadError}
          inline
          inlineText="Couldn’t read the latest version of this resume. What you see, and any typing, is kept."
          onRetry={() => void view.refresh()}
          what="This resume"
        />
      ) : null}

      {failedApply ? (
        // One plain cause in the buttons' words, then what matters next;
        // body text, since amber means "waiting on you" (the red badge says
        // it could not apply).
        <p className="text-sm text-foreground" data-apply-failed role="status">
          {applyFailureLine(failedApply.reason)}
        </p>
      ) : null}

      {status.detail && resume?.state === "failed" ? (
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

      {writing && level !== "original" && pendingLevel !== "original" ? (
        // The written page's frame, kept while it is written, so the page
        // that arrives lands where the skeleton was.
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <ResumePaperSkeleton label={writingLabel} />
        </div>
      ) : draft ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex min-h-0 flex-1 gap-4">
            <ResumeEditor
              className={cn(
                !explicitMode && "@min-[88rem]/resume:flex",
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
                !explicitMode && "@min-[88rem]/resume:flex",
                mode === "edit" && "hidden",
              )}
            >
              <ResumePreview
                error={view.previewError}
                label={`${LEVEL_LABEL[shownLevel]} resume for ${job.title}`}
                onRetry={() => void view.refresh()}
                preview={view.preview}
              />
            </div>
          </div>
        </div>
      ) : level === "original" ? (
        <OriginalResumeFile state={originalFile} />
      ) : (
        <ResumePaperSkeleton label={writingLabel} />
      )}
    </section>
  );
}

/**
 * The resume pane while its job loads: header, level control and a blank
 * page, where the loaded ones land.
 */
function ResumePaneSkeleton(props: { onBack?: (() => void) | undefined }) {
  return (
    <section
      aria-busy="true"
      aria-label="Resume"
      className="surface-panel-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)"
      data-resume-pane-skeleton
      id={LIST_DETAIL_REGION_ID}
    >
      {/* A sheet that opens while its resume is read has its way back
          from the first frame: focus lands on it, never on the page. */}
      {props.onBack ? <DetailSheetBack onBack={props.onBack} /> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="grid gap-1">
          <div className="flex min-h-[1lh] items-center text-(length:--text-title)">
            <span className="skeleton block h-[0.8em] w-1/2" />
          </div>
          <div className="flex min-h-[1lh] items-center text-sm">
            <span className="skeleton block h-[0.8em] w-1/3" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="skeleton block h-8 w-72" />
          <span className="skeleton ml-auto block h-8 w-24" />
        </div>
        <ResumePaperSkeleton label="Opening the resume…" />
      </div>
    </section>
  );
}
