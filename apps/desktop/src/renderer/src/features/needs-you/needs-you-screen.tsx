import { CreateAnswerPane } from "./create-answer-pane";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
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

type Item = NeedsYouTask | SavedFormAnswerSummary;
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
  useEffect(() => {
    setActiveId(null);
    setSelection(NO_SELECTION);
    setEditing(false);
    setCreating(false);
    pinned.current = null;
  }, [tab, text, kind]);
  useEffect(() => {
    if (
      pinned.current !== null &&
      pinned.current === activeId &&
      !list.rows.some((row) => row.id === activeId)
    )
      return;
    pinned.current = null;
    if (
      !creating &&
      !editing &&
      !list.loading &&
      (activeId === null || !list.rows.some((row) => row.id === activeId))
    )
      setActiveId(list.rows[0]?.id ?? null);
  }, [activeId, creating, editing, list.loading, list.rows]);

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
  const toggle = (id: number, shift: boolean) =>
    setSelection((value) => toggleSelection(value, id, shift, list.rows));
  const resolvedSelection = useNeedsSelection({
    selection,
    setSelection,
    rows: list.rows,
    loading: list.loading,
    tab,
    text,
    kind,
  });
  const visibleSelection = resolvedSelection.selection;
  const selectedCount = countSelected(visibleSelection, list.total);
  const missing = useCallback((id: number) => {
    if (pinned.current === id) pinned.current = null;
    setActiveId((current) => (current === id ? null : current));
  }, []);
  const active = list.rows.find((row) => row.id === activeId);
  const source = active && "source" in active ? active.source : undefined;
  useListKeys({
    rows: list.rows,
    activeId,
    setActiveId: activate,
    toggle,
    selectAll: () => setSelection(selectAll()),
    clearSelection: () => setSelection(NO_SELECTION),
    loadMore: () => void list.loadMore(),
    filterSelector: "#needs-you-filter",
  });
  const latest = useRef({ list, selection: visibleSelection, activeId });
  latest.current = { list, selection: visibleSelection, activeId };
  const resolved = useCallback(
    (id: number, message: string) => {
      const { list, selection } = latest.current;
      const next =
        list.rows.find(
          (row) => row.id !== id && isSelected(selection, row.id),
        ) ??
        list.rows.find((row) => row.id > id) ??
        list.rows.find((row) => row.id !== id);
      list.removeRows((value) => value === id);
      setActiveId(next?.id ?? null);
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
            rows={list.rows}
            total={list.total}
            totalCapped={list.totalCapped}
            loading={list.loading}
            hasMore={!editing && list.nextCursor !== null}
            onLoadMore={() => void list.loadMore()}
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
                    const first = list.rows.find((row) =>
                      isSelected(selection, row.id),
                    );
                    if (first) activate(first.id);
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
              text
                ? "No matching questions or answers."
                : tab === "tasks"
                  ? "You're all caught up. Applications keep running in the background."
                  : "No saved answers yet. Choose Save this answer for next time when a form needs you."
            }
            renderRow={(row, state) => (
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
                        ("preview" in row ? "Reusable answer" : "Application")
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
            )}
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
          ) : tab === "tasks" && source ? (
            <section
              id="list-detail"
              aria-label="Source sign-in"
              data-needs-detail-id={activeId}
              className="surface-panel-shell overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
            >
              <SourceNeedPane key={source.id} source={source} />
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
