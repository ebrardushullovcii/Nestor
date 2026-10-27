import {
  TRACKER_STATUS_LABEL,
  matchesAssistantListView,
  trackerStatusValues,
  type TrackerFilterInput,
  type TrackerFilter,
  type TrackerRow,
  type TrackerSort,
  type TrackerStatus,
  type TrackerStatusCounts,
  type TrackerView,
  type TrackerSelectionInput,
} from "@nestor/contracts";
import { Download, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  countSelected,
  isSelected,
  LIST_DETAIL_REGION_ID,
  ListDetailLayout,
  ListPane,
  NO_SELECTION,
  plural,
  selectAll,
  toggleSelection,
  useListKeys,
  useStoreList,
  type ListSelection,
} from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";

import { useAssistantContextSource } from "@renderer/features/job-finder/assistant/assistant-provider";
import { ListEmpty } from "@renderer/features/job-lists/list-empty";
import { useAssistantTrackerView } from "@renderer/features/job-lists/use-assistant-list-view";

import {
  ApplicationDetail,
  useSetStatus,
  useTrackerChangeToast,
} from "./application-detail";
import { ApplicationsBoard } from "./applications-board";
import {
  countGroup,
  describeDue,
  describeStatus,
  formatDay,
  OPEN_STATUSES,
  STAGE_GROUPS,
} from "./tracker-format";
import { describeError } from "./use-application";

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
  trackerStatusValues.map((status) => [status, 0]),
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
 * with columns or a board by stage, the details always beside it.
 */
