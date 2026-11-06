import { cn } from "@renderer/lib/cn";
import type {
  JobSelectionInput,
  ShortlistedPage,
  ShortlistedRow,
} from "@nestor/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { useToast } from "@renderer/components/ui/toast";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { useAssistantContextSource } from "@renderer/features/job-finder/assistant/assistant-provider";
import {
  isSelected,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  clearSelected,
  CountFigure,
  countText,
  plural,
  stepSelectAll,
  toggleSelection,
  useDetailSheet,
  useListKeys,
  useSelectAllCount,
  useStoreList,
  type ListRowState,
  type ListSelection,
  besideList,
} from "@renderer/features/job-lists";

import {
  APPLICATION_BADGE,
  describeResume,
  LEVEL_HINT,
  LEVEL_LABEL,
} from "./resume-format";
import { ResumePane } from "./resume-pane";
import { describeError, useResume } from "./use-resume";
import { ListEmpty } from "../job-lists/list-empty";
import { useAssistantListView } from "../job-lists/use-assistant-list-view";
import { useEffectWhileKeptRouteShown } from "../job-finder/lib/kept-route-visibility";
import { applyFailureLine } from "../applications/apply-failure";

type Tab = "shortlisted" | "resume";

const FILTER_ID = "shortlisted-filter";

/**
 * Shortlisted: every shortlisted job's resume is written as soon as it lands
 * here. Read each one, edit it if you like, approve it if you like; Apply
 * takes any written resume, approved or not, from either tab.
 */
