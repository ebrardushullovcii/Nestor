import {
  JobSearchSettingsSchema,
  PICKY_MIN_FIT,
  type JobFilterInput,
  type JobSearchSettings,
  type JobSort,
  type TriageStage,
} from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import {
  ListDetailLayout,
  ListPane,
  NO_SELECTION,
  STAGE_LABEL,
  countSelected,
  plural,
  selectAll,
  toSelectionInput,
  toggleSelection,
  useJobList,
  useListKeys,
  type ListSelection,
} from "@renderer/features/job-lists";

import { takeFirstSearchRequest } from "./first-search";
import {
  FIND_JOBS_FILTER_SELECTOR,
  FindJobsRow,
  FindJobsToolbar,
} from "./find-jobs-list";
import { JobDetailPane } from "./job-detail-pane";
import { SearchPanel } from "./search-panel";
import { TRIAGE_ACTIONS, type TriageAction } from "./triage-actions";
import { useSearchStatus } from "./use-search-status";
import { useAssistantListView } from "../job-lists/use-assistant-list-view";
import { useAssistantContextSource } from "../job-finder/assistant/assistant-provider";

const TABS: readonly TriageStage[] = ["found", "shortlisted", "hidden"];
const SORTS: Record<TriageStage, readonly JobSort[]> = {
  found: ["best_fit", "newest", "posted"],
  shortlisted: ["recent", "best_fit", "posted"],
  hidden: ["recent", "best_fit", "newest"],
};

function describe(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (Error: )?/u,
        "",
      )
    : "Something went wrong.";
}

/**
 * What the person was looking at. The screen is drawn once before the rest
 * of Job Finder loads and again inside it; this carries their place across.
 */
let remembered: {
  stage: TriageStage;
  sortByStage: Record<TriageStage, JobSort>;
  text: string;
  fitFloor: number | null;
  floorTouched: boolean;
  activeId: number | null;
} = {
  stage: "found",
  sortByStage: { found: "best_fit", shortlisted: "recent", hidden: "recent" },
  text: "",
  fitFloor: null,
  floorTouched: false,
  activeId: null,
};

/** Recent moves for Undo, kept across the same remount. */
const rememberedMoves: { current: { moveId: number; label: string }[] } = {
  current: [],
};

/**
 * Find jobs: choose a few things, search, and triage what comes in. Jobs
 * appear as a search finds them; shortlist, hide or move them back with a
 * click or a key, one at a time or all at once, and Undo any move.
 */
