import {
  JobSearchSettingsSchema,
  PICKY_MIN_FIT,
  type JobFilterInput,
  type JobRow,
  type JobSearchSettings,
  type JobSort,
  type TriageStage,
} from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { emptyFitReason, useEmptyFitSummary } from "./empty-fit";

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
  ListRowSkeleton,
  NO_SELECTION,
  STAGE_LABEL,
  clearSelected,
  isSelecting,
  isStackedLayout,
  plural,
  stepSelectAll,
  toSelectionInput,
  toggleSelection,
  useJobList,
  useListKeys,
  useSelectAllCount,
  type ListSelection,
  CountFigure,
  countWords,
  besideList,
} from "@renderer/features/job-lists";

import { takeFirstSearchRequest } from "./first-search";
import {
  FIND_JOBS_FILTER_SELECTOR,
  FindJobsRow,
  FindJobsToolbar,
  describeFloor,
} from "./find-jobs-list";
import { JobDetailPane } from "./job-detail-pane";
import { SearchPanel, SearchStatus } from "./search-panel";
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
  activeId: number | null;
} = {
  stage: "found",
  sortByStage: { found: "best_fit", shortlisted: "recent", hidden: "recent" },
  text: "",
  activeId: null,
};

/**
 * The fit floor the person chose ("Any fit" is null), kept across restarts.
 * Untouched, the floor follows the last search's pickiness; a search with
 * another pickiness puts it back to that.
 */
interface FloorChoice {
  fitFloor: number | null;
  floorTouched: boolean;
}
const FLOOR_KEY = "nestor.find-jobs.fit-floor";

function readFloor(): FloorChoice {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(FLOOR_KEY) ?? "null",
    ) as Partial<FloorChoice> | null;
    if (
      typeof saved?.floorTouched === "boolean" &&
      (saved.fitFloor === null || typeof saved.fitFloor === "number")
    )
      return { fitFloor: saved.fitFloor, floorTouched: saved.floorTouched };
  } catch {
    // An unreadable choice falls back to the search's own floor.
  }
  return { fitFloor: null, floorTouched: false };
}

