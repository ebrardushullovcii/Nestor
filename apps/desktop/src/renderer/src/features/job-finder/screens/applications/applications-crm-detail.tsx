import { Input } from "@renderer/components/ui/input";
import { useEffect, useId, useMemo, useState } from "react";
import type {
  ApplicationCrmExportFormat,
  ApplicationCrmInterview,
  ApplicationCrmMutationInput,
  ApplicationCrmReminder,
  ApplicationCrmSettings,
  ApplicationCrmStage,
  ApplicationRecord,
  CandidateAsset,
} from "@nestor/contracts";
import {
  deviceTimeZone,
  resolvePlanTimeZone,
} from "../../lib/job-finder-timestamp-format";
import {
  trackerTimeToIso,
  searchableTrackerTimeZones,
  trackerTimeZoneLabel,
  trackerTimeInputValue,
  formatTrackerMoment,
} from "./applications-tracker-time";
import { Button } from "@renderer/components/ui/button";

import {
  APPLICATION_CRM_STAGE_LABELS,
  APPLICATION_CRM_MANUAL_STAGES,
  applicationCrmDataForView,
} from "./applications-crm-model";
import { StatusBadge } from "../../components/status-badge";
import { formatApplicationEmployerLine } from "../../lib/job-employer-location-display";
import { getJobFinderDateInputLocale } from "../../lib/job-finder-date-input-locale";

const jobFinderDateInputLocale = getJobFinderDateInputLocale();

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const fieldClassName =
  "h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]";
const areaClassName =
  "min-h-20 w-full resize-y rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 py-2 text-sm leading-6 text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]";

const legacySubmitApprovalEvent = {
  title: "Automatic submit approval requested",
  detail:
    "A run-scoped submit approval was created for this job. The current safe implementation still stops before any final submit action.",
} as const;

function applicationCrmEventCopyForView(
  title: string,
  detail: string | null,
): { title: string; detail: string | null } {
  if (
    title !== legacySubmitApprovalEvent.title ||
    detail !== legacySubmitApprovalEvent.detail
  ) {
    return { title, detail };
  }

  return {
    title: "Historical legacy event: preparation approval requested",
    detail:
      "Legacy record: this requested approval to open and fill the application for preparation only. It granted no authority to submit.",
  };
}

/** What an export holds, as the export links' tooltip. */
const EXPORT_SCOPE_NOTE =
  "Local notes and stages only. Exports contain these tracking facts, not submission evidence.";

