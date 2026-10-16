import { joinUniqueSentences } from "../../lib/sentence-copy";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  RapidReviewDecision,
  RapidReviewDecisionLog,
  RapidReviewDecisionKind,
  RapidReviewMutationInput,
  JobListRow,
} from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import { Link } from "react-router-dom";
import {
  CollectionPagination,
  COLLECTION_PAGE_SIZE,
} from "../../components/collection-pagination";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import { usePersistedCollectionView } from "../../hooks/use-persisted-collection-view";
import { getAdjacentCollectionItemId } from "../../lib/collection-keyboard-navigation";
import { getPostedDateLabel } from "../../lib/job-finder-utils";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { hasOpenJobFinderOverlays } from "../../lib/job-finder-overlay-ownership";
import { getMatchAssessmentPresentation } from "../../lib/match-assessment-presentation";

const RAPID_REVIEW_DETAIL_ID = "rapid-review-job-detail";
const RAPID_REVIEW_DETAIL_TITLE_ID = "rapid-review-detail-title";

const RAPID_REVIEW_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["J / K", "move"],
  ["S", "shortlist"],
  ["X", "reject"],
  ["I", "inspect"],
  ["U", "undo"],
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (isTypingTarget(target)) return true;

  const interactiveTarget = target.closest(
    'a, button, [contenteditable="true"], [role="button"], [role="checkbox"], [role="combobox"], [role="link"], [role="listbox"], [role="option"], [role="radio"], [role="switch"]',
  );
  if (!interactiveTarget) return false;

  // Collection item buttons are the intended owner for J/K and the row-level
  // arrow navigation. Any other control must keep the screen shortcuts out.
  return !interactiveTarget.hasAttribute("data-collection-item-id");
}

export function buildLatestDecisionIndex(
  log: RapidReviewDecisionLog | null,
): ReadonlyMap<string, RapidReviewDecision> {
  const index = new Map<string, RapidReviewDecision>();
  if (!log) return index;

  for (const entry of log.entries) {
    if (entry.undo !== null) continue;
    const current = index.get(entry.jobId);
    if (!current || entry.revision >= current.revision) {
      index.set(entry.jobId, entry);
    }
  }

  return index;
}

// The canonical undo target: the newest append-order entry that has not been
// undone. Binding U and the undo button to this entry keeps undo working
// after the decided job leaves the visible list (a reject archives the job),
// instead of falling back to whichever unrelated row is active.
export function findLatestUndoableDecision(
  log: RapidReviewDecisionLog | null,
): RapidReviewDecision | null {
  if (!log) return null;

  for (let index = log.entries.length - 1; index >= 0; index -= 1) {
    const entry = log.entries[index];
    if (entry && entry.undo === null) return entry;
  }

  return null;
}

function formatRecommendation(value: string): string {
  return value.replaceAll("_", " ");
}