export function ApplicationsScreen() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const setStatus = useSetStatus();
  const showChange = useTrackerChangeToast();
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [views, setViews] = useState<TrackerView[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [dueCount, setDueCount] = useState(0);
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
    if (Number.isInteger(linked) && linked > 0) setActiveId(linked);
  }, [linked, navigationKey]);

  // A new list starts with nothing ticked; its first application opens.
  useEffect(() => setSelection(NO_SELECTION), [query]);
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

  const toggle = (id: number, shiftKey: boolean) =>
    setSelection((current) =>
      toggleSelection(current, id, shiftKey, list.rows),
    );

  useListKeys({
    rows: list.rows,
    activeId,
    setActiveId,
    toggle,
    selectAll: () => setSelection(selectAll()),
    clearSelection: () => setSelection(NO_SELECTION),
    loadMore: () => void list.loadMore(),
    filterSelector: `#${FILTER_ID}`,
  });

  const exportCsv = async () => {
    try {
      const result = await window.nestor.tracker.exportCsv(query);
      showToast(
        result.outputPath
          ? {
              title: `Exported ${plural(result.rows, "application")}`,
              description: result.outputPath,
            }
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
  const total = trackerStatusValues.reduce((sum, s) => sum + counts[s], 0);
  const showColumns = prefs.columns;
  const singleView = views.length === 1 ? (views[0] ?? null) : null;

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <div
        aria-label="Which applications"
        className="flex flex-wrap gap-1"
        role="group"
      >
        <FilterChip
          active={filter.statuses.length === 0}
          count={total}
          label="All"
          onClick={() => setFilter((f) => ({ ...f, statuses: [] }))}
        />
        {STAGE_GROUPS.map((group) => (
          <FilterChip
            active={groupId === group.id}
            count={countGroup(counts, group.statuses)}
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
          className="h-8 rounded-(--radius-field) border border-(--control-border) bg-card px-2 text-xs"
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
          className="max-w-56 min-w-0"
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
          className="h-8 rounded-(--radius-field) border border-(--control-border) bg-card px-2 text-xs"
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
        <Button onClick={() => setNaming("")} size="toolbar" variant="ghost">
          <Save aria-hidden />
          Save view
        </Button>
      ) : (
        <form
          className="flex items-center gap-1"
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

  const detail = <ApplicationDetail jobId={activeId} />;

  return (
    <LockedScreenLayout
      contentClassName="xl:overflow-hidden"
      lockContentHeight
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
        <ListDetailLayout
          applicationState={{
            ...query,
            layout: prefs.layout,
            selectedIds: [...selection.ids],
            all: selection.all,
          }}
          detail={detail}
          list={
            <ApplicationsBoard
              activeId={activeId}
              filter={withoutStatuses(query)}
              onActivate={setActiveId}
            />
          }
          table
        />
      ) : (
        <ListDetailLayout
          applicationState={{
            ...query,
            ...prefs,
            selectedIds: [...selection.ids],
            all: selection.all,
          }}
          detail={detail}
          table
          list={
            <ListPane<TrackerRow>
              activeId={activeId}
              bulkActions={
                <>
                  <select
                    aria-label="Move the ticked applications to"
                    className="h-8 rounded-(--radius-field) border border-(--control-border) bg-card px-2 text-xs"
                    onChange={(event) => {
                      const status = event.target.value as Exclude<
                        TrackerStatus,
                        "applying"
                      >;
                      if (!status) return;
                      const selection = target();
                      if (!selection) return;
                      void setStatus(selection, status).then(() =>
                        setSelection(NO_SELECTION),
                      );
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
              empty={
                total === 0 ? (
                  <ListEmpty
                    action={{
                      label: "Go to approved resumes",
                      onClick: () =>
                        void navigate("/job-finder/review-queue?tab=approved"),
                    }}
                    detail="Approve resumes in Shortlisted and Apply sends them; each one shows up here."
                    title="No applications yet"
                  />
                ) : (
                  <ListEmpty title="No application matches these filters." />
                )
              }
              hasMore={list.nextCursor !== null}
              label="Applications"
              loading={list.loading}
              noun="application"
              onClearSelection={() => setSelection(NO_SELECTION)}
              onLoadMore={() => void list.loadMore()}
              onSelectAll={() => setSelection(selectAll())}
              renderRow={(row, state) => (
                <ApplicationRow
                  active={state.active}
                  checked={state.checked}
                  columns={showColumns}
                  density={prefs.density}
                  key={row.id}
                  onActivate={setActiveId}
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
                    placeholder="Find an application"
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
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={props.active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs",
        props.active
          ? "border-primary-fill bg-primary-fill text-primary-fill-foreground"
          : "border-(--control-border) bg-card text-foreground hover:bg-accent",
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.label}
      {props.count !== undefined ? (
        <span className="tabular-nums opacity-80">
          {props.count.toLocaleString()}
        </span>
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

/** One application as a row of the columns the person chose. */
function ApplicationRow(props: {
  row: TrackerRow;
  active: boolean;
  checked: boolean;
  columns: readonly Column[];
  density: Density;
  onActivate: (id: number) => void;
  onToggle: (id: number, shiftKey: boolean) => void;
}) {
  const { row } = props;
  const shows = (column: Column) => props.columns.includes(column);
  const status = describeStatus(row);
  const tags = shows("tags") && row.tags.length > 0 ? row.tags.join(", ") : "";
  // Two lines a column, so the company keeps its room beside the dates.
  const stage = shows("status") || shows("since");
  const timing = shows("next") || shows("applied");
  return (
    <li className="relative min-w-0 pl-10" data-list-row-id={row.id}>
      <div className="absolute inset-y-0 left-0 z-10 flex w-10 items-center justify-center">
        <Checkbox
          aria-label={`Select ${row.company}, ${row.title}`}
          checked={props.checked}
          onClick={(event) => {
            event.preventDefault();
            props.onToggle(row.id, event.shiftKey);
          }}
        />
      </div>
      <SelectableRow
        aria-controls={LIST_DETAIL_REGION_ID}
        className={cn(
          "grid w-full items-center gap-3 pr-3 text-left text-sm",
          stage && timing
            ? "grid-cols-[minmax(10rem,1fr)_7rem_11rem]"
            : stage
              ? "grid-cols-[minmax(10rem,1fr)_7rem]"
              : timing
                ? "grid-cols-[minmax(10rem,1fr)_11rem]"
                : "grid-cols-1",
          props.density === "compact" ? "py-1.5" : "py-3",
        )}
        onClick={() => props.onActivate(row.id)}
        selected={props.active}
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
            {shows("since") ? (
              <span className="text-foreground-soft">
                Since {formatDay(row.statusAt)}
              </span>
            ) : null}
          </span>
        ) : null}
        {timing ? (
          <span className="grid min-w-0 gap-0.5 text-xs">
            {shows("next") && row.nextAt ? (
              <span
                className="truncate font-medium"
                title={row.nextTitle ?? ""}
              >
                {describeDue(row.nextAt)}: {row.nextTitle}
              </span>
            ) : null}
            {shows("applied") && row.appliedAt ? (
              <span className="text-foreground-soft">
                Applied {formatDay(row.appliedAt)}
              </span>
            ) : null}
          </span>
        ) : null}
      </SelectableRow>
    </li>
  );
}