export function ApplicationsCrmDetail(props: {
  record: ApplicationRecord;
  homeTimeZone?: string;
  relatedJobCanonicalUrl?: string | null;
  settings: ApplicationCrmSettings;
  onMutate: (command: ApplicationCrmMutationInput) => Promise<void>;
  onExport: (
    format: ApplicationCrmExportFormat,
    recordId: string,
  ) => Promise<void>;
}) {
  const homeTimeZone = resolvePlanTimeZone(
    props.homeTimeZone ?? deviceTimeZone(),
  );
  const crm = applicationCrmDataForView(props.record);
  const employerLine = formatApplicationEmployerLine({
    company: props.record.company,
    ...(props.relatedJobCanonicalUrl
      ? { canonicalUrl: props.relatedJobCanonicalUrl }
      : {}),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState(crm.tags.join(", "));
  const [note, setNote] = useState("");
  const [manualReceipt, setManualReceipt] = useState("");
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [interviewTitle, setInterviewTitle] = useState("");
  const [interviewAt, setInterviewAt] = useState("");
  const [interviewTimeZone, setInterviewTimeZone] = useState(homeTimeZone);
  const [timeZoneQuery, setTimeZoneQuery] = useState("");
  const timeZones = useMemo(
    () => searchableTrackerTimeZones(timeZoneQuery, homeTimeZone),
    [timeZoneQuery, homeTimeZone],
  );
  const [timeZoneOpen, setTimeZoneOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [offerAmount, setOfferAmount] = useState(
    crm.compensation.offerBase?.amount.toString() ?? "",
  );
  const [offerCurrency, setOfferCurrency] = useState(
    crm.compensation.offerBase?.currency ?? "EUR",
  );
  const [offerPeriod, setOfferPeriod] = useState<"hour" | "month" | "year">(
    crm.compensation.offerBase?.period ?? "year",
  );
  const [offerDeadline, setOfferDeadline] = useState(
    crm.compensation.offerDeadlineAt
      ? trackerTimeInputValue(
          Date.parse(crm.compensation.offerDeadlineAt),
          homeTimeZone,
        )
      : "",
  );
  const [reminderReschedules, setReminderReschedules] = useState<
    Record<string, string>
  >({});
  const [candidateAssets, setCandidateAssets] = useState<
    readonly CandidateAsset[]
  >([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const addNoteReasonId = useId();
  const exportDisabledReasonId = useId();
  // Re-seed only when a different record is shown. Revision bumps on the same
  // record must not clobber in-progress drafts; the screen keys this detail by
  // record id, so this also acts as a safety net for unkeyed mounts.
  useEffect(() => {
    const nextCrm = applicationCrmDataForView(props.record);
    setTags(nextCrm.tags.join(", "));
    setOfferAmount(nextCrm.compensation.offerBase?.amount.toString() ?? "");
    setOfferCurrency(nextCrm.compensation.offerBase?.currency ?? "EUR");
    setOfferPeriod(nextCrm.compensation.offerBase?.period ?? "year");
    setOfferDeadline(
      nextCrm.compensation.offerDeadlineAt
        ? trackerTimeInputValue(
            Date.parse(nextCrm.compensation.offerDeadlineAt),
            homeTimeZone,
          )
        : "",
    );
    setReminderReschedules({});
    setError(null);
  }, [props.record.id]);

  useEffect(() => {
    let active = true;
    void window.nestor.jobFinder
      .listCandidateAssets({ includeDeleted: false })
      .then((result) => {
        if (!active) return;
        setCandidateAssets(
          result.assets.filter(
            (asset) =>
              asset.deletedAt === null &&
              asset.consentScope === "job_application_attachment",
          ),
        );
      })
      .catch(() => {
        if (active) setCandidateAssets([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const customStagesById = useMemo(
    () =>
      new Map(props.settings.customStages.map((stage) => [stage.id, stage])),
    [props.settings.customStages],
  );

  async function mutate(mutation: ApplicationCrmMutationInput["mutation"]) {
    setPending(true);
    setError(null);
    try {
      await props.onMutate({
        applicationRecordId: props.record.id,
        expectedRevision: crm.revision,
        mutation,
      });
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The application update could not be saved.",
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  function saveTags() {
    const nextTags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (nextTags.join("\u0000") === crm.tags.join("\u0000")) return;
    void mutate({ type: "set_tags", tags: nextTags });
  }

  function selectStage(value: string) {
    const customId = value.startsWith("custom:") ? value.slice(7) : null;
    const custom = customId ? customStagesById.get(customId) : null;
    const stage = custom?.baseStage ?? (value as ApplicationCrmStage);
    const selection = {
      stage,
      customStageId: custom?.id ?? null,
      label: custom?.label ?? APPLICATION_CRM_STAGE_LABELS[stage],
    };
    void mutate({
      type: "set_stage",
      stage: selection.stage,
      customStageId: selection.customStageId,
      note: null,
    });
  }

  function setReminderStatus(
    entry: ApplicationCrmReminder,
    status: "completed" | "dismissed",
  ) {
    const now = new Date().toISOString();
    void mutate({
      type: "upsert_reminder",
      reminder: {
        ...entry,
        status,
        updatedAt: now,
        ...(status === "completed" ? { completedAt: now } : {}),
      },
    });
  }

  function rescheduleReminder(entry: ApplicationCrmReminder) {
    const dueAt = trackerTimeToIso(
      reminderReschedules[entry.id] ?? "",
      homeTimeZone,
    );
    if (!dueAt) return;
    void mutate({
      type: "upsert_reminder",
      reminder: { ...entry, dueAt, updatedAt: new Date().toISOString() },
    }).then((saved) => {
      if (!saved) return;
      setReminderReschedules((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
    });
  }

  function setInterviewStatus(
    entry: ApplicationCrmInterview,
    status: "completed" | "cancelled",
  ) {
    void mutate({
      type: "upsert_interview",
      interview: { ...entry, status, updatedAt: new Date().toISOString() },
    });
  }

  return (
    <section
      className="grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-4"
      aria-labelledby="application-crm-details-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* The page header already says the tracker never submits; the
              paragraph that said it again here is gone. */}
          <p className="label-mono-xs">Application tracker</p>
          <h3
            className="mt-1 font-semibold text-foreground"
            id="application-crm-details-heading"
          >
            Track what happens next
          </h3>
          <p className="mt-1 text-sm font-medium break-words leading-6 text-foreground">
            {employerLine
              ? `${props.record.title} · ${employerLine}`
              : props.record.title}
          </p>
        </div>
        {/* These two were the same colour as the paragraph directly above
            them, with no underline, box or chevron — nothing said they were
            controls. One link treatment, always underlined. */}
        <div className="flex items-baseline gap-4">
          <Button
            aria-describedby={pending ? exportDisabledReasonId : undefined}
            disabled={pending}
            onClick={() => void props.onExport("csv", props.record.id)}
            size="sm"
            title={EXPORT_SCOPE_NOTE}
            type="button"
            variant="link"
          >
            Export this application (CSV)
          </Button>
          <Button
            aria-describedby={pending ? exportDisabledReasonId : undefined}
            disabled={pending}
            onClick={() => void props.onExport("json", props.record.id)}
            size="sm"
            title={EXPORT_SCOPE_NOTE}
            type="button"
            variant="link"
          >
            Export this application (JSON)
          </Button>
          {pending ? (
            <span
              className="text-(length:--text-small) text-(--disabled-foreground)"
              id={exportDisabledReasonId}
            >
              Available once the change you just made has saved.
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p
          className="rounded-(--radius-field) border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid content-start gap-3">
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Stage
            <select
              className={fieldClassName}
              disabled={pending}
              onChange={(event) => selectStage(event.target.value)}
              value={
                crm.customStageId ? `custom:${crm.customStageId}` : crm.stage
              }
            >
              {!APPLICATION_CRM_MANUAL_STAGES.includes(crm.stage) &&
              !crm.customStageId ? (
                <option value={crm.stage} disabled>
                  {APPLICATION_CRM_STAGE_LABELS[crm.stage]} (from activity)
                </option>
              ) : null}
              {APPLICATION_CRM_MANUAL_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {APPLICATION_CRM_STAGE_LABELS[stage]}
                </option>
              ))}
              {props.settings.customStages.length > 0 ? (
                <optgroup label="Custom stages">
                  {props.settings.customStages.map((stage) => (
                    <option key={stage.id} value={`custom:${stage.id}`}>
                      {stage.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          {crm.stage === "ready_to_send" ||
          (props.record.lastAttemptState === "ready" &&
            crm.stageSource !== "user") ? (
            <div className="grid gap-2">
              <p className="text-sm text-foreground-soft">
                After the employer confirms receipt, record that you sent it.
              </p>
              <Input
                aria-label="Receipt reference (optional)"
                placeholder="Receipt reference (optional)"
                value={manualReceipt}
                onChange={(event) => setManualReceipt(event.target.value)}
              />
              <Button
                disabled={pending}
                onClick={() =>
                  void mutate({
                    type: "set_stage",
                    stage: "applied",
                    customStageId: null,
                    note: manualReceipt.trim()
                      ? `You recorded a send. Receipt: ${manualReceipt.trim()}`
                      : "You recorded that you sent this application.",
                  })
                }
                size="sm"
                variant="secondary"
              >
                I sent it
              </Button>
            </div>
          ) : null}
        </div>
        {/* Tags save when the field is left or Enter is pressed, the same
            as the stage beside them saves on change; Add buttons are only for
            new notes, reminders and interviews. */}
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            saveTags();
          }}
        >
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="application-crm-tags"
          >
            Tags
          </label>
          <div className="flex gap-2">
            <input
              className={fieldClassName}
              disabled={pending}
              id="application-crm-tags"
              onBlur={saveTags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="priority, remote, referral"
              value={tags}
            />
          </div>
        </form>
      </div>

      <details
        className="group rounded-(--radius-field) border border-(--surface-panel-border) p-3"
        open
      >
        <summary className="cursor-pointer font-semibold text-foreground">
          Notes and follow-ups
        </summary>
        <div className="mt-3 grid gap-4">
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const body = note.trim();
              if (!body) return;
              void mutate({
                type: "add_note",
                note: {
                  id: createId("note"),
                  body,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              }).then((saved) => {
                if (saved)
                  setNote((current) =>
                    current.trim() === body ? "" : current,
                  );
              });
            }}
          >
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="application-crm-note"
            >
              Add a note
            </label>
            <textarea
              className={areaClassName}
              id="application-crm-note"
              maxLength={4_000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Record recruiter feedback or what you want to remember."
              value={note}
            />
            {/* A greyed control with no stated reason reads as broken. */}
            <div className="grid justify-items-start gap-1">
              <Button
                aria-describedby={
                  pending || !note.trim() ? addNoteReasonId : undefined
                }
                className="justify-self-start"
                disabled={pending || !note.trim()}
                size="sm"
                type="submit"
                variant="secondary"
              >
                Add note
              </Button>
              {pending || !note.trim() ? (
                <p
                  className="text-(length:--text-small) text-(--disabled-foreground)"
                  id={addNoteReasonId}
                >
                  {pending
                    ? "Available once the change you just made has saved."
                    : "Write the note first."}
                </p>
              ) : null}
            </div>
          </form>
          {crm.notes.length > 0 ? (
            <ul className="grid gap-2" aria-label="Application notes">
              {[...crm.notes].reverse().map((entry) => (
                <li
                  className="flex items-start justify-between gap-3 rounded-(--radius-field) bg-background/45 p-3 text-sm"
                  key={entry.id}
                >
                  <div>
                    <p className="min-w-0 wrap-anywhere whitespace-pre-wrap text-foreground">
                      {entry.body}
                    </p>
                    <time
                      className="mt-1 block text-xs text-muted-foreground"
                      dateTime={entry.updatedAt}
                    >
                      {formatTrackerMoment(entry.updatedAt, homeTimeZone)}
                    </time>
                  </div>
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void mutate({ type: "remove_note", noteId: entry.id })
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.75fr)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const dueAt = trackerTimeToIso(reminderAt, homeTimeZone);
              if (!reminderTitle.trim() || !dueAt) return;
              const now = new Date().toISOString();
              void mutate({
                type: "upsert_reminder",
                reminder: {
                  id: createId("reminder"),
                  title: reminderTitle.trim(),
                  dueAt,
                  status: "pending",
                  note: null,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: null,
                },
              }).then((saved) => {
                if (!saved) return;
                setReminderTitle("");
                setReminderAt("");
              });
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Reminder
              <input
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setReminderTitle(event.target.value)}
                placeholder="Follow up"
                value={reminderTitle}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              <span>
                Due{" "}
                <span
                  aria-hidden="true"
                  className="font-normal text-foreground-muted"
                >
                  ({homeTimeZone})
                </span>
              </span>
              <input
                aria-label="Due"
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setReminderAt(event.target.value)}
                lang={jobFinderDateInputLocale}
                type="datetime-local"
                value={reminderAt}
              />
            </label>
            <Button
              disabled={pending || !reminderTitle.trim() || !reminderAt}
              size="sm"
              type="submit"
              variant="secondary"
            >
              Add
            </Button>
          </form>
          {crm.reminders.length > 0 ? (
            <ul aria-label="Application reminders" className="grid gap-2">
              {[...crm.reminders].reverse().map((entry) => (
                <li
                  className="grid gap-2 rounded-(--radius-field) bg-background/45 p-3 text-sm"
                  key={entry.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium text-foreground">
                        {entry.title}
                      </p>
                      <time
                        className="mt-0.5 block text-xs text-muted-foreground"
                        dateTime={entry.dueAt}
                      >
                        Due {formatTrackerMoment(entry.dueAt, homeTimeZone)}
                      </time>
                    </div>
                    <StatusBadge
                      tone={entry.status === "pending" ? "active" : "muted"}
                    >
                      {entry.status}
                    </StatusBadge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.status === "pending" ? (
                      <>
                        <Button
                          disabled={pending}
                          onClick={() => setReminderStatus(entry, "completed")}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Complete
                        </Button>
                        <Button
                          disabled={pending}
                          onClick={() => setReminderStatus(entry, "dismissed")}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Dismiss
                        </Button>
                        <form
                          className="flex items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            rescheduleReminder(entry);
                          }}
                        >
                          <input
                            aria-label={`New due time for ${entry.title}`}
                            className={`${fieldClassName} sm:w-56`}
                            disabled={pending}
                            onChange={(event) =>
                              setReminderReschedules((current) => ({
                                ...current,
                                [entry.id]: event.target.value,
                              }))
                            }
                            lang={jobFinderDateInputLocale}
                            type="datetime-local"
                            value={reminderReschedules[entry.id] ?? ""}
                          />
                          <Button
                            disabled={pending || !reminderReschedules[entry.id]}
                            size="sm"
                            type="submit"
                            variant="secondary"
                          >
                            Reschedule
                          </Button>
                        </form>
                      </>
                    ) : null}
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void mutate({
                          type: "remove_reminder",
                          reminderId: entry.id,
                        })
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>

      <details className="rounded-(--radius-field) border border-(--control-border) p-3">
        <summary className="cursor-pointer font-semibold text-foreground">
          Interviews and contacts
        </summary>
        <div className="mt-3 grid gap-4">
          <form
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.75fr)_minmax(10rem,0.6fr)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const startsAt = trackerTimeToIso(interviewAt, interviewTimeZone);
              if (!startsAt) {
                setError(
                  "This time does not exist in that time zone. Choose another time.",
                );
                return;
              }
              if (!interviewTitle.trim()) return;
              const now = new Date().toISOString();
              void mutate({
                type: "upsert_interview",
                interview: {
                  id: createId("interview"),
                  title: interviewTitle.trim(),
                  startsAt,
                  endsAt: null,
                  timeZone: interviewTimeZone,
                  location: null,
                  meetingUrl: null,
                  contactIds: [],
                  status: "scheduled",
                  notes: null,
                  createdAt: now,
                  updatedAt: now,
                },
              }).then((saved) => {
                if (!saved) return;
                setInterviewTitle("");
                setInterviewAt("");
              });
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Interview
              <input
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setInterviewTitle(event.target.value)}
                placeholder="Technical interview"
                value={interviewTitle}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              <span>
                Starts{" "}
                <span
                  aria-hidden="true"
                  className="font-normal text-foreground-muted"
                >
                  ({interviewTimeZone})
                </span>
              </span>
              <input
                aria-label="Starts"
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setInterviewAt(event.target.value)}
                lang={jobFinderDateInputLocale}
                type="datetime-local"
                value={interviewAt}
              />
            </label>
            <div
              className="relative grid min-w-0 gap-1.5 text-sm font-medium text-foreground"
              onBlur={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  setTimeZoneOpen(false);
              }}
            >
              <label htmlFor="interview-zone-search">Time zone</label>
              <Input
                id="interview-zone-search"
                aria-label="Interview time zone"
                role="combobox"
                aria-expanded={timeZoneOpen}
                aria-controls="interview-zone-options"
                aria-autocomplete="list"
                disabled={pending}
                value={
                  timeZoneOpen
                    ? timeZoneQuery
                    : trackerTimeZoneLabel(interviewTimeZone)
                }
                placeholder="Search city or zone"
                onFocus={(event) => {
                  if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.parentElement?.contains(
                      event.relatedTarget,
                    )
                  ) {
                    setTimeZoneQuery("");
                    setTimeZoneOpen(true);
                  }
                }}
                onChange={(event) => {
                  setTimeZoneQuery(event.target.value);
                  setTimeZoneOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setTimeZoneOpen(false);
                  if (event.key === "Enter" && timeZoneOpen) {
                    event.preventDefault();
                    if (timeZones[0]) setInterviewTimeZone(timeZones[0]);
                    setTimeZoneOpen(false);
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setTimeZoneOpen(true);
                    document
                      .querySelector<HTMLButtonElement>(
                        "#interview-zone-options [role=option]",
                      )
                      ?.focus();
                  }
                }}
              />
              {timeZoneOpen ? (
                <div
                  id="interview-zone-options"
                  role="listbox"
                  aria-label="Time zones"
                  className="absolute top-full z-50 mt-1 max-h-56 w-full overflow-auto rounded-(--radius-field) border border-(--field-border) bg-popover p-1 shadow-(--select-shadow)"
                  onMouseDown={(event) => event.preventDefault()}
                >
                  {timeZones.slice(0, 50).map((zone) => (
                    <button
                      key={zone}
                      type="button"
                      role="option"
                      aria-selected={zone === interviewTimeZone}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-secondary focus:bg-secondary"
                      onClick={() => {
                        setInterviewTimeZone(zone);
                        document
                          .getElementById("interview-zone-search")
                          ?.focus();
                        setTimeZoneOpen(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          document
                            .getElementById("interview-zone-search")
                            ?.focus();
                          setTimeZoneOpen(false);
                        }
                        if (
                          event.key === "ArrowDown" ||
                          event.key === "ArrowUp"
                        ) {
                          event.preventDefault();
                          const sibling =
                            event.key === "ArrowDown"
                              ? event.currentTarget.nextElementSibling
                              : event.currentTarget.previousElementSibling;
                          if (sibling instanceof HTMLElement) sibling.focus();
                        }
                      }}
                    >
                      {trackerTimeZoneLabel(zone)}
                    </button>
                  ))}
                  {timeZones.length === 0 ? (
                    <p className="p-2 text-xs">No matching time zone</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <Button
              disabled={pending || !interviewTitle.trim() || !interviewAt}
              size="sm"
              type="submit"
              variant="secondary"
            >
              Add
            </Button>
          </form>
          {crm.interviews.length > 0 ? (
            <ul aria-label="Application interviews" className="grid gap-2">
              {[...crm.interviews].reverse().map((entry) => (
                <li
                  className="grid gap-2 rounded-(--radius-field) bg-background/45 p-3 text-sm"
                  key={entry.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium text-foreground">
                        {entry.title}
                      </p>
                      <time
                        className="mt-0.5 block text-xs text-muted-foreground"
                        dateTime={entry.startsAt}
                      >
                        Starts{" "}
                        {formatTrackerMoment(entry.startsAt, entry.timeZone)}
                      </time>
                    </div>
                    <StatusBadge
                      tone={
                        entry.status === "scheduled"
                          ? "active"
                          : entry.status === "completed"
                            ? "positive"
                            : "muted"
                      }
                    >
                      {entry.status}
                    </StatusBadge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.status === "scheduled" ? (
                      <>
                        <Button
                          disabled={pending}
                          onClick={() => setInterviewStatus(entry, "completed")}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Complete
                        </Button>
                        <Button
                          disabled={pending}
                          onClick={() => setInterviewStatus(entry, "cancelled")}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                      </>
                    ) : null}
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void mutate({
                          type: "remove_interview",
                          interviewId: entry.id,
                        })
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (!contactName.trim()) return;
              const now = new Date().toISOString();
              void mutate({
                type: "upsert_contact",
                contact: {
                  id: createId("contact"),
                  name: contactName.trim(),
                  role: null,
                  email: contactEmail.trim() || null,
                  phone: null,
                  profileUrl: null,
                  notes: null,
                  createdAt: now,
                  updatedAt: now,
                },
              }).then((saved) => {
                if (!saved) return;
                setContactName("");
                setContactEmail("");
              });
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Contact name
              <input
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setContactName(event.target.value)}
                value={contactName}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Email
              <input
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setContactEmail(event.target.value)}
                type="email"
                value={contactEmail}
              />
            </label>
            <Button
              disabled={pending || !contactName.trim()}
              size="sm"
              type="submit"
              variant="secondary"
            >
              Add
            </Button>
          </form>
          {crm.contacts.length > 0 ? (
            <ul aria-label="Application contacts" className="grid gap-2">
              {[...crm.contacts].reverse().map((entry) => (
                <li
                  className="flex items-start justify-between gap-3 rounded-(--radius-field) bg-background/45 p-3 text-sm"
                  key={entry.id}
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-foreground">
                      {entry.name}
                    </p>
                    {entry.email ? (
                      <p className="mt-0.5 text-xs break-words text-muted-foreground">
                        {entry.email}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void mutate({
                        type: "remove_contact",
                        contactId: entry.id,
                      })
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>

      <details className="rounded-(--radius-field) border border-(--control-border) p-3">
        <summary className="cursor-pointer font-semibold text-foreground">
          Offer and attachments
        </summary>
        <div className="mt-3 grid gap-4">
          <form
            className="grid gap-2 sm:grid-cols-4 sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const amount = Number(offerAmount);
              if (!Number.isFinite(amount) || amount < 0) return;
              void mutate({
                type: "set_compensation",
                compensation: {
                  ...crm.compensation,
                  offerBase: {
                    amount,
                    currency: offerCurrency.trim().toUpperCase(),
                    period: offerPeriod,
                  },
                  offerDeadlineAt: trackerTimeToIso(
                    offerDeadline,
                    homeTimeZone,
                  ),
                  offerStatus:
                    crm.compensation.offerStatus === "none"
                      ? "active"
                      : crm.compensation.offerStatus,
                },
              });
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Offer amount
              <input
                className={fieldClassName}
                disabled={pending}
                min="0"
                onChange={(event) => setOfferAmount(event.target.value)}
                type="number"
                value={offerAmount}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Currency
              <input
                className={fieldClassName}
                disabled={pending}
                maxLength={3}
                onChange={(event) => setOfferCurrency(event.target.value)}
                value={offerCurrency}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Period
              <select
                className={fieldClassName}
                disabled={pending}
                onChange={(event) =>
                  setOfferPeriod(event.target.value as typeof offerPeriod)
                }
                value={offerPeriod}
              >
                <option value="hour">Hourly</option>
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              <span>
                Deadline{" "}
                <span
                  aria-hidden="true"
                  className="font-normal text-foreground-muted"
                >
                  ({homeTimeZone})
                </span>
              </span>
              <input
                aria-label="Deadline"
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setOfferDeadline(event.target.value)}
                lang={jobFinderDateInputLocale}
                type="datetime-local"
                value={offerDeadline}
              />
            </label>
            <Button
              className="sm:col-span-4 sm:justify-self-start"
              disabled={pending || !offerAmount}
              size="sm"
              type="submit"
              variant="secondary"
            >
              Save offer
            </Button>
          </form>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Approved local asset
              <select
                className={fieldClassName}
                disabled={pending}
                onChange={(event) => setSelectedAssetId(event.target.value)}
                value={selectedAssetId}
              >
                <option value="">Choose an asset</option>
                {candidateAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.originalName}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={pending || !selectedAssetId}
              onClick={() => {
                const asset = candidateAssets.find(
                  (candidate) => candidate.id === selectedAssetId,
                );
                if (!asset) return;
                void mutate({
                  type: "add_attachment",
                  attachment: {
                    id: createId("attachment"),
                    candidateAssetId: asset.id,
                    label: asset.originalName,
                    kind: [
                      "resume",
                      "cover_letter",
                      "portfolio",
                      "work_sample",
                    ].includes(asset.kind)
                      ? (asset.kind as
                          | "resume"
                          | "cover_letter"
                          | "portfolio"
                          | "work_sample")
                      : "other",
                    addedAt: new Date().toISOString(),
                  },
                }).then((saved) => {
                  if (saved) setSelectedAssetId("");
                });
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Link asset
            </Button>
          </div>
          {crm.attachments.length > 0 ? (
            <ul
              aria-label="Linked application attachments"
              className="grid gap-2"
            >
              {[...crm.attachments].reverse().map((entry) => (
                <li
                  className="flex items-start justify-between gap-3 rounded-(--radius-field) bg-background/45 p-3 text-sm"
                  key={entry.id}
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-foreground">
                      {entry.label}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {entry.kind.replaceAll("_", " ")}
                    </p>
                  </div>
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void mutate({
                        type: "remove_attachment",
                        attachmentId: entry.id,
                      })
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Unlink
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            Only metadata is linked here. The file itself, its integrity checks,
            and its stored bytes stay with your files under Profile.
          </p>
        </div>
      </details>

      <details className="rounded-(--radius-field) border border-(--control-border) p-3">
        <summary className="cursor-pointer font-semibold text-foreground">
          Timeline ({crm.events.length})
        </summary>
        {crm.events.length > 0 ? (
          <ol className="mt-3 grid gap-2">
            {[...crm.events]
              .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
              .map((event) => {
                const copy = applicationCrmEventCopyForView(
                  event.title,
                  event.detail,
                );
                return (
                  <li
                    className="border-l-2 border-(--surface-panel-border) pl-3"
                    key={event.id}
                  >
                    <strong className="text-sm text-foreground">
                      {copy.title}
                    </strong>
                    {copy.detail ? (
                      <p className="mt-1 text-sm text-foreground-soft">
                        {copy.detail}
                      </p>
                    ) : null}
                    <time
                      className="mt-1 block text-xs text-muted-foreground"
                      dateTime={event.at}
                    >
                      {formatTrackerMoment(event.at, homeTimeZone)} ·{" "}
                      {event.source.replaceAll("_", " ")}
                    </time>
                  </li>
                );
              })}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No tracker activity has been recorded yet. Existing safe-apply
            history remains available below.
          </p>
        )}
      </details>

      {null}

      {null}
    </section>
  );
}