export function RapidReviewScreen(props: {
  campaignId: string;
  campaignName: string;
  error?: string | null;
  jobs: readonly JobListRow[];
  log: RapidReviewDecisionLog | null;
  onInspectJob: (jobId: string) => void;
  onMutate: (input: RapidReviewMutationInput) => Promise<unknown>;
  pending: boolean;
}) {
  const view = usePersistedCollectionView("rapid-review", "comfortable");
  // Route remounts deliberately restart review at the first row of page 1:
  // the route passes no active-job state and the decision log — not
  // localStorage — is the only durable record of review progress. Do not
  // invent persistence for this anchor.
  const [activeJobId, setActiveJobId] = useState<string | null>(
    props.jobs[0]?.id ?? null,
  );
  const [page, setPage] = useState(1);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [localError, setLocalError] = useState<string | null>(null);
  const screenRegionRef = useRef<HTMLElement | null>(null);
  const latestDecisions = useMemo(
    () => buildLatestDecisionIndex(props.log),
    [props.log],
  );
  const latestUndoable = useMemo(
    () => findLatestUndoableDecision(props.log),
    [props.log],
  );
  const latestUndoableJob = useMemo(
    () =>
      latestUndoable
        ? (props.jobs.find((job) => job.id === latestUndoable.jobId) ?? null)
        : null,
    [latestUndoable, props.jobs],
  );

  const visibleJobs = useMemo(
    () =>
      props.jobs.filter((job) =>
        matchesCollectionSearch(view.query, [
          job.title,
          job.company,
          job.location,
          job.salaryText,
          job.matchAssessment.recommendationRationale,
          ...job.matchAssessment.reasons,
          ...job.matchAssessment.gaps,
        ]),
      ),
    [props.jobs, view.query],
  );
  const activeIndex = Math.max(
    0,
    visibleJobs.findIndex((job) => job.id === activeJobId),
  );
  const activeJob = visibleJobs[activeIndex] ?? null;
  const activeJobDate = activeJob ? getPostedDateLabel(activeJob) : null;
  const pageCount = Math.max(
    1,
    Math.ceil(visibleJobs.length / COLLECTION_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const pagedVisibleJobs = useMemo(
    () =>
      visibleJobs.slice(
        (currentPage - 1) * COLLECTION_PAGE_SIZE,
        currentPage * COLLECTION_PAGE_SIZE,
      ),
    [currentPage, visibleJobs],
  );
  const comparedJobs = props.jobs
    .filter((job) => selectedIds.has(job.id))
    .slice(0, 4);

  useEffect(() => {
    if (visibleJobs.length === 0) return;
    if (!visibleJobs.some((job) => job.id === activeJobId)) {
      setActiveJobId(visibleJobs[0]!.id);
    }
  }, [activeJobId, visibleJobs]);

  useEffect(() => {
    setPage(1);
  }, [view.query]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount));
  }, [pageCount]);

  useEffect(() => {
    if (activeIndex < 0 || visibleJobs.length === 0) return;
    setPage(Math.floor(activeIndex / COLLECTION_PAGE_SIZE) + 1);
  }, [activeIndex, visibleJobs.length]);

  useEffect(() => {
    if (!pendingFocusId) return;
    // Scoped to this screen's region and cancelled on cleanup/re-request so
    // a stale frame can never focus rows belonging to another surface.
    const frame = window.requestAnimationFrame(() => {
      const region = screenRegionRef.current;
      const target = region
        ? Array.from(
            region.querySelectorAll<HTMLElement>("[data-collection-item-id]"),
          ).find((item) => item.dataset.collectionItemId === pendingFocusId)
        : undefined;
      target?.focus();
      setPendingFocusId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentPage, pendingFocusId]);
  // The workspace owns a focus scope: the shell route focus lands on <main>
  // first, then this section claims focus with preventScroll so S/X/I/U/J/K
  // have an unambiguous home. Claims never steal from a focused child or from
  // any interactive control elsewhere, and never run while an overlay owns
  // interaction. A rAF re-claim covers focus that settles after this commit.
  const hasReviewJobs = props.jobs.length > 0;
  useEffect(() => {
    if (!hasReviewJobs) return undefined;
    const claimWorkspaceFocus = () => {
      const region = screenRegionRef.current;
      if (!region || hasOpenJobFinderOverlays()) return;
      const current = document.activeElement;
      if (current && region.contains(current)) return;
      if (isInteractiveTarget(current)) return;
      region.focus({ preventScroll: true });
    };
    claimWorkspaceFocus();
    const frame = window.requestAnimationFrame(claimWorkspaceFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [hasReviewJobs]);

  const move = useCallback(
    (offset: number) => {
      if (visibleJobs.length === 0) return;
      const next = Math.min(
        visibleJobs.length - 1,
        Math.max(0, activeIndex + offset),
      );
      const nextId = visibleJobs[next]!.id;
      setActiveJobId(nextId);
      setPage(Math.floor(next / COLLECTION_PAGE_SIZE) + 1);
      setPendingFocusId(nextId);
    },
    [activeIndex, visibleJobs],
  );

  const handleListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, jobId: string) => {
      if (event.target !== event.currentTarget) return;

      const nextId = getAdjacentCollectionItemId(
        visibleJobs.map((job) => job.id),
        jobId,
        event.key,
      );
      if (!nextId) return;
      event.preventDefault();
      event.stopPropagation();
      const nextIndex = visibleJobs.findIndex((job) => job.id === nextId);
      const nextPage = Math.floor(nextIndex / COLLECTION_PAGE_SIZE) + 1;
      if (nextPage !== currentPage) {
        setPage(nextPage);
      }
      setActiveJobId(nextId);
      setPendingFocusId(nextId);
    },
    [currentPage, visibleJobs],
  );

  // Pointer pagination keeps the shared CollectionPagination contract: the
  // Next/Previous control retains focus across the page turn, so this handler
  // never schedules row focus. What it restores is the page↔active-row
  // invariant the raw setter broke (page 6 of 500 rendered rows with no
  // aria-current while the detail still described a page-1 job): every
  // rendered page contains its active row, so exactly one visible row is
  // aria-current and the detail pane always describes it.
  const goToPage = useCallback(
    (requestedPage: number) => {
      const nextPage = Math.min(Math.max(requestedPage, 1), pageCount);
      const startIndex = (nextPage - 1) * COLLECTION_PAGE_SIZE;
      const endIndex = nextPage * COLLECTION_PAGE_SIZE;
      const nextActiveId =
        activeJob && activeIndex >= startIndex && activeIndex < endIndex
          ? activeJob.id
          : (visibleJobs[startIndex]?.id ?? null);
      setPage(nextPage);
      if (nextActiveId) setActiveJobId(nextActiveId);
    },
    [activeIndex, activeJob, pageCount, visibleJobs],
  );

  const decide = useCallback(
    async (jobIds: readonly string[], decision: RapidReviewDecisionKind) => {
      if (jobIds.length === 0 || props.pending) return;
      setLocalError(null);
      try {
        await props.onMutate({
          type: "decide",
          campaignId: props.campaignId,
          jobIds: [...jobIds],
          decision,
          expectedRevisions: Object.fromEntries(
            jobIds.map((jobId) => [
              jobId,
              latestDecisions.get(jobId)?.revision ?? null,
            ]),
          ),
          reason: null,
        });
        setSelectedIds(new Set());
        if (jobIds.includes(activeJobId ?? "")) move(1);
      } catch (error) {
        setLocalError(
          error instanceof Error ? error.message : "The review action failed.",
        );
      }
    },
    [activeJobId, latestDecisions, move, props],
  );

  const undo = useCallback(
    async (jobId: string) => {
      const current = latestDecisions.get(jobId);
      if (!current || props.pending) return;
      setLocalError(null);
      try {
        await props.onMutate({
          type: "undo",
          campaignId: props.campaignId,
          jobId,
          expectedRevision: current.revision,
          reason: null,
        });
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : "Undo failed.");
      }
    },
    [latestDecisions, props],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Focus-scope contract: the shortcuts live only while the review
      // workspace (or a descendant) holds focus. Body, shell main, and any
      // other surface keep them dead, and while an overlay owns interaction —
      // consulted at keypress time via the shared LIFO stack — they never fire.
      if (
        event.defaultPrevented ||
        hasOpenJobFinderOverlays() ||
        !screenRegionRef.current?.contains(document.activeElement) ||
        isInteractiveTarget(event.target) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const key = event.key.toLocaleLowerCase();
      if (key === "j" || event.key === "ArrowDown") move(1);
      else if (key === "k" || event.key === "ArrowUp") move(-1);
      else if (activeJob && key === "s")
        void decide([activeJob.id], "shortlist");
      else if (activeJob && key === "x") void decide([activeJob.id], "reject");
      else if (activeJob && key === "i") props.onInspectJob(activeJob.id);
      else if (latestUndoable && key === "u") void undo(latestUndoable.jobId);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeJob, decide, latestUndoable, move, props, undo]);

  if (props.jobs.length === 0) {
    return (
      <section className="grid min-h-96 place-items-center p-8 text-center">
        <div className="max-w-lg space-y-2">
          <h1 className="font-semibold">Quick review</h1>
          <p className="text-foreground-soft">
            Nothing has been found to review yet. Run a search on Find jobs
            first; no browser or application work starts here.
          </p>
          <div className="flex justify-center pt-2">
            <Button asChild type="button">
              <Link to={JOB_FINDER_ROUTE_PATHS.discovery}>
                Open Find jobs
              </Link>
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-busy={props.pending}
      className="grid gap-4 p-4 outline-none"
      ref={screenRegionRef}
      tabIndex={-1}
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-foreground-muted">
            {props.campaignName}
          </p>
          <h1 className="font-semibold">Quick review</h1>
          <p className="text-sm text-foreground-soft">
            Review local job evidence only. Nothing here opens a browser or
            starts an application.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="sr-only">
            Keyboard shortcuts, while the review workspace has focus:
          </span>
          {RAPID_REVIEW_SHORTCUTS.map(([keys, label]) => (
            <span
              className="flex items-center gap-1.5 text-xs text-foreground-soft"
              key={label}
            >
              <kbd className="rounded-(--radius-chip) border border-border-subtle bg-(--field) px-1.5 py-0.5 font-mono text-[0.68rem] leading-4 text-foreground">
                {keys}
              </kbd>
              <span>{label}</span>
            </span>
          ))}
        </div>
      </header>

      <CollectionSearchToolbar
        className="px-0"
        density={view.density}
        label="Search these results"
        onDensityChange={view.setDensity}
        onQueryChange={view.setQuery}
        placeholder="Search roles, companies, locations, or evidence"
        query={view.query}
        totalCount={props.jobs.length}
        visibleCount={visibleJobs.length}
      />

      {props.error || localError ? (
        <p role="alert" className="border border-destructive/40 p-3 text-sm">
          {localError ?? props.error}
        </p>
      ) : null}

      {latestUndoable ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            pending={props.pending}
            onClick={() => void undo(latestUndoable.jobId)}
            type="button"
            variant="ghost"
          >
            {latestUndoableJob
              ? `Undo ${formatRecommendation(latestUndoable.kind)}: ${latestUndoableJob.title}`
              : "Undo last review decision"}
          </Button>
          <p className="text-xs text-foreground-muted">
            Reverts the most recent review decision — press U while the review
            workspace has focus.
          </p>
        </div>
      ) : null}

      {visibleJobs.length === 0 ? (
        <CollectionNoMatches
          noun="jobs"
          onClear={() => view.setQuery("")}
          query={view.query}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.4fr)]">
          <p className="sr-only" role="status">
            {activeJob
              ? `Reviewing ${activeJob.title} at ${activeJob.company}`
              : ""}
          </p>
          <div className="grid content-start gap-2">
            <ul
              className="grid content-start gap-2"
              aria-label="Jobs to review"
            >
              {pagedVisibleJobs.map((job) => {
                const current = latestDecisions.get(job.id);
                const active = activeJob?.id === job.id;
                const assessment = getMatchAssessmentPresentation(job);
                return (
                  <li
                    key={job.id}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] border ${
                      active ? "border-primary bg-secondary" : "border-border"
                    }`}
                  >
                    <button
                      aria-controls={
                        activeJob ? RAPID_REVIEW_DETAIL_ID : undefined
                      }
                      aria-current={active ? "true" : undefined}
                      aria-keyshortcuts="ArrowUp ArrowDown Home End"
                      className="w-full p-3 text-left"
                      data-collection-item-id={job.id}
                      onClick={() => setActiveJobId(job.id)}
                      onKeyDown={(event) => handleListKeyDown(event, job.id)}
                      type="button"
                    >
                      <span className="block font-semibold">{job.title}</span>
                      <span className="block text-sm text-foreground-soft">
                        {job.company} · {job.location}
                      </span>
                      <span className="mt-1 block text-xs text-foreground-muted">
                        {assessment.headlineScoreLabel}
                        {current
                          ? ` · ${formatRecommendation(current.kind)}`
                          : " · not reviewed"}
                      </span>
                    </button>
                    {/* Own grid column: the padded label is a distinct >=24px
                        target that never overlaps the row button target. */}
                    <label className="flex items-center gap-1 justify-self-end self-start p-2 text-xs">
                      <input
                        aria-label={`Select ${job.title} at ${job.company}`}
                        checked={selectedIds.has(job.id)}
                        onChange={(event) =>
                          setSelectedIds((currentIds) => {
                            const next = new Set(currentIds);
                            if (event.target.checked) next.add(job.id);
                            else next.delete(job.id);
                            return next;
                          })
                        }
                        type="checkbox"
                      />
                      Compare
                    </label>
                  </li>
                );
              })}
            </ul>
            <CollectionPagination
              itemLabel="jobs"
              onPageChange={goToPage}
              page={currentPage}
              pageSize={COLLECTION_PAGE_SIZE}
              totalCount={visibleJobs.length}
            />
          </div>

          {activeJob ? (
            // At xl the detail pins beside the 40-row page so walking a long
            // page never strands it above the viewport (the blank bordered
            // column next to the paginator). Below xl it stays in normal
            // stacked flow — no sticky trap on narrow or 125% layouts.
            <article
              aria-labelledby={RAPID_REVIEW_DETAIL_TITLE_ID}
              className="grid content-start gap-4 border border-border p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-10rem)] xl:self-start xl:overflow-y-auto"
              id={RAPID_REVIEW_DETAIL_ID}
            >
              <div>
                <p className="text-xs uppercase tracking-widest text-foreground-muted">
                  Listing facts
                </p>
                <h2 className="font-semibold" id={RAPID_REVIEW_DETAIL_TITLE_ID}>
                  {activeJob.title}
                </h2>
                <p>
                  {activeJob.company} · {activeJob.location} ·{" "}
                  {activeJob.workMode}
                </p>
                <p className="text-sm text-foreground-soft">
                  {activeJob.salaryText ?? "Compensation not listed"}
                  {activeJobDate
                    ? ` · ${activeJobDate.label} ${activeJobDate.value}`
                    : ""}
                </p>
              </div>
              <div className="grid gap-2 border-t border-border pt-3">
                <p className="text-xs uppercase tracking-widest text-foreground-muted">
                  Model assessment — review, not fact
                </p>
                <p className="font-semibold">
                  {getMatchAssessmentPresentation(activeJob).headlineScoreLabel}{" "}
                  ·{" "}
                  {formatRecommendation(
                    activeJob.matchAssessment.recommendation,
                  )}
                </p>
                <p>
                  {joinUniqueSentences([
                    activeJob.matchAssessment.recommendationRationale ?? "",
                  ])}
                </p>
                <p>
                  <strong>Strongest reason:</strong>{" "}
                  {activeJob.matchAssessment.reasons[0] ??
                    "No supporting reason recorded."}
                </p>
                <p>
                  <strong>Hard conflicts:</strong>{" "}
                  {activeJob.matchAssessment.requirements
                    .filter(
                      (item) =>
                        item.importance === "required" &&
                        item.status === "conflict",
                    )
                    .map((item) => item.label)
                    .join(", ") || "None recorded"}
                </p>
                <p>
                  <strong>Missing evidence:</strong>{" "}
                  {activeJob.matchAssessment.gaps.join(", ") || "None recorded"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                <Button
                  pending={props.pending}
                  onClick={() => void decide([activeJob.id], "shortlist")}
                  type="button"
                >
                  Shortlist and next
                </Button>
                <Button
                  pending={props.pending}
                  onClick={() => void decide([activeJob.id], "reject")}
                  type="button"
                  variant="outline"
                >
                  Reject and next
                </Button>
                <Button
                  onClick={() => props.onInspectJob(activeJob.id)}
                  type="button"
                  variant="secondary"
                >
                  Inspect details
                </Button>
              </div>
            </article>
          ) : null}
        </div>
      )}

      {comparedJobs.length >= 2 ? (
        <section
          aria-label="Job comparison"
          className="overflow-x-auto border border-border p-3"
        >
          <h2 className="mb-2 font-semibold">Compare selected jobs</h2>
          <div className="grid min-w-[42rem] grid-cols-2 gap-2 lg:grid-cols-4">
            {comparedJobs.map((job) => (
              <article className="border border-border p-3" key={job.id}>
                <h3 className="font-semibold">{job.title}</h3>
                <p className="text-sm">{job.company}</p>
                <p className="text-sm">
                  {job.location} · {job.workMode}
                </p>
                <p className="text-sm">{job.salaryText ?? "Pay unknown"}</p>
                <p className="mt-2 font-semibold">
                  {getMatchAssessmentPresentation(job).headlineScoreLabel}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {selectedIds.size > 0 ? (
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 border border-primary/40 bg-background p-3 shadow-lg">
          <p>
            {selectedIds.size} selected. Bulk actions only change local review
            decisions.
          </p>
          <div className="flex gap-2">
            <Button
              pending={props.pending}
              onClick={() => void decide([...selectedIds], "shortlist")}
              type="button"
            >
              Shortlist selected
            </Button>
            <Button
              pending={props.pending}
              onClick={() => void decide([...selectedIds], "reject")}
              type="button"
              variant="outline"
            >
              Reject selected
            </Button>
            <Button
              onClick={() => setSelectedIds(new Set())}
              type="button"
              variant="ghost"
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