export function FindJobsScreen() {
  const { showToast } = useToast();
  const status = useSearchStatus();
  const [stage, setStage] = useState<TriageStage>(remembered.stage);
  const [sortByStage, setSortByStage] = useState(remembered.sortByStage);
  const [text, setText] = useState(remembered.text);
  const lastPicky = status.search?.settings.picky ?? "balanced";
  const [fitFloor, setFitFloor] = useState(remembered.fitFloor);
  const [floorTouched, setFloorTouched] = useState(remembered.floorTouched);
  const floor = floorTouched ? fitFloor : PICKY_MIN_FIT[lastPicky];
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [activeId, setActiveId] = useState(remembered.activeId);
  const [searchParams] = useSearchParams();
  const navigationKey = useLocation().key;

  const linkedJob = Number(searchParams.get("job") ?? "");
  const [starting, setStarting] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const undoStack = rememberedMoves;

  const sort = sortByStage[stage];
  const filter: JobFilterInput = {
    stage,
    text,
    minFit: stage === "found" ? floor : null,
  };
  const list = useJobList({ ...filter, sort });
  const selectedCount = countSelected(selection, list.total);
  const actions = TRIAGE_ACTIONS[stage];

  // A job asked for by link stays open even when it is not on the first page.
  const pinnedId = useRef<number | null>(remembered.activeId);

  // A new list starts with nothing ticked and its first job open.
  useEffect(() => {
    setSelection(NO_SELECTION);
    setActiveId(pinnedId.current);
    pinnedId.current = null;
  }, [stage, text, floor]);
  useEffect(() => {
    if (activeId === null && !list.loading)
      setActiveId(list.rows[0]?.id ?? null);
  }, [activeId, list.loading, list.rows]);
  useAssistantListView(searchParams.get("jobs"), {
    requestId: navigationKey,
    setSelection,
    current: { stage, text, minFit: floor, sort: sortByStage[stage] },
    applyView(view) {
      const nextStage = view.stage ?? stage;
      if (!TABS.includes(nextStage as TriageStage)) return false;
      const targetStage = nextStage as TriageStage;
      const changed = targetStage !== stage || (view.text !== undefined && view.text !== text) || (view.minFit !== undefined && view.minFit !== floor);
      setStage(targetStage);
      if (view.text !== undefined) setText(view.text);
      if (view.minFit !== undefined) { setFitFloor(view.minFit); setFloorTouched(true); }
      if (view.sort) setSortByStage((current) => ({ ...current, [targetStage]: view.sort! }));
      return changed;
    },
  });


  // `?job=<id>` opens that job in its tab, so a link or the Assistant can
  // point at one job.
  useEffect(() => {
    if (!Number.isInteger(linkedJob) || linkedJob <= 0) return;
    void window.nestor.jobs.run("get_job", { id: linkedJob }).then((job) => {
      if (!job) return;
      pinnedId.current = job.id;
      setActiveId(job.id);
      if (TABS.includes(job.stage as TriageStage))
        setStage(job.stage as TriageStage);
      setText("");
    });
  }, [linkedJob, navigationKey]);

  useEffect(() => {
    remembered = { stage, sortByStage, text, fitFloor, floorTouched, activeId };
  }, [activeId, fitFloor, floorTouched, sortByStage, stage, text]);

  const latest = useRef({ list, selection, activeId, filter, stage });
  latest.current = { list, selection, activeId, filter, stage };
  useAssistantContextSource("find-jobs", () => {
    const { list, selection, activeId, filter } = latest.current;
    return {
      screen: "discovery",
      focus: activeId === null ? null : { kind: "job", id: String(activeId), label: list.rows.find((row) => row.id === activeId)?.title ?? null },
      list: {
        listKind: "jobs", selectedIds: selection.all ? [] : [...selection.ids].map(String),
        displayedIds: list.rows.map((row) => String(row.id)), filteredIds: [],
        totalFilteredCount: list.total, filterSummary: JSON.stringify({ ...filter, allSelected: selection.all, except: selection.all ? [...selection.ids] : [] }), campaignId: null,
      },
    };
  });

  const undo = useCallback(
    async (entry?: { moveId: number; label: string }) => {
      const target = entry ?? undoStack.current.pop();
      if (!target) {
        showToast({ id: "find-jobs-undo", title: "Nothing to undo" });
        return;
      }
      undoStack.current = undoStack.current.filter(
        (item) => item.moveId !== target.moveId,
      );
      try {
        const result = await window.nestor.jobs.run("undo_move", {
          moveId: target.moveId,
        });
        showToast({
          id: "find-jobs-move",
          title:
            result.moved > 0
              ? `Put ${plural(result.moved, "job")} back`
              : "Those jobs had already moved",
        });
      } catch (error) {
        showToast({ title: describe(error), tone: "warning" });
      }
      void latest.current.list.refresh();
    },
    [showToast],
  );

  const move = useCallback(
    async (action: TriageAction, onlyActive = false) => {
      const { list, selection, activeId, filter } = latest.current;
      const ticked = onlyActive ? null : toSelectionInput(selection, filter);
      const input = ticked ?? (activeId !== null ? { ids: [activeId] } : null);
      if (!input) return;
      const moved =
        "filter" in input
          ? (id: number) => !(input.except ?? []).includes(id)
          : (id: number) => input.ids.includes(id);
      // The next job to open is the first one after the last that leaves.
      const rows = list.rows;
      const lastIndex = rows.reduce(
        (found, row, index) => (moved(row.id) ? index : found),
        -1,
      );
      const next =
        rows.slice(lastIndex + 1).find((row) => !moved(row.id)) ??
        [...rows].reverse().find((row) => !moved(row.id));
      list.removeRows(moved);
      setActiveId(next?.id ?? null);
      if (ticked) setSelection(NO_SELECTION);
      try {
        const result = await window.nestor.jobs.run("move_jobs", {
          selection: input,
          to: action.to,
        });
        if (result.moveId === null) {
          void list.refresh();
          return;
        }
        const entry = {
          moveId: result.moveId,
          label: `${action.done} ${plural(result.moved, "job")}`,
        };
        undoStack.current = [...undoStack.current.slice(-19), entry];
        showToast({
          id: "find-jobs-move",
          title: entry.label,
          action: { label: "Undo", onClick: () => void undo(entry) },
        });
      } catch (error) {
        showToast({ title: describe(error), tone: "warning" });
        void list.refresh();
      }
    },
    [showToast, undo],
  );

  const startSearch = useCallback(async (settings: JobSearchSettings) => {
    setStarting(true);
    setSearchError(null);
    try {
      await window.nestor.jobs.run("start_search", settings);
      setStage("found");
      setFloorTouched(false);
    } catch (error) {
      setSearchError(describe(error));
    } finally {
      setStarting(false);
    }
  }, []);

  // Finishing guided setup starts the first search, if none has run.
  useEffect(() => {
    if (status.loaded && takeFirstSearchRequest() && status.search === null)
      void startSearch(JobSearchSettingsSchema.parse({}));
  }, [startSearch, status.loaded, status.search]);

  const activate = useCallback((id: number) => setActiveId(id), []);
  const toggle = useCallback((id: number, shiftKey: boolean) => {
    setSelection((current) =>
      toggleSelection(current, id, shiftKey, latest.current.list.rows),
    );
  }, []);

  useListKeys({
    rows: list.rows,
    activeId,
    setActiveId,
    toggle,
    selectAll: () => setSelection(selectAll()),
    clearSelection: () => setSelection(NO_SELECTION),
    undo: () => void undo(),
    open: (id) =>
      void window.nestor.jobs.run("get_job", { id }).then((job) => {
        if (job) openUrlInJobFinderBrowser(job.url);
      }),
    actions: Object.fromEntries(
      actions.map((action) => [action.key, () => void move(action)]),
    ),
    loadMore: () => void list.loadMore(),
    filterSelector: FIND_JOBS_FILTER_SELECTOR,
  });

  const counts = list.counts;
  const tabOptions: SegmentedControlOption<TriageStage>[] = TABS.map((tab) => ({
    value: tab,
    label: (
      <span className="flex items-center gap-1.5">
        {STAGE_LABEL[tab]}
        <span className="tabular-nums text-foreground-muted">
          {counts[tab].toLocaleString()}
        </span>
      </span>
    ),
    ariaLabel: `${STAGE_LABEL[tab]}, ${counts[tab]}`,
  }));

  const running = status.search?.state === "running";
  const filtered = text.trim() !== "" || (stage === "found" && floor !== null);
  const lastMove = undoStack.current.at(-1) ?? null;
  const emptyMessage =
    stage === "found" && counts.found === 0
      ? running
        ? ["Searching your job sites…", "Jobs show up here as they are found."]
        : lastMove
          ? ["All caught up", "Every found job is shortlisted or hidden."]
          : ["No jobs yet", "Pick how to search above and press Search."]
      : filtered && list.total === 0
        ? [
            text.trim() === "" && stage === "found" && floor !== null
              ? `No jobs at fit ${floor}+ left`
              : `No ${STAGE_LABEL[stage].toLowerCase()} jobs match`,
            null,
          ]
        : [
            stage === "shortlisted" ? "Nothing shortlisted" : "Nothing hidden",
            stage === "shortlisted"
              ? "Press S on a job in Found."
              : "Jobs you hide, and ones a search skipped, show up here.",
          ];
  const empty = (
    <div className="grid justify-items-center gap-3 text-center text-(length:--text-description) text-foreground-soft">
      <p className="font-medium text-foreground">{emptyMessage[0]}</p>
      {emptyMessage[1] ? <p>{emptyMessage[1]}</p> : null}
      <div className="flex flex-wrap justify-center gap-2">
        {filtered && list.total === 0 && counts[stage] > 0 ? (
          <Button
            onClick={() => {
              setText("");
              setFloorTouched(true);
              setFitFloor(null);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Show all{" "}
            {plural(counts[stage], `${STAGE_LABEL[stage].toLowerCase()} job`)}
          </Button>
        ) : null}
        {lastMove ? (
          <Button
            onClick={() => void undo()}
            size="sm"
            title="Undo · U"
            type="button"
            variant="ghost"
          >
            Undo: {lastMove.label.toLowerCase()}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pt-3 xl:overflow-hidden">
      <PageHeader
        description="Search your job sites, then shortlist the jobs worth a resume."
        title="Find jobs"
      />
      <SearchPanel
        error={searchError}
        onStart={(settings) => void startSearch(settings)}
        onStop={() => void window.nestor.jobs.run("stop_search", {})}
        starting={starting}
        status={status}
      />
      <SegmentedControl
        label="Which jobs"
        onValueChange={(value) => setStage(value)}
        options={tabOptions}
        value={stage}
      />
      <ListDetailLayout
        state={{ stage, text, minFit: floor, sort, selectedIds: [...selection.ids], all: selection.all }}
        detail={
          <JobDetailPane
            actions={actions}
            jobId={activeId}
            onMove={(to) => {
              const action = actions.find((a) => a.to === to);
              if (action) void move(action, true);
            }}
            stage={stage}
          />
        }
        list={
          <ListPane
            activeId={activeId}
            bulkActions={
              <>
                {actions.map((action, index) => (
                  <Button
                    key={action.to}
                    onClick={() => void move(action)}
                    size="sm"
                    type="button"
                    variant={index === 0 ? "primary" : "outline"}
                  >
                    {action.label}
                  </Button>
                ))}
                <Button
                  onClick={() => setSelection(NO_SELECTION)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear
                </Button>
              </>
            }
            empty={empty}
            hasMore={list.nextCursor !== null}
            label={`${STAGE_LABEL[stage]} jobs`}
            loading={list.loading}
            onClearSelection={() => setSelection(NO_SELECTION)}
            onLoadMore={() => void list.loadMore()}
            onSelectAll={() => setSelection(selectAll())}
            renderRow={(row, state) => (
              <FindJobsRow
                onActivate={activate}
                onToggle={toggle}
                row={row}
                state={state}
              />
            )}
            rows={list.rows}
            selectedCount={selectedCount}
            selection={selection}
            toolbar={
              <FindJobsToolbar
                fitFloor={
                  stage === "found"
                    ? {
                        floor,
                        below:
                          floor !== null && !list.totalCapped
                            ? Math.max(0, counts.found - list.total)
                            : null,
                      }
                    : null
                }
                onSort={(next) =>
                  setSortByStage((current) => ({ ...current, [stage]: next }))
                }
                onText={setText}
                onToggleFloor={() => {
                  setFloorTouched(true);
                  setFitFloor(
                    floor === null
                      ? (PICKY_MIN_FIT[lastPicky] ?? PICKY_MIN_FIT.balanced)
                      : null,
                  );
                }}
                sort={sort}
                sorts={SORTS[stage]}
                text={text}
              />
            }
            total={list.total}
            totalCapped={list.totalCapped}
          />
        }
      />
    </div>
  );
}
