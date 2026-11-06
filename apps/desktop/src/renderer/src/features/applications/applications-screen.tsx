import {
  TRACKER_STATUS_LABEL,
  matchesAssistantListView,
  trackerFilterStatusValues,
  type TrackerFilterInput,
  type TrackerFilter,
  type TrackerRow,
  type TrackerSort,
  type TrackerStatus,
  type TrackerStatusCounts,
  type TrackerView,
  type TrackerSelectionInput,
} from "@nestor/contracts";
import {
  FILTER_CHIP_ACTIVE_CLASS,
  FILTER_CHIP_CLASS,
} from "@renderer/components/ui/chip";
import { Download, ListChecks, Save } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { SelectableRow } from "@renderer/components/ui/selectable-row";
import { useToast } from "@renderer/components/ui/toast";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import {
  useDetailSheet,
  clearSelected,
  countSelected,
  isSelected,
  LIST_DETAIL_REGION_ID,
  LIST_ROW_SELECT_PAD_CLASS,
  ListDetailLayout,
  ListPane,
  ListRowCheck,
  listRowPlacement,
  NO_SELECTION,
  SELECTING,
  plural,
  stepSelectAll,
  toggleSelection,
  useListKeys,
  useRowPress,
  useStoreList,
  type ListRowState,
  type ListSelection,
  CountFigure,
  countText,
  besideList,
} from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";

import { useAssistantContextSource } from "@renderer/features/job-finder/assistant/assistant-provider";
import { ListEmpty } from "@renderer/features/job-lists/list-empty";
import { useStageCounts } from "@renderer/features/job-lists/use-stage-counts";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { useLaunchReads } from "@renderer/features/job-finder/lib/launch-reads";
import { useAssistantTrackerView } from "@renderer/features/job-lists/use-assistant-list-view";

import {
  ApplicationDetail,
  useSetStatus,
  useTrackerChangeToast,
} from "./application-detail";
import { ApplicationsBoard, BoardDetailSheet } from "./applications-board";
import {
  countGroup,
  describeSince,
  shownGroups,
  describeDue,
  describeNext,
  describeStatus,
  formatDay,
  OPEN_STATUSES,
  STAGE_GROUPS,
} from "./tracker-format";
import { describeError } from "./use-application";
import { savedFileToast } from "@renderer/features/job-finder/lib/saved-file-toast";

type Layout = "list" | "board";
type Density = "compact" | "comfortable";
type Column = "status" | "since" | "applied" | "next" | "tags";

const COLUMN_LABEL: Record<Column, string> = {
  status: "Status",
  since: "Since",
  applied: "Applied",
  next: "Next",
  tags: "Tags",
};
const ALL_COLUMNS = Object.keys(COLUMN_LABEL) as Column[];
const PREFS_KEY = "nestor.applications.view";
const QUIET_DAYS = 14;
const FILTER_ID = "applications-filter";

const EMPTY_COUNTS = Object.fromEntries(
  trackerFilterStatusValues.map((status) => [status, 0]),
) as TrackerStatusCounts;

interface Prefs {
  layout: Layout;
  density: Density;
  columns: Column[];
}

function readPrefs(): Prefs {
  const fallback: Prefs = {
    layout: "list",
    density: "compact",
    columns: ALL_COLUMNS,
  };
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(PREFS_KEY) ?? "null",
    ) as Partial<Prefs> | null;
    return { ...fallback, ...saved };
  } catch {
    return fallback;
  }
}

type FilterState = TrackerFilter & { sort: TrackerSort };
const NO_FILTER: FilterState = {
  statuses: [],
  tag: null,
  text: "",
  due: false,
  quietForDays: null,
  sort: "recent",
};

/**
 * Applications: every application from the moment Apply takes it, where it
 * stands, what is next, its replies, interviews, reminders and notes. A list
 * with columns, the details beside it, or a board by stage, a card's details
 * over its right side.
 */
