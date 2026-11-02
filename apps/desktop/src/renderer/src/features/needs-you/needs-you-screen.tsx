import { CreateAnswerPane } from "./create-answer-pane";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight } from "lucide-react";
import type {
  ApplicationRow,
  NeedsYouCounts,
  NeedsYouKind,
  NeedsYouTask,
  SavedFormAnswerSummary,
} from "@nestor/contracts";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAssistantNeedsView } from "@renderer/features/job-lists/use-assistant-list-view";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import {
  DetailSheetBack,
  useDetailSheet,
  EmptyPane,
  clearSelected,
  countSelected,
  isSelected,
  LIST_ROW_SELECT_PAD_CLASS,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  stepSelectAll,
  toggleSelection,
  useListKeys,
  useStoreList,
  type ListSelection,
  CountFigure,
  countText,
  besideList,
} from "@renderer/features/job-lists";
import { TaskPane, describeError } from "./task-pane";
import { SavedAnswerPane } from "./saved-answer-pane";
import { SourceNeedPane } from "./source-need-pane";
import { useNeedsSelection } from "./use-needs-selection";
import {
  currentWorkItem,
  siteCheck,
  useWorkThrough,
  workThrough,
  type WorkItem,
} from "./work-through";
import { openPreparedApplication } from "@renderer/features/applications/open-application";
import {
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
} from "@renderer/features/job-finder/components/list-row";
import { cn } from "@renderer/lib/cn";
import { ListEmpty } from "@renderer/features/job-lists/list-empty";

/** Job sites on one host share one sign-in, so they are one row. */
interface SiteRow {
  /** The first task's id: the row's id in the list and the selection. */
  id: number;
  host: string;
  label: string;
  tasks: NeedsYouTask[];
}
type Item = NeedsYouTask | SiteRow | SavedFormAnswerSummary;
const isSite = (row: Item): row is SiteRow => "tasks" in row;
const EMPTY_COUNTS: NeedsYouCounts = {
  question: 0,
  sign_in: 0,
  captcha: 0,
  mfa: 0,
  saved: 0,
};
const KIND = {
  question: "Needs your answer",
  sign_in: "Sign in",
  captcha: "CAPTCHA",
  mfa: "Verification",
};
/** What a `?kind=` link (from Home) narrows the list to. */
const KIND_FILTER_LABEL: Record<NeedsYouKind, string> = {
  question: "Questions for applications",
  sign_in: "Site sign-ins",
  captcha: "CAPTCHA checks",
  mfa: "Verification codes",
};

/** The company and role waiting on a task, and how many more wait too. */
function waitingLabel(waiting: {
  company: string;
  title: string;
  count: number;
}) {
  const label = [waiting.company, waiting.title].filter(Boolean).join(" · ");
  return waiting.count > 1 ? `${label} and ${waiting.count - 1} more` : label;
}

/** A site as a person names it: its host, without "www.". */
function siteName(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

function mergeSites(tasks: readonly NeedsYouTask[]): SiteRow[] {
  const byHost = new Map<string, SiteRow>();
  for (const task of tasks) {
    if (!task.source) continue;
    const host = siteName(task.source.url) ?? task.source.url;
    const row = byHost.get(host);
    if (row) row.tasks.push(task);
    else
      byHost.set(host, {
        id: task.id,
        host,
        label: task.source.label,
        tasks: [task],
      });
  }
  return [...byHost.values()];
}

/**
 * Every item the Needs you filter matches, page by page: the items holding
 * up applications, then the sign-ins for job sites merged by site, as the
 * list shows them. What "all selected" covers, loaded or not.
 */
export async function readEveryMatchingTask(filter: {
  text: string;
  kind: NeedsYouKind | null;
}): Promise<(NeedsYouTask | SiteRow)[]> {
  const read = async (group: "applications" | "sites") => {
    const rows: NeedsYouTask[] = [];
    let after = 0;
    for (;;) {
      const page = await window.nestor.needsYou.run("list_needs_you", {
        after,
        limit: 200,
        text: filter.text,
        kind: filter.kind,
        group,
      });
      rows.push(...page.rows);
      if (page.nextCursor === null || page.rows.length === 0) return rows;
      after = page.nextCursor;
    }
  };
  const [applications, sites] = await Promise.all([
    read("applications"),
    read("sites"),
  ]);
  return [...applications, ...mergeSites(sites)];
}

function toWorkItem(row: NeedsYouTask | SiteRow): WorkItem {
  return isSite(row)
    ? {
        id: row.id,
        kind: "site",
        label: row.label,
        taskIds: row.tasks.map((task) => task.id),
        sources: row.tasks.flatMap((task) =>
          task.source ? [{ id: task.source.id, url: task.source.url }] : [],
        ),
      }
    : {
        id: row.id,
        kind: "task",
        label: row.prompt,
        taskIds: [row.id],
        sources: [],
      };
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/**
 * Filled forms waiting for the person's Send. They are not blocked, so they
 * are not counted in Needs you; they are listed so nothing waits unseen.
 */
function useReadyForms() {
  const [ready, setReady] = useState<{
    rows: ApplicationRow[];
    more: boolean;
  }>({ rows: [], more: false });
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const page = await window.nestor.jobFinder.listApplications({
          state: "ready",
          limit: 50,
        });
        if (live) setReady({ rows: page.rows, more: page.nextCursor !== null });
      } catch {
        /* Keep the last list; the next change reads again. */
      }
    };
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.cause === "application") void read();
    });
    void read();
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return ready;
}

