import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NeedsYouCounts,
  NeedsYouTask,
  SavedFormAnswerSummary,
} from "@nestor/contracts";
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

export function NeedsYouScreen() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<"tasks" | "saved">("tasks");
  const [text, setText] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useStoreList<Item, NeedsYouCounts>({
    key: JSON.stringify([tab, text]),
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
        });
        return {
          ...page,
          nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
        };
      }
      const [page, counts] = await Promise.all([
        window.nestor.needsYou.run("list_form_answers", { after, limit, text }),
        window.nestor.needsYou.run("needs_you_counts", {}),
      ]);
      return {
        ...page,
        counts,
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
      };
    },
  });
  useEffect(() => {
    setActiveId(null);
    setSelection(NO_SELECTION);
    setEditing(false);
  }, [tab, text]);
  useEffect(() => {
    if (
      !editing &&
      !list.loading &&
      (activeId === null || !list.rows.some((row) => row.id === activeId))
    )
      setActiveId(list.rows[0]?.id ?? null);
  }, [activeId, editing, list.loading, list.rows]);

  const activate = useCallback((id: number) => {
    setEditing(false);
    setActiveId(id);
  }, []);
  const toggle = (id: number, shift: boolean) =>
    setSelection((value) => toggleSelection(value, id, shift, list.rows));
  const selectedCount = countSelected(selection, list.total);
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
  const latest = useRef({ list, selection, activeId });
  latest.current = { list, selection, activeId };
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
    const forgotten = await window.nestor.needsYou.run(
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
    list.counts.question +
    list.counts.sign_in +
    list.counts.captcha +
    list.counts.mfa;
  return (
    <LockedScreenLayout
      lockContentHeight
      topContent={
        <div className="grid gap-3 pb-4">
          <PageHeader
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
              { value: "saved", label: `Saved answers ${list.counts.saved}` },
            ]}
          />
          {list.error ? <p role="alert">{list.error}</p> : null}
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
            selection={selection}
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
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void forget(
                      list.rows
                        .filter((row) => isSelected(selection, row.id))
                        .map((row) => row.id),
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
                    ? `${row.source.label} · ${row.source.url}`
                    : [row.scope.country, row.scope.siteOrigin]
                        .filter(Boolean)
                        .join(" · ") ||
                      ("kind" in row ? "Application" : "Reusable answer")
                }
                status={"kind" in row ? KIND[row.kind] : row.preview}
                onActivate={activate}
                onToggle={toggle}
              />
            )}
          />
        }
        detail={
          activeId === null ? (
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
              className="surface-panel-shell overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
            >
              <SourceNeedPane key={source.id} source={source} />
            </section>
          ) : tab === "tasks" ? (
            <TaskPane
              key={`task:${activeId}`}
              id={activeId}
              onEditing={setEditing}
              onResolved={resolved}
            />
          ) : (
            <SavedAnswerPane
              key={`answer:${activeId}`}
              id={activeId}
              onEditing={setEditing}
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