export function ApplicationsScreen() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const setStatus = useSetStatus();
  const showChange = useTrackerChangeToast();
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [activeId, setActiveId] = useState<number | null>(null);
  // On the board, details open only when a card is clicked.
  const [sheetOpen, setSheetOpen] = useState(false);
  // The list view's details, stacked beside a docked assistant, open as a
  // sheet over the list (the board has its own sheet above).
  const listSheet = useDetailSheet();
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [views, setViews] = useState<TrackerView[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [dueCount, setDueCount] = useState(0);
  const [moving, setMoving] = useState(false);
  const query = filter;
  const groupId =
    STAGE_GROUPS.find(
      (group) =>
        group.statuses.length === filter.statuses.length &&
        group.statuses.every((status) => filter.statuses.includes(status)),
    )?.id ?? null;

  const list = useStoreList<TrackerRow, TrackerStatusCounts>({
    key: JSON.stringify(query),
    load: ({ cursor, limit }) =>
      window.nestor.tracker.run("list_applications", {
        ...query,
        cursor,
        limit,
      }),
    emptyCounts: EMPTY_COUNTS,
  });
  const selectedCount = countSelected(selection, list.total);

  useEffect(() => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const loadSide = useCallback(() => {
    void window.nestor.tracker
      .run("list_views", {})
      .then((result) => setViews(result.views));
    void window.nestor.tracker
      .run("list_tags", {})
      .then((result) => setTags(result.tags));
    void window.nestor.tracker
      .run("list_applications", { due: true, limit: 1 })
      .then((page) => setDueCount(page.total));
  }, []);
  useEffect(() => {
    loadSide();
    return window.nestor.jobs.onChange((change) => {
      // Apply's queue and sends move the counts and follow-ups too.
      if (change.cause === "tracker" || change.cause === "application")
        loadSide();
    });
  }, [loadSide]);

  // `?jobId=` opens that application, for links from Home and the Assistant.
  const [searchParams] = useSearchParams();
  const { key: navigationKey } = useLocation();
  const linked = Number(searchParams.get("jobId") ?? "");
  useEffect(() => {
    if (!Number.isInteger(linked) || linked <= 0) return;
    setActiveId(linked);
    setSheetOpen(true);
    listSheet.openIfStacked();
  }, [linked, navigationKey, listSheet.openIfStacked]);

  // A new list starts with nothing ticked (still in select mode, if it
  // was); its first application opens.
  useEffect(() => setSelection(clearSelected), [query]);
  useEffect(() => {
    if (activeId === null && !list.loading)
      setActiveId(list.rows[0]?.id ?? null);
  }, [activeId, list.loading, list.rows]);

  useAssistantTrackerView(searchParams.get("applications"), {
    requestId: navigationKey,
    current: { ...query, ...prefs },
    setSelection,
    applyView(view) {
      setFilter((current) => {
        const next = {
          statuses: view.statuses ?? current.statuses,
          tag: view.tag === undefined ? current.tag : view.tag,
          text: view.text ?? current.text,
          due: view.due ?? current.due,
          quietForDays:
            view.quietForDays === undefined
              ? current.quietForDays
              : view.quietForDays,
          sort: view.sort ?? current.sort,
        };
        return matchesAssistantListView(current, next) ? current : next;
      });
      setPrefs((current) => ({
        layout: view.layout ?? current.layout,
        density: view.density ?? current.density,
        columns: view.columns ?? current.columns,
      }));
    },
  });

  const latest = useRef({ selection, activeId, query, list });
  latest.current = { selection, activeId, query, list };
  useAssistantContextSource("applications", () => {
    const { selection, activeId, query, list } = latest.current;
    const active = list.rows.find((row) => row.id === activeId);
    return {
      screen: "applications",
      focus:
        activeId === null
          ? null
          : {
              kind: "application",
              id: String(activeId),
              label: active ? `${active.title} at ${active.company}` : null,
            },
      list: {
        listKind: "applications",
        selectedIds: list.rows
          .filter((row) => isSelected(selection, row.id))
          .map((row) => String(row.id)),
        displayedIds: list.rows.map((row) => String(row.id)),
        filteredIds: [],
        totalFilteredCount: list.total,
        filterSummary: JSON.stringify({
          ...query,
          allSelected: selection.all,
          except: selection.all ? [...selection.ids] : [],
        }),
        campaignId: null,
      },
    };
  });

  /** The ticked applications on screen, or the open one. */
  const target = useCallback((): TrackerSelectionInput | null => {
    const { selection, activeId, query } = latest.current;
    if (selection.all) {
      const filter = {
        statuses: query.statuses,
        tag: query.tag,
        text: query.text,
        due: query.due,
        quietForDays: query.quietForDays,
      };
      return { filter, except: [...selection.ids] };
    }
    if (selection.ids.size) return { ids: [...selection.ids] };
    return activeId === null ? null : { ids: [activeId] };
  }, []);

  const toggle = useCallback(
    (id: number, shiftKey: boolean) =>
      setSelection((current) =>
        toggleSelection(current, id, shiftKey, latest.current.list.rows),
      ),
    [],
  );

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
    loadMore: () => void list.loadMore(),
    filterSelector: `#${FILTER_ID}`,
  });

  const exportCsv = async () => {
    try {
      const result = await window.nestor.tracker.exportCsv(query);
      showToast(
        result.outputPath
          ? savedFileToast(
              `Exported ${plural(result.rows, "application")}`,
              result.outputPath,
              showToast,
            )
          : { title: "Export cancelled. Nothing was saved." },
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    }
  };

  const saveView = async (name: string) => {
    const { sort, ...filter } = query;
    try {
      const result = await window.nestor.tracker.run("save_view", {
        name,
        filter,
        sort,
      });
      showChange(`Saved the view ${name}`, result);
      setNaming(null);
      loadSide();
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    }
  };

  const applyView = (view: TrackerView) =>
    setFilter({ ...view.filter, sort: view.sort });

  const counts = list.counts;
  const firstStep = useFirstApplicationStep();
  // Every application once: the tracker's statuses (Applying counts only
  // those in flight) plus the ones Apply could not finish.
  const total = trackerFilterStatusValues.reduce(
    (sum, s) => sum + (counts[s] ?? 0),
    0,
  );
  const showColumns = prefs.columns;
  const singleView = views.length === 1 ? (views[0] ?? null) : null;

  // One row at every width: the stage chips where they fit, a compact
  // stage menu where they would wrap, and Save view never on a line alone.
  const filters = (
    <div
      className="@container/filters -m-1 flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto p-1"
      data-application-filters
    >
      <select
        aria-label="Stage"
        // On the board the columns are the stages, so the stage filter is
        // this one compact menu at every width, never a second row of the
        // same stages as chips above the columns.
        className={cn(
          "h-8 shrink-0 rounded-(--radius-field) border border-(--field-border) bg-card px-2 text-(length:--text-small)",
          prefs.layout !== "board" && "@6xl/filters:hidden",
        )}
        onChange={(event) => {
          const group = STAGE_GROUPS.find((g) => g.id === event.target.value);
          setFilter((f) => ({
            ...f,
            statuses: group ? [...group.statuses] : [],
          }));
        }}
        value={groupId ?? ""}
      >
        <option value="">
          All stages ({countText(total, list.countsKnown)})
        </option>
        {shownGroups(counts).map((group) => (
          <option key={group.id} value={group.id}>
            {group.label} (
            {countText(countGroup(counts, group.statuses), list.countsKnown)})
          </option>
        ))}
      </select>
      <div
        aria-label="Which applications"
        className={cn(
          "hidden shrink-0 gap-1",
          prefs.layout !== "board" && "@6xl/filters:flex",
        )}
        role="group"
      >
        <FilterChip
          active={filter.statuses.length === 0}
          count={total}
          countKnown={list.countsKnown}
          label="All"
          onClick={() => setFilter((f) => ({ ...f, statuses: [] }))}
        />
        {shownGroups(counts).map((group) => (
          <FilterChip
            active={groupId === group.id}
            count={countGroup(counts, group.statuses)}
            countKnown={list.countsKnown}
            key={group.id}
            label={group.label}
            onClick={() =>
              setFilter((f) => ({
                ...f,
                statuses: groupId === group.id ? [] : [...group.statuses],
              }))
            }
          />
        ))}
      </div>
      <FilterChip
        active={filter.due}
        label="Follow-ups due"
        onClick={() => setFilter((f) => ({ ...f, due: !f.due }))}
      />
      <FilterChip
        active={filter.quietForDays !== null}
        label={`Quiet ${filter.quietForDays ?? QUIET_DAYS}+ days`}
        onClick={() =>
          setFilter((f) => ({
            ...f,
            quietForDays: f.quietForDays === null ? QUIET_DAYS : null,
          }))
        }
      />
      {tags.length > 0 ? (
        <select
          aria-label="Tag"
          className="h-8 shrink-0 rounded-(--radius-field) border border-(--field-border) bg-card px-2 text-xs"
          onChange={(event) =>
            setFilter((f) => ({ ...f, tag: event.target.value || null }))
          }
          value={filter.tag ?? ""}
        >
          <option value="">Any tag</option>
          {tags.map(({ tag, count }) => (
            <option key={tag} value={tag}>
              {tag} ({count})
            </option>
          ))}
        </select>
      ) : null}
      {singleView ? (
        <Button
          aria-label={`Open view ${singleView.name}`}
          className="max-w-56 min-w-0 shrink"
          onClick={() => applyView(singleView)}
          size="toolbar"
          title={singleView.name}
          variant="outline"
        >
          <span className="truncate">{singleView.name}</span>
        </Button>
      ) : views.length > 1 ? (
        <select
          aria-label="Saved views"
          className="h-8 shrink-0 rounded-(--radius-field) border border-(--field-border) bg-card px-2 text-xs"
          onChange={(event) => {
            const view = views.find((v) => String(v.id) === event.target.value);
            if (view) applyView(view);
          }}
          value=""
        >
          <option value="">Saved views…</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </select>
      ) : null}
      {naming === null ? (
        <Button
          aria-label="Save view"
          className="ml-auto shrink-0"
          onClick={() => setNaming("")}
          size="toolbar"
          title="Save these filters as a view"
          variant="ghost"
        >
          <Save aria-hidden />
          <span className="hidden @3xl/filters:inline">Save view</span>
        </Button>
      ) : (
        <form
          className="ml-auto flex shrink-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (naming.trim()) void saveView(naming.trim());
          }}
        >
          <Input
            aria-label="Name this view"
            autoFocus
            className="h-8 w-40 text-xs"
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNaming(null);
            }}
            placeholder="Name this view"
            value={naming}
          />
          <Button disabled={!naming.trim()} size="toolbar" type="submit">
            Save
          </Button>
          <Button
            onClick={() => setNaming(null)}
            size="toolbar"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </form>
      )}
    </div>
  );

  const detail = <ApplicationDetail framed={false} jobId={activeId} />;
  const listDetail = (
    <ApplicationDetail
      jobId={activeId}
      list={besideList(list)}
      onBack={listSheet.close}
    />
  );

  return (
    <LockedScreenLayout
      contentClassName={
        prefs.layout === "board"
          ? "split:overflow-hidden"
          : "flex flex-col overflow-hidden"
      }
      lockContentHeight
      lockStacked={prefs.layout !== "board"}
      topContent={
        <div className="grid gap-3">
          <PageHeader
            actions={
              <>
                {dueCount > 0 && !filter.due ? (
                  <Button
                    onClick={() =>
                      setFilter({ ...NO_FILTER, due: true, sort: "next" })
                    }
                    size="toolbar"
                    // With an application open, its own action leads.
                    variant={activeId === null ? "primary" : "outline"}
                  >
                    Follow up on {plural(dueCount, "application")}
                  </Button>
                ) : null}
                <Button
                  onClick={() => void exportCsv()}
                  size="toolbar"
                  variant="outline"
                >
                  <Download aria-hidden />
                  Export
                </Button>
                {prefs.layout === "board" ? (
                  // Bulk work across stages happens in the list: Select on
                  // the board opens the list in select mode, filters kept.
                  <Button
                    onClick={() => {
                      setPrefs((p) => ({ ...p, layout: "list" }));
                      setSelection(SELECTING);
                    }}
                    size="toolbar"
                    title="Select applications to move several at once (opens the list)"
                    variant="ghost"
                  >
                    <ListChecks aria-hidden />
                    Select
                  </Button>
                ) : null}
                <SegmentedControl<Layout>
                  label="Show as"
                  onValueChange={(layout) =>
                    setPrefs((p) => ({ ...p, layout }))
                  }
                  options={[
                    { value: "list", label: "List" },
                    { value: "board", label: "Board" },
                  ]}
                  value={prefs.layout}
                />
              </>
            }
            description="Every application, where it stands and what is next."
            title="Applications"
          />
          {filters}
        </div>
      }
    >
      {prefs.layout === "board" ? (
        // The board takes the whole width; a card's details open over it.
        <div
          className="relative flex min-h-0 flex-1 split:h-full"
          data-application-list-state={JSON.stringify({
            ...query,
            layout: prefs.layout,
            selectedIds: [...selection.ids],
            all: selection.all,
          })}
        >
          <ApplicationsBoard
            activeId={sheetOpen ? activeId : null}
            counts={counts}
            emptyAction={{
              label: firstStep.label,
              onClick: () => void navigate(firstStep.to),
            }}
            filter={withoutStatuses(query)}
            onActivate={(id) => {
              setActiveId(id);
              setSheetOpen(true);
            }}
            sheetOpen={sheetOpen && activeId !== null}
          />
          {sheetOpen && activeId !== null ? (
            <BoardDetailSheet onClose={() => setSheetOpen(false)}>
              {detail}
            </BoardDetailSheet>
          ) : null}
        </div>
      ) : (
        <ListDetailLayout
          applicationState={{
            ...query,
            ...prefs,
            selectedIds: [...selection.ids],
            all: selection.all,
          }}
          detail={listDetail}
          sheet={{
            open: listSheet.open && activeId !== null,
            onClose: listSheet.close,
          }}
          table
          list={
            <ListPane<TrackerRow>
              activeId={activeId}
              bulkActions={
                <>
                  <select
                    aria-busy={moving || undefined}
                    aria-label={`Move ${plural(selectedCount, "selected application")} to`}
                    className="h-8 rounded-(--radius-button) border border-(--control-border) bg-card px-2 text-(length:--text-small) font-medium disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={moving}
                    onChange={(event) => {
                      const status = event.target.value as Exclude<
                        TrackerStatus,
                        "applying"
                      >;
                      if (!status) return;
                      const selection = target();
                      if (!selection) return;
                      setMoving(true);
                      void setStatus(selection, status)
                        .then(() => setSelection(NO_SELECTION))
                        .finally(() => setMoving(false));
                    }}
                    value=""
                  >
                    <option value="">Move to…</option>
                    {[
                      ...OPEN_STATUSES,
                      "rejected",
                      "withdrawn",
                      "no_reply",
                    ].map((status) => (
                      <option key={status} value={status}>
                        {TRACKER_STATUS_LABEL[status as TrackerStatus]}
                      </option>
                    ))}
                  </select>
                </>
              }
              endNote={
                filter.statuses.length > 0 ||
                filter.tag ||
                filter.text.trim() ||
                filter.due ||
                filter.quietForDays !== null
                  ? null
                  : "Applications appear here as Apply starts them."
              }
              empty={
                total === 0 ? (
                  <ListEmpty
                    action={{
                      label: firstStep.label,
                      onClick: () => void navigate(firstStep.to),
                    }}
                    detail={firstStep.detail}
                    title="No applications yet"
                  />
                ) : (
                  <ListEmpty
                    action={{
                      label: "Clear filters",
                      onClick: () =>
                        setFilter((current) => ({
                          ...NO_FILTER,
                          sort: current.sort,
                        })),
                    }}
                    title="No application matches these filters."
                  />
                )
              }
              fillStacked
              hasMore={list.nextCursor !== null}
              label="Applications"
              loading={list.loading}
              error={list.error}
              onRetry={() => void list.refresh()}
              noun="application"
              windowed
              onLoadMore={() => void list.loadMore()}
              onSelectionChange={setSelection}
              renderSkeletonRow={(index) => (
                <ApplicationRowSkeleton
                  columns={showColumns}
                  density={prefs.density}
                  index={index}
                />
              )}
              renderRow={(row, state) => (
                <ApplicationRow
                  {...state}
                  columns={showColumns}
                  density={prefs.density}
                  onActivate={(id) => {
                    setActiveId(id);
                    listSheet.openIfStacked();
                  }}
                  onToggle={toggle}
                  row={row}
                />
              )}
              rows={list.rows}
              selectedCount={selectedCount}
              selection={selection}
              toolbar={
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Input
                    aria-label="Find an application"
                    className="h-8 min-w-0 flex-1"
                    id={FILTER_ID}
                    onChange={(event) =>
                      setFilter((f) => ({ ...f, text: event.target.value }))
                    }
                    placeholder="Find an application  /"
                    type="search"
                    value={filter.text}
                  />
                  <select
                    aria-label="Sort"
                    className="h-8 rounded-(--radius-field) border border-(--control-border) bg-card px-2 text-xs"
                    onChange={(event) =>
                      setFilter((f) => ({
                        ...f,
                        sort: event.target.value as TrackerSort,
                      }))
                    }
                    value={filter.sort}
                  >
                    <option value="recent">Latest change</option>
                    <option value="applied">Newest applied</option>
                    <option value="next">Next up</option>
                  </select>
                  <ViewOptions prefs={prefs} setPrefs={setPrefs} />
                </div>
              }
              total={list.total}
              totalCapped={list.totalCapped}
            />
          }
        />
      )}
    </LockedScreenLayout>
  );
}