/** A group's heading row: what the group is, how many, and its one action. */
function GroupHeader(props: {
  inList?: boolean;
  label: string;
  group: string;
  open?: boolean;
  onToggle?: () => void;
  action?: { label: string; onClick: () => void } | null;
}) {
  const Wrapper = props.inList ? "li" : "div";
  return (
    <Wrapper
      className="flex min-h-10 items-center gap-2 border-b border-(--surface-panel-border) py-1.5 pr-3 pl-4"
      data-needs-group={props.group}
    >
      {props.onToggle ? (
        <button
          aria-expanded={props.open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-(length:--text-small) font-medium text-foreground"
          onClick={props.onToggle}
          type="button"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 shrink-0 transition-transform",
              props.open && "rotate-90",
            )}
          />
          <span className="truncate">{props.label}</span>
        </button>
      ) : (
        <h3 className="min-w-0 flex-1 truncate text-(length:--text-small) font-medium text-foreground">
          {props.label}
        </h3>
      )}
      {props.action ? (
        <Button onClick={props.action.onClick} size="toolbar" variant="outline">
          {props.action.label}
        </Button>
      ) : null}
    </Wrapper>
  );
}

export function NeedsYouScreen() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<"tasks" | "saved">("tasks");
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedKind = searchParams.get("kind");
  const kind =
    requestedKind && requestedKind in KIND_FILTER_LABEL
      ? (requestedKind as NeedsYouKind)
      : null;
  const [text, setText] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const navigateTo = useNavigate();
  const pinned = useRef<number | null>(null);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  // Until the counts are read they are unknown ("–"), never 0.
  const [countsKnown, setCountsKnown] = useState(false);
  // Read the counts again (Try again on the list reads them with it).
  const refreshCounts = useRef<() => void>(() => undefined);
  useEffect(() => {
    let live = true;
    let reading = false;
    let again = false;
    const refresh = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          const value = await window.nestor.needsYou.run(
            "needs_you_counts",
            {},
          );
          if (live) {
            setCounts(value);
            setCountsKnown(true);
          }
        } while (live && again);
      } catch {
        /* A later store change retries the read; keep the last known count. */
      } finally {
        reading = false;
      }
    };
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.cause === "application") void refresh();
    });
    refreshCounts.current = () => void refresh();
    void refresh();
    return () => {
      live = false;
      refreshCounts.current = () => undefined;
      unsubscribe();
    };
  }, []);
  const list = useStoreList<Item, NeedsYouCounts>({
    key: JSON.stringify([tab, text, kind]),
    emptyCounts: EMPTY_COUNTS,
    pauseUpdates: editing,
    refreshOn: (change) => change.cause === "application",
    load: async ({ cursor, limit }) => {
      const after = cursor ? Number(cursor) : 0;
      if (tab === "tasks") {
        const page = await window.nestor.needsYou.run("list_needs_you", {
          after,
          limit,
          text,
          kind,
          group: "applications",
        });
        return {
          ...page,
          nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
        };
      }
      const page = await window.nestor.needsYou.run("list_form_answers", {
        after,
        limit,
        text,
      });
      return {
        ...page,
        counts: EMPTY_COUNTS,
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
      };
    },
  });
  // A list read that lands while the counts are still unknown reads them
  // again too, so a recovered list never sits under "–" tabs.
  useEffect(() => {
    if (list.countsKnown && !countsKnown) refreshCounts.current();
  }, [list.countsKnown, list.rows, countsKnown]);
  // Sign-ins for job sites search could not read, after the items holding
  // up applications; sites on one host merge into one row.
  const sites = useStoreList<NeedsYouTask, NeedsYouCounts>({
    key: JSON.stringify([tab, text, kind, "sites"]),
    emptyCounts: EMPTY_COUNTS,
    pauseUpdates: editing,
    refreshOn: (change) => change.cause === "application",
    load: async ({ cursor, limit }) => {
      if (tab !== "tasks")
        return {
          rows: [],
          nextCursor: null,
          total: 0,
          totalCapped: false,
          counts: EMPTY_COUNTS,
        };
      const page = await window.nestor.needsYou.run("list_needs_you", {
        after: cursor ? Number(cursor) : 0,
        limit,
        text,
        kind,
        group: "sites",
      });
      return {
        ...page,
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
      };
    },
  });
  const siteRows = useMemo(
    () => (tab === "tasks" ? mergeSites(sites.rows) : []),
    [tab, sites.rows],
  );
  const [sitesExpanded, setSitesExpanded] = useState<boolean | null>(null);
  const appsLoaded = !list.loading && list.nextCursor === null;
  const sitesOpen = sitesExpanded ?? (appsLoaded && list.rows.length === 0);
  const showSites = tab === "tasks" && appsLoaded && sitesOpen;
  const rows: readonly Item[] = useMemo(
    () => (showSites ? [...list.rows, ...siteRows] : list.rows),
    [showSites, list.rows, siteRows],
  );
  // Site sign-ins are counted as the list shows them and Work through takes
  // them, one row per site, so every site page is read even while the group
  // is folded (one page holds 50 sign-ins; a site with 51 would otherwise
  // count as two rows, or the raw 51). Until then the count is the raw one
  // and a selection that covers it says "Counting…".
  const sitesPending =
    tab === "tasks" && sites.nextCursor !== null && sites.error === null;
  // A later site page that failed leaves the count unknown, not raw: the
  // reading stops (it would fail again by itself), a selection covering the
  // sites says it couldn't count, and Work through waits for Try again.
  const sitesFailed =
    tab === "tasks" && sites.nextCursor !== null && sites.error !== null;
  const sitesUnresolved = sitesPending || sitesFailed;
  const { loadMore: loadMoreSites } = sites;
  useEffect(() => {
    if (sitesPending && !sites.loading) void loadMoreSites();
  }, [sitesPending, sites.loading, sites.rows, loadMoreSites]);
  const siteCount = sites.nextCursor === null ? siteRows.length : sites.total;
  const ready = useReadyForms();
  const { walk, checks } = useWorkThrough();
  const walkItem = currentWorkItem(walk);
  const walkThroughState = useRef(walk);
  walkThroughState.current = walk;
  useEffect(() => {
    setActiveId(null);
    setSelection(clearSelected);
    setEditing(false);
    setCreating(false);
    setSitesExpanded(null);
    pinned.current = null;
  }, [tab, text, kind]);
  useEffect(() => {
    if (
      pinned.current !== null &&
      pinned.current === activeId &&
      !rows.some((row) => row.id === activeId)
    )
      return;
    pinned.current = null;
    if (
      !creating &&
      !editing &&
      !list.loading &&
      (activeId === null || !rows.some((row) => row.id === activeId))
    )
      setActiveId(rows[0]?.id ?? null);
  }, [activeId, creating, editing, list.loading, rows]);

  // Stacked beside a docked assistant, an item opens as a sheet over the
  // list instead of below it on a scrolling page.
  const sheet = useDetailSheet();
  const activate = useCallback((id: number) => {
    setEditing(false);
    setActiveId(id);
    pinned.current = null;
    setCreating(false);
  }, []);
  const openRow = useCallback(
    (id: number) => {
      activate(id);
      sheet.openIfStacked();
    },
    [activate, sheet.openIfStacked],
  );
  useAssistantNeedsView(searchParams.get("needs"), {
    requestId: useLocation().key,
    canApply: !editing,
    current: { tab, text, kind },
    setSelection,
    setFocus: (id) => {
      activate(id);
      pinned.current = id;
    },
    applyView: (view) => {
      if (view.tab !== undefined) setTab(view.tab);
      if (view.text !== undefined) setText(view.text);
      if (view.kind !== undefined && view.kind !== kind)
        setSearchParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            if (view.kind) next.set("kind", view.kind);
            else next.delete("kind");
            return next;
          },
          { replace: true },
        );
    },
  });
  // A walk's question opens in the detail pane; its sites open in the browser.
  const walkTaskId =
    walkItem?.kind === "task" && !walk?.paused ? walkItem.id : null;
  useEffect(() => {
    if (walkTaskId === null) return;
    activate(walkTaskId);
    pinned.current = walkTaskId;
  }, [walkTaskId, activate]);
  const toggle = (id: number, shift: boolean) =>
    setSelection((value) => toggleSelection(value, id, shift, rows));
  const resolvedSelection = useNeedsSelection({
    selection,
    setSelection,
    rows,
    loading: list.loading,
    tab,
    text,
    kind,
  });
  const visibleSelection = resolvedSelection.selection;
  // Counted the way the list shows them (and Work through takes them): the
  // sign-ins of one site are one row once every site is read.
  const total = list.total + (tab === "tasks" ? siteCount : 0);
  const selectedCount = countSelected(visibleSelection, total);
  const missing = useCallback((id: number) => {
    if (pinned.current === id) pinned.current = null;
    setActiveId((current) => (current === id ? null : current));
  }, []);
  const active =
    rows.find((row) => row.id === activeId) ??
    siteRows.find((row) => row.id === activeId);
  const site = active && isSite(active) ? active : undefined;
  useListKeys({
    rows,
    activeId,
    setActiveId: activate,
    toggle,
    selectAll: () =>
      setSelection((current) =>
        stepSelectAll(
          current,
          latest.current.rows,
          latest.current.list.nextCursor === null &&
            !latest.current.list.totalCapped &&
            latest.current.rows.length >= latest.current.total,
        ),
      ),
    clearSelection: () => setSelection(NO_SELECTION),
    loadMore: () =>
      void (list.nextCursor !== null || !showSites
        ? list.loadMore()
        : sites.loadMore()),
    filterSelector: "#needs-you-filter",
  });
  const latest = useRef({
    list,
    rows,
    selection: visibleSelection,
    activeId,
    total,
  });
  latest.current = {
    list,
    rows,
    selection: visibleSelection,
    activeId,
    total,
  };
  const resolved = useCallback(
    (id: number, message: string) => {
      const { list, rows, selection } = latest.current;
      const next =
        rows.find((row) => row.id !== id && isSelected(selection, row.id)) ??
        rows.find((row) => row.id > id) ??
        rows.find((row) => row.id !== id);
      list.removeRows((value) => value === id);
      // A walk on this question moves on to its own next item.
      if (currentWorkItem(walkThroughState.current)?.id === id)
        workThrough.finished(id);
      else setActiveId(next?.id ?? null);
      setEditing(false);
      setSelection((value) =>
        value.all
          ? value
          : {
              ...value,
              ids: new Set([...value.ids].filter((value) => value !== id)),
            },
      );
      showToast({ title: message, tone: "success" });
      void list.refresh();
    },
    [showToast],
  );
  async function forget(ids: number[], everything = false) {
    const { forgotten } = await window.nestor.needsYou.run(
      "forget_form_answers",
      everything ? { filter: { text }, except: [...selection.ids] } : { ids },
    );
    const gone = new Set(ids);
    list.removeRows((id) => gone.has(id));
    setActiveId(null);
    setSelection(NO_SELECTION);
    setEditing(false);
    showToast({
      title: `Forgot ${plural(forgotten, "saved answer", "saved answers")}`,
      tone: "success",
    });
    void list.refresh();
  }
  // "Work through N" starts exactly the N selected items: every one the
  // filter matches (less the ones left out) when all are selected, and
  // ticked items that are not on a loaded page, read from the store first.
  // A failed read starts nothing and says so beside the button.
  const [workError, setWorkError] = useState<string | null>(null);
  const [resolvingWork, setResolvingWork] = useState(false);
  useEffect(() => setWorkError(null), [selection]);
  async function startWork() {
    const loaded = [...list.rows, ...siteRows];
    const shown = new Set(loaded.map((row) => row.id));
    const complete =
      !selection.all && [...selection.ids].every((id) => shown.has(id));
    setWorkError(null);
    let rows: readonly Item[] = loaded;
    if (!complete) {
      setResolvingWork(true);
      try {
        rows = await readEveryMatchingTask({ text, kind });
      } catch (error) {
        setWorkError(describeError(error));
        return;
      } finally {
        setResolvingWork(false);
      }
    }
    const items = rows
      .filter((row) => isSelected(selection, row.id))
      .map((row) => toWorkItem(row as NeedsYouTask | SiteRow));
    setSelection(NO_SELECTION);
    workThrough.start(items);
  }
  const totalTasks =
    counts.question + counts.sign_in + counts.captcha + counts.mfa;
  const openReady = (id: number) =>
    void openPreparedApplication(id, showToast)
      .then((opened) => {
        if (!opened)
          showToast({
            title: "This form is no longer open. Find it in Applications.",
            tone: "warning",
          });
      })
      .catch((error: unknown) =>
        showToast({ title: describeError(error), tone: "warning" }),
      );
  const readyCount = ready.rows.length;
  const readyLabel = `${readyCount}${ready.more ? "+" : ""}`;
  const walkSites = () =>
    workThrough.start(siteRows.map((row) => toWorkItem(row)));
  const sitesHeader = (inList: boolean) => (
    <GroupHeader
      action={walk ? null : { label: "Sign in to each", onClick: walkSites }}
      group="sites"
      inList={inList}
      // Counted as the rows: one job site per host. Until every site page
      // is read (or after one failed) the sites are not counted, so the
      // label never states the raw number of sign-in tasks as sites.
      label={
        sitesUnresolved
          ? `Job sites need you to sign in · ${sitesFailed ? "couldn’t count them" : "counting…"}`
          : `${plural(siteRows.length, "job site needs", "job sites need")} you to sign in`
      }
      onToggle={() => setSitesExpanded(!sitesOpen)}
      open={sitesOpen}
    />
  );
  const showGroups = tab === "tasks" && !text;
  // The list's count in the tab's own terms: the items holding things up
  // (the same number as the tab and the header badge), and the filled-in
  // forms as their own collection beside it.
  // Until the counts are read, the rows read so far are the only count
  // there is: never an all-clear beside items that wait.
  const blocked = text || kind || !countsKnown ? total : totalTasks;
  const summary =
    tab === "tasks" ? (
      <span className="tabular-nums">
        {!list.countsKnown || (!countsKnown && list.error !== null)
          ? list.loading
            ? "Reading what needs you…"
            : "Not read yet"
          : blocked === 0
            ? "Nothing needs you"
            : `${plural(blocked, "item needs", "items need")} you`}
        {/* The badge counts every waiting item; sign-ins on one host are
            one row and one step: say how many Work through takes when the
            two differ. */}
        {tab === "tasks" &&
        !text &&
        !kind &&
        countsKnown &&
        !sitesUnresolved &&
        list.nextCursor === null &&
        list.total + siteRows.length !== blocked
          ? ` · ${(list.total + siteRows.length).toLocaleString()} to work through`
          : ""}
        {readyCount > 0 ? ` · ${readyLabel} ready to send` : ""}
      </span>
    ) : (
      <span className="tabular-nums">
        {plural(total, "saved answer", "saved answers")}
      </span>
    );
  const footer =
    tab !== "tasks" ? null : (
      <>
        {appsLoaded && !sitesOpen && siteRows.length > 0
          ? sitesHeader(false)
          : null}
        {readyCount > 0 ? (
          <section aria-label="Ready for you to send" data-needs-group="ready">
            <GroupHeader
              group="ready"
              label={`Ready to send · ${readyLabel}`}
            />
            <ul className="m-0 grid list-none p-0">
              {ready.rows.map((row) => (
                <li key={row.id}>
                  <button
                    className={cn(
                      jobFinderListRowClassName,
                      LIST_ROW_SELECT_PAD_CLASS,
                      "w-full text-left outline-none hover:bg-(--surface-overlay-list) focus-ring",
                    )}
                    onClick={() => openReady(row.id)}
                    title={
                      row.error ?? "Open the filled form to review and send"
                    }
                    type="button"
                  >
                    <span className={jobFinderListRowLinesClassName}>
                      <strong className={jobFinderListRowTitleClassName}>
                        {row.title}
                      </strong>
                      <span className={jobFinderListRowMetaClassName}>
                        {[row.company, row.location]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {/* Why a Send for me form waits, when it has a reason. */}
                      <span
                        className={cn(
                          jobFinderListRowStatusClassName,
                          "text-foreground-soft",
                        )}
                      >
                        {row.error ?? "Filled in. Review it and send."}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  return (
    <LockedScreenLayout
      contentClassName="flex flex-col overflow-hidden"
      lockContentHeight
      lockStacked
      topContent={
        <div
          className="grid gap-3 pb-4"
          data-needs-editing={editing ? "true" : "false"}
          data-needs-list-state={JSON.stringify({
            tab,
            text,
            kind,
            focusId: activeId ?? undefined,
            selectedIds: [...visibleSelection.ids],
            all: selection.all,
          })}
        >
          <PageHeader
            actions={
              tab === "saved" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setCreating(true);
                    setEditing(false);
                    setSelection(NO_SELECTION);
                    sheet.openIfStacked();
                  }}
                >
                  Add answer
                </Button>
              ) : undefined
            }
            title="Needs you"
            description="Answer once. Finish the steps only you can do."
          />
          <SegmentedControl
            className="self-start"
            label="Needs you view"
            variant="tabs"
            value={tab}
            onValueChange={setTab}
            options={[
              {
                value: "tasks",
                label: (
                  <span className="flex items-center gap-1.5">
                    Needs you
                    <CountFigure
                      count={totalTasks}
                      known={countsKnown}
                      slot="needs-you:tasks"
                    />
                  </span>
                ),
                ariaLabel: `Needs you ${countText(totalTasks, countsKnown)}`,
              },
              {
                value: "saved",
                label: (
                  <span className="flex items-center gap-1.5">
                    Saved answers
                    <CountFigure
                      count={counts.saved}
                      known={countsKnown}
                      slot="needs-you:saved"
                    />
                  </span>
                ),
                ariaLabel: `Saved answers ${countText(counts.saved, countsKnown)}`,
              },
            ]}
          />
          {tab === "tasks" && kind ? (
            <p className="flex items-center gap-2 text-sm text-foreground-soft">
              Showing {KIND_FILTER_LABEL[kind].toLowerCase()} only.
              <Button
                onClick={() => setSearchParams({}, { replace: true })}
                size="toolbar"
                variant="ghost"
              >
                Show everything
              </Button>
            </p>
          ) : null}
          {walk && walkItem ? (
            <p
              className="flex flex-wrap items-center gap-2 text-sm text-foreground-soft"
              data-needs-walk
              role="status"
            >
              {walk.paused ? (
                <>
                  Paused at {walk.index + 1} of {walk.items.length}
                  <Button onClick={() => workThrough.resume()} size="toolbar">
                    Continue
                  </Button>
                </>
              ) : (
                <>
                  <span>
                    {walkItem.kind === "site"
                      ? `Signing in · ${walkItem.label} · `
                      : "Working through "}
                    {walk.index + 1} of {walk.items.length}
                  </span>
                  <Button
                    onClick={() => workThrough.skip()}
                    size="toolbar"
                    variant="outline"
                  >
                    Skip
                  </Button>
                </>
              )}
              <Button
                onClick={() => workThrough.stop()}
                size="toolbar"
                variant="ghost"
              >
                Stop
              </Button>
            </p>
          ) : null}
          {/* A failed list read is shown in the list itself (ListPane's
              error state, with Try again); a failed selection check is
              here, with its own way on. */}
          {resolvedSelection.error ? (
            <p
              className="flex flex-wrap items-center gap-2 text-(length:--text-small) text-foreground"
              role="alert"
            >
              <span>{resolvedSelection.error}</span>
              <Button
                onClick={resolvedSelection.retry}
                size="toolbar"
                type="button"
                variant="outline"
              >
                Check again
              </Button>
            </p>
          ) : null}
        </div>
      }
    >
      <ListDetailLayout
        sheet={{
          open: sheet.open && (activeId !== null || creating),
          onClose: sheet.close,
        }}
        list={
          <ListPane<Item>
            activeId={activeId}
            fillStacked
            label={
              tab === "tasks" ? "Things needing you" : "Saved form answers"
            }
            noun={tab === "tasks" ? "item" : "answer"}
            rows={rows}
            total={total}
            // Until every site page is read the merged count is unknown:
            // "Select all matching", never the raw sign-in count.
            totalCapped={
              list.totalCapped || sites.totalCapped || sitesUnresolved
            }
            loading={list.loading}
            error={list.error}
            onRetry={() => {
              // List, site rows and counts recover together: the summary
              // and tabs never stay behind the rows they describe.
              void list.refresh();
              void sites.refresh();
              refreshCounts.current();
            }}
            hasMore={
              !editing &&
              (list.nextCursor !== null ||
                (sitesOpen && sites.nextCursor !== null))
            }
            onLoadMore={() =>
              void (list.nextCursor !== null || !showSites
                ? list.loadMore()
                : sites.loadMore())
            }
            footer={footer}
            selection={visibleSelection}
            selectedCount={selectedCount}
            counting={visibleSelection.all && sitesPending}
            countText={
              visibleSelection.all && sitesFailed ? "Couldn’t count" : undefined
            }
            onSelectionChange={setSelection}
            summary={summary}
            toolbar={
              <Input
                id="needs-you-filter"
                aria-label="Filter Needs you"
                className="h-8 min-w-0 flex-1"
                type="search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Find a question  /"
              />
            }
            bulkActions={
              tab === "tasks" ? (
                visibleSelection.all && sitesFailed ? (
                  // A site page failed: the sign-ins it holds are not
                  // counted, so nothing starts until they are.
                  <span className="flex items-center gap-2" role="alert">
                    <span className="hidden truncate text-(length:--text-small) text-(--warning-text) @2xl/listbar:inline">
                      Couldn’t read every job site
                    </span>
                    <Button
                      onClick={() => void sites.loadMore()}
                      size="toolbar"
                      title={sites.error ?? undefined}
                      variant="outline"
                    >
                      Try again
                    </Button>
                  </span>
                ) : workError ? (
                  // The full selection could not be read: say so here,
                  // with the way on, rather than start a part of it.
                  <span className="flex items-center gap-2" role="alert">
                    <span className="hidden truncate text-(length:--text-small) text-(--warning-text) @2xl/listbar:inline">
                      Couldn’t read every selected item
                    </span>
                    <Button
                      onClick={() => void startWork()}
                      size="toolbar"
                      title={workError}
                      variant="outline"
                    >
                      Try again
                    </Button>
                  </span>
                ) : (
                  <Button
                    aria-label={`Work through ${plural(selectedCount, "selected item", "selected items")}`}
                    disabled={
                      resolvingWork || (visibleSelection.all && sitesPending)
                    }
                    pending={resolvingWork}
                    size="toolbar"
                    onClick={() => void startWork()}
                  >
                    {visibleSelection.all && sitesPending
                      ? "Work through"
                      : `Work through ${selectedCount.toLocaleString()}`}
                  </Button>
                )
              ) : (
                <Button
                  aria-label={`Forget ${plural(selectedCount, "selected answer", "selected answers")}`}
                  size="toolbar"
                  variant="outline"
                  pending={busy}
                  disabled={
                    busy ||
                    resolvedSelection.pending ||
                    Boolean(resolvedSelection.error)
                  }
                  onClick={() => {
                    setBusy(true);
                    void forget(
                      selection.all
                        ? list.rows
                            .filter((row) =>
                              isSelected(visibleSelection, row.id),
                            )
                            .map((row) => row.id)
                        : [...visibleSelection.ids],
                      selection.all,
                    )
                      .catch((error) =>
                        showToast({
                          title: describeError(error),
                          tone: "warning",
                        }),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  {`Forget ${selectedCount.toLocaleString()}`}
                </Button>
              )
            }
            empty={
              text ? (
                <ListEmpty
                  action={{ label: "Clear filter", onClick: () => setText("") }}
                  title={`Nothing matches “${text.trim()}”`}
                />
              ) : tab === "tasks" && readyCount > 0 ? (
                <div
                  className="grid justify-items-start gap-3"
                  data-needs-ready-summary
                >
                  <p>
                    Nothing is blocked.{" "}
                    {readyCount === 1 && !ready.more
                      ? "1 application is"
                      : `${readyLabel} applications are`}{" "}
                    filled in and waiting for your Send, listed below.
                  </p>
                  <Button
                    onClick={() => openReady(ready.rows[0]!.id)}
                    size="sm"
                  >
                    Review and send
                  </Button>
                </div>
              ) : tab === "tasks" ? (
                <ListEmpty
                  action={{
                    label: "See applications",
                    onClick: () => void navigateTo("/job-finder/applications"),
                  }}
                  detail="When a form asks something your profile cannot answer, or a site needs you to sign in, it waits here. Applications keep running meanwhile."
                  title="You're all caught up"
                />
              ) : (
                <ListEmpty
                  action={{
                    label: "Add answer",
                    onClick: () => {
                      setCreating(true);
                      setEditing(false);
                      setSelection(NO_SELECTION);
                    },
                  }}
                  detail="Answers you save fill the same question on later forms. Save one from a question, or add one now."
                  title="No saved answers yet"
                />
              )
            }
            renderRow={(row, state) =>
              isSite(row) ? (
                <Fragment key={row.id}>
                  {row.id === siteRows[0]?.id ? sitesHeader(true) : null}
                  <ListRowFrame
                    {...state}
                    id={row.id}
                    title={`Sign in to ${row.label}`}
                    meta={
                      row.tasks.length > 1
                        ? // Sign-ins, the unit of the items: the group
                          // header counts job sites (hosts), so "51 sites"
                          // under "2 job sites" read as a contradiction.
                          `${row.host} · ${row.tasks.length.toLocaleString()} sign-ins`
                        : row.host
                    }
                    status={
                      {
                        checking: "Checking…",
                        still: "Still can't read it",
                        none: "Search couldn't read this site",
                      }[
                        siteCheck(
                          checks,
                          row.tasks.map((task) => task.id),
                        ) ?? "none"
                      ]
                    }
                    onActivate={openRow}
                    onToggle={toggle}
                  />
                </Fragment>
              ) : (
                <Fragment key={row.id}>
                  {showGroups &&
                  siteRows.length > 0 &&
                  row.id === list.rows[0]?.id ? (
                    <GroupHeader
                      group="applications"
                      inList
                      label={`Holding up applications (${list.total.toLocaleString()})`}
                    />
                  ) : null}
                  <ListRowFrame
                    key={row.id}
                    {...state}
                    id={row.id}
                    title={row.prompt}
                    meta={
                      "source" in row && row.source
                        ? row.source.label
                        : "waitingFor" in row && row.waitingFor
                          ? waitingLabel(row.waitingFor)
                          : [row.scope.country, row.scope.siteOrigin]
                              .filter(Boolean)
                              .join(" · ") ||
                            ("preview" in row
                              ? "Reusable answer"
                              : "Application")
                    }
                    trailing={
                      "preview" in row
                        ? undefined
                        : siteName(row.source?.url ?? row.scope.siteOrigin)
                    }
                    status={
                      "preview" in row
                        ? row.needsConfirmation
                          ? "Review saved answer"
                          : row.preview
                        : row.blockedUrl
                          ? "Blocked"
                          : KIND[row.kind]
                    }
                    onActivate={openRow}
                    onToggle={toggle}
                  />
                </Fragment>
              )
            }
          />
        }
        detail={
          // As a sheet, one card: Back and the item share the frame (the
          // item's own border and corners went inside the sheet's, two
          // nested cards with the outer corners showing above).
          <div className="flex min-h-0 min-w-0 flex-1 flex-col stacked:overflow-hidden stacked:rounded-(--radius-panel) stacked:border stacked:border-(--surface-panel-border) stacked:bg-(--surface-panel-shell) [&>*:last-child]:flex-1 stacked:[&>section]:rounded-none stacked:[&>section]:border-0">
            <DetailSheetBack onBack={sheet.close} />
            {tab === "saved" && creating ? (
              <CreateAnswerPane
                onEditing={setEditing}
                onCreated={(value) => {
                  setCreating(false);
                  setEditing(false);
                  pinned.current = value.id;
                  setActiveId(value.id);
                  showToast({
                    title: "Answer saved for future forms.",
                    tone: "success",
                  });
                  void list.refresh();
                }}
              />
            ) : activeId === null ? (
              <EmptyPane
                label="Details"
                list={besideList({
                  rows,
                  loading: list.loading,
                  error: list.error,
                })}
              >
                Pick an item to see it here.
              </EmptyPane>
            ) : tab === "tasks" && site ? (
              <section
                id="list-detail"
                aria-label="Site sign-in"
                data-needs-detail-id={activeId}
                className="surface-panel-shell overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
              >
                <SourceNeedPane
                  key={site.id}
                  check={siteCheck(
                    checks,
                    site.tasks.map((task) => task.id),
                  )}
                  host={site.host}
                  site={toWorkItem(site)}
                />
              </section>
            ) : tab === "tasks" ? (
              <TaskPane
                key={`task:${activeId}`}
                id={activeId}
                onEditing={setEditing}
                onMissing={missing}
                onResolved={resolved}
              />
            ) : (
              <SavedAnswerPane
                key={`answer:${activeId}`}
                id={activeId}
                onEditing={setEditing}
                onMissing={missing}
                onSaved={(message) => {
                  showToast({ title: message, tone: "success" });
                  void list.refresh();
                }}
                onForget={forget}
              />
            )}
          </div>
        }
      />
    </LockedScreenLayout>
  );
}
