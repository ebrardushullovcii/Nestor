import {
  CLOSED_TRACKER_STATUSES,
  TRACKER_STATUS_LABEL,
  type TrackerEvent,
  type TrackerChange,
  type TrackerSelectionInput,
  type TrackerStatus,
} from "@nestor/contracts";
import { ExternalLink, Trash2, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Disclosure } from "@renderer/components/ui/disclosure";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { Textarea } from "@renderer/components/ui/textarea";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import {
  DetailSheetBack,
  EmptyPane,
  type BesideList,
  LIST_DETAIL_REGION_ID,
  ListReadError,
} from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";

import {
  describeDue,
  describeStatus,
  formatDay,
  formatWhen,
  OPEN_STATUSES,
  WORK_HINT,
} from "./tracker-format";
import {
  ApplicationWork,
  StopApply,
  useApplicationWork,
} from "./application-work";
import { applyFailureLine } from "./apply-failure";
import { describeError, useApplication } from "./use-application";

/** The one detail-pane frame, shared with Find jobs' job details. */
const DETAIL_FRAME_CLASS =
  "surface-panel-shell h-full overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)";

type AddKind = "reply" | "interview" | "reminder" | "note";

interface ApplicationDraft {
  kind: AddKind;
  title: string;
  body: string;
  due: string;
  place: string;
  tag: string;
}
const EMPTY_DRAFT: ApplicationDraft = {
  kind: "reply",
  title: "",
  body: "",
  due: "",
  place: "",
  tag: "",
};

const ADD_LABEL: Record<AddKind, string> = {
  reply: "Reply",
  interview: "Interview",
  reminder: "Reminder",
  note: "Note",
};

const TITLE_HINT: Record<AddKind, string> = {
  reply: "Who wrote and what they said, in a line",
  interview: "Phone screen with the recruiter",
  reminder: "Follow up if no news",
  note: "Anything worth remembering",
};

/** Every local tracker change offers the same guarded store Undo. */
export function useTrackerChangeToast() {
  const { showToast } = useToast();
  return (title: string, change: TrackerChange) => {
    const undoId = change.undoId;
    showToast({
      ...(undoId === null ? {} : { id: `tracker-change-${undoId}` }),
      title,
      tone: "success",
      ...(undoId === null
        ? {}
        : {
            action: {
              label: "Undo",
              onClick: () => {
                void window.nestor.tracker
                  .run("undo_tracker_change", { undoId })
                  .then((result) =>
                    showToast({
                      title: result.changed
                        ? "Tracker change undone"
                        : "Nothing changed",
                      ...(result.changed ? { tone: "success" as const } : {}),
                      ...(result.skipped
                        ? { description: "Later edits were kept." }
                        : {}),
                    }),
                  )
                  .catch((error: unknown) =>
                    showToast({ title: describeError(error), tone: "warning" }),
                  );
              },
            },
          }),
    });
  };
}

