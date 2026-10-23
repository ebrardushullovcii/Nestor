import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Input } from "@renderer/components/ui/input";
import {
  formatTrackerMoment as formatCalendarMoment,
  trackerTimeInputValue,
  formatTrackerCell,
} from "./applications-tracker-time";
import { resolvePlanTimeZone } from "../../lib/job-finder-timestamp-format";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmStage,
  ApplicationCrmStageDefinition,
  ApplicationRecord,
} from "@nestor/contracts";
import { useToast } from "@renderer/components/ui/toast";
import { Info } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { Badge } from "@renderer/components/ui/badge";
import { EmptyState } from "../../components/empty-state";
import {
  APPLICATION_CRM_PAGE_SIZE,
  CollectionPagination,
} from "../../components/collection-pagination";
import {
  CollectionColumnPicker,
  CollectionNoMatches,
  CollectionSavedViews,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import { usePersistedCollectionView } from "../../hooks/use-persisted-collection-view";

import {
  sortApplicationCrmRecords,
  type TrackerSort,
  APPLICATION_CRM_STAGE_NAMES,
  APPLICATION_CRM_STAGE_ORDER,
  APPLICATION_CRM_MANUAL_STAGES,
  applicationCrmDataForView,
  applicationCrmStageLabelForView,
  applicationCrmStageProvenanceDetailForView,
  applicationCrmStageProvenanceForView,
  buildApplicationCrmCalendarForView,
  groupApplicationRecordsByStage,
} from "./applications-crm-model";
import { formatApplicationEmployerLine } from "../../lib/job-employer-location-display";
import { useAssistantContextSource } from "../../assistant/assistant-provider";
import { buildListContext } from "../../assistant/assistant-context-capture";

export const APPLICATION_CRM_VIEW_VALUES = [
  "table",
  "kanban",
  "calendar",
] as const;
export type ApplicationCrmView = (typeof APPLICATION_CRM_VIEW_VALUES)[number];

const crmSavedViewValues = [
  "all",
  "needs_follow_up",
  "interviews",
  "scheduled_interviews",
  "offers",
  "archived",
] as const;
type CrmSavedView = (typeof crmSavedViewValues)[number];

const crmSavedViewLabels: Record<CrmSavedView, string> = {
  all: "All applications",
  needs_follow_up: "Needs follow-up",
  interviews: "Interview stage",
  scheduled_interviews: "Scheduled interviews",
  archived: "Archived applications",
  offers: "Offers",
};

const columnValues = [
  "job",
  "company",
  "stage",
  "reminder",
  "interview",
  "tags",
  "applied",
  "updated",
] as const;
type CrmColumn = (typeof columnValues)[number];
const columnMinimumWidths: Record<CrmColumn, number> = {
  job: 12,
  company: 10,
  stage: 8.5,
  reminder: 7.5,
  interview: 7.5,
  tags: 5,
  applied: 7.5,
  updated: 7.5,
};

/**
 * Below this many records the table/board/calendar switcher and the exports
 * are not offered: they are three ways of viewing, and two formats for
 * exporting, a single row.
 */
export const APPLICATION_CRM_VIEW_SWITCHER_MIN_RECORDS = 2;

const viewLabels: Record<ApplicationCrmView, string> = {
  table: "List",
  kanban: "Board",
  calendar: "Calendar",
};

function encodeVisibleRecordIdKey(recordIds: readonly string[]): string {
  return JSON.stringify(recordIds);
}

function decodeVisibleRecordIdKey(key: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) &&
      parsed.every((id): id is string => typeof id === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

const emptyStateCopy: Record<
  ApplicationCrmView,
  { description: string; title: string }
> = {
  table: {
    title: "No applications yet",
    description:
      "Shortlist a job or prepare an application and it will appear as a row in your tracker table.",
  },
  kanban: {
    title: "No applications on your board yet",
    description:
      "Applications you prepare will appear here grouped by hiring stage.",
  },
  calendar: {
    title: "Nothing scheduled yet",
    description:
      "Upcoming reminders, interviews, and offer deadlines will appear on the application calendar.",
  },
};

/** Overdue first, then today, tomorrow and later, so what is due is on top. */
function groupCalendarEntries<T extends { startsAt: string }>(
  entries: readonly T[],
  now: number,
  timeZone?: string,
): { key: string; label: string; entries: T[] }[] {
  const today = trackerTimeInputValue(now, resolvePlanTimeZone(timeZone)).slice(
    0,
    10,
  );
  const tomorrowDate = new Date(`${today}T12:00:00Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const groups = [
    { key: "overdue", label: "Overdue", entries: [] as T[] },
    { key: "today", label: "Today", entries: [] as T[] },
    { key: "tomorrow", label: "Tomorrow", entries: [] as T[] },
    { key: "later", label: "Later", entries: [] as T[] },
  ];
  for (const entry of entries) {
    const at = Date.parse(entry.startsAt);
    const day = trackerTimeInputValue(
      Date.parse(entry.startsAt),
      resolvePlanTimeZone(timeZone),
    ).slice(0, 10);
    const group =
      at < now
        ? groups[0]
        : day === today
          ? groups[1]
          : day === tomorrow
            ? groups[2]
            : groups[3];
    group?.entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}

const BOARD_PAGE_SIZE = 10;
const columnLabels: Record<CrmColumn, string> = {
  job: "Job",
  company: "Company",
  stage: "Stage",
  reminder: "Next reminder",
  interview: "Interview",
  tags: "Tags",
  applied: "Applied",
  updated: "Updated",
};

const NO_CUSTOM_STAGES: readonly ApplicationCrmStageDefinition[] = [];

function RecordButton(props: {
  record: ApplicationRecord;
  selected: boolean;
  onSelect: (id: string) => void;
  compact?: boolean;
  relatedJobCanonicalUrl?: string | null;
  relatedJobLocation?: string | null;
}) {
  const crm = applicationCrmDataForView(props.record);
  const pendingReminderCount = crm.reminders.filter(
    (reminder) => reminder.status === "pending",
  ).length;
  const employer = formatApplicationEmployerLine({
    company: props.record.company,
    ...(props.relatedJobCanonicalUrl
      ? { canonicalUrl: props.relatedJobCanonicalUrl }
      : {}),
  });
  const employerLine = [props.relatedJobLocation, employer]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "grid w-full min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-3 text-left outline-none transition-colors hover:bg-(--surface-panel-raised) focus-visible:ring-[3px] focus-visible:ring-ring/30",
        props.selected && "border-primary/60 bg-(--surface-panel-raised)",
        props.compact && "gap-1.5 p-2.5",
      )}
      onClick={() => props.onSelect(props.record.id)}
      type="button"
    >
      <strong className="min-w-0 break-words text-sm text-foreground">
        {props.record.title}
      </strong>
      {employerLine ? (
        <span className="min-w-0 break-words text-xs text-foreground-soft">
          {employerLine}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-1.5">
        <Badge
          title={applicationCrmStageProvenanceDetailForView(props.record)}
          variant="section"
        >
          {applicationCrmStageProvenanceForView(props.record)}
        </Badge>
        {crm.tags.slice(0, 3).map((tag) => (
          <Badge key={tag} variant="section">
            {tag}
          </Badge>
        ))}
        {pendingReminderCount > 0 ? (
          <Badge variant="section">
            {pendingReminderCount} reminder
            {pendingReminderCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}

export function ApplicationsCrmViews(props: {
  requestedRecordId?: string | null;
  homeTimeZone?: string;
  records: readonly ApplicationRecord[];
  selectedRecordId: string | null;
  view: ApplicationCrmView;
  discoveryJobs?: ReadonlyArray<{
    id: string;
    canonicalUrl: string;
    location?: string | null;
  }>;
  onSelectRecord: (recordId: string) => void;
  onViewChange: (view: ApplicationCrmView) => void;
  onVisibleRecordIdsChange?: (recordIds: readonly string[]) => void;
  onBulkChange?: (
    command: ApplicationCrmBulkStageMutationInput,
  ) => Promise<void>;
  onBulkStageChange?: (
    recordIds: readonly string[],
    stage: ApplicationCrmStage,
  ) => Promise<void>;
  /** Stages the person named; shown and searchable by those names. */
  customStages?: readonly ApplicationCrmStageDefinition[];
  /** Marks a reminder done straight from the calendar (N-018). */
  onCompleteReminder?: (recordId: string, reminderId: string) => Promise<void>;
}) {
  const customStages = props.customStages ?? NO_CUSTOM_STAGES;
  const { showToast } = useToast();
  const latestRecordsRef = useRef(props.records);
  latestRecordsRef.current = props.records;
  const [bulkStage, setBulkStage] = useState("reviewing");
  const [bulkTags, setBulkTags] = useState("");
  const [confirmation, setConfirmation] = useState<{
    action: "stage" | "tags" | "archive" | "restore";
    ids: readonly string[];
    label: string;
    records: readonly ApplicationRecord[];
    stage: ApplicationCrmStage;
    customStageId: string | null;
    tags: string[];
  } | null>(null);
  const {
    applySavedView,
    deleteSavedView,
    density,
    query,
    savedViews,
    saveCurrentView,
    setDensity,
    setQuery,
  } = usePersistedCollectionView("applications-crm", "comfortable");
  const [savedView, setSavedView] = useState<CrmSavedView>(() => {
    try {
      const stored = window.localStorage.getItem(
        "nestor.job-finder.applications-crm.saved-view.v1",
      );
      return crmSavedViewValues.includes(stored as CrmSavedView)
        ? (stored as CrmSavedView)
        : "all";
    } catch {
      return "all";
    }
  });
  const [visibleColumns, setVisibleColumns] = useState<readonly CrmColumn[]>(
    () => {
      try {
        const stored = JSON.parse(
          window.localStorage.getItem(
            "nestor.job-finder.applications-crm.columns.v2",
          ) ??
            window.localStorage.getItem(
              "nestor.job-finder.applications-crm.columns.v1",
            ) ??
            "null",
        ) as unknown;
        return Array.isArray(stored)
          ? columnValues.filter(
              (column) =>
                stored.includes(column) ||
                (column === "applied" &&
                  !window.localStorage.getItem(
                    "nestor.job-finder.applications-crm.columns.v2",
                  )),
            )
          : columnValues;
      } catch {
        return columnValues;
      }
    },
  );
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [showEmptyKanbanStages, setShowEmptyKanbanStages] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [completingEntryId, setCompletingEntryId] = useState<string | null>(
    null,
  );
  const [calendarError, setCalendarError] = useState<string | null>(null);
  async function completeReminder(entry: {
    id: string;
    applicationRecordId: string;
  }) {
    if (!props.onCompleteReminder) return;
    setCompletingEntryId(entry.id);
    setCalendarError(null);
    try {
      await props.onCompleteReminder(
        entry.applicationRecordId,
        entry.id.slice("reminder_".length),
      );
    } catch {
      setCalendarError(
        "The reminder could not be marked done. Open the application and try again.",
      );
    } finally {
      setCompletingEntryId(null);
    }
  }
  const selectedIdsRef = useRef(selectedIds);
  const pagedRecordIdsRef = useRef<readonly string[]>([]);
  selectedIdsRef.current = selectedIds;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TrackerSort>("updated");
  const [boardPages, setBoardPages] = useState<
    Partial<Record<ApplicationCrmStage, number>>
  >({});
  const selectionKey = selectedIds.join("\0");
  useLayoutEffect(() => {
    if (!props.requestedRecordId) return;
    setQuery("");
    const record = props.records.find(
      (record) => record.id === props.requestedRecordId,
    );
    setSavedView(record?.crm?.archivedAt ? "archived" : "all");
  }, [props.requestedRecordId]);

  useEffect(() => {
    setBulkError(null);
  }, [selectionKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "nestor.job-finder.applications-crm.saved-view.v1",
        savedView,
      );
      window.localStorage.setItem(
        "nestor.job-finder.applications-crm.columns.v2",
        JSON.stringify(visibleColumns),
      );
    } catch {
      // The CRM stays usable when renderer preferences cannot be persisted.
    }
  }, [savedView, visibleColumns]);

  const relatedJobsById = useMemo(
    () =>
      new Map((props.discoveryJobs ?? []).map((job) => [job.id, job] as const)),
    [props.discoveryJobs],
  );

  const filteredRecords = useMemo(
    () =>
      sortApplicationCrmRecords(
        props.records.filter((record) => {
          const crm = applicationCrmDataForView(record);
          if (Boolean(crm.archivedAt) !== (savedView === "archived"))
            return false;
          const savedViewMatch =
            savedView === "all" ||
            savedView === "archived" ||
            (savedView === "needs_follow_up" &&
              (crm.stage === "no_response" ||
                crm.reminders.some(
                  (reminder) => reminder.status === "pending",
                ))) ||
            (savedView === "interviews" && crm.stage === "interview") ||
            (savedView === "scheduled_interviews" &&
              crm.interviews.some(
                (interview) => interview.status === "scheduled",
              )) ||
            // An offer is an offer whether or not the stage was moved to it:
            // a saved, still-open offer counts.
            (savedView === "offers" &&
              (crm.stage === "offer" ||
                crm.compensation.offerStatus === "active"));
          const employerLine = formatApplicationEmployerLine({
            company: record.company,
            ...(relatedJobsById.get(record.jobId)?.canonicalUrl
              ? {
                  canonicalUrl: relatedJobsById.get(record.jobId)?.canonicalUrl,
                }
              : {}),
          });
          return (
            savedViewMatch &&
            matchesCollectionSearch(query, [
              record.title,
              record.company,
              employerLine,
              crm.stage,
              applicationCrmStageLabelForView(record, customStages),
              ...crm.tags,
              ...crm.contacts.flatMap((contact) => [
                contact.name,
                contact.email,
              ]),
            ])
          );
        }),
        sort,
      ),
    [customStages, props.records, query, relatedJobsById, savedView, sort],
  );
  const visibleRecordIdKey = useMemo(
    () => encodeVisibleRecordIdKey(filteredRecords.map((record) => record.id)),
    [filteredRecords],
  );
  const onVisibleRecordIdsChangeRef = useRef(props.onVisibleRecordIdsChange);
  onVisibleRecordIdsChangeRef.current = props.onVisibleRecordIdsChange;
  const reportedVisibleRecordIdKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (reportedVisibleRecordIdKeyRef.current === visibleRecordIdKey) {
      return;
    }
    reportedVisibleRecordIdKeyRef.current = visibleRecordIdKey;
    onVisibleRecordIdsChangeRef.current?.(
      decodeVisibleRecordIdKey(visibleRecordIdKey),
    );
  }, [visibleRecordIdKey]);

  // The tracker's ticked rows are the assistant's selection (ADR 0037).
  useAssistantContextSource(
    "applications-tracker-list",
    () => ({
      list: buildListContext({
        listKind: "applications",
        checkedIds: selectedIdsRef.current,
        displayedIds: pagedRecordIdsRef.current,
        filteredIds: filteredRecords.map((record) => record.id),
        filterSummary: query.trim() ? `matching "${query.trim()}"` : null,
      }),
    }),
    { priority: 1 },
  );

  useEffect(() => {
    const visibleIds = new Set(filteredRecords.map((record) => record.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [filteredRecords]);

  useEffect(() => {
    setPage(1);
    setBoardPages({});
  }, [props.view, query, savedView, sort]);

  const calendar = useMemo(
    () => buildApplicationCrmCalendarForView(filteredRecords, relatedJobsById),
    [filteredRecords, relatedJobsById],
  );
  const pageItemCount =
    props.view === "calendar" ? calendar.length : filteredRecords.length;
  const pageCount = Math.max(
    1,
    Math.ceil(pageItemCount / APPLICATION_CRM_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount));
  }, [pageCount]);
  const pagedRecords = useMemo(
    () =>
      filteredRecords.slice(
        (currentPage - 1) * APPLICATION_CRM_PAGE_SIZE,
        currentPage * APPLICATION_CRM_PAGE_SIZE,
      ),
    [currentPage, filteredRecords],
  );
  pagedRecordIdsRef.current = pagedRecords.map((record) => record.id);

  const grouped = useMemo(
    () => groupApplicationRecordsByStage(filteredRecords),
    [filteredRecords],
  );
  if (props.view === "kanban") {
    pagedRecordIdsRef.current = [...grouped.entries()].flatMap(
      ([stage, records]) => {
        const stagePage = Math.min(
          boardPages[stage] ?? 1,
          Math.max(1, Math.ceil(records.length / BOARD_PAGE_SIZE)),
        );
        return records
          .slice((stagePage - 1) * BOARD_PAGE_SIZE, stagePage * BOARD_PAGE_SIZE)
          .map((record) => record.id);
      },
    );
  }
  const groupedTotals = useMemo(
    () => groupApplicationRecordsByStage(filteredRecords),
    [filteredRecords],
  );
  const populatedKanbanStages = useMemo(
    () =>
      APPLICATION_CRM_STAGE_ORDER.filter(
        (stage) => (grouped.get(stage)?.length ?? 0) > 0,
      ),
    [grouped],
  );
  const emptyKanbanStages = useMemo(
    () =>
      APPLICATION_CRM_STAGE_ORDER.filter(
        (stage) => (grouped.get(stage)?.length ?? 0) === 0,
      ),
    [grouped],
  );
  const pagedCalendar = useMemo(
    () =>
      calendar.slice(
        (currentPage - 1) * APPLICATION_CRM_PAGE_SIZE,
        currentPage * APPLICATION_CRM_PAGE_SIZE,
      ),
    [calendar, currentPage],
  );
  const recordsById = useMemo(
    () => new Map(filteredRecords.map((record) => [record.id, record])),
    [filteredRecords],
  );
  const selectedRecordIndex = useMemo(
    () =>
      props.selectedRecordId
        ? filteredRecords.findIndex(
            (record) => record.id === props.selectedRecordId,
          )
        : -1,
    [filteredRecords, props.selectedRecordId],
  );
  const selectedCalendarIndex = useMemo(
    () =>
      props.selectedRecordId
        ? calendar.findIndex(
            (entry) => entry.applicationRecordId === props.selectedRecordId,
          )
        : -1,
    [calendar, props.selectedRecordId],
  );
  const lastPagedSelection = useRef<string | null>(null);
  useEffect(() => {
    if (lastPagedSelection.current === props.selectedRecordId) return;
    const selectedIndex =
      props.view === "calendar" ? selectedCalendarIndex : selectedRecordIndex;
    if (selectedIndex < 0) return;
    lastPagedSelection.current = props.selectedRecordId;
    setPage(Math.floor(selectedIndex / APPLICATION_CRM_PAGE_SIZE) + 1);
  }, [
    props.selectedRecordId,
    props.view,
    selectedCalendarIndex,
    selectedRecordIndex,
  ]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const columnVisible = (column: CrmColumn) => visibleColumns.includes(column);
  const trackerPanelRef = useRef<HTMLElement>(null);
  const tablePaneRef = useRef<HTMLDivElement>(null);
  const [tableMinimum, setTableMinimum] = useState({ pane: 0, panel: 0 });
  useLayoutEffect(() => {
    const pane = tablePaneRef.current;
    const panel = trackerPanelRef.current;
    const table = pane?.querySelector("table");
    if (!pane || !panel || !table) return;
    const measure = () => {
      const rows = Array.from(table.tBodies[0]?.rows ?? []).slice(0, 3);
      const rowHeights = rows.map((row) => row.getBoundingClientRect().height);
      const rowHeight = Math.max(0, ...rowHeights);
      const paneHeight = Math.ceil(
        (table.tHead?.getBoundingClientRect().height ?? 0) +
          rowHeights.reduce((total, height) => total + height, 0) +
          (3 - rows.length) * rowHeight +
          Math.max(0, pane.offsetHeight - pane.clientHeight),
      );
      const otherHeight = Array.from(panel.children).reduce(
        (total, child) =>
          total + (child === pane ? 0 : child.getBoundingClientRect().height),
        0,
      );
      const panelHeight = Math.ceil(paneHeight + otherHeight + 2);
      setTableMinimum((current) =>
        current.pane === paneHeight && current.panel === panelHeight
          ? current
          : { pane: paneHeight, panel: panelHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    for (const child of panel.children) {
      if (child !== pane) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [props.view, pagedRecords, density, selectedIds.length]);

  const rowPadding =
    density === "compact" ? "py-2" : density === "detailed" ? "py-5" : "py-3";

  function requestBulkChange(action: "stage" | "tags" | "archive" | "restore") {
    const custom = customStages.find(
      (entry) => `custom:${entry.id}` === bulkStage,
    );
    const label =
      action === "stage"
        ? `Move ${selectedIds.length} ${selectedIds.length === 1 ? "application" : "applications"} to ${custom?.label ?? APPLICATION_CRM_STAGE_NAMES[bulkStage as ApplicationCrmStage]}?`
        : action === "tags"
          ? `Add tags to ${selectedIds.length} ${selectedIds.length === 1 ? "application" : "applications"}?`
          : `${action === "archive" ? "Archive" : "Restore"} ${selectedIds.length} ${selectedIds.length === 1 ? "application" : "applications"}?`;
    setConfirmation({
      action,
      ids: [...selectedIds],
      label,
      records: props.records.filter((record) =>
        selectedIds.includes(record.id),
      ),
      stage: custom?.baseStage ?? (bulkStage as ApplicationCrmStage),
      customStageId: custom?.id ?? null,
      tags: bulkTags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  }

  async function runBulkChange() {
    if (!confirmation) return;
    const stage = confirmation.stage;
    const selected = confirmation.records;
    if (selected.length !== confirmation.ids.length) {
      setBulkError("Some selected applications changed. Select them again.");
      return;
    }
    const command: ApplicationCrmBulkStageMutationInput = {
      action: confirmation.action,
      items: selected.map((record) => ({
        applicationRecordId: record.id,
        expectedRevision: applicationCrmDataForView(record).revision,
      })),
      stage,
      customStageId: confirmation.customStageId,
      note: null,
      ...(confirmation.action === "tags" ? { tags: confirmation.tags } : {}),
    };
    setBulkPending(true);
    setBulkError(null);
    try {
      if (props.onBulkChange) await props.onBulkChange(command);
      else if (confirmation.action === "stage" && props.onBulkStageChange)
        await props.onBulkStageChange(confirmation.ids, stage);
      else throw new Error("This change is unavailable.");
      if (confirmation.action === "stage" && props.onBulkChange) {
        const reverse: ApplicationCrmBulkStageMutationInput = {
          action: "undo",
          stage,
          customStageId: null,
          note: "Undid bulk stage change",
          items: selected.map((record) => {
            const crm = applicationCrmDataForView(record);
            const changed =
              crm.stageSource !== "user" ||
              crm.stage !== stage ||
              crm.customStageId !== confirmation.customStageId;
            return {
              applicationRecordId: record.id,
              expectedRevision: crm.revision + (changed ? 1 : 0),
              previousStage: {
                stage: crm.stage,
                stageSource: crm.stageSource,
                customStageId: crm.customStageId,
                stageChangedAt: crm.stageChangedAt,
                appliedAt: crm.appliedAt,
                lastEmployerActivityAt: crm.lastEmployerActivityAt,
              },
            };
          }),
        };
        showToast({
          title: `${selected.length} ${selected.length === 1 ? "application" : "applications"} moved`,
          action: {
            label: "Undo",
            onClick: () => {
              void undoBulkChange(
                reverse,
                new Set(
                  selected.flatMap((record) =>
                    record.events.map((event) => event.id),
                  ),
                ),
              );
            },
          },
        });
      } else
        showToast({
          title: `${selected.length} ${selected.length === 1 ? "application" : "applications"} updated`,
        });
      setSelectedIds([]);
      setConfirmation(null);
    } catch {
      setBulkError(
        "The selected applications could not be updated. Keep them selected and try again.",
      );
    } finally {
      setBulkPending(false);
    }
  }

  async function undoBulkChange(
    command: ApplicationCrmBulkStageMutationInput,
    previousEventIds: ReadonlySet<string>,
  ) {
    if (!props.onBulkChange) return;
    setBulkPending(true);
    setBulkError(null);
    try {
      const closedStep = command.items.some((item) =>
        latestRecordsRef.current
          .find((record) => record.id === item.applicationRecordId)
          ?.events.some(
            (event) =>
              !previousEventIds.has(event.id) &&
              (event.title === "Application step closed: you withdrew it" ||
                event.title === "Application step closed: you sent it"),
          ),
      );
      await props.onBulkChange(command);
      showToast({
        title: "Previous stages restored",
        ...(closedStep
          ? {
              description:
                "Closed steps stay closed. Start the application again from its row to reopen the form.",
            }
          : {}),
      });
    } catch {
      setBulkError(
        "Undo could not be saved because an application changed. Your newer changes were kept.",
      );
    } finally {
      setBulkPending(false);
    }
  }

  return (
    <section
      ref={trackerPanelRef}
      style={
        props.view === "table" && tableMinimum.pane > 0
          ? { minHeight: tableMinimum.panel }
          : undefined
      }
      className="surface-panel-shell @container/tracker flex min-h-0 max-h-[calc(100dvh-15rem)] min-w-0 flex-1 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border)"
    >
      {/* The page header already says "Tracker"; the panel's own name is
          for assistive technology and names the table. Search, count,
          Show, Sort, density, saved views, columns and the view switch share
          one toolbar row. */}
      <h2 className="sr-only" id="application-tracker-heading">
        Application tracker
      </h2>
      <span className="sr-only" id="application-tracker-stage-help">
        A stage is either one you recorded or one Job Finder worked out from
        your activity.
      </span>
      <CollectionSearchToolbar
        compact
        density={density}
        filters={
          <div className="contents" data-tracker-filter-row>
            <Select
              value={savedView}
              onValueChange={(value) => setSavedView(value as CrmSavedView)}
            >
              <SelectTrigger aria-label="Show" size="toolbar" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {crmSavedViewValues.map((view) => (
                  <SelectItem key={view} value={view}>
                    {crmSavedViewLabels[view]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {props.view !== "calendar" ? (
              <Select
                value={sort}
                onValueChange={(value) => setSort(value as TrackerSort)}
              >
                <SelectTrigger
                  aria-label="Sort applications"
                  size="toolbar"
                  className="w-48"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">Recently updated</SelectItem>
                  <SelectItem value="company">Company</SelectItem>
                  <SelectItem value="applied_oldest">
                    Applied date: oldest first
                  </SelectItem>
                  <SelectItem value="applied_newest">
                    Applied date: newest first
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : null}
          </div>
        }
        label="Search applications"
        onDensityChange={setDensity}
        onQueryChange={setQuery}
        placement="panel"
        placeholder="Search jobs, companies, contacts, stages, or tags"
        query={query}
        totalCount={props.records.length}
        viewActions={
          <>
            <CollectionSavedViews
              onApply={(id) => {
                const metadata = applySavedView(id);
                const show = metadata?.show?.[0];
                if (crmSavedViewValues.includes(show as CrmSavedView))
                  setSavedView(show as CrmSavedView);
                else {
                  setSavedView("all");
                  showToast({
                    title: "Saved search restored",
                    description:
                      "This older view did not save Show. Choose Show and save the view again to include it.",
                  });
                }
              }}
              onDelete={deleteSavedView}
              onSave={(name) => saveCurrentView(name, { show: [savedView] })}
              views={savedViews}
            />
            {props.view === "table" ? (
              <CollectionColumnPicker
                columns={columnValues.map((column) => ({
                  id: column,
                  label: columnLabels[column],
                  required: column === "job",
                  visible: visibleColumns.includes(column),
                }))}
                onChange={(columnId, visible) =>
                  setVisibleColumns((current) =>
                    visible
                      ? [...current, columnId as CrmColumn]
                      : current.filter((value) => value !== columnId),
                  )
                }
              />
            ) : null}
            {/* A table, a board and a calendar are three ways of looking at
                a list. With one row there is nothing to look at three ways,
                so the switcher is earned rather than always present. */}
            {props.records.length >=
            APPLICATION_CRM_VIEW_SWITCHER_MIN_RECORDS ? (
              <div
                aria-label="Application view"
                className="flex gap-1"
                data-testid="applications-crm-view-switcher"
                role="group"
              >
                {APPLICATION_CRM_VIEW_VALUES.map((view) => (
                  <Button
                    aria-pressed={props.view === view}
                    key={view}
                    onClick={() => props.onViewChange(view)}
                    size="toolbar"
                    type="button"
                    variant={props.view === view ? "secondary" : "ghost"}
                  >
                    {viewLabels[view]}
                  </Button>
                ))}
              </div>
            ) : null}
          </>
        }
        visibleCount={filteredRecords.length}
      />

      {props.records.length === 0 ? (
        <EmptyState
          description={emptyStateCopy[props.view].description}
          title={emptyStateCopy[props.view].title}
        />
      ) : filteredRecords.length === 0 && query && savedView === "all" ? (
        <CollectionNoMatches
          noun="applications"
          onClear={() => setQuery("")}
          query={query}
        />
      ) : filteredRecords.length === 0 ? (
        <div className="grid min-h-48 place-items-center px-6 text-center">
          <div>
            <h3 className="font-semibold text-foreground">
              {query
                ? `Nothing in ${crmSavedViewLabels[savedView]} matches "${query}"`
                : "No applications in this view right now"}
            </h3>
            {/* Both filters can hide a row; each gets its own way back. */}
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button
                onClick={() => setSavedView("all")}
                size="sm"
                type="button"
                variant="ghost"
              >
                Show all applications
              </Button>
              {query ? (
                <Button
                  onClick={() => setQuery("")}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear search
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {props.view === "table" && filteredRecords.length > 0 ? (
        <div
          ref={tablePaneRef}
          style={
            tableMinimum.pane > 0 ? { minHeight: tableMinimum.pane } : undefined
          }
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          data-locked-pane-scroll-region
        >
          <table
            aria-labelledby="application-tracker-heading"
            className="w-full table-fixed border-collapse text-left text-sm"
            style={{
              minWidth: `${2.5 + columnValues.filter(columnVisible).reduce((width, column) => width + columnMinimumWidths[column], 0)}rem`,
            }}
            data-application-tracker-table
          >
            <thead className="sticky top-0 z-10 bg-(--surface-panel-solid)">
              <tr className="border-b border-(--surface-panel-border)">
                <th className="w-10 px-3 py-3" scope="col">
                  <input
                    aria-label="Select all matching applications"
                    checked={
                      selectedIdSet.size > 0 &&
                      selectedIdSet.size === filteredRecords.length
                    }
                    onChange={(event) =>
                      setSelectedIds(
                        event.target.checked
                          ? filteredRecords.map((record) => record.id)
                          : [],
                      )
                    }
                    type="checkbox"
                  />
                </th>
                {columnValues.filter(columnVisible).map((column) => (
                  <th
                    className={cn(
                      "label-mono-xs px-2 py-3 capitalize",
                      column === "job"
                        ? "w-[12rem]"
                        : column === "company"
                          ? "w-[10rem]"
                          : column === "stage"
                            ? "w-[8.5rem] whitespace-nowrap"
                            : column === "tags"
                              ? "w-20 whitespace-nowrap"
                              : // Date columns: "Oct 3, 12:37 PM" and the
                                // "Next reminder" heading fit without cutting.
                                "w-[7.5rem] whitespace-nowrap",
                    )}
                    key={column}
                    scope="col"
                    {...(column === "stage"
                      ? { "aria-describedby": "application-tracker-stage-help" }
                      : {})}
                    title={
                      ["updated", "applied", "reminder"].includes(column)
                        ? resolvePlanTimeZone(props.homeTimeZone)
                        : column === "stage"
                          ? "A stage is either one you recorded or one Job Finder worked out from your activity."
                          : undefined
                    }
                  >
                    {columnLabels[column]}
                    {column === "stage" ? (
                      <Info
                        aria-hidden="true"
                        className="ml-1 inline size-3 align-[-1px] text-foreground-muted"
                      />
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRecords.map((record) => {
                const crm = applicationCrmDataForView(record);
                const employer = formatApplicationEmployerLine({
                  company: record.company,
                  ...(relatedJobsById.get(record.jobId)?.canonicalUrl
                    ? {
                        canonicalUrl: relatedJobsById.get(record.jobId)
                          ?.canonicalUrl,
                      }
                    : {}),
                });
                const employerLine = [
                  relatedJobsById.get(record.jobId)?.location,
                  employer,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const reminder = crm.reminders
                  .filter((entry) => entry.status === "pending")
                  .sort((left, right) =>
                    left.dueAt.localeCompare(right.dueAt),
                  )[0];
                const interview = crm.interviews
                  .filter((entry) => entry.status === "scheduled")
                  .sort((left, right) =>
                    left.startsAt.localeCompare(right.startsAt),
                  )[0];
                return (
                  <tr
                    className={cn(
                      "cursor-pointer border-b border-(--surface-panel-border) hover:bg-(--surface-panel-raised)",
                      props.selectedRecordId === record.id &&
                        "bg-(--surface-panel-raised)",
                    )}
                    key={record.id}
                    onClick={() => props.onSelectRecord(record.id)}
                  >
                    <td
                      className={cn("px-3", rowPadding)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        aria-label={
                          employerLine
                            ? `Select ${record.title} at ${employerLine}`
                            : `Select ${record.title}`
                        }
                        checked={selectedIdSet.has(record.id)}
                        onChange={(event) =>
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) {
                              next.add(record.id);
                            } else {
                              next.delete(record.id);
                            }
                            return [...next];
                          })
                        }
                        type="checkbox"
                      />
                    </td>
                    {columnVisible("job") ? (
                      <td
                        className={cn(
                          "px-2 font-semibold text-foreground",
                          rowPadding,
                        )}
                      >
                        <button
                          className="block w-full truncate text-left outline-none focus-visible:underline"
                          title={record.title}
                          onClick={() => props.onSelectRecord(record.id)}
                          type="button"
                        >
                          {record.title}
                        </button>
                      </td>
                    ) : null}
                    {columnVisible("company") ? (
                      <td
                        className={cn("px-2 text-foreground-soft", rowPadding)}
                      >
                        <span
                          className="block truncate"
                          title={employerLine ?? undefined}
                        >
                          {employerLine ?? "—"}
                        </span>
                      </td>
                    ) : null}
                    {columnVisible("stage") ? (
                      <td className={cn("whitespace-nowrap px-2", rowPadding)}>
                        <span
                          className="block truncate"
                          title={`${applicationCrmStageLabelForView(record, customStages)}. ${applicationCrmStageProvenanceDetailForView(record)}`}
                        >
                          {applicationCrmStageLabelForView(
                            record,
                            customStages,
                          )}
                        </span>
                      </td>
                    ) : null}
                    {columnVisible("reminder") ? (
                      <td
                        className={cn(
                          "whitespace-nowrap px-2 text-muted-foreground",
                          rowPadding,
                        )}
                      >
                        <span
                          className="block truncate"
                          title={
                            reminder
                              ? formatCalendarMoment(
                                  reminder.dueAt,
                                  props.homeTimeZone,
                                )
                              : undefined
                          }
                        >
                          {reminder
                            ? formatTrackerCell(
                                reminder.dueAt,
                                props.homeTimeZone,
                              )
                            : "—"}
                        </span>
                      </td>
                    ) : null}
                    {columnVisible("interview") ? (
                      <td
                        title={
                          interview
                            ? formatCalendarMoment(
                                interview.startsAt,
                                interview.timeZone,
                              )
                            : undefined
                        }
                        className={cn(
                          "whitespace-nowrap px-2 text-muted-foreground",
                          rowPadding,
                        )}
                      >
                        <span className="block truncate">
                          {interview
                            ? formatTrackerCell(
                                interview.startsAt,
                                interview.timeZone,
                              )
                            : "—"}
                        </span>
                      </td>
                    ) : null}
                    {columnVisible("tags") ? (
                      <td
                        className={cn(
                          "whitespace-nowrap px-2 text-muted-foreground",
                          rowPadding,
                        )}
                      >
                        <span
                          className="block truncate"
                          title={crm.tags.join(", ") || undefined}
                        >
                          {crm.tags.join(", ") || "—"}
                        </span>
                      </td>
                    ) : null}
                    {columnVisible("applied") ? (
                      <td
                        className={cn(
                          "whitespace-nowrap px-2 text-muted-foreground",
                          rowPadding,
                        )}
                      >
                        <span
                          className="block truncate"
                          title={
                            crm.appliedAt
                              ? formatCalendarMoment(
                                  crm.appliedAt,
                                  props.homeTimeZone,
                                )
                              : undefined
                          }
                        >
                          {crm.appliedAt
                            ? formatTrackerCell(
                                crm.appliedAt,
                                props.homeTimeZone,
                              )
                            : "—"}
                        </span>
                      </td>
                    ) : null}
                    {columnVisible("updated") ? (
                      <td
                        className={cn(
                          "whitespace-nowrap px-2 text-muted-foreground",
                          rowPadding,
                        )}
                      >
                        <span
                          className="block truncate"
                          title={formatCalendarMoment(
                            record.lastUpdatedAt,
                            props.homeTimeZone,
                          )}
                        >
                          {formatTrackerCell(
                            record.lastUpdatedAt,
                            props.homeTimeZone,
                          )}
                        </span>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {bulkError && selectedIds.length === 0 ? (
        <p role="alert" className="p-3 text-destructive">
          {bulkError}
        </p>
      ) : null}
      {props.view === "table" && selectedIds.length > 0 ? (
        <div
          data-bulk-selection-bar
          className="sticky bottom-0 z-20 shrink-0 flex flex-wrap items-center justify-between gap-3 border-t border-primary/30 bg-(--surface-panel-solid) px-5 py-3 shadow-[0_-12px_28px_rgba(0,0,0,0.35)]"
        >
          {bulkError ? (
            <p
              className="basis-full rounded-(--radius-field) border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {bulkError}
            </p>
          ) : null}
          {confirmation ? (
            <div
              role="alertdialog"
              aria-label="Confirm bulk change"
              className="grid w-full gap-2"
            >
              <strong>{confirmation.label}</strong>
              <p>
                {selectedIds.length === 1
                  ? "This application will change."
                  : "Every selected application will change, including those on other pages."}
              </p>
              {confirmation.action === "archive" ? (
                <p>
                  Outcomes and dates stay saved. You can restore these
                  applications from Archived applications.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  disabled={bulkPending}
                  onClick={() => void runBulkChange()}
                >
                  Confirm change
                </Button>
                <Button
                  disabled={bulkPending}
                  onClick={() => setConfirmation(null)}
                  variant="ghost"
                >
                  Cancel change
                </Button>
              </div>
            </div>
          ) : null}
          <strong className="text-sm text-foreground">
            {selectedIds.length} matching application
            {selectedIds.length === 1 ? "" : "s"} selected
          </strong>
          {!confirmation ? (
            <>
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-2 text-sm">
                  Stage
                  <Select
                    value={bulkStage}
                    disabled={bulkPending}
                    onValueChange={setBulkStage}
                  >
                    <SelectTrigger
                      aria-label="Bulk stage"
                      size="toolbar"
                      className="w-40"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {APPLICATION_CRM_MANUAL_STAGES.map((stage) => (
                        <SelectItem key={stage} value={stage}>
                          {APPLICATION_CRM_STAGE_NAMES[stage]}
                        </SelectItem>
                      ))}
                      {customStages.map((stage) => (
                        <SelectItem key={stage.id} value={`custom:${stage.id}`}>
                          {stage.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <Button
                  disabled={
                    bulkPending ||
                    (!props.onBulkStageChange && !props.onBulkChange)
                  }
                  onClick={() => requestBulkChange("stage")}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Move to{" "}
                  {customStages.find(
                    (entry) => `custom:${entry.id}` === bulkStage,
                  )?.label ??
                    APPLICATION_CRM_STAGE_NAMES[
                      bulkStage as ApplicationCrmStage
                    ]}
                </Button>
                {props.onBulkChange ? (
                  <>
                    <Input
                      size="toolbar"
                      className="w-56"
                      aria-label="Bulk tags"
                      placeholder="Tags, separated by commas"
                      value={bulkTags}
                      onChange={(event) => setBulkTags(event.target.value)}
                    />
                    <Button
                      disabled={bulkPending || !bulkTags.trim()}
                      onClick={() => requestBulkChange("tags")}
                      size="sm"
                      variant="ghost"
                    >
                      Add tags
                    </Button>
                    <Button
                      disabled={bulkPending}
                      onClick={() =>
                        requestBulkChange(
                          savedView === "archived" ? "restore" : "archive",
                        )
                      }
                      size="sm"
                      variant="ghost"
                    >
                      {savedView === "archived"
                        ? "Restore selected"
                        : "Archive selected"}
                    </Button>
                  </>
                ) : null}
                <Button
                  disabled={bulkPending}
                  onClick={() => setSelectedIds([])}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear selection
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {props.view === "kanban" && filteredRecords.length > 0 ? (
        <div
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4"
          data-locked-pane-scroll-region
        >
          <div className="grid min-w-0 gap-3">
            {emptyKanbanStages.length > 0 ? (
              <div className="flex min-w-0 justify-end">
                <Button
                  onClick={() =>
                    setShowEmptyKanbanStages((current) => !current)
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {showEmptyKanbanStages
                    ? "Hide empty stages"
                    : `Show empty stages (${emptyKanbanStages.length})`}
                </Button>
              </div>
            ) : null}
            {populatedKanbanStages.map((stage) => {
              const allStageRecords = grouped.get(stage) ?? [];
              const stagePage = Math.min(
                boardPages[stage] ?? 1,
                Math.max(
                  1,
                  Math.ceil(allStageRecords.length / BOARD_PAGE_SIZE),
                ),
              );
              const stageRecords = allStageRecords.slice(
                (stagePage - 1) * BOARD_PAGE_SIZE,
                stagePage * BOARD_PAGE_SIZE,
              );
              return (
                <section
                  className="grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-3"
                  key={stage}
                  aria-label={`${APPLICATION_CRM_STAGE_NAMES[stage]} applications`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-foreground">
                      {APPLICATION_CRM_STAGE_NAMES[stage]}
                    </h3>
                    <Badge variant="section">
                      {groupedTotals.get(stage)?.length ?? 0}
                    </Badge>
                  </div>
                  <div className="grid gap-2">
                    {stageRecords.length > 0 ? (
                      stageRecords.map((record) => (
                        <RecordButton
                          compact
                          key={record.id}
                          onSelect={props.onSelectRecord}
                          record={record}
                          relatedJobLocation={
                            relatedJobsById.get(record.jobId)?.location ?? null
                          }
                          relatedJobCanonicalUrl={
                            relatedJobsById.get(record.jobId)?.canonicalUrl ??
                            null
                          }
                          selected={props.selectedRecordId === record.id}
                        />
                      ))
                    ) : (
                      <p className="rounded-(--radius-field) border border-dashed border-(--surface-panel-border) p-3 text-xs text-muted-foreground">
                        No applications
                      </p>
                    )}
                  </div>
                  {allStageRecords.length > BOARD_PAGE_SIZE ? (
                    <CollectionPagination
                      itemLabel={`${APPLICATION_CRM_STAGE_NAMES[stage]} applications`}
                      page={stagePage}
                      pageSize={BOARD_PAGE_SIZE}
                      totalCount={allStageRecords.length}
                      onPageChange={(value) =>
                        setBoardPages((current) => ({
                          ...current,
                          [stage]: value,
                        }))
                      }
                    />
                  ) : null}
                </section>
              );
            })}
            {showEmptyKanbanStages ? (
              <div
                aria-label="Empty stages"
                className="grid min-w-0 grid-cols-2 gap-2"
                role="list"
              >
                {emptyKanbanStages.map((stage) => (
                  <div
                    className="flex min-w-0 items-center justify-between gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) px-3 py-2"
                    key={stage}
                    role="listitem"
                  >
                    <span className="min-w-0 break-words text-xs font-medium text-foreground-soft">
                      {APPLICATION_CRM_STAGE_NAMES[stage]}
                    </span>
                    <Badge variant="section">0</Badge>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {props.view === "calendar" && filteredRecords.length > 0 ? (
        <div
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-5"
          data-locked-pane-scroll-region
        >
          {calendarError ? (
            <p
              className="mb-4 rounded-(--radius-field) border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {calendarError}
            </p>
          ) : null}
          {calendar.length > 0 ? (
            <div className="grid gap-5">
              {groupCalendarEntries(
                pagedCalendar,
                Date.now(),
                props.homeTimeZone,
              ).map((group) => (
                <section
                  aria-label={group.label}
                  className="grid gap-2"
                  key={group.key}
                >
                  <h3
                    className={
                      group.key === "overdue"
                        ? "text-xs font-bold uppercase tracking-(--tracking-label) text-(--warning-text)"
                        : "text-xs font-bold uppercase tracking-(--tracking-label) text-foreground-muted"
                    }
                  >
                    {group.label}
                  </h3>
                  <ol className="grid gap-3">
                    {group.entries.map((entry) => {
                      const record = recordsById.get(entry.applicationRecordId);
                      return (
                        <li
                          className="grid gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-4 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
                          key={entry.id}
                        >
                          <time
                            className="text-sm font-semibold text-foreground"
                            dateTime={entry.startsAt}
                          >
                            {formatCalendarMoment(
                              entry.startsAt,
                              entry.timeZone ?? props.homeTimeZone,
                            )}
                          </time>
                          <div className="min-w-0">
                            <strong className="block break-words text-sm text-foreground">
                              {entry.title}
                            </strong>
                            <span className="label-mono-xs">
                              {entry.kind.replaceAll("_", " ")}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {entry.kind === "reminder" &&
                            props.onCompleteReminder ? (
                              <Button
                                aria-label={`Mark "${entry.title}" done`}
                                disabled={completingEntryId !== null}
                                onClick={() => void completeReminder(entry)}
                                pending={completingEntryId === entry.id}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                Mark done
                              </Button>
                            ) : null}
                            <Button
                              disabled={!record}
                              onClick={() =>
                                record && props.onSelectRecord(record.id)
                              }
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Open
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center text-center">
              <div>
                <h3 className="font-semibold text-foreground">
                  Nothing scheduled
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pending reminders, interviews, and offer deadlines will appear
                  here.
                </p>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {pageItemCount > 0 && props.view !== "kanban" ? (
        <CollectionPagination
          itemLabel={
            props.view === "calendar" ? "scheduled items" : "applications"
          }
          onPageChange={setPage}
          page={currentPage}
          pageSize={APPLICATION_CRM_PAGE_SIZE}
          totalCount={pageItemCount}
        />
      ) : null}
    </section>
  );
}
