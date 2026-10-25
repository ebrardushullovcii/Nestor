import {
  CLOSED_TRACKER_STATUSES,
  TRACKER_STATUS_LABEL,
  type TrackerEvent,
  type TrackerChange,
  type TrackerSelectionInput,
  type TrackerStatus,
} from "@nestor/contracts";
import { ExternalLink, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { Textarea } from "@renderer/components/ui/textarea";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { LIST_DETAIL_REGION_ID } from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";

import {
  describeDue,
  describeStatus,
  formatDay,
  formatWhen,
  OPEN_STATUSES,
  WORK_HINT,
} from "./tracker-format";
import { describeError, useApplication } from "./use-application";

type AddKind = "reply" | "interview" | "reminder" | "note";

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
export function ApplicationDetail(props: { jobId: number | null }) {
  const { application } = useApplication(props.jobId);
  const { showToast } = useToast();
  const setStatus = useSetStatus();
  const showChange = useTrackerChangeToast();
  const [kind, setKind] = useState<AddKind>("reply");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [due, setDue] = useState("");
  const [place, setPlace] = useState("");
  const [tag, setTag] = useState("");

  if (!application) {
    return (
      <section
        className="grid min-h-0 place-items-center p-8 text-sm text-foreground-soft"
        id={LIST_DETAIL_REGION_ID}
      >
        {props.jobId === null
          ? "Pick an application to see where it stands."
          : "Opening…"}
      </section>
    );
  }

  const { job, row, events } = application;
  const closed = CLOSED_TRACKER_STATUSES.includes(row.status);
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
      setTitle("");
      setBody("");
      setDue("");
      setPlace("");
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
    if (ok) setTag("");
  };

  return (
    <section
      aria-label={`Application to ${job.company}`}
      data-job-detail-id={job.id}
      className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto pr-1"
      data-locked-pane-scroll-region
      id={LIST_DETAIL_REGION_ID}
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-(length:--text-title) text-(--text-headline)">
            {job.title}
          </h2>
          <p className="text-sm text-foreground-soft">
            {[job.company, job.location].filter(Boolean).join(" · ")}
            {row.appliedAt ? ` · Applied ${formatDay(row.appliedAt)}` : ""}
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
      </header>

      {row.status === "applying" ? (
        <div className="grid gap-1">
          <StatusBadge className="self-start" tone={status.tone}>
            {status.label}
          </StatusBadge>
          <p className="text-sm text-foreground-soft">
            {WORK_HINT[row.work ?? "queued"]}
          </p>
          {row.workError ? (
            <p className="text-sm text-(--warning-text)">{row.workError}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<TrackerStatus>
            label="Where this application stands"
            onValueChange={(next) =>
              void setStatus(
                { ids: [job.id] },
                next as Exclude<TrackerStatus, "applying">,
              )
            }
            options={OPEN_STATUSES.map((value) => ({
              value,
              label: TRACKER_STATUS_LABEL[value],
            }))}
            value={closed ? ("" as TrackerStatus) : row.status}
          />
          {closed ? (
            <StatusBadge tone="muted">{status.label}</StatusBadge>
          ) : (
            <div className="flex items-center gap-1">
              {CLOSED_TRACKER_STATUSES.map((value) => (
                <Button
                  key={value}
                  onClick={() =>
                    void setStatus(
                      { ids: [job.id] },
                      value as Exclude<TrackerStatus, "applying">,
                    )
                  }
                  size="toolbar"
                  variant="ghost"
                >
                  {TRACKER_STATUS_LABEL[value]}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {row.nextAt ? (
        <p className="rounded-(--radius-field) border border-(--surface-panel-border) px-3 py-2 text-sm">
          <span className="font-semibold">{describeDue(row.nextAt)}:</span>{" "}
          {row.nextTitle} · {formatWhen(row.nextAt)}
        </p>
      ) : null}

      <form
        className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-3"
        onSubmit={(event) => void add(event)}
      >
        <SegmentedControl<AddKind>
          className="self-start"
          label="What to add"
          onValueChange={setKind}
          options={(Object.keys(ADD_LABEL) as AddKind[]).map((value) => ({
            value,
            label: ADD_LABEL[value],
          }))}
          value={kind}
        />
        <Input
          aria-label={`${ADD_LABEL[kind]} title`}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={TITLE_HINT[kind]}
          value={title}
        />
        {dated ? (
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="When"
              className="w-56"
              onChange={(event) => setDue(event.target.value)}
              type="datetime-local"
              value={due}
            />
            {kind === "interview" ? (
              <Input
                aria-label="Where or meeting link"
                className="min-w-0 flex-1"
                onChange={(event) => setPlace(event.target.value)}
                placeholder="Where, or the meeting link"
                value={place}
              />
            ) : null}
          </div>
        ) : null}
        {kind === "reply" || kind === "note" ? (
          <Textarea
            aria-label="Details"
            onChange={(event) => setBody(event.target.value)}
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

      <div className="flex flex-wrap items-center gap-2">
        {row.tags.map((value) => (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-(--surface-panel-border) px-2 py-0.5 text-xs"
            key={value}
          >
            {value}
            <button
              aria-label={`Remove tag ${value}`}
              className="text-foreground-muted hover:text-foreground"
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
            className="h-7 w-32 text-xs"
            onChange={(event) => setTag(event.target.value)}
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
    </section>
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
