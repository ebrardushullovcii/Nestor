import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  SquareCheck,
  X,
} from "lucide-react";
import type {
  ApplicationDetails,
  ApplicationReviewAnswer,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Disclosure } from "@renderer/components/ui/disclosure";

/** Controls where the person picks an option rather than typing. */
const CHOICE_CONTROLS = new Set(["select", "combobox", "radio", "checkbox"]);

/**
 * An answer as the person gives it on the form: the options to pick for a
 * choice, or the text to type. A stored JSON list is several picked options.
 */
export function handAnswer(answer: ApplicationReviewAnswer): {
  kind: "text" | "choice" | "choices";
  values: string[];
} {
  if (answer.answer.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(answer.answer);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((value) => typeof value === "string")
      )
        return { kind: "choices", values: parsed };
    } catch {
      // Not a list: the text itself.
    }
  }
  if (answer.control === "checkbox")
    return { kind: "choices", values: [answer.answer] };
  if (answer.control && CHOICE_CONTROLS.has(answer.control))
    return { kind: "choice", values: [answer.answer] };
  return { kind: "text", values: [answer.answer] };
}

/** What Copy puts on the clipboard for one answer. */
function answerText(answer: ApplicationReviewAnswer): string {
  return handAnswer(answer).values.join(", ");
}

/** Every answer under its question, ready to paste into notes or a form. */
export function allAnswersText(details: ApplicationDetails): string {
  const card = details.reviewCard;
  if (!card) return "";
  return [
    ...card.answers.map(
      (answer) => `${answer.question}\n${answerText(answer)}`,
    ),
    ...(card.letter ? [`Cover letter\n${card.letter.text}`] : []),
  ].join("\n\n");
}

/** One line per file, under each of the form's names for it. */
function attachedFiles(details: ApplicationDetails) {
  const files: { fileName: string; labels: string[]; path: string | null }[] =
    [];
  for (const [label, fileName] of [
    ...(details.resumeFileName
      ? [["Resume", details.resumeFileName] as const]
      : []),
    ...(details.reviewCard?.attachments ?? []).map(
      (file) => [file.label, file.fileName] as const,
    ),
  ]) {
    const same = files.find((entry) => entry.fileName === fileName);
    if (same) {
      if (!same.labels.includes(label)) same.labels.push(label);
      continue;
    }
    files.push({
      fileName,
      labels: [label],
      path:
        fileName === details.resumeFileName
          ? (details.resumeFilePath ?? null)
          : null,
    });
  }
  return files;
}

const SHOW_FILE_LABEL =
  typeof navigator !== "undefined" && /^Mac/u.test(navigator.platform)
    ? "Show in Finder"
    : "Show in folder";

/** A Copy button that says so for a moment after it copied. */
function CopyButton(props: {
  text: string;
  label?: string;
  accessibleName: string;
  disabled?: boolean;
  variant?: "ghost" | "outline";
  size?: "xs" | "compact";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const label = props.label ?? "Copy";
  return (
    <Button
      aria-label={
        state === "copied"
          ? `Copied ${props.accessibleName}`
          : `${label} ${props.accessibleName}`
      }
      disabled={props.disabled}
      onClick={() => {
        void window.nestor.jobFinder
          .writeClipboardText(props.text)
          .then(() => setState("copied"))
          .catch(() => setState("failed"))
          .finally(() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setState("idle"), 1600);
          });
      }}
      size={props.size ?? "xs"}
      variant={props.variant ?? "ghost"}
    >
      {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : label}
    </Button>
  );
}

function Step(props: {
  n: number;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <span
        aria-hidden="true"
        className="flex size-6 items-center justify-center rounded-full border border-(--control-border) text-xs font-semibold text-foreground-soft"
      >
        {props.n}
      </span>
      <div className="grid min-w-0 gap-3">
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {props.title}
          </h3>
          {props.aside}
        </div>
        {props.children}
      </div>
    </li>
  );
}