function notReady(count: number): string {
  return `${plural(count, "resume")} still being written`;
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
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // The paper needs its width: beside a narrowed list where the split can
  // give it complete lines at a readable scale, and as a sheet over the list
  // where it cannot (1024 wide, or beside the docked assistant).
  const reading = useReadingLayout();
  const sheet = useDetailSheet({ always: reading.sheet });
  // The window narrows (or the assistant docks) while a resume is read
  // beside the list: the resume stays in front, now as the sheet.
  const readingWas = useRef<boolean | null>(null);
  const { setOpen: setSheetOpen } = sheet;
  useEffect(() => {
    if (!reading.measured) return;
    const was = readingWas.current;
    readingWas.current = reading.sheet;
    if (was === false && reading.sheet && activeIdRef.current !== null)
      setSheetOpen(true);
  }, [reading.measured, reading.sheet, setSheetOpen]);
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
  const {
    selectedCount,
    counting,
    total: matching,
    totalCapped,
  } = useSelectAllCount({
    key: JSON.stringify([tab, text, list.counts[tab]]),
    selection,
    total: list.total,
    totalCapped: list.totalCapped,
    count: () =>
      window.nestor.jobs
        .run("count_jobs", { stage: tab, text })
        .then((result) => result.total),
  });
  const selectedText = `${selectedCount.toLocaleString()}${
    totalCapped && selection.all ? "+" : ""
  }`;
  // Ticked resumes still being written cannot be approved yet. Counted over
  // explicit ticks (every ticked row is loaded); "all matching" is checked
  // when it runs, and those still writing stay in To review.
  const stillWriting =
    tab === "shortlisted" && !selection.all
      ? list.rows.filter(
          (row) => selection.ids.has(row.id) && row.resume?.state !== "ready",
        ).length
      : 0;
  const approvable = selection.all
    ? selectedCount
    : Math.max(0, selectedCount - stillWriting);

  // Arriving with nothing to review while approved jobs wait opens Approved,
  // where the jobs are. A link, a tab or an Assistant view chooses for itself.
  const [arriving, setArriving] = useState(false);
  const choosesTab =
    requestedApproved || searchParams.has("jobId") || searchParams.has("jobs");
  useEffectWhileKeptRouteShown(() => {
    if (!choosesTab) setArriving(true);
  }, [choosesTab, navigationKey]);
  useEffect(() => {
    if (!arriving || list.loading) return;
    setArriving(false);
    if (
      tab === "shortlisted" &&
      text === "" &&
      list.counts.shortlisted === 0 &&
      list.counts.resume > 0
    )
      setTab("resume");
  }, [arriving, list.loading, list.counts, tab, text]);

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

  // A new list starts with nothing ticked (still in select mode, if it was)
  // and its first (or linked) job open.
  useEffect(() => {
    setSelection(clearSelected);
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
        // Name the tab and both counts: an empty tab is not a filter.
        filterSummary: JSON.stringify({
          stage: tab,
          tab: tab === "shortlisted" ? "To review" : "Approved",
          toReview: list.counts.shortlisted,
          approved: list.counts.resume,
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

  /**
   * An action that empties a filtered list takes the filter away too: the
   * person is never left on "No job matches" while jobs still wait here.
   */
  const clearFilterIfEmptied = useCallback((gone: (id: number) => boolean) => {
    const { list, text } = latest.current;
    if (
      text.trim() !== "" &&
      list.nextCursor === null &&
      list.rows.every((row) => gone(row.id))
    )
      setText("");
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
      clearFilterIfEmptied((id) => gone.has(id));
      setBusy(null);
      approvalPending.current = false;
      if (approved.length > 0)
        showToast({
          id: "shortlisted-approve",
          title:
            approved.length === 1 && !ticked
              ? `Approved ${view.job?.title ?? "the resume"}`
              : `Approved ${plural(approved.length, "resume")}`,
          description: "It waits in Approved. Apply works from either tab.",
          tone: "success",
        });
    }
  }, [clearFilterIfEmptied, nextAfter, showToast]);

  // Jobs this screen just sent to Apply: if Apply fails one before it is
  // sent, the "Applying to…" toast is replaced by the failure, naming the
  // job, wherever the person is in the app.
  const applyWatch = useRef(new Set<number>());
  useEffect(() => {
    // Absent where only resumes are bridged (some screen tests).
    const jobFinder = (window.nestor as Partial<typeof window.nestor>)
      .jobFinder;
    if (!jobFinder) return undefined;
    return jobFinder.onApplicationsChange((change) => {
      const watched = [...applyWatch.current].filter(
        (id) => change.ids === null || change.ids.includes(id),
      );
      if (watched.length === 0) return;
      void jobFinder
        .applicationsForJobs({ jobIds: watched })
        .then((rows) => {
          const failed = rows.filter((row) => row.state === "failed");
          for (const row of rows)
            if (!["queued", "running"].includes(row.state))
              applyWatch.current.delete(row.jobId);
          const first = failed[0];
          if (!first) return;
          showToast({
            id: "shortlisted-apply",
            title:
              failed.length === 1
                ? `Couldn’t apply to ${first.title}${first.company ? ` at ${first.company}` : ""}`
                : `Couldn’t apply to ${plural(failed.length, "job")}`,
            description:
              failed.length === 1
                ? `${applyFailureLine(first.error)} It’s marked in Shortlisted, with Try again.`
                : "Nothing was sent. They’re marked in Shortlisted, with Try again.",
            tone: "warning",
            duration: 15_000,
          });
        })
        .catch(() => undefined);
    });
  }, [showToast]);

  /**
   * Applies the ticked jobs or the open one, every matching job in this tab
   * whose resume is written (approved or not), or the jobs shown on this
   * page of the list.
   */
  const apply = useCallback(
    async (scope: "target" | "all" | "page" = "target") => {
      const input: JobSelectionInput | null =
        scope === "all"
          ? {
              filter: { stage: latest.current.tab, text: latest.current.text },
              except: [],
            }
          : scope === "page"
            ? { ids: latest.current.list.rows.map((row) => row.id) }
            : target();
      if (!input || ("ids" in input && input.ids.length === 0)) return;
      setBusy("apply");
      try {
        const result = await window.nestor.jobFinder.applyJobs({
          selection: input,
          // A page is a bulk choice: a job a saved rule skipped stays skipped.
          ...(scope === "page" ? { bulk: true } : {}),
        });
        setSelection(NO_SELECTION);
        if (result.queued > 0) {
          const ids =
            "ids" in input
              ? input.ids
              : latest.current.list.rows
                  .filter(
                    (row) =>
                      !("except" in input) ||
                      !(input.except ?? []).includes(row.id),
                  )
                  .map((row) => row.id);
          for (const id of ids) applyWatch.current.add(id);
        }
        showToast({
          id: "shortlisted-apply",
          title:
            result.queued > 0
              ? `Applying to ${plural(result.queued, "job")}`
              : result.unchanged > 0
                ? "Those jobs are already being applied to"
                : notReady(result.notReady),
          description:
            result.queued === 0 && result.unchanged === 0
              ? "Apply once a resume is written."
              : result.notReady > 0
                ? `${notReady(result.notReady)} stayed here.`
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
    clearFilterIfEmptied(gone);
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
        tone: "success",
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
  }, [clearFilterIfEmptied, nextAfter, showToast, target]);

  useListKeys({
    rows: list.rows,
    activeId,
    setActiveId,
    toggle: (id, shiftKey) =>
      setSelection((current) =>
        toggleSelection(current, id, shiftKey, list.rows),
      ),
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

  const toggle = useCallback(
    (id: number, shiftKey: boolean) =>
      setSelection((current) =>
        toggleSelection(current, id, shiftKey, latest.current.list.rows),
      ),
    [],
  );
  const toReview = list.counts.shortlisted;
  const approved = list.counts.resume;
  const navigate = useNavigate();
  const findJobs = {
    label: "Find jobs",
    onClick: () => void navigate("/job-finder/discovery"),
  };

  // The tab says some jobs are here but the list came back empty: the list
  // or the count is a moment behind (an approval just moved a job). Read
  // once more before saying "nothing here", instead of showing "No approved
  // resumes yet" under "Approved 2".
  const listKey = JSON.stringify([tab, text]);
  const disagree =
    !list.loading &&
    text === "" &&
    list.rows.length === 0 &&
    list.nextCursor === null &&
    list.counts[tab] > 0;
  const rechecked = useRef<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  useEffect(() => {
    if (!disagree || rechecked.current === listKey) return;
    rechecked.current = listKey;
    setRechecking(true);
    void latest.current.list.refresh().finally(() => setRechecking(false));
  }, [disagree, listKey]);

  const jobsText = (count: number, capped = false) =>
    `${count.toLocaleString()}${capped ? "+" : ""} ${count === 1 ? "job" : "jobs"}`;
  // Every job here already has Apply at work: nothing to press.
  const allApplying =
    selectedCount === 0 &&
    list.rows.length > 0 &&
    list.nextCursor === null &&
    list.rows.every(
      (row) => row.application !== null && row.application.status !== "failed",
    );
  // The pending label follows where each one really is: an application
  // waiting on an answer or a Send is no longer "applying".
  const appliesBy = (status: "applying" | "ready" | "needs_you") =>
    list.rows.filter((row) => row.application?.status === status).length;
  const applyingLabel = (() => {
    const parts = [
      appliesBy("applying") > 0
        ? `Applying to ${jobsText(appliesBy("applying"))}`
        : null,
      appliesBy("needs_you") > 0
        ? `${appliesBy("needs_you").toLocaleString()} waiting on you`
        : null,
      appliesBy("ready") > 0
        ? `${appliesBy("ready").toLocaleString()} ready to send`
        : null,
    ].filter(Boolean);
    return parts.length > 0
      ? parts.join(" · ")
      : `Applying to ${jobsText(list.rows.length)}`;
  })();
  const applyLabel = allApplying
    ? applyingLabel
    : counting
      ? "Apply"
      : selectedCount > 0
        ? `Apply to ${jobsText(selectedCount, totalCapped && selection.all)}`
        : list.totalCapped
          ? "Apply to all matching jobs"
          : list.total === 1
            ? "Apply to 1 job"
            : `Apply to all ${jobsText(list.total)}`;

  return (
    <LockedScreenLayout
      contentClassName="flex flex-col overflow-hidden"
      lockContentHeight
      lockStacked
      topContent={
        // A resume open as a sheet over the list (1024, or beside the
        // docked assistant) folds the page title and tabs away: the paper
        // takes their height, and "Back to the list" brings them back.
        <div
          className={cn(
            "grid gap-3",
            reading.sheet && sheet.open && activeId !== null && "hidden",
          )}
          data-page-chrome-folded={
            reading.sheet && sheet.open && activeId !== null ? "" : undefined
          }
        >
          <PageHeader
            actions={
              list.total > 0 ? (
                <>
                  {selectedCount === 0 && list.total > list.rows.length ? (
                    // More jobs match than this page shows.
                    <Button
                      disabled={busy !== null || list.loading}
                      onClick={() => void apply("page")}
                      size="toolbar"
                      variant="outline"
                    >
                      {`Apply to the ${jobsText(list.rows.length)} on this page`}
                    </Button>
                  ) : null}
                  <Button
                    disabled={
                      busy !== null || list.loading || counting || allApplying
                    }
                    onClick={() =>
                      void apply(selectedCount === 0 ? "all" : "target")
                    }
                    pending={busy === "apply"}
                    size="toolbar"
                    title={
                      allApplying
                        ? "Apply is already working on each of these. Follow them in Applications."
                        : undefined
                    }
                  >
                    {applyLabel}
                  </Button>
                </>
              ) : null
            }
            description={
              tab === "shortlisted"
                ? "Resumes write themselves as jobs arrive. Read, edit if you like, approve or apply."
                : "Approved resumes. Apply takes them from here."
            }
            title="Shortlisted"
          />
          <SegmentedControl<Tab>
            className="self-start"
            label="Which shortlisted jobs"
            variant="tabs"
            onValueChange={setTab}
            options={[
              {
                value: "shortlisted",
                label: (
                  <span className="flex items-center gap-1.5">
                    To review
                    <CountFigure
                      count={toReview}
                      known={list.countsKnown}
                      slot="shortlisted:to-review"
                    />
                  </span>
                ),
                ariaLabel: `To review ${countText(toReview, list.countsKnown)}`,
              },
              {
                value: "resume",
                label: (
                  <span className="flex items-center gap-1.5">
                    Approved
                    <CountFigure
                      count={approved}
                      known={list.countsKnown}
                      slot="shortlisted:approved"
                    />
                  </span>
                ),
                ariaLabel: `Approved ${countText(approved, list.countsKnown)}`,
              },
            ]}
            value={tab}
          />
        </div>
      }
    >
      <ListDetailLayout
        columnsClassName={reading.columnsClassName}
        rootRef={reading.ref}
        rootStyle={reading.style}
        sheet={{ open: sheet.open && activeId !== null, onClose: sheet.close }}
        sheetAlways={reading.sheet}
        sheetOverAssistant
        state={{
          stage: tab,
          text,
          selectedIds: [...selection.ids],
          all: selection.all,
        }}
        detail={
          <ResumePane
            application={
              list.rows.find((row) => row.id === activeId)?.application ?? null
            }
            applying={busy === "apply"}
            approving={busy === "approve"}
            list={rechecking ? "rows" : besideList(list)}
            listLoading={
              list.loading ||
              rechecking ||
              (activeId !== null && view.job === null)
            }
            onApply={() => void apply()}
            onApprove={() => void approve()}
            onBack={sheet.close}
            onMoveBack={() => void moveBack()}
            bulkActive={selectedCount > 0}
            view={view}
          />
        }
        list={
          <ListPane<ShortlistedRow>
            activeId={activeId}
            bulkActions={
              <>
                {stillWriting > 0 ? (
                  // Why Approve counts fewer than are ticked, or is off.
                  <span className="hidden truncate text-(length:--text-small) text-foreground-soft @2xl/listbar:inline">
                    {`${stillWriting.toLocaleString()} still writing`}
                  </span>
                ) : null}
                <Button
                  aria-label={
                    tab !== "shortlisted"
                      ? `Apply to ${selectedText} selected`
                      : stillWriting > 0
                        ? `Approve ${approvable.toLocaleString()} of ${selectedText} selected`
                        : `Approve ${selectedText} selected`
                  }
                  disabled={
                    busy !== null ||
                    counting ||
                    (tab === "shortlisted" && approvable === 0)
                  }
                  title={
                    stillWriting > 0
                      ? `${plural(stillWriting, "resume")} still writing ${stillWriting === 1 ? "stays" : "stay"} in To review`
                      : undefined
                  }
                  onClick={() =>
                    void (tab === "shortlisted" ? approve() : apply())
                  }
                  pending={
                    tab === "shortlisted"
                      ? busy === "approve"
                      : busy === "approve" || busy === "apply"
                  }
                  size="toolbar"
                >
                  {`${tab === "shortlisted" ? "Approve" : "Apply"} ${
                    counting
                      ? ""
                      : tab === "shortlisted" && !selection.all
                        ? approvable.toLocaleString()
                        : selectedText
                  }`.trim()}
                </Button>
                {tab === "shortlisted" ? (
                  // A written resume can be applied with as it is: approval
                  // is the person's marker, never a step before Apply.
                  <Button
                    aria-label={`Apply to ${selectedText} selected`}
                    disabled={busy !== null || counting}
                    onClick={() => void apply()}
                    pending={busy === "apply"}
                    size="toolbar"
                    variant="outline"
                  >
                    {`Apply ${counting ? "" : selectedText}`.trim()}
                  </Button>
                ) : null}
                <Button
                  aria-label={`Move back ${selectedText} selected`}
                  disabled={busy !== null || counting}
                  onClick={() => void moveBack()}
                  size="toolbar"
                  title={`Move back ${selectedText} to Find jobs`}
                  variant="outline"
                >
                  {/* In words at every width: a narrow reading list gives
                      its verbs a row of their own. */}
                  {`Move back ${counting ? "" : selectedText}`.trim()}
                </Button>
              </>
            }
            endNote={
              text
                ? null
                : tab === "shortlisted"
                  ? "Jobs you shortlist next appear here once their resumes are written."
                  : "Approved resumes wait here until Apply sends them."
            }
            empty={
              text ? (
                <ListEmpty
                  action={{ label: "Clear filter", onClick: () => setText("") }}
                  detail={
                    list.counts[tab] > 0
                      ? `${jobsText(list.counts[tab])} in ${tab === "shortlisted" ? "To review" : "Approved"} don't match it.`
                      : null
                  }
                  title={`No job matches “${text.trim()}”`}
                />
              ) : tab === "shortlisted" ? (
                <ListEmpty
                  action={
                    approved > 0
                      ? {
                          label: `See ${plural(approved, "approved job")}`,
                          onClick: () => setTab("resume"),
                        }
                      : findJobs
                  }
                  detail="Shortlist jobs in Find jobs and their resumes start writing here."
                  title="Nothing to review"
                />
              ) : (
                <ListEmpty
                  action={
                    toReview > 0
                      ? {
                          label: `Review ${plural(toReview, "resume")}`,
                          onClick: () => setTab("shortlisted"),
                        }
                      : findJobs
                  }
                  detail="Approve a resume in To review and it waits here for Apply."
                  title="No approved resumes yet"
                />
              )
            }
            fillStacked
            hasMore={list.nextCursor !== null}
            label={
              tab === "shortlisted" ? "Resumes to review" : "Approved resumes"
            }
            loading={list.loading}
            error={list.error}
            onRetry={() => void list.refresh()}
            pending={rechecking}
            counting={counting}
            onLoadMore={() => void list.loadMore()}
            onSelectionChange={setSelection}
            renderRow={(row, state) => (
              <ShortlistedListRow
                {...state}
                onActivate={(id) => {
                  setActiveId(id);
                  sheet.openIfStacked();
                }}
                onToggle={toggle}
                row={row}
              />
            )}
            rows={list.rows}
            selectedCount={selectedCount}
            selection={selection}
            toolbar={
              <Input
                aria-label="Find a shortlisted job"
                className="h-8 min-w-0 flex-1"
                id={FILTER_ID}
                onChange={(event) => setText(event.target.value)}
                placeholder="Find a job  /"
                type="search"
                value={text}
              />
            }
            total={matching}
            totalCapped={totalCapped}
            windowed
          />
        }
      />
    </LockedScreenLayout>
  );
}

/**
 * The width the resume pane needs for a complete Letter line at the readable
 * 75%: the 612 px page, the desk's padding and edge (50), the pane's padding
 * and edge (34) and room for the desk's scrollbar (14).
 */
export const READING_DETAIL_MIN = 710;
/** The list beside it: never narrower than its rows can be read at. */
const READING_LIST_MIN = 240;
const READING_LIST_MAX = 352;
const READING_GAP = 16;

/**
 * Shortlisted's layout while resumes are read: the list narrows so the paper
 * gets the width (its own split, never the shared ratio), and where even a
 * narrowed list leaves less than the paper needs, the list takes the width
 * and the resume opens as a sheet over it. The page then shows complete
 * lines at fit width; zoom stays the person's choice.
 */
function useReadingLayout() {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    if (node.clientWidth > 0) setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.current.observe(node);
  }, []);
  const sheet =
    width !== null &&
    width < READING_LIST_MIN + READING_GAP + READING_DETAIL_MIN;
  const list =
    width === null
      ? READING_LIST_MAX
      : Math.min(
          READING_LIST_MAX,
          Math.max(
            READING_LIST_MIN,
            width - READING_GAP - READING_DETAIL_MIN - 96,
          ),
        );
  return {
    ref,
    sheet,
    measured: width !== null,
    columnsClassName: "split:grid-cols-[var(--reading-list)_minmax(0,1fr)]",
    // Snapped to 16 px, so resizing the window settles in a few steps.
    style: {
      "--reading-list": `${Math.round(list / 16) * 16}px`,
    } as CSSProperties,
  };
}

/** Each tab's own name, which its rows' badges need not repeat. */
const TAB_NAMES: ReadonlySet<string> = new Set(["To review", "Approved"]);

/** One shortlisted job and its resume's state; memoized like every list row. */
const ShortlistedListRow = memo(function ShortlistedListRow(
  props: ListRowState & {
    row: ShortlistedRow;
    onActivate: (id: number) => void;
    onToggle: (id: number, shiftKey: boolean) => void;
  },
) {
  const { row } = props;
  const status = row.application
    ? APPLICATION_BADGE[row.application.status]
    : describeResume(row.resume);
  return (
    <ListRowFrame
      active={props.active}
      exiting={props.exiting}
      motion={props.motion}
      index={props.index}
      setSize={props.setSize}
      top={props.top}
      // A badge that only repeats the tab ("To review" on every row of To
      // review) says nothing and took the title's width ("Product Desi…"):
      // only a state the tab does not already say gets one.
      badge={
        TAB_NAMES.has(status.label) ? undefined : (
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        )
      }
      checked={props.checked}
      id={row.id}
      meta={[row.company, row.location].filter(Boolean).join(" · ")}
      nameParts={{
        badge: TAB_NAMES.has(status.label) ? null : status.label,
        status: row.resume ? `${LEVEL_LABEL[row.resume.level]} resume` : null,
      }}
      onActivate={props.onActivate}
      onToggle={props.onToggle}
      status={
        row.resume ? (
          <span title={LEVEL_HINT[row.resume.level]}>
            {LEVEL_LABEL[row.resume.level]} resume
          </span>
        ) : null
      }
      title={row.title}
    />
  );
});