/** The pickiness a fit floor stands for; null for a floor of its own. */
function pickyForFloor(
  floor: number | null,
): JobSearchSettings["picky"] | null {
  for (const [picky, min] of Object.entries(PICKY_MIN_FIT))
    if (min === floor) return picky as JobSearchSettings["picky"];
  return null;
}

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
  const navigate = useNavigate();
  const { showToast } = useToast();
  const status = useSearchStatus();
  const [stage, setStage] = useState<TriageStage>(remembered.stage);
  const [sortByStage, setSortByStage] = useState(remembered.sortByStage);
  const [text, setText] = useState(remembered.text);
  const lastPicky = status.search?.settings.picky ?? "balanced";
  const [{ fitFloor, floorTouched }, setFloorChoice] =
    useState<FloorChoice>(readFloor);
  // Before any search there is no fit to filter by: the list starts on Any
  // fit, so a first search that finds only stretch jobs still shows them.
  const floor = floorTouched
    ? fitFloor
    : status.loaded && status.search === null
      ? null
      : PICKY_MIN_FIT[lastPicky];
  const chooseFloor = useCallback((fitFloor: number | null) => {
    setFloorChoice({ fitFloor, floorTouched: true });
  }, []);
  const lastPickyRef = useRef(lastPicky);
  lastPickyRef.current = lastPicky;
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [activeId, setActiveId] = useState(remembered.activeId);
  // Stacked (beside a docked assistant on a narrow window), the details
  // open as a sheet over the list when the person opens a row.
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const [searchParams] = useSearchParams();
  const navigationKey = useLocation().key;

  const linkedJob = Number(searchParams.get("job") ?? "");
  const [starting, setStarting] = useState(false);
  // Sites turned on in Profile, once the search card has read them.
  const [siteTotal, setSiteTotal] = useState<number | null>(null);
  // The screen's width decides where the search's status line goes: in the
  // card under its choices (narrow), or beside the tabs (from the card's
  // one-row width, 48rem).
  const [screenWidth, setScreenWidth] = useState(0);
  const screenObserver = useRef<ResizeObserver | null>(null);
  const screenRef = useCallback((node: HTMLDivElement | null) => {
    screenObserver.current?.disconnect();
    screenObserver.current = null;
    if (!node) return;
    setScreenWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    screenObserver.current = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setScreenWidth(width);
    });
    screenObserver.current.observe(node);
  }, []);
  const statusBesideTabs = screenWidth >= 768;
  const [searchError, setSearchError] = useState<string | null>(null);
  const undoStack = rememberedMoves;

  const sort = sortByStage[stage];
  const filter: JobFilterInput = {
    stage,
    text,
    minFit: stage === "found" ? floor : null,
  };
  const list = useJobList({ ...filter, sort });
  const {
    selectedCount,
    counting,
    total: matching,
    totalCapped,
  } = useSelectAllCount({
    // A running search moves the count; read it again as the tab grows.
    key: JSON.stringify([filter, list.counts[stage]]),
    selection,
    total: list.total,
    totalCapped: list.totalCapped,
    count: () =>
      window.nestor.jobs
        .run("count_jobs", filter)
        .then((result) => result.total),
  });
  const prioritizeVisible = useCallback(
    (rows: readonly JobRow[]) => {
      if (stage === "found" && rows.length) {
        void window.nestor.jobs
          .run("prioritize_fit", {
            ids: rows.slice(0, 200).map((row) => row.id),
          })
          .catch(() => undefined);
      }
    },
    [stage],
  );
  const actions = TRIAGE_ACTIONS[stage];

  // A job asked for by link stays open even when it is not on the first page.
  const pinnedId = useRef<number | null>(remembered.activeId);

  // A new list starts with nothing ticked (still in select mode, if it was)
  // and its first job open.
  useEffect(() => {
    setSelection(clearSelected);
    setActiveId(pinnedId.current);
    setSheetOpen(pinnedId.current !== null);
    pinnedId.current = null;
  }, [stage, text, floor]);
  // When the open job leaves this tab from outside the screen (the Assistant
  // moved it, or another window did), the one after it opens, or nothing when
  // the tab is empty, as a move on this screen does. A linked job that isn't
  // among the loaded rows stays open.
  const shownRows = useRef<readonly JobRow[]>([]);
  useEffect(() => {
    const before = shownRows.current;
    shownRows.current = list.rows;
    if (list.loading) return;
    if (activeId === null) {
      setActiveId(list.rows[0]?.id ?? null);
      return;
    }
    const at = before.findIndex((row) => row.id === activeId);
    if (at < 0 || list.rows.some((row) => row.id === activeId)) return;
    const still = new Set(list.rows.map((row) => row.id));
    const next =
      before.slice(at + 1).find((row) => still.has(row.id)) ??
      list.rows[Math.min(at, list.rows.length - 1)];
    setActiveId(next?.id ?? null);
  }, [activeId, list.loading, list.rows]);
  useAssistantListView(searchParams.get("jobs"), {
    requestId: navigationKey,
    setSelection,
    current: { stage, text, minFit: floor, sort: sortByStage[stage] },
    applyView(view) {
      const nextStage = view.stage ?? stage;
      if (!TABS.includes(nextStage as TriageStage)) return false;
      const targetStage = nextStage as TriageStage;
      const changed =
        targetStage !== stage ||
        (view.text !== undefined && view.text !== text) ||
        (view.minFit !== undefined && view.minFit !== floor);
      setStage(targetStage);
      if (view.text !== undefined) setText(view.text);
      if (view.minFit !== undefined) chooseFloor(view.minFit);
      if (view.sort)
        setSortByStage((current) => ({
          ...current,
          [targetStage]: view.sort!,
        }));
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
    remembered = { stage, sortByStage, text, activeId };
  }, [activeId, sortByStage, stage, text]);
  useEffect(() => {
    window.localStorage.setItem(
      FLOOR_KEY,
      JSON.stringify({ fitFloor, floorTouched }),
    );
  }, [fitFloor, floorTouched]);

  const latest = useRef({ list, selection, activeId, filter, stage });
  latest.current = { list, selection, activeId, filter, stage };
  useAssistantContextSource("find-jobs", () => {
    const { list, selection, activeId, filter } = latest.current;
    return {
      screen: "discovery",
      focus:
        activeId === null
          ? null
          : {
              kind: "job",
              id: String(activeId),
              label:
                list.rows.find((row) => row.id === activeId)?.title ?? null,
            },
      list: {
        listKind: "jobs",
        selectedIds: selection.all ? [] : [...selection.ids].map(String),
        displayedIds: list.rows.map((row) => String(row.id)),
        filteredIds: [],
        totalFilteredCount: list.total,
        filterSummary: JSON.stringify({
          ...filter,
          allSelected: selection.all,
          except: selection.all ? [...selection.ids] : [],
        }),
        campaignId: null,
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
          ...(result.moved > 0 ? { tone: "success" as const } : {}),
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
      // A move that empties a filtered list takes the filter away too, so
      // the person is not left on "No jobs match" with jobs still waiting.
      if (
        (latest.current.filter.text ?? "").trim() !== "" &&
        !list.rows.some((row) => !moved(row.id)) &&
        list.nextCursor === null
      )
        setText("");
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
          tone: "success",
          action: { label: "Undo", onClick: () => void undo(entry) },
        });
      } catch (error) {
        showToast({ title: describe(error), tone: "warning" });
        void list.refresh();
      }
    },
    [showToast, undo],
  );

  // The list's fit floor is the one fit control on this screen; a search
  // records it as how picky it was, so the two can never disagree.
  const floorRef = useRef(floor);
  floorRef.current = floor;
  const startSearch = useCallback(async (chosen: JobSearchSettings) => {
    const settings: JobSearchSettings = {
      ...chosen,
      picky: pickyForFloor(floorRef.current) ?? chosen.picky,
    };
    setStarting(true);
    setSearchError(null);
    try {
      await window.nestor.jobs.run("start_search", settings);
      setStage("found");
      // A search that changes how picky it is brings its own fit floor.
      if (settings.picky !== lastPickyRef.current)
        setFloorChoice({ fitFloor: null, floorTouched: false });
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

  const activate = useCallback((id: number) => {
    setActiveId(id);
    // Only a stacked layout covers the list with the details, and a press in
    // select mode ticks rows instead.
    if (!isSelecting(latest.current.selection) && isStackedLayout())
      setSheetOpen(true);
  }, []);
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
    selectAll: () =>
      setSelection((current) =>
        stepSelectAll(
          current,
          latest.current.list.rows,
          latest.current.list.nextCursor === null &&
            !latest.current.list.totalCapped &&
            latest.current.list.rows.length >= latest.current.list.total,
        ),
      ),
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
  const running = status.search?.state === "running";
  // A first search with nothing found yet: rows are on their way, so the
  // list shows skeleton rows rather than an empty message.
  const firstRowsComing = stage === "found" && running && counts.found === 0;
  const tabOptions: SegmentedControlOption<TriageStage>[] = TABS.map((tab) => {
    // "Found 0" is not true while a first search brings rows in: the count
    // is not known yet, and says so with the same "–" as an unread count.
    const known = list.countsKnown && !(tab === "found" && firstRowsComing);
    return {
      value: tab,
      label: (
        <span className="flex items-center gap-1.5">
          {STAGE_LABEL[tab]}
          <CountFigure
            className="text-foreground-muted"
            count={counts[tab]}
            known={known}
            slot={`find-jobs:${tab}`}
          />
        </span>
      ),
      ariaLabel: `${STAGE_LABEL[tab]}, ${countWords(counts[tab], known)}`,
    };
  });

  const emptyFit =
    stage === "found" &&
    floor !== null &&
    !text.trim() &&
    !list.loading &&
    list.total === 0 &&
    counts.found > 0;
  const fitSummary = useEmptyFitSummary(emptyFit, floor, list.rows);
  const fitReason = emptyFitReason(fitSummary, floor);
  const filtered = text.trim() !== "" || (stage === "found" && floor !== null);
  // Jobs that left Found (here, in the chat or on another screen) mean the
  // search has run; "No jobs yet" is only true when no stage has any.
  const sortedJobs =
    counts.shortlisted + counts.hidden + counts.resume + counts.applied;
  // Before any job was found there is no job to pick: the list (its one
  // explanation and action) takes the width, with no "Pick a job" pane.
  const noJobsYet =
    stage === "found" &&
    list.countsKnown &&
    !list.loading &&
    counts.found === 0 &&
    sortedJobs === 0 &&
    !running &&
    !text.trim();
  const emptyMessage =
    stage === "found" && counts.found === 0
      ? (status.progress?.failed ?? 0) > 0 ||
        (status.search?.state === "failed" && !status.progress?.needsYou)
        ? [
            "Some sites could not be read",
            "Open What each site found above to see why, fix their URLs or search again.",
          ]
        : (status.progress?.needsYou ?? 0) > 0
          ? [
              "Some sites need you",
              "Open Needs you to sign in, then retry those sites.",
            ]
          : sortedJobs > 0
            ? ["All caught up", "Every found job is shortlisted or hidden."]
            : siteTotal === 0
              ? [
                  "Add a job site first",
                  "Searches read the job sites you add in Profile. Press Add a job site above, then search it here.",
                ]
              : ["No jobs yet", "Pick how to search above and press Search."]
      : filtered && list.total === 0
        ? [
            text.trim() === "" && stage === "found" && floor !== null
              ? `No found jobs at ${describeFloor(floor).toLowerCase()} or better`
              : `No ${STAGE_LABEL[stage].toLowerCase()} jobs match “${text.trim()}”`,
            emptyFit ? fitReason.detail : null,
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
        {emptyFit && fitReason.eligibility ? (
          <Button
            onClick={() => {
              void navigate(
                "/job-finder/profile?section=preferences&focus=work-eligibility",
              );
            }}
            size="sm"
            type="button"
          >
            Check where you can work
          </Button>
        ) : null}
        {text.trim() !== "" && list.total === 0 ? (
          <Button
            onClick={() => setText("")}
            size="sm"
            type="button"
            variant="outline"
          >
            Clear filter
          </Button>
        ) : filtered && list.total === 0 && counts[stage] > 0 ? (
          <Button
            onClick={() => chooseFloor(null)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show all {counts[stage].toLocaleString()}
          </Button>
        ) : null}
      </div>
    </div>
  );

  // The list's scope in plain words, on the row under its tools:
  // "5 of 11 jobs · 6 below good fit · Show all".
  const unscoredNow =
    text.trim() || totalCapped || list.belowFloorCapped
      ? 0
      : Math.max(0, counts.found - matching - (list.belowFloor ?? 0));
  // Hide takes a scored job out of the list at once, before the stage counts
  // catch up: for a moment "found" still counts it and the difference read
  // as one more job "not scored yet". With the same number found, the jobs
  // waiting for a score never grow (new jobs change "found"), so the line
  // keeps its last set of numbers, all of them together ("14 of 27 · 9
  // below · 4 not scored", never "13 of 27 · 9 below · 4" adding to 26),
  // until the counts agree again.
  const nowScope = {
    matching,
    found: counts.found,
    below: list.belowFloor ?? 0,
    unscored: unscoredNow,
  };
  const scopeSeen = useRef(nowScope);
  const scope =
    scopeSeen.current.found === counts.found &&
    unscoredNow > scopeSeen.current.unscored
      ? scopeSeen.current
      : nowScope;
  useEffect(() => {
    scopeSeen.current = scope;
  });
  const unscored = scope.unscored;
  const matchingText = `${scope.matching.toLocaleString()}${totalCapped ? "+" : ""}`;
  const floorScope =
    stage === "found" && floor !== null
      ? {
          below: scope.below,
          belowText: `${scope.below.toLocaleString()}${list.belowFloorCapped ? "+" : ""}`,
          // "of all found" only without a text filter, which counts apart.
          ofAll: !text.trim() && scope.found > scope.matching,
          unscored,
        }
      : null;
  const checkingFit = (status.fitChecking ?? 0) - (status.fitRechecking ?? 0);
  const recheckingFit = status.fitRechecking ?? 0;
  const scopeText = floorScope?.ofAll
    ? `${matchingText} of ${scope.found.toLocaleString()} jobs`
    : `${matchingText} ${scope.matching === 1 ? "job" : "jobs"}`;
  const belowText =
    floorScope && floorScope.below > 0 && floor !== null
      ? ` · ${floorScope.belowText} below ${describeFloor(floor).toLowerCase()}`
      : "";
  const summary = (
    <span className="tabular-nums" data-list-scope>
      {floorScope && floorScope.unscored > 0 ? (
        <>
          <span className="hidden @lg/listbar:inline">
            {`${scopeText}${belowText} · ${floorScope.unscored.toLocaleString()} not scored yet`}
          </span>
          {/* A narrow list says every part in short, so the parts still add
              up to the total ("14 of 27 · 9 below · 4 unscored"). */}
          <span className="@lg/listbar:hidden">
            {`${floorScope.ofAll ? `${matchingText} of ${scope.found.toLocaleString()}` : scopeText}${
              floorScope.below > 0 && floor !== null
                ? ` · ${floorScope.belowText} below`
                : ""
            } · ${floorScope.unscored.toLocaleString()} unscored`}
          </span>
        </>
      ) : (
        `${scopeText}${belowText}`
      )}
      {floorScope && (floorScope.ofAll || floorScope.below > 0) ? (
        <>
          {" · "}
          <button
            // A link in a 20px line: its own box is 24px tall (2px above
            // and below the text), and the negative margin keeps the line
            // at 20px; the summary line's padding keeps the box unclipped.
            className="inline-block -my-0.5 rounded-(--radius-small) py-0.5 font-medium text-(--link) underline underline-offset-2 outline-none hover:text-(--link-hover) focus-ring"
            onClick={() => chooseFloor(null)}
            type="button"
          >
            Show all
          </button>
        </>
      ) : null}
      {recheckingFit > 0 ? (
        <span role="status">
          {` · Re-checking fit for ${plural(recheckingFit, "job")}`}
        </span>
      ) : checkingFit > 0 ? (
        <span role="status">
          {` · Checking fit for ${checkingFit.toLocaleString()} more…`}
        </span>
      ) : null}
    </span>
  );
  const countText = `${selectedCount.toLocaleString()}${totalCapped && selection.all ? "+" : ""}`;

  return (
    <div
      // The same stable scrollbar lane as every other route, so the page's
      // right edge does not jump between routes.
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pt-3 [scrollbar-gutter:stable]"
      ref={screenRef}
    >
      <PageHeader
        description="Search your job sites, then shortlist the jobs worth a resume."
        title="Find jobs"
      />
      <SearchPanel
        error={searchError}
        onStart={(settings) => void startSearch(settings)}
        onSiteTotal={setSiteTotal}
        onStop={() => void window.nestor.jobs.run("stop_search", {})}
        siteTotal={siteTotal}
        starting={starting}
        status={status}
        statusApart={statusBesideTabs}
      />
      {/* Wide, the search's status line sits beside the tabs, in the room
          they leave, so the search card is one row and the list gets the
          height of a row more. */}
      <div className="flex min-w-0 items-end gap-4">
        <SegmentedControl
          className="shrink-0"
          label="Which jobs"
          variant="tabs"
          onValueChange={(value) => setStage(value)}
          options={tabOptions}
          value={stage}
        />
        {statusBesideTabs ? (
          <SearchStatus
            className="mb-0.5 flex-1"
            error={searchError}
            noSites={siteTotal === 0}
            status={status}
          />
        ) : null}
      </div>
      <ListDetailLayout
        {...(noJobsYet
          ? { columnsClassName: "split:grid-cols-[minmax(0,1fr)]" }
          : {})}
        sheet={{ open: sheetOpen && activeId !== null, onClose: closeSheet }}
        state={{
          stage,
          text,
          minFit: floor,
          sort,
          selectedIds: [...selection.ids],
          all: selection.all,
        }}
        detail={
          noJobsYet ? null : (
            <JobDetailPane
              actions={actions}
              jobId={activeId}
              bulkActive={selectedCount > 0}
              list={besideList(list)}
              listLoading={list.loading || firstRowsComing}
              onBack={closeSheet}
              onMove={(to) => {
                const action = actions.find((a) => a.to === to);
                if (action) void move(action, true);
              }}
              stage={stage}
            />
          )
        }
        list={
          <ListPane
            onVisibleRows={prioritizeVisible}
            activeId={activeId}
            counting={counting}
            bulkActions={actions.map((action, index) => (
              <Button
                aria-label={
                  counting
                    ? undefined
                    : `${action.bulk(countText)} ${selectedCount === 1 ? "job" : "jobs"}`
                }
                disabled={counting}
                key={action.to}
                onClick={() => void move(action)}
                size="toolbar"
                title={`${action.verb} · ${action.key.toUpperCase()}`}
                type="button"
                variant={index === 0 ? "primary" : "outline"}
              >
                {/* Named by scope, so it never reads as the open job's own
                    move: "Shortlist 3", not a second "Shortlist". */}
                {counting ? action.verb : action.bulk(countText)}
              </Button>
            ))}
            empty={empty}
            fillStacked
            hasMore={list.nextCursor !== null}
            label={`${STAGE_LABEL[stage]} jobs`}
            loading={list.loading}
            error={list.error}
            onRetry={() => void list.refresh()}
            onLoadMore={() => void list.loadMore()}
            onSelectionChange={setSelection}
            pending={firstRowsComing}
            renderSkeletonRow={(index) => (
              <ListRowSkeleton index={index} lines={2} />
            )}
            renderRow={(row, state) => (
              <FindJobsRow
                {...state}
                onActivate={activate}
                onToggle={toggle}
                row={row}
              />
            )}
            rows={list.rows}
            selectedCount={selectedCount}
            selection={selection}
            summary={summary}
            toolbar={
              // No job in this tab at all (a first run, an empty Hidden):
              // nothing to filter, sort or set a fit for, so no controls
              // over the empty message. A filter typed earlier keeps its
              // field so it can be cleared.
              list.countsKnown && counts[stage] === 0 && !text.trim() ? null : (
                <FindJobsToolbar
                  fitFloor={stage === "found" ? { floor } : null}
                  onSort={(next) =>
                    setSortByStage((current) => ({ ...current, [stage]: next }))
                  }
                  onFloor={chooseFloor}
                  onText={setText}
                  sort={sort}
                  sorts={SORTS[stage]}
                  text={text}
                />
              )
            }
            total={matching}
            totalCapped={totalCapped}
            windowed
          />
        }
      />
    </div>
  );
}