function withoutStatuses(
  query: TrackerFilterInput & { sort: TrackerSort },
): Omit<TrackerFilterInput, "statuses"> {
  return {
    tag: query.tag,
    text: query.text,
    due: query.due,
    quietForDays: query.quietForDays,
  };
}

function FilterChip(props: {
  label: string;
  count?: number;
  /** False while the count is unread (a failed first read): "–", not 0. */
  countKnown?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={props.active}
      className={cn(
        FILTER_CHIP_CLASS,
        props.active && FILTER_CHIP_ACTIVE_CLASS,
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.label}
      {props.count !== undefined ? (
        <CountFigure
          className="text-muted-foreground"
          count={props.count}
          known={props.countKnown ?? true}
          slot={`applications:${props.label}`}
        />
      ) : null}
    </button>
  );
}

/** Which columns the list shows and how tightly. */
function ViewOptions(props: {
  prefs: Prefs;
  setPrefs: (update: (prefs: Prefs) => Prefs) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        size="toolbar"
        variant="ghost"
      >
        Columns
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 grid w-48 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-card p-3 shadow-lg">
          {ALL_COLUMNS.map((column) => (
            <label className="flex items-center gap-2 text-sm" key={column}>
              <Checkbox
                checked={props.prefs.columns.includes(column)}
                onCheckedChange={(checked) =>
                  props.setPrefs((prefs) => ({
                    ...prefs,
                    columns: checked
                      ? ALL_COLUMNS.filter(
                          (c) => c === column || prefs.columns.includes(c),
                        )
                      : prefs.columns.filter((c) => c !== column),
                  }))
                }
              />
              {COLUMN_LABEL[column]}
            </label>
          ))}
          <SegmentedControl<Density>
            label="Density"
            onValueChange={(density) =>
              props.setPrefs((prefs) => ({ ...prefs, density }))
            }
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Roomy" },
            ]}
            value={props.prefs.density}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One application as a row of the columns the person chose. Memoized, so a
 * key press re-renders only the rows whose state changed.
 */
const ApplicationRow = memo(function ApplicationRow(
  props: ListRowState & {
    row: TrackerRow;
    columns: readonly Column[];
    density: Density;
    onActivate: (id: number) => void;
    onToggle: (id: number, shiftKey: boolean) => void;
  },
) {
  const { row } = props;
  const shows = (column: Column) => props.columns.includes(column);
  const status = describeStatus(row);
  const tags = shows("tags") && row.tags.length > 0 ? row.tags.join(", ") : "";
  // Two lines a column, so the company keeps its room beside the dates.
  const stage = shows("status") || shows("since");
  const timing = shows("next") || shows("applied");
  const press = useRowPress(row.id, props.onActivate, props.onToggle);
  // Wide rows fill their third column with the next step: the scheduled
  // one, else what the stage waits on, so no row ends in empty width.
  const next = shows("next") ? describeNext(row) : null;
  return (
    <li
      className="@container/approw relative min-w-0"
      data-list-row-id={row.id}
      {...listRowPlacement(props)}
    >
      <ListRowCheck
        align="center"
        checked={props.checked}
        id={row.id}
        label={`${row.company}, ${row.title}`}
        onToggle={props.onToggle}
      />
      <SelectableRow
        aria-controls={LIST_DETAIL_REGION_ID}
        // Named from its data, the same at every width: the narrow row
        // folds its next step into the status column.
        aria-label={[
          row.company,
          row.title,
          tags,
          shows("status") ? status.label : null,
          shows("since") ? describeSince(row) : null,
          next?.text,
        ]
          .filter(Boolean)
          .join(", ")}
        className={cn(
          applicationRowGridClassName(stage, timing),
          LIST_ROW_SELECT_PAD_CLASS,
          props.density === "compact" ? "py-1.5" : "py-3",
        )}
        onClick={press.onClick}
        onMouseDown={press.onMouseDown}
        selected={props.active}
        checked={props.checked}
        tabIndex={props.active ? 0 : -1}
      >
        <span className="grid min-w-0">
          <span className="truncate font-semibold" title={row.company}>
            {row.company}
          </span>
          <span
            className="truncate text-xs text-foreground-soft"
            title={tags ? `${row.title} · ${tags}` : row.title}
          >
            {row.title}
            {tags ? ` · ${tags}` : ""}
          </span>
        </span>
        {stage ? (
          <span className="grid min-w-0 justify-items-start gap-0.5 text-xs">
            {shows("status") ? (
              <StatusBadge className="whitespace-nowrap" tone={status.tone}>
                {status.label}
              </StatusBadge>
            ) : null}
            {/* A narrow list has no timing column: the next step, when
                there is one, takes the "Since" line's place. */}
            {timing && shows("next") && row.nextAt ? (
              <span
                className="max-w-full truncate font-medium @2xl/approw:hidden"
                title={row.nextTitle ?? ""}
              >
                {describeDue(row.nextAt)}
              </span>
            ) : null}
            {shows("since") ? (
              <span
                className={cn(
                  "text-foreground-soft",
                  timing &&
                    shows("next") &&
                    row.nextAt &&
                    "hidden @2xl/approw:inline",
                )}
              >
                {describeSince(row)}
              </span>
            ) : null}
          </span>
        ) : null}
        {timing ? (
          // Only where the list is wide enough to give it room: at 1024 a
          // mostly empty third column took the company's and title's width.
          <span
            className={cn(
              "min-w-0 gap-0.5 text-xs",
              stage ? "hidden @2xl/approw:grid" : "grid",
            )}
          >
            {next ? (
              <span
                className={cn(
                  "truncate",
                  next.act ? "font-medium" : "text-foreground-soft",
                )}
                data-next-step={next.act ? "act" : "wait"}
                title={next.text}
              >
                {next.text}
              </span>
            ) : null}
            {/* One date per row: an application still at Applied already
                says "Since" that day. */}
            {shows("applied") &&
            row.appliedAt &&
            !(
              shows("since") &&
              row.status === "applied" &&
              formatDay(row.statusAt) === formatDay(row.appliedAt)
            ) ? (
              <span className="text-foreground-soft">
                Applied {formatDay(row.appliedAt)}
              </span>
            ) : null}
          </span>
        ) : null}
      </SelectableRow>
    </li>
  );
});

/**
 * The row box: the same flat divider rows as every other list (no rounded
 * card of its own), with the columns the person chose.
 */
/**
 * The status column fits the longest status chip ("Sent? Check the site",
 * "Filling in the form") whole, at every width: the company and title
 * truncate first, a chip never does.
 */
function applicationRowGridClassName(stage: boolean, timing: boolean) {
  return cn(
    "grid w-full items-center gap-3 rounded-none border-x-0 border-t-0 border-b border-b-(--surface-panel-border) pr-3 text-left text-sm focus-visible:z-10",
    stage && timing
      ? "grid-cols-[minmax(8rem,1fr)_9.5rem] @2xl/approw:grid-cols-[minmax(10rem,1fr)_9.5rem_minmax(11rem,1fr)]"
      : stage
        ? "grid-cols-[minmax(8rem,1fr)_9.5rem]"
        : timing
          ? "grid-cols-[minmax(10rem,1fr)_minmax(11rem,1fr)]"
          : "grid-cols-1",
  );
}

/** A loading row laid out like `ApplicationRow` with the same columns. */
function ApplicationRowSkeleton(props: {
  columns: readonly Column[];
  density: Density;
  index: number;
}) {
  const shows = (column: Column) => props.columns.includes(column);
  const stage = shows("status") || shows("since");
  const timing = shows("next") || shows("applied");
  const widths = ["w-2/5", "w-1/2", "w-1/3", "w-3/5"] as const;
  return (
    <li
      aria-hidden="true"
      className="@container/approw min-w-0"
      data-list-row-skeleton
    >
      <div
        className={cn(
          applicationRowGridClassName(stage, timing),
          "px-4",
          props.density === "compact" ? "py-1.5" : "py-3",
        )}
      >
        <span className="grid min-w-0">
          <span className="flex h-5 items-center">
            <span
              className={cn(
                "skeleton block h-3",
                widths[props.index % widths.length],
              )}
            />
          </span>
          <span className="flex h-4 items-center">
            <span className="skeleton block h-2.5 w-3/5" />
          </span>
        </span>
        {stage ? (
          <span className="grid gap-0.5">
            {shows("status") ? (
              <span className="skeleton block h-5 w-20" />
            ) : null}
            {shows("since") ? (
              <span className="flex h-4 items-center">
                <span className="skeleton block h-2.5 w-16" />
              </span>
            ) : null}
          </span>
        ) : null}
        {timing ? (
          <span
            className={cn(
              "gap-0.5",
              stage ? "hidden @2xl/approw:grid" : "grid",
            )}
          >
            {shows("next") ? (
              <span className="flex h-4 items-center">
                <span className="skeleton block h-2.5 w-28" />
              </span>
            ) : null}
            {shows("applied") ? (
              <span className="flex h-4 items-center">
                <span className="skeleton block h-2.5 w-20" />
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * With no applications yet, the empty list leads to the step that comes
 * next from where the person is: finishing setup, approving the resumes that
 * are written, reading the ones to review, sorting found jobs, or a first
 * search. Never to an empty Approved tab.
 */
function useFirstApplicationStep(): {
  label: string;
  detail: string;
  to: string;
} {
  const stages = useStageCounts();
  const setup = useLaunchReads().context?.profileSetupState?.status ?? null;
  if (setup === "not_started" || setup === "in_progress")
    return {
      label: setup === "not_started" ? "Set up your profile" : "Finish setup",
      detail:
        "Apply sends your shortlisted resumes with your profile; each application shows up here.",
      to: "/job-finder/profile/setup",
    };
  if (stages && stages.resume > 0)
    return {
      label: `Apply to ${plural(stages.resume, "approved job")}`,
      detail:
        "Their resumes are approved. Apply sends them; each one shows up here.",
      to: "/job-finder/review-queue?tab=approved",
    };
  if (stages && stages.shortlisted > 0)
    return {
      label: `Review ${plural(stages.shortlisted, "resume")}`,
      detail:
        "Approve a resume in Shortlisted and Apply sends it; it shows up here.",
      to: "/job-finder/review-queue",
    };
  if (stages && stages.found > 0)
    return {
      label: "Sort found jobs",
      detail:
        "Shortlist the jobs you want; each gets a resume to approve, then Apply sends it.",
      to: JOB_FINDER_ROUTE_PATHS.discovery,
    };
  return {
    label: "Find jobs",
    detail:
      "Search your job sites, shortlist, approve a resume, and Apply sends it here.",
    to: JOB_FINDER_ROUTE_PATHS.discovery,
  };
}
