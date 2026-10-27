import type {
  JobSelectionInput,
  ShortlistedPage,
  ShortlistedRow,
} from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { useAssistantContextSource } from "@renderer/features/job-finder/assistant/assistant-provider";
import {
  countSelected,
  isSelected,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  plural,
  selectAll,
  toggleSelection,
  useListKeys,
  useStoreList,
  type ListSelection,
} from "@renderer/features/job-lists";

import { describeResume, LEVEL_LABEL } from "./resume-format";
import { ResumePane } from "./resume-pane";
import { describeError, useResume } from "./use-resume";
import { useAssistantListView } from "../job-lists/use-assistant-list-view";
import { useEffectWhileKeptRouteShown } from "../job-finder/lib/kept-route-visibility";

type Tab = "shortlisted" | "resume";

const FILTER_ID = "shortlisted-filter";

/**
 * Shortlisted: every shortlisted job's resume is written as soon as it lands
 * here. Read each one, edit it if you like, and approve it; Apply takes the
 * approved ones at once.
 */
function needApproval(count: number): string {
  return `${plural(count, "job")} need${count === 1 ? "s" : ""} an approved resume`;
}

export function ShortlistedScreen() {
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const navigationKey = useLocation().key;
  // `?tab=approved` opens the Approved list (Home's "Apply to approved jobs").
  const [tab, setTab] = useState<Tab>(() =>
    searchParams.get("tab") === "approved" ? "resume" : "shortlisted",
  );
  const [text, setText] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const [busy, setBusy] = useState<"approve" | "apply" | "move" | null>(null);
  const approvalPending = useRef(false);
  const requestedApproved = searchParams.get("tab") === "approved";
  useEffectWhileKeptRouteShown(() => {
    if (!requestedApproved) return;
    setTab("resume");
    setText("");
    setSelection(NO_SELECTION);
  }, [requestedApproved, navigationKey]);
  const view = useResume(activeId);
  const list = useStoreList<ShortlistedRow>({
    key: JSON.stringify([tab, text]),
    load: ({ cursor, limit }) =>
      window.nestor.resumes.run("list_shortlisted", {
        stage: tab,
        text,
        sort: "recent",
        cursor,
        limit,
      }),
    refreshOn: (change) =>
      change.stages.includes("shortlisted") || change.stages.includes("resume"),
  });
  const selectedCount = countSelected(selection, list.total);

  // A job asked for by link (`?jobId=`) stays open in its own tab.
  const linkedJob = Number(searchParams.get("jobId") ?? "");
  const pinnedId = useRef<number | null>(null);
  useEffect(() => {
    if (!Number.isInteger(linkedJob) || linkedJob <= 0) return;
    void window.nestor.jobs.run("get_job", { id: linkedJob }).then((job) => {
      if (job?.stage !== "shortlisted" && job?.stage !== "resume") return;
      pinnedId.current = job.id;
      setActiveId(job.id);
      setTab(job.stage);
      setText("");
    });
  }, [linkedJob, navigationKey]);

  // A new list starts with nothing ticked and its first (or linked) job open.
  useEffect(() => {
    setSelection(NO_SELECTION);
    setActiveId(pinnedId.current);
    pinnedId.current = null;
  }, [tab, text]);
  // When the open job leaves this tab (sent, moved or approved elsewhere),
  // the one after it opens, or nothing when the tab is empty. A linked job
  // that isn't among the loaded rows stays open.
  const shownRows = useRef<readonly ShortlistedRow[]>([]);
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
    current: { stage: tab, text },
    applyView(view) {
      const nextTab = view.stage ?? tab;
      if (nextTab !== "shortlisted" && nextTab !== "resume") return false;
      const changed =
        nextTab !== tab || (view.text !== undefined && view.text !== text);
      setTab(nextTab);
      if (view.text !== undefined) setText(view.text);
      return changed;
    },
  });

  const latest = useRef({ list, activeId, view, selection, tab, text, busy });
  latest.current = { list, activeId, view, selection, tab, text, busy };
  useAssistantContextSource("shortlisted", () => {
    const { list, activeId, view, selection, tab, text } = latest.current;
    return {
      screen: "review_queue",
      focus:
        activeId === null
          ? null
          : {
              kind: "job",
              id: String(activeId),
              label: view.job?.title ?? null,
            },
      list: {
        listKind: "shortlist",
        selectedIds: list.rows
          .filter((row) => isSelected(selection, row.id))
          .map((row) => String(row.id)),
        displayedIds: list.rows.map((row) => String(row.id)),
        filteredIds: [],
        totalFilteredCount: list.total,
        filterSummary: JSON.stringify({
          stage: tab,
          text,
          allSelected: selection.all,
          except: selection.all ? [...selection.ids] : [],
        }),
        campaignId: null,
      },
      editor:
        activeId === null
          ? null
          : {
              editor: "resume",
              draftId: view.draft?.id ?? null,
              draftVersion: 0,
              selection: null,
              jobId: String(activeId),
              savedRevision: view.resume?.updatedAt ?? null,
              hasUnsavedEdits:
                view.dirty ||
                view.saveStatus === "saving" ||
                view.saveStatus === "failed",
              mode: view.resume?.level === "original" ? "original" : "editable",
            },
    };
  });

  /** The ticked jobs, or the open one when none are ticked. */
  const target = useCallback((): JobSelectionInput | null => {
    const { selection, activeId, tab, text } = latest.current;
    if (selection.all)
      return { filter: { stage: tab, text }, except: [...selection.ids] };
    if (selection.ids.size > 0) return { ids: [...selection.ids] };
    return activeId !== null ? { ids: [activeId] } : null;
  }, []);

  /** The job to open after `gone` leave the list: the next one still here. */
  const nextAfter = useCallback((gone: (id: number) => boolean) => {
    const { list, activeId } = latest.current;
    const index = list.rows.findIndex((row) => row.id === activeId);
    return (
      list.rows.slice(index + 1).find((row) => !gone(row.id)) ??
      [...list.rows].reverse().find((row) => !gone(row.id)) ??
      null
    );
  }, []);

  /** Approves the open resume, or the ticked ones, and opens the next. */
  const approve = useCallback(async () => {
    const { activeId, view, selection, tab, text, busy } = latest.current;
    if (busy !== null || approvalPending.current) return;
    const ticked = selection.all || selection.ids.size > 0;
    if (!ticked && (activeId === null || view.resume?.state !== "ready"))
      return;
    approvalPending.current = true;
    setBusy("approve");
    const approved: number[] = [];
    try {
      if (
        view.job &&
        (ticked ? isSelected(selection, view.job.id) : view.job.id === activeId)
      )
        await view.flush();
      const ids: number[] = [];
      if (selection.all) {
        // Resolve the selection before any approval moves rows or changes a cursor.
        let cursor: string | null = null;
        do {
          const page: ShortlistedPage = await window.nestor.resumes.run(
            "list_shortlisted",
            {
              stage: tab,
              text,
              sort: "recent",
              cursor,
              limit: 200,
            },
          );
          for (const row of page.rows)
            if (isSelected(selection, row.id) && row.resume?.state === "ready")
              ids.push(row.id);
          cursor = page.nextCursor;
        } while (cursor !== null);
      } else if (ticked) {
        for (const id of selection.ids) {
          const candidate = await window.nestor.resumes.run("get_resume", {
            jobId: id,
          });
          if (
            candidate.job.stage === tab &&
            candidate.resume?.state === "ready"
          )
            ids.push(id);
        }
      } else if (activeId !== null) ids.push(activeId);
      if (ids.length === 0)
        showToast({
          title: "No resumes are ready to approve yet",
          description: "They stay in To review.",
        });
      for (const id of ids) {
        await window.nestor.resumes.run("approve_resume", { jobId: id });
        approved.push(id);
      }
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    } finally {
      const gone = new Set(approved);
      const next = nextAfter((id) => gone.has(id));
      latest.current.list.removeRows((id) => gone.has(id));
      setActiveId(next?.id ?? null);
      setSelection(NO_SELECTION);
      setBusy(null);
      approvalPending.current = false;
      if (approved.length > 0)
        showToast({
          id: "shortlisted-approve",
          title:
            approved.length === 1 && !ticked
              ? `Approved ${view.job?.title ?? "the resume"}`
              : `Approved ${plural(approved.length, "resume")}`,
          description: "Apply can take it now, from Approved.",
        });
    }
  }, [nextAfter, showToast]);

  const apply = useCallback(
    async (everything = false) => {
      const input: JobSelectionInput | null = everything
        ? { filter: { stage: "resume", text: latest.current.text }, except: [] }
        : target();
      if (!input) return;
      setBusy("apply");
      try {
        const result = await window.nestor.jobFinder.applyJobs({
          selection: input,
        });
        setSelection(NO_SELECTION);
        showToast({
          id: "shortlisted-apply",
          title:
            result.queued > 0
              ? `Applying to ${plural(result.queued, "job")}`
              : result.unchanged > 0
                ? "Those jobs are already being applied to"
                : needApproval(result.notApproved),
          description:
            result.queued === 0 && result.unchanged === 0
              ? "Approve a resume, then apply."
              : result.notApproved > 0
                ? `${needApproval(result.notApproved)} and stayed here.`
                : "Each one moves to Applications once it is sent.",
        });
      } catch (error) {
        showToast({ title: describeError(error), tone: "warning" });
      } finally {
        setBusy(null);
      }
    },
    [showToast, target],
  );

  /** Sends the ticked jobs, or the open one, back to Find jobs, with Undo. */
  const moveBack = useCallback(async () => {
    const input = target();
    if (!input) return;
    const gone = (id: number) =>
      "ids" in input
        ? input.ids.includes(id)
        : !(input.except ?? []).includes(id);
    const next = nextAfter(gone);
    latest.current.list.removeRows(gone);
    setActiveId(next?.id ?? null);
    setSelection(NO_SELECTION);
    setBusy("move");
    try {
      const result = await window.nestor.jobs.run("move_jobs", {
        selection: input,
        to: "found",
      });
      const { moveId } = result;
      // The rows left at once; if the store moved none, show what it holds.
      if (result.moved === 0) void latest.current.list.refresh();
      showToast({
        id: "shortlisted-move",
        title: `Moved ${plural(result.moved, "job")} back to Find jobs`,
        ...(moveId !== null
          ? {
              action: {
                label: "Undo",
                onClick: () =>
                  void window.nestor.jobs.run("undo_move", { moveId }),
              },
            }
          : {}),
      });
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
      void latest.current.list.refresh();
    } finally {
      setBusy(null);
    }
  }, [nextAfter, showToast, target]);

  useListKeys({
    rows: list.rows,
    activeId,
    setActiveId,
    toggle: (id, shiftKey) =>
      setSelection((current) =>
        toggleSelection(current, id, shiftKey, list.rows),
      ),
    selectAll: () => setSelection(selectAll()),
    clearSelection: () => setSelection(NO_SELECTION),
    loadMore: () => void list.loadMore(),
    filterSelector: `#${FILTER_ID}`,
  });
  // Ctrl+Enter approves and opens the next one, even while editing: the edit
  // is saved first.
  useEffectWhileKeptRouteShown(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      if (latest.current.tab !== "shortlisted") return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-assistant-sidebar]")
      )
        return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      void approve();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve]);

  const toggle = (id: number, shiftKey: boolean) =>
    setSelection((current) =>
      toggleSelection(current, id, shiftKey, list.rows),
    );
  const toReview = list.counts.shortlisted;
  const approved = list.counts.resume;

  return (
    <LockedScreenLayout
      contentClassName="xl:overflow-hidden"
      lockContentHeight
      topContent={
        <div className="grid gap-3">
          <PageHeader
            actions={
              tab === "resume" && approved > 0 ? (
                <Button
                  disabled={busy !== null}
                  onClick={() => void apply(selectedCount === 0)}
                  pending={busy === "apply"}
                  size="toolbar"
                >
                  {selectedCount > 0
                    ? `Apply to ${plural(selectedCount, "job")}`
                    : `Apply to all ${plural(approved, "job")}`}
                </Button>
              ) : null
            }
            description={
              tab === "shortlisted"
                ? "Resumes write themselves as jobs arrive. Read, edit if you like, approve."
                : "Approved resumes. Apply takes them from here."
            }
            title="Shortlisted"
          />
          <SegmentedControl<Tab>
            className="self-start"
            label="Which shortlisted jobs"
            onValueChange={setTab}
            options={[
              { value: "shortlisted", label: `To review ${toReview}` },
              { value: "resume", label: `Approved ${approved}` },
            ]}
            value={tab}
          />
        </div>
      }
    >
      <ListDetailLayout
        state={{
          stage: tab,
          text,
          selectedIds: [...selection.ids],
          all: selection.all,
        }}
        detail={
          <ResumePane
            applying={busy === "apply"}
            approving={busy === "approve"}
            onApply={() => void apply()}
            onApprove={() => void approve()}
            onMoveBack={() => void moveBack()}
            view={view}
          />
        }
        list={
          <ListPane<ShortlistedRow>
            activeId={activeId}
            bulkActions={
              <>
                <Button
                  disabled={busy !== null}
                  onClick={() => void moveBack()}
                  size="toolbar"
                  variant="outline"
                >
                  Move back
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void (tab === "shortlisted" ? approve() : apply())
                  }
                  size="toolbar"
                >
                  {tab === "shortlisted" ? "Approve" : "Apply"}
                </Button>
              </>
            }
            empty={
              text
                ? "No shortlisted job matches."
                : tab === "shortlisted"
                  ? "Nothing to review. Shortlist jobs in Find jobs and their resumes start writing here."
                  : "No approved resumes yet. Approve one in To review."
            }
            hasMore={list.nextCursor !== null}
            label={
              tab === "shortlisted" ? "Resumes to review" : "Approved resumes"
            }
            loading={list.loading}
            onClearSelection={() => setSelection(NO_SELECTION)}
            onLoadMore={() => void list.loadMore()}
            onSelectAll={() => setSelection(selectAll())}
            renderRow={(row, state) => {
              const status = describeResume(row.resume);
              return (
                <ListRowFrame
                  active={state.active}
                  badge={
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  }
                  checked={state.checked}
                  id={row.id}
                  key={row.id}
                  meta={[row.company, row.location].filter(Boolean).join(" · ")}
                  onActivate={setActiveId}
                  onToggle={toggle}
                  status={row.resume ? LEVEL_LABEL[row.resume.level] : null}
                  title={row.title}
                />
              );
            }}
            rows={list.rows}
            selectedCount={selectedCount}
            selection={selection}
            toolbar={
              <Input
                aria-label="Find a shortlisted job"
                className="h-8 min-w-0 flex-1"
                id={FILTER_ID}
                onChange={(event) => setText(event.target.value)}
                placeholder="Find a job"
                type="search"
                value={text}
              />
            }
            total={list.total}
            totalCapped={list.totalCapped}
          />
        }
      />
    </LockedScreenLayout>
  );
}
