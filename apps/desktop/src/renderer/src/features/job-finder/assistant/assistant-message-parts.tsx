import { useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  ListChecks,
  RotateCcw,
  X,
} from "lucide-react";
import type { AssistantMessage, AssistantMessagePart } from "@nestor/contracts";

import { cn } from "@renderer/lib/cn";
import { AssistantMarkdown } from "./assistant-markdown";

/**
 * Compact results: a change summary with Undo, a small diff, rows that open
 * the real records, a question with its choices, a checklist. No big card
 * for every sentence.
 */

export interface AssistantPartActions {
  onUndo: (receiptId: string) => Promise<string | null>;
  onResolveProposal: (input: {
    messageId: string;
    proposalId: string;
    action: "accept" | "reject";
  }) => Promise<void>;
  onAnswer: (questionId: string, answer: string) => void;
  onOpenRoute: (route: string) => void;
}

const TARGET_LABELS: Record<string, string> = {
  profile: "Profile",
  search_preferences: "Preferences",
  settings: "Settings",
  resume_draft: "Resume",
  search_plan: "Search plan",
};

const RECORD_CHANGE_PATTERN = /^(?:Added|Removed) /u;

/**
 * "Changed Headline · Added Education: Example College". A record added or
 * removed names itself; only values edited in place read "Changed".
 */
export function describeChangedFields(fields: readonly string[]): string {
  const shown = fields.slice(0, 6);
  const edited = shown.filter((field) => !RECORD_CHANGE_PATTERN.test(field));
  const records = shown.filter((field) => RECORD_CHANGE_PATTERN.test(field));
  return [edited.length > 0 ? `Changed ${edited.join(", ")}` : null, ...records]
    .filter((part): part is string => part !== null)
    .join(" · ")
    .concat(fields.length > 6 ? ` and ${fields.length - 6} more` : "");
}