function AnswerRow(props: {
  answer: ApplicationReviewAnswer;
  disabled: boolean;
}) {
  const { answer } = props;
  const hand = handAnswer(answer);
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3 py-2.5"
      data-own-browser-answer={answer.fieldKey ?? answer.question}
    >
      <p className="text-xs text-foreground-soft">{answer.question}</p>
      <div className="row-span-2 -mr-1">
        <CopyButton
          accessibleName={`answer to “${answer.question}”`}
          disabled={props.disabled}
          text={answerText(answer)}
        />
      </div>
      {hand.kind === "text" ? (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
          {hand.values[0]}
        </p>
      ) : (
        <ul
          aria-label={
            hand.kind === "choice" ? "Option to pick" : "Options to tick"
          }
          className="grid gap-1"
        >
          {hand.values.map((value) => (
            <li
              className="flex items-start gap-2 text-sm text-foreground"
              key={value}
            >
              {hand.kind === "choice" ? (
                <CircleDot
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-primary"
                />
              ) : (
                <SquareCheck
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-primary"
                />
              )}
              <span className="min-w-0 break-words">
                <span className="sr-only">
                  {hand.kind === "choice" ? "Pick " : "Tick "}
                </span>
                {value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FileRow(props: {
  file: { fileName: string; labels: string[]; path: string | null };
  disabled: boolean;
}) {
  const { file } = props;
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <li
      className="grid gap-2 px-3 py-2.5"
      data-own-browser-file={file.fileName}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <FileText
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-foreground-soft"
        />
        <div className="grid min-w-0 gap-0.5">
          <p className="break-all text-sm font-medium text-foreground">
            {file.fileName}
          </p>
          <p className="text-xs text-foreground-soft">
            {file.labels.join(", ")}
          </p>
        </div>
      </div>
      {file.path ? (
        <div className="flex flex-wrap gap-2 pl-6.5">
          <Button
            disabled={props.disabled}
            onClick={() => {
              setNotice(null);
              void window.nestor.jobFinder
                .revealSavedFile(file.path!)
                .then((result) => {
                  if (result.outcome === "not_found")
                    setNotice(
                      "That file is no longer there. Open the application in Applications to find the resume it used.",
                    );
                  else if (result.outcome === "unsupported")
                    setNotice("Showing files is not supported on this device.");
                })
                .catch(() =>
                  setNotice("The file could not be shown. Try again."),
                );
            }}
            size="compact"
            variant="outline"
          >
            <FolderOpen aria-hidden />
            {SHOW_FILE_LABEL}
          </Button>
          <CopyButton
            accessibleName={`the path to ${file.fileName}`}
            disabled={props.disabled}
            label="Copy path"
            size="compact"
            text={file.path}
            variant="outline"
          />
        </div>
      ) : null}
      {notice ? (
        <p className="pl-6.5 text-xs text-(--warning-text)" role="status">
          {notice}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Everything a person needs to finish an application in their own browser
 * after a site refused Nestor's: the page, each answer Apply prepared under
 * the form's own question, the file it attached, and a way to say how it
 * went. It only shows what the run recorded; nothing here sends anything.
 */
export function OwnBrowserFinish(props: {
  blockedUrl: string;
  /** The waiting application's record; undefined while it loads. */
  record: ApplicationDetails | null | undefined;
  disabled: boolean;
  onOpen: (browser: "own" | "nestor") => void;
  onSettle: ((sent: boolean) => void) | null;
}) {
  const { record } = props;
  const answers = record?.reviewCard?.answers ?? [];
  const letter = record?.reviewCard?.letter ?? null;
  const files = record ? attachedFiles(record) : [];
  const site = record?.application.company ?? "the employer";
  let n = 0;
  return (
    <ol className="grid gap-6" data-own-browser-finish>
      <Step n={++n} title="Open the application in your browser">
        <div className="flex flex-wrap gap-2">
          <Button disabled={props.disabled} onClick={() => props.onOpen("own")}>
            <ExternalLink aria-hidden />
            Open in my browser
          </Button>
          <Button
            disabled={props.disabled}
            onClick={() => props.onOpen("nestor")}
            variant="outline"
          >
            Open in Nestor
          </Button>
        </div>
        <p className="break-all text-xs text-foreground-muted">
          {props.blockedUrl}
        </p>
      </Step>

      {record === undefined ? (
        <li className="pl-9 text-sm text-foreground-soft" role="status">
          Loading the answers Apply prepared…
        </li>
      ) : null}

      {answers.length > 0 || letter ? (
        <Step
          aside={
            record ? (
              <CopyButton
                accessibleName="answers"
                disabled={props.disabled}
                label="Copy all"
                size="compact"
                text={allAnswersText(record)}
                variant="outline"
              />
            ) : null
          }
          n={++n}
          title="Fill in the answers Apply prepared"
        >
          <p className="text-sm text-foreground-soft">
            {answers.length === 1 ? "1 answer" : `${answers.length} answers`},
            in the form’s order. For a choice, pick the option shown.
          </p>
          {answers.length > 0 ? (
            <ul
              aria-label="Prepared answers"
              className="divide-y divide-(--surface-panel-border) rounded-(--radius-field) border border-(--surface-panel-border)"
            >
              {answers.map((answer, index) => (
                <AnswerRow
                  answer={answer}
                  disabled={props.disabled}
                  key={answer.fieldKey ?? `${answer.question}:${index}`}
                />
              ))}
            </ul>
          ) : null}
          {letter ? (
            <Disclosure
              className="text-sm"
              contentClassName="grid gap-2 pl-7.5"
              summary="Cover letter"
            >
              <p className="whitespace-pre-wrap text-foreground">
                {letter.text}
              </p>
              <div>
                <CopyButton
                  accessibleName="cover letter"
                  disabled={props.disabled}
                  size="compact"
                  text={letter.text}
                  variant="outline"
                />
              </div>
            </Disclosure>
          ) : null}
        </Step>
      ) : null}

      {files.length > 0 ? (
        <Step
          n={++n}
          title={files.length === 1 ? "Attach this file" : "Attach these files"}
        >
          <p className="text-sm text-foreground-soft">
            The same file Apply attached. Drag it from the folder onto the form,
            or paste its path in the file picker.
          </p>
          <ul
            aria-label="Files to attach"
            className="divide-y divide-(--surface-panel-border) rounded-(--radius-field) border border-(--surface-panel-border)"
          >
            {files.map((file) => (
              <FileRow
                disabled={props.disabled}
                file={file}
                key={file.fileName}
              />
            ))}
          </ul>
        </Step>
      ) : null}

      {props.onSettle && record ? (
        <Step n={++n} title="Tell Nestor how it went">
          <p className="text-sm text-foreground-soft">
            After you submit, look for {site}’s confirmation on the page or in
            your email.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={props.disabled}
              onClick={() => props.onSettle?.(true)}
              variant="outline"
            >
              <Check aria-hidden />
              It went through
            </Button>
            <Button
              disabled={props.disabled}
              onClick={() => props.onSettle?.(false)}
              variant="outline"
            >
              <X aria-hidden />
              It didn’t go through
            </Button>
          </div>
        </Step>
      ) : null}
    </ol>
  );
}
