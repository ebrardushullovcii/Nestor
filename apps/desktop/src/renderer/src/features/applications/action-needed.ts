import type { ApplicationDetails, NeedsYouTask } from "@nestor/contracts";

import { formatWhen } from "./tracker-format";

/**
 * The one line a handoff leads with, in Needs you and on the application:
 * "ACTION NEEDED — <site>: <what to do>. Done so far: <…>. Sent: <…>."
 *
 * Every part says only what a record supports. A filled form is not a send,
 * and no send recorded is not proof the site saved nothing, so the sent part
 * never claims either from the absence of a receipt.
 */
export interface ActionNeeded {
  site: string;
  /** Whole sentences: the exact control, fact or review the person owns. */
  action: string;
  /** Null while the application's record is still loading. */
  done: string | null;
  sent: string | null;
}

/** The parts of a Needs you item the line reads. */
export type ActionNeededTask = Pick<
  NeedsYouTask,
  "kind" | "prompt" | "input" | "scope"
> &
  Partial<Pick<NeedsYouTask, "askReason" | "blockedUrl">>;

const STEP_PROMPT = /^Press (.+) on the site, then continue$/u;
const UPLOAD_PROMPT = /^(.+) — upload (failed|not confirmed)$/u;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)]+/giu;

/** A site as a person names it: its host, without "www.". */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}

/**
 * Text from a run or a page, safe to lead with: one line, and any address in
 * it cut to its host, so no sign-in path or query reaches the screen.
 */
function plain(text: string): string {
  return text
    .replace(URL_IN_TEXT, (url) => hostOf(url) ?? "the site")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A clause as a sentence: capitalised and ended once. */
function sentence(text: string): string {
  const value = plain(text);
  if (!value) return "";
  const lead = value[0]!.toUpperCase() + value.slice(1);
  return /[.!?]$/u.test(lead) ? lead : `${lead}.`;
}

function quoted(prompt: string): string {
  return `“${plain(prompt).replace(/^[“"]|[”"]$/gu, "")}”`;
}

/**
 * What the person has to do for one item, naming the form's own control or
 * the exact question. `accessDetail` is the run's recorded reason for a site
 * step (such as which access a sign-in provider asks for); it is shown as
 * recorded and never guessed from the provider's name.
 */
export function taskAction(
  task: ActionNeededTask,
  options: {
    /** The line sits on the application, not in Needs you beside the item. */
    onApplication?: boolean;
    accessDetail?: string | null;
  } = {},
): string {
  const prompt = task.prompt ?? "";
  const here = options.onApplication ? " in Needs you" : " here";
  const accessDetail = options.accessDetail ?? null;
  if (task.blockedUrl)
    return "The site blocked Nestor’s browser. Open the job in your own browser and apply there.";
  if (task.kind === "question") {
    const step = STEP_PROMPT.exec(prompt);
    // Nestor already pressed it once and the page did not confirm the step.
    if (step && task.askReason?.check === "step_not_confirmed")
      return `${sentence(task.askReason.detail)} Then press “I pressed it, continue”${here}.`;
    if (step)
      return `Press ${plain(step[1]!)} on the form yourself, then press “I pressed it, continue”${here}.`;
    const upload = UPLOAD_PROMPT.exec(prompt);
    if (upload)
      return `Attach the file for ${plain(upload[1]!)} on the form; the upload ${upload[2] === "failed" ? "failed" : "was not confirmed"}.`;
    if (!plain(prompt))
      return options.onApplication
        ? "Open its item in Needs you to see the question."
        : "Answer the question below.";
    // A read or model failure is Nestor's, not a gap in the person's facts.
    if (task.askReason?.check === "question_classification")
      return `Nestor could not read the question ${quoted(prompt)}. This is a Nestor problem, not missing information. Press “Open application” to check the form; you do not need to enter saved facts again.`;
    if (task.input === "file")
      return `Choose the file for ${quoted(prompt)}${options.onApplication ? here : ""}.`;
    return `Give your answer to ${quoted(prompt)}${options.onApplication ? here : ""}.`;
  }
  const reason = [sentence(prompt), accessDetail ? sentence(accessDetail) : ""]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(" ");
  const fallback =
    task.kind === "captcha"
      ? "Complete the CAPTCHA in the browser."
      : task.kind === "mfa"
        ? "Enter the verification code in the browser."
        : "Finish this step on the site in the browser.";
  return `${reason || fallback} Then press “Check again”${options.onApplication ? here : ""}.`;
}

/** Where the person acts: the item's site when it names one, else the employer. */
export function actionSite(
  task: Pick<ActionNeededTask, "scope"> | null,
  applications: readonly { company: string }[],
): string {
  // Read defensively: a partial record must not take the pane down.
  const origin = task?.scope?.siteOrigin;
  const host = origin ? hostOf(origin) : null;
  if (host) return host;
  const [first] = applications;
  if (!first) return "this application";
  const more = applications.length - 1;
  return more > 0 ? `${first.company} and ${more} more` : first.company;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What the run recorded putting on the form; nothing it only selected. */
export function doneSoFar(details: ApplicationDetails): string {
  const card = details.reviewCard;
  if (!card) return "nothing is recorded on the form yet.";
  const parts: string[] = [];
  if (card.answers.length > 0)
    parts.push(`filled ${plural(card.answers.length, "field", "fields")}`);
  const files = [...new Set(card.attachments.map((file) => file.fileName))];
  if (files.length > 0) parts.push(`attached ${files.join(", ")}`);
  if (card.letter) parts.push("added a cover letter");
  return parts.length > 0
    ? `${parts.join(", ")} (${formatWhen(card.preparedAt)}).`
    : "nothing is recorded on the form yet.";
}

/**
 * Whether the application went out, from the send's own receipt. Without
 * one it says no send is recorded, and that what the site saved on its own
 * is not known, unless the browser saw a save.
 */
export function sentStatus(details: ApplicationDetails): string {
  const { application, receipt, reviewCard: card } = details;
  if (receipt?.outcome === "submitted" || application.submittedAt) {
    const by = receipt?.evidence.some(
      (entry) => entry.kind === "operator_confirmation",
    )
      ? "you confirmed"
      : "site confirmed";
    const when = receipt?.verifiedAt ?? application.submittedAt;
    return `yes, ${receipt ? by : "recorded"}${when ? ` ${formatWhen(when)}` : ""}.`;
  }
  if (
    receipt?.outcome === "outcome_uncertain" ||
    application.state === "uncertain"
  )
    return `unknown. Nestor pressed send${receipt ? ` (${formatWhen(receipt.attemptedAt)})` : ""}, but the site has not confirmed receipt. Nestor will not send it again by itself.`;
  if (receipt?.outcome === "not_submitted")
    return `no, the application was not sent${receipt.verifiedAt ? ` (checked ${formatWhen(receipt.verifiedAt)})` : ""}.`;
  if (card?.intermediateSaved)
    return "no application send recorded. The site saved some answers or files while Nestor filled the form.";
  if (card)
    return "no application send recorded. Whether the site saved answers on its own is not verified.";
  return "no application send recorded.";
}

/** The line as plain text, as it reads on screen. */
export function actionNeededText(line: ActionNeeded): string {
  return [
    `ACTION NEEDED — ${line.site}: ${line.action}`,
    line.done === null ? null : `Done so far: ${line.done}`,
    line.sent === null ? null : `Sent: ${line.sent}`,
  ]
    .filter(Boolean)
    .join(" ");
}