/** Moves applications to a status, says so, and offers Undo. */
export function useSetStatus() {
  const { showToast } = useToast();
  const showChange = useTrackerChangeToast();
  return async (
    selection: TrackerSelectionInput,
    status: Exclude<TrackerStatus, "applying">,
  ) => {
    try {
      const result = await window.nestor.tracker.run("set_status", {
        selection,
        status,
      });
      showChange(
        result.changed === 0
          ? "Nothing changed"
          : `${result.changed === 1 ? "Moved" : `Moved ${result.changed} applications`} to ${TRACKER_STATUS_LABEL[status]}`,
        result,
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    }
  };
}

/** One application: where it stands, what is next, and its history. */
export function ApplicationDetail(props: {
  jobId: number | null;
  /** Stacked under a sheet: closes the sheet back to the list. */
  onBack?: () => void;
  /**
   * Draw the shared detail frame (bordered panel, header over a scrolling
   * body), as Find jobs, Shortlisted and Needs you do. Off inside the
   * board's sheet, which is that frame already.
   */
  framed?: boolean;
  /** The list beside it: with nothing in it, there is nothing to pick. */
  list?: BesideList;
}) {
  const framed = props.framed ?? true;
  const { application, error: readError, reload } = useApplication(props.jobId);
  const work = useApplicationWork(props.jobId);
  const { showToast } = useToast();
  const setStatus = useSetStatus();
  const showChange = useTrackerChangeToast();
  const [drafts, setDrafts] = useState<Record<number, ApplicationDraft>>({});
  const [composer, setComposer] = useState(false);
  const { kind, title, body, due, place, tag } =
    props.jobId === null ? EMPTY_DRAFT : (drafts[props.jobId] ?? EMPTY_DRAFT);
  const editDraft = (patch: Partial<ApplicationDraft>) => {
    const id = props.jobId;
    if (id === null) return;
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  if (!application || application.job.id !== props.jobId) {
    if (props.jobId === null)
      return (
        <EmptyPane label="Application details" list={props.list}>
          Pick an application to see where it stands.
        </EmptyPane>
      );
    if (readError)
      return (
        <section
          aria-label="Application details"
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            framed && DETAIL_FRAME_CLASS,
          )}
          data-application-read-error
          id={LIST_DETAIL_REGION_ID}
        >
          {props.onBack ? <DetailSheetBack onBack={props.onBack} /> : null}
          <div className="grid flex-1 place-items-center p-6">
            <ListReadError
              error={readError}
              kept="The application is unchanged, and anything you were writing in it is kept."
              onRetry={() => void reload()}
              what="This application"
            />
          </div>
        </section>
      );
    return (
      <section
        aria-busy="true"
        className={cn(
          "grid min-h-0 place-items-center p-8 text-sm text-foreground-soft",
          framed && DETAIL_FRAME_CLASS,
        )}
        id={LIST_DETAIL_REGION_ID}
      >
        Opening…
      </section>
    );
  }

  const { job, row, events } = application;
  const status = describeStatus(row);
  const dated = kind === "interview" || kind === "reminder";

  const run = async (work: () => Promise<TrackerChange>, done: string) => {
    try {
      const result = await work();
      showChange(done, result);
      return true;
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
      return false;
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || (dated && !due)) return;
    const ok = await run(
      () =>
        window.nestor.tracker.run("add_event", {
          jobId: job.id,
          kind,
          title: title.trim(),
          body: body.trim() || null,
          dueAt: dated ? new Date(due).toISOString() : null,
          place: kind === "interview" ? place.trim() || null : null,
        }),
      `${ADD_LABEL[kind]} added`,
    );
    if (ok) {
      editDraft({ title: "", body: "", due: "", place: "" });
    }
  };

  const addTag = async (event: FormEvent) => {
    event.preventDefault();
    const value = tag.trim();
    if (!value) return;
    const ok = await run(
      () =>
        window.nestor.tracker.run("set_tags", {
          selection: { ids: [job.id] },
          add: [value],
        }),
      `Tagged ${value}`,
    );
    if (ok) editDraft({ tag: "" });
  };

  const composerOpen = composer || Boolean(title || body || due || place);

  return (
    <section
      aria-label={`Application to ${job.company}`}
      data-job-detail-id={job.id}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        framed
          ? DETAIL_FRAME_CLASS
          : "gap-4 overflow-y-auto stacked:rounded-(--radius-panel) stacked:bg-(--background) stacked:p-3",
      )}
      data-locked-pane-scroll-region={framed ? undefined : true}
      id={LIST_DETAIL_REGION_ID}
    >
      {props.onBack ? <DetailSheetBack onBack={props.onBack} /> : null}
      {readError ? (
        <ListReadError
          error={readError}
          inline
          inlineText="Couldn’t read the latest for this application. What you see, and anything you were writing, is kept."
          onRetry={() => void reload()}
          what="This application"
        />
      ) : null}
      {/* Led by where it stands and what is next; logging a reply or an
          interview is one step away, not the biggest thing on the pane. */}
      <header
        className={cn(
          "grid shrink-0 gap-4",
          framed && "border-b border-(--surface-panel-border) px-6 py-5",
        )}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-(length:--text-heading-2) font-semibold text-(--text-headline)">
              {job.title}
            </h2>
            <p className="overflow-hidden text-(length:--text-description) text-foreground-soft">
              {/* No line starts or ends on a "·": each item carries the
                  separator before it, and the separator that would start
                  a line sits in the 1rem the row is pulled left by,
                  clipped. Each item keeps its words together. */}
              <span className="-ml-4 flex flex-wrap">
                {[
                  job.company,
                  job.location,
                  row.appliedAt ? `Applied ${formatDay(row.appliedAt)}` : null,
                ]
                  .filter(Boolean)
                  .map((item) => (
                    <span
                      className="whitespace-nowrap before:inline-block before:w-4 before:text-center before:content-['·']"
                      key={item}
                    >
                      {item}
                    </span>
                  ))}
              </span>
            </p>
          </div>
          <Button
            onClick={() => openUrlInJobFinderBrowser(job.url)}
            size="toolbar"
            variant="ghost"
          >
            <ExternalLink aria-hidden />
            Listing
          </Button>
        </div>

        {row.status === "applying" ? (
          <div className="grid gap-1">
            {/* Stop rides on Apply's status line, quiet, so the forward
                actions below keep one row. */}
            <div className="flex min-h-6 items-center justify-between gap-3">
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              <StopApply details={work} />
            </div>
            {row.work === "failed" ? (
              // One plain cause in the buttons' words, then "Nothing was
              // sent.", in body text: the red badge above says it could not
              // apply, and amber means "waiting on you".
              <p className="text-sm text-foreground" data-apply-failed>
                {applyFailureLine(row.workError)}
              </p>
            ) : (
              <p className="text-sm text-foreground-soft">
                {WORK_HINT[row.work ?? "queued"]}
              </p>
            )}
            {row.workError && row.work !== "failed" ? (
              <p className="flex max-w-[70ch] items-baseline gap-2 text-sm text-foreground">
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-(--warning-text)"
                />
                <span className="min-w-0">{row.workError}</span>
              </p>
            ) : null}
          </div>
        ) : (
          <StageStatus
            onChange={(next) => void setStatus({ ids: [job.id] }, next)}
            status={row.status}
          />
        )}

        {row.nextAt ? (
          <p className="text-sm">
            <span className="font-semibold">{describeDue(row.nextAt)}:</span>{" "}
            {row.nextTitle} · {formatWhen(row.nextAt)}
          </p>
        ) : null}
      </header>

      <div
        className={cn(
          "grid content-start gap-4",
          framed && "min-h-0 flex-1 overflow-y-auto px-6 py-5",
        )}
        data-locked-pane-scroll-region={framed ? true : undefined}
      >
        <ApplicationWork
          applyUrl={job.applyUrl ?? job.url}
          details={work}
          showStop={row.status !== "applying"}
        />

        <Disclosure
          className="text-sm"
          contentClassName="pl-7.5"
          onOpenChange={setComposer}
          open={composerOpen}
          summary="Log a reply, interview, reminder or note"
        >
          <form className="grid gap-2" onSubmit={(event) => void add(event)}>
            <SegmentedControl<AddKind>
              className="self-start"
              label="What to add"
              onValueChange={(kind) => editDraft({ kind })}
              options={(Object.keys(ADD_LABEL) as AddKind[]).map((value) => ({
                value,
                label: ADD_LABEL[value],
              }))}
              value={kind}
            />
            <Input
              aria-label={`${ADD_LABEL[kind]} title`}
              onChange={(event) => editDraft({ title: event.target.value })}
              placeholder={TITLE_HINT[kind]}
              value={title}
            />
            {dated ? (
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="When"
                  className="w-56"
                  onChange={(event) => editDraft({ due: event.target.value })}
                  type="datetime-local"
                  value={due}
                />
                {kind === "interview" ? (
                  <Input
                    aria-label="Where or meeting link"
                    className="min-w-0 flex-1"
                    onChange={(event) =>
                      editDraft({ place: event.target.value })
                    }
                    placeholder="Where, or the meeting link"
                    value={place}
                  />
                ) : null}
              </div>
            ) : null}
            {kind === "reply" || kind === "note" ? (
              <Textarea
                aria-label="Details"
                onChange={(event) => editDraft({ body: event.target.value })}
                placeholder="Details (optional)"
                rows={2}
                value={body}
              />
            ) : null}
            <Button
              className="justify-self-start"
              disabled={!title.trim() || (dated && !due)}
              size="toolbar"
              type="submit"
            >
              Add {ADD_LABEL[kind].toLowerCase()}
            </Button>
          </form>
        </Disclosure>

        {/* Laid out like Status above it: a label column, then the field at
            the same width, so the detail's two fields share one right edge. */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="w-12 shrink-0 text-(length:--text-small) text-foreground-soft"
          >
            Tags
          </span>
          {row.tags.map((value) => (
            <span
              className="inline-flex h-7 items-center gap-0.5 rounded-full border border-(--surface-panel-border) pr-0.5 pl-2.5 text-xs"
              key={value}
            >
              {value}
              {/* A 24px target inside the 28px chip, not the bare 12px ×. */}
              <button
                aria-label={`Remove tag ${value}`}
                className="inline-flex size-6 items-center justify-center rounded-full text-foreground-muted outline-none hover:bg-accent hover:text-foreground focus-ring"
                onClick={() =>
                  void run(
                    () =>
                      window.nestor.tracker.run("set_tags", {
                        selection: { ids: [job.id] },
                        remove: [value],
                      }),
                    `Removed ${value}`,
                  )
                }
                type="button"
              >
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
          <form onSubmit={(event) => void addTag(event)}>
            <Input
              aria-label="Add a tag"
              className="h-8 w-48 text-xs"
              onChange={(event) => editDraft({ tag: event.target.value })}
              placeholder="Add a tag"
              value={tag}
            />
          </form>
        </div>

        <ol aria-label="History" className="grid gap-2">
          {events.map((event) => (
            <TimelineItem event={event} key={event.id} />
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * Where an application stands: one status menu, and under it a progress
 * line through the open stages (Applied to Offer) with the current one
 * named. A closed application shows the line quiet and says how it closed.
 */
function StageStatus(props: {
  status: TrackerStatus;
  onChange: (status: Exclude<TrackerStatus, "applying">) => void;
}) {
  const closed = CLOSED_TRACKER_STATUSES.includes(props.status);
  const at = OPEN_STATUSES.indexOf(props.status);
  const id = useId();
  return (
    <div className="grid gap-2" data-application-stage>
      <div className="flex items-center gap-2">
        <label
          className="w-12 shrink-0 text-(length:--text-small) text-foreground-soft"
          htmlFor={id}
        >
          Status
        </label>
        <select
          // A form field in the detail: the field height and type, with the
          // shared inset chevron every select draws (globals.css).
          className="h-10 w-48 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 text-(length:--text-field) font-medium text-foreground transition-[border-color] duration-(--duration-fast) outline-none hover:border-(--field-border-hover) focus-visible:border-(--field-focus-border) focus-visible:shadow-(--field-focus-shadow)"
          id={id}
          onChange={(event) =>
            props.onChange(
              event.target.value as Exclude<TrackerStatus, "applying">,
            )
          }
          value={props.status}
        >
          <optgroup label="In progress">
            {OPEN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TRACKER_STATUS_LABEL[value]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Closed">
            {CLOSED_TRACKER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TRACKER_STATUS_LABEL[value]}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="grid gap-1">
        <ol
          aria-label={
            closed
              ? `Closed: ${TRACKER_STATUS_LABEL[props.status]}`
              : `Stage ${at + 1} of ${OPEN_STATUSES.length}: ${TRACKER_STATUS_LABEL[props.status]}`
          }
          className="m-0 flex list-none gap-1 p-0"
          data-stage-progress
        >
          {OPEN_STATUSES.map((value, index) => (
            <li
              className={cn(
                "h-1.5 flex-1 rounded-full",
                !closed && index <= at
                  ? "bg-primary"
                  : "bg-(--surface-progress-track)",
              )}
              data-reached={!closed && index <= at ? "" : undefined}
              key={value}
              title={TRACKER_STATUS_LABEL[value]}
            />
          ))}
        </ol>
        <p className="text-xs text-foreground-muted">
          {closed
            ? `Closed · ${TRACKER_STATUS_LABEL[props.status]}`
            : OPEN_STATUSES.map((value, index) => (
                <span key={value}>
                  {index > 0 ? " → " : ""}
                  <span
                    className={cn(
                      index === at && "font-medium text-foreground",
                    )}
                  >
                    {TRACKER_STATUS_LABEL[value]}
                  </span>
                </span>
              ))}
        </p>
      </div>
    </div>
  );
}

function TimelineItem({ event }: { event: TrackerEvent }) {
  const { showToast } = useToast();
  const showChange = useTrackerChangeToast();
  const dated = event.kind === "interview" || event.kind === "reminder";
  const toggle = async (done: boolean) => {
    try {
      const result = await window.nestor.tracker.run("update_event", {
        id: event.id,
        done,
      });
      showChange(done ? "Marked done" : "Reopened", result);
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    }
  };
  return (
    <li
      className={cn(
        "flex gap-3 rounded-(--radius-field) px-2 py-1.5 text-sm",
        event.kind !== "status" && "border border-(--surface-panel-border)",
      )}
    >
      {dated ? (
        <Checkbox
          aria-label={`${event.title} done`}
          checked={event.doneAt !== null}
          className="mt-0.5"
          onCheckedChange={(checked) => void toggle(checked === true)}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className={cn(event.doneAt && "text-foreground-muted line-through")}>
          {event.kind === "status" ? (
            <span className="text-foreground-soft">Moved to {event.title}</span>
          ) : (
            <>
              <span className="font-semibold capitalize">{event.kind}</span>{" "}
              {event.title}
            </>
          )}
        </p>
        {event.dueAt ? (
          <p className="text-xs text-foreground-soft">
            {formatWhen(event.dueAt)}
            {event.place ? ` · ${event.place}` : ""}
          </p>
        ) : null}
        {event.body ? (
          <p className="whitespace-pre-wrap text-foreground-soft">
            {event.body}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 text-xs text-foreground-muted">
        {formatDay(event.at)}
      </span>
      {event.kind !== "status" ? (
        <button
          aria-label={`Delete ${event.title}`}
          className="shrink-0 text-foreground-muted hover:text-foreground"
          onClick={() =>
            void window.nestor.tracker
              .run("delete_event", { id: event.id })
              .then((result) => showChange("Deleted tracker entry", result))
              .catch((error: unknown) =>
                showToast({ title: describeError(error), tone: "warning" }),
              )
          }
          type="button"
        >
          <Trash2 aria-hidden className="size-4" />
        </button>
      ) : null}
    </li>
  );
}