function ChangePart(props: {
  part: Extract<AssistantMessagePart, { type: "change" }>;
  actions: AssistantPartActions;
}) {
  const { part } = props;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const undone = part.status === "undone";
  return (
    <div
      className="grid gap-1.5 rounded-(--radius-field) border border-(--control-border) bg-(--surface-panel-raised) px-3 py-2"
      data-assistant-change={part.receiptId}
      data-assistant-change-status={part.status}
    >
      <div className="flex items-start gap-2">
        <Check
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            undone
              ? "text-muted-foreground"
              : "text-(--success-foreground,currentColor)",
          )}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span
            className={cn(
              "text-[13px] font-medium text-foreground",
              undone && "line-through opacity-70",
            )}
          >
            {TARGET_LABELS[part.target] ?? "Saved"}: {part.summary}
          </span>
          {part.fields.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">
              {describeChangedFields(part.fields)}
            </span>
          ) : null}
          {part.status === "partially_undone" ? (
            <span className="text-[12px] text-muted-foreground">
              Partly undone.
            </span>
          ) : null}
        </div>
        {part.status !== "undone" ? (
          <button
            className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-button) px-2 py-1 text-[12px] font-medium text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void props.actions
                .onUndo(part.receiptId)
                .then((message) => setNote(message))
                .finally(() => setBusy(false));
            }}
            type="button"
          >
            <RotateCcw aria-hidden="true" className="size-3" />
            Undo
          </button>
        ) : (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            Undone
          </span>
        )}
      </div>
      {part.preview.length > 0 ? (
        <button
          aria-expanded={showDiff}
          className="inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
          onClick={() => setShowDiff((value) => !value)}
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 transition-transform",
              showDiff && "rotate-90",
            )}
          />
          {showDiff ? "Hide what changed" : "Show what changed"}
        </button>
      ) : null}
      {showDiff ? (
        <dl className="grid gap-1.5 text-[12px]">
          {part.preview.map((entry, index) => (
            <div className="grid gap-0.5" key={`${entry.label}_${index}`}>
              <dt className="font-medium text-foreground">{entry.label}</dt>
              {entry.before ? (
                <dd className="whitespace-pre-line break-words text-muted-foreground line-through">
                  {entry.before}
                </dd>
              ) : null}
              {entry.after ? (
                <dd className="whitespace-pre-line break-words text-foreground">
                  {entry.after}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}
      {note ? (
        <p aria-live="polite" className="text-[12px] text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function ProposalPart(props: {
  message: AssistantMessage;
  part: Extract<AssistantMessagePart, { type: "proposal" }>;
  actions: AssistantPartActions;
}) {
  const { part } = props;
  const [busy, setBusy] = useState(false);
  const resolve = (action: "accept" | "reject") => {
    setBusy(true);
    void props.actions
      .onResolveProposal({
        messageId: props.message.id,
        proposalId: part.proposalId,
        action,
      })
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="grid gap-2 rounded-(--radius-field) border border-dashed border-(--control-border) px-3 py-2"
      data-assistant-proposal={part.proposalId}
      data-assistant-proposal-status={part.status}
    >
      <span className="text-[13px] font-medium text-foreground">
        Suggested: {part.summary}
      </span>
      <ul className="grid gap-1 text-[12px] text-muted-foreground">
        {part.items.map((item) => (
          <li className="whitespace-pre-wrap" key={item.id}>
            {item.detail ? `${item.label}\n${item.detail}` : item.label}
          </li>
        ))}
      </ul>
      {part.status === "pending" ? (
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-1 rounded-(--radius-button) bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
            disabled={busy}
            onClick={() => resolve("accept")}
            type="button"
          >
            <Check aria-hidden="true" className="size-3" />
            Apply
          </button>
          <button
            className="inline-flex items-center gap-1 rounded-(--radius-button) border border-(--control-border) px-2.5 py-1 text-[12px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
            disabled={busy}
            onClick={() => resolve("reject")}
            type="button"
          >
            <X aria-hidden="true" className="size-3" />
            Dismiss
          </button>
        </div>
      ) : (
        <span className="text-[12px] text-muted-foreground">
          {part.status === "applied" ? "Applied." : "Dismissed."}
        </span>
      )}
    </div>
  );
}

function recordsHeading(
  part: Extract<AssistantMessagePart, { type: "records" }>,
): string | null {
  // Saved messages may predate truthful per-row sending receipts.
  return part.kind === "applications" && part.title === "Sent"
    ? "Sending results"
    : part.title;
}

function RecordsPart(props: {
  part: Extract<AssistantMessagePart, { type: "records" }>;
  actions: AssistantPartActions;
}) {
  const { part } = props;
  const heading = recordsHeading(part);
  return (
    <div className="grid gap-1" data-assistant-records={part.kind}>
      {heading ? (
        <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          {heading}
        </span>
      ) : null}
      <ul className="grid overflow-hidden rounded-(--radius-field) border border-(--control-border)">
        {part.rows.map((row, index) => (
          <li
            className={cn(index > 0 && "border-t border-(--control-border)")}
            key={row.id}
          >
            <button
              className="grid w-full gap-0.5 px-3 py-1.5 text-left outline-none hover:bg-secondary focus-visible:bg-secondary disabled:cursor-default"
              disabled={!row.route}
              onClick={() => row.route && props.actions.onOpenRoute(row.route)}
              type="button"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">
                  <span className="mr-1.5 text-muted-foreground">
                    {index + 1}.
                  </span>
                  {row.title}
                </span>
                {row.status ? (
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {row.status}
                  </span>
                ) : null}
              </span>
              {row.subtitle ? (
                <span className="truncate text-[12px] text-muted-foreground">
                  {row.subtitle}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {part.totalCount > part.rows.length ? (
        <span className="text-[12px] text-muted-foreground">
          Showing {part.rows.length} of {part.totalCount}.
        </span>
      ) : null}
    </div>
  );
}

function ActivityPart(props: {
  part: Extract<AssistantMessagePart, { type: "activity" }>;
}) {
  const entries = props.part.entries;
  if (entries.length === 0) return null;
  const failed = entries.filter((entry) => entry.outcome !== "done").length;
  return (
    <details
      className="group text-[12px] text-muted-foreground"
      data-assistant-activity-log
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 outline-none hover:text-foreground focus-visible:underline">
        <ChevronRight
          aria-hidden="true"
          className="size-3 transition-transform group-open:rotate-90"
        />
        {entries.length} step{entries.length === 1 ? "" : "s"}
        {failed > 0 ? `, ${failed} did not go through` : ""}
      </summary>
      <ol className="mt-1 grid gap-0.5 pl-4">
        {entries.map((entry, index) => (
          <li className="flex gap-1.5" key={`${entry.toolName}_${index}`}>
            {entry.outcome === "done" ? (
              <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            ) : (
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-3 shrink-0"
              />
            )}
            <span>
              {entry.label}
              {entry.outcome !== "done" && entry.detail
                ? `: ${entry.detail}`
                : ""}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function QuestionPart(props: {
  part: Extract<AssistantMessagePart, { type: "question" }>;
  actions: AssistantPartActions;
}) {
  const { part } = props;
  return (
    <div
      className="grid gap-2 rounded-(--radius-field) border border-(--control-border) px-3 py-2"
      data-assistant-question={part.questionId}
    >
      <span className="text-[13px] font-medium text-foreground">
        {part.prompt}
      </span>
      {part.status === "open" && part.options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {part.options.map((option) => (
            <button
              className="rounded-(--radius-button) border border-(--control-border) px-2.5 py-1 text-[12px] text-foreground outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40"
              key={option}
              onClick={() => props.actions.onAnswer(part.questionId, option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {part.status === "answered" && part.answer ? (
        <span className="text-[12px] text-muted-foreground">
          Answered: {part.answer}
        </span>
      ) : null}
    </div>
  );
}

function PlanPart(props: {
  part: Extract<AssistantMessagePart, { type: "plan" }>;
}) {
  return (
    <div className="grid gap-1" data-assistant-plan={props.part.planId}>
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <ListChecks aria-hidden="true" className="size-3.5" />
        {props.part.title}
      </span>
      <ol className="grid gap-0.5 pl-5 text-[12px]">
        {props.part.steps.map((step) => (
          <li
            className={cn(
              "list-decimal",
              step.status === "done"
                ? "text-muted-foreground line-through"
                : "text-foreground",
            )}
            key={step.id}
          >
            {step.label}
            {step.status !== "done" && step.status !== "pending" ? (
              <span className="ml-1 text-muted-foreground">
                ({step.status})
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Repeated reads of the same jobs share one list; the latest read supplies fit. */
export function consolidateJobLists(
  parts: readonly AssistantMessagePart[],
): AssistantMessagePart[] {
  const result: AssistantMessagePart[] = [];
  for (const part of parts) {
    if (part.type !== "records" || part.kind !== "jobs") {
      result.push(part);
      continue;
    }
    const ids = new Set(part.rows.map((row) => row.id));
    const previousIndex = result.findIndex(
      (candidate) =>
        candidate.type === "records" &&
        candidate.kind === "jobs" &&
        (candidate.rows.every((row) => ids.has(row.id)) ||
          part.rows.every((row) =>
            candidate.rows.some((saved) => saved.id === row.id),
          )),
    );
    const previous = result[previousIndex];
    if (previous?.type !== "records") {
      result.push({
        ...part,
        rows: [...new Map(part.rows.map((row) => [row.id, row])).values()],
      });
      continue;
    }
    const rows = new Map(previous.rows.map((row) => [row.id, row]));
    for (const row of part.rows) rows.set(row.id, row);
    const larger = part.rows.length >= previous.rows.length ? part : previous;
    result[previousIndex] = {
      ...larger,
      title: part.title ?? previous.title,
      rows: [...rows.values()],
    };
  }
  return result;
}

export function AssistantMessageParts(props: {
  message: AssistantMessage;
  actions: AssistantPartActions;
}) {
  const { message } = props;
  return (
    <div className="grid gap-2">
      {consolidateJobLists(message.parts).map((part, index) => {
        const key = `${message.id}_${index}`;
        switch (part.type) {
          case "text":
            return message.role === "user" ? (
              <p className="whitespace-pre-wrap break-words" key={key}>
                {part.text}
              </p>
            ) : (
              <AssistantMarkdown content={part.text} key={key} />
            );
          case "change":
            return <ChangePart actions={props.actions} key={key} part={part} />;
          case "proposal":
            return (
              <ProposalPart
                actions={props.actions}
                key={key}
                message={message}
                part={part}
              />
            );
          case "records":
            return (
              <RecordsPart actions={props.actions} key={key} part={part} />
            );
          case "activity":
            return <ActivityPart key={key} part={part} />;
          case "question":
            return (
              <QuestionPart actions={props.actions} key={key} part={part} />
            );
          case "plan":
            return <PlanPart key={key} part={part} />;
          case "notice":
            return part.kind === "compacted" || part.kind === "archived" ? (
              <div
                className="flex items-center gap-2 text-[12px] text-muted-foreground"
                data-assistant-notice={part.kind}
                key={key}
                role="separator"
              >
                <span className="h-px flex-1 bg-(--control-border)" />
                {part.text}
                <span className="h-px flex-1 bg-(--control-border)" />
              </div>
            ) : (
              <p
                className="text-[13px] text-muted-foreground"
                data-assistant-notice={part.kind}
                key={key}
              >
                {part.text}
              </p>
            );
          case "attachment":
            return (
              <span
                className="inline-flex w-fit items-center gap-1.5 rounded-(--radius-button) border border-(--control-border) px-2 py-0.5 text-[12px]"
                key={key}
              >
                <FileText aria-hidden="true" className="size-3" />
                {part.attachment.fileName}
              </span>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
