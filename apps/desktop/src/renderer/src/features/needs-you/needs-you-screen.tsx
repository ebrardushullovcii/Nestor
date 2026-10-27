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
import { useLocation, useSearchParams } from "react-router-dom";
import { useAssistantNeedsView } from "@renderer/features/job-lists/use-assistant-list-view";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import {
  countSelected,
  isSelected,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  selectAll,
  toggleSelection,
  useListKeys,
  useStoreList,
  type ListSelection,
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
  question: "Your answer",
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
  const pinned = useRef<number | null>(null);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
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
          if (live) setCounts(value);
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
    void refresh();
    return () => {
      live = false;
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
  const siteCount = sites.nextCursor === null ? siteRows.length : sites.total;
  const ready = useReadyForms();
  const { walk, checks } = useWorkThrough();
  const walkItem = currentWorkItem(walk);
  const walkThroughState = useRef(walk);
  walkThroughState.current = walk;
  useEffect(() => {
    setActiveId(null);
    setSelection(NO_SELECTION);
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

  const activate = useCallback((id: number) => {
    setEditing(false);
    setActiveId(id);
    pinned.current = null;
    setCreating(false);
  }, []);
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
  const total = list.total + (tab === "tasks" ? sites.total : 0);
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
    selectAll: () => setSelection(selectAll()),
    clearSelection: () => setSelection(NO_SELECTION),
    loadMore: () =>
      void (list.nextCursor !== null || !showSites
        ? list.loadMore()
        : sites.loadMore()),
    filterSelector: "#needs-you-filter",
  });
  const latest = useRef({ list, rows, selection: visibleSelection, activeId });
  latest.current = { list, rows, selection: visibleSelection, activeId };
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
      showToast({ title: message });
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
      title: `${forgotten} saved ${forgotten === 1 ? "answer" : "answers"} forgotten.`,
    });
    void list.refresh();
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
      label={`${plural(siteCount, "job site needs", "job sites need")} you to sign in`}
      onToggle={() => setSitesExpanded(!sitesOpen)}
      open={sitesOpen}
    />
  );
  const showGroups = tab === "tasks" && !text;
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
              label={`Ready for you to send (${readyLabel})`}
            />
            <ul className="m-0 grid list-none p-0">
              {ready.rows.map((row) => (
                <li className="pl-10" key={row.id}>
                  <button
                    className={cn(
                      jobFinderListRowClassName,
                      "w-full text-left hover:bg-(--accent)",
                    )}
                    onClick={() => openReady(row.id)}
                    title="Open the filled form to review and send"
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
                      <span
                        className={cn(
                          jobFinderListRowStatusClassName,
                          "text-foreground-soft",
                        )}
                      >
                        Filled in. Review it and send.
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
      lockContentHeight
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
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "tasks", label: `Needs you ${totalTasks}` },
              { value: "saved", label: `Saved answers ${counts.saved}` },
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
          {list.error ? <p role="alert">{list.error}</p> : null}
          {resolvedSelection.error ? (
            <p role="alert">{resolvedSelection.error}</p>
          ) : null}
        </div>
      }
    >
      <ListDetailLayout
        list={
          <ListPane<Item>
            activeId={activeId}
            label={
              tab === "tasks" ? "Things needing you" : "Saved form answers"
            }
            noun={tab === "tasks" ? "item" : "answer"}
            rows={rows}
            total={total}
            totalCapped={list.totalCapped || sites.totalCapped}
            loading={list.loading}
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
            onSelectAll={() => setSelection(selectAll())}
            onClearSelection={() => setSelection(NO_SELECTION)}
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
                <Button
                  size="toolbar"
                  onClick={() => {
                    const items = [...list.rows, ...siteRows]
                      .filter((row) => isSelected(selection, row.id))
                      .map((row) => toWorkItem(row as NeedsYouTask | SiteRow));
                    setSelection(NO_SELECTION);
                    workThrough.start(items);
                  }}
                >
                  Work through selected
                </Button>
              ) : (
                <Button
                  size="toolbar"
                  variant="outline"
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
                  Forget selected
                </Button>
              )
            }
            empty={
              text ? (
                "No matching questions or answers."
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
                    filled in and waiting for your Send.
                  </p>
                  <Button
                    onClick={() => openReady(ready.rows[0]!.id)}
                    size="sm"
                  >
                    Review and send
                  </Button>
                </div>
              ) : tab === "tasks" ? (
                "You're all caught up. Applications keep running in the background."
              ) : (
                "No saved answers yet. Choose Save this answer for next time when a form needs you."
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
                        ? `${row.host} · ${row.tasks.length} sites`
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
                    onActivate={activate}
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
                    onActivate={activate}
                    onToggle={toggle}
                  />
                </Fragment>
              )
            }
          />
        }
        detail={
          tab === "saved" && creating ? (
            <CreateAnswerPane
              onEditing={setEditing}
              onCreated={(value) => {
                setCreating(false);
                setEditing(false);
                pinned.current = value.id;
                setActiveId(value.id);
                showToast({ title: "Answer saved for future forms." });
                void list.refresh();
              }}
            />
          ) : activeId === null ? (
            <section
              id="list-detail"
              className="surface-panel-shell rounded-(--radius-panel) border border-(--surface-panel-border) p-5 text-sm text-foreground-soft"
            >
              Choose an item to see it here.
            </section>
          ) : tab === "tasks" && site ? (
            <section
              id="list-detail"
              aria-label="Source sign-in"
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
                showToast({ title: message });
                void list.refresh();
              }}
              onForget={forget}
            />
          )
        }
      />
    </LockedScreenLayout>
  );
}
