import { normalizeSignal } from "./control-classification";
import type {
  ApplyAgentConfig,
  ApplyClickable,
  ApplyFormAction,
  ApplyFormObservation,
} from "./types";

/**
 * What Fill in for me presses on its own.
 *
 * Local non-final steps use local-step-preflight and a stricter read-only
 * runtime mechanic. All other form buttons stay with the person. Fill also
 * presses what helps it fill: parts of a field, a link back to the
 * form, a cookie banner's dismissal, the button that opens the form before
 * anything is filled, and an "Add another" row inside the form. Whatever any
 * press makes the page send still meets the network fence, which lets out
 * nothing but reads and the selected resume.
 */

/** What Fill remembers between presses, kept on the run's guard state. */
export interface FillPressState {
  /** Fields this run has written; a press is not a field write. */
  fieldWrites: number;
  /** The run has pressed the button that opens the form. */
  openedForm: boolean;
  /** Per form section, the field writes there were when a row was last added. */
  rowsAdded: Map<string, number>;
}

export type FillPress =
  | { kind: "field_part" | "link" | "open_form"; ref: string }
  | { kind: "cookie_banner"; ref: string; label: string }
  | { kind: "add_row"; ref: string; section: string };

/** Clickable roles that are part of answering one field, not of the form. */
const FIELD_PART_ROLES = new Set([
  "combobox",
  "option",
  "listbox",
  "radio",
  "checkbox",
  "switch",
  "menuitemradio",
  "menuitemcheckbox",
  "treeitem",
]);

/**
 * Whether Fill in for me may open this address itself: only the application
 * form it was started on, the page it is on, or the page an earlier run of
 * this application filled its form on or followed a link to. Any other link
 * (a "Continue", a step) is the person's, like any other button.
 */
export function fillMayOpen(
  config: Pick<ApplyAgentConfig, "application" | "replay">,
  currentUrl: string | null,
  href: string,
): boolean {
  const address = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value, currentUrl ?? undefined);
      return `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  };
  const target = address(href);
  return (
    target !== null &&
    (target === address(currentUrl) ||
      target === address(config.application.startingUrl) ||
      // The page an earlier run of this application filled the form on, and
      // the way it went there (a job page's Application tab): a refill
      // goes back to restore it.
      target === address(config.replay?.formUrl) ||
      (config.replay?.path ?? []).some(
        (step) =>
          step.tool !== "click" && step.href && target === address(step.href),
      ))
  );
}

type Pressable = (ApplyFormAction | ApplyClickable) & { formAction?: string };

/** Words that make a button the form's own, whatever else it says. */
const FORM_STEP_WORDS =
  /\b(?:submit|send|apply|application|save|continue|next|finish|complete|review|done|confirm|post|proceed)\b/u;

const COOKIE_PART = /\b(?:cookies?|consent|gdpr|tracking|privacy)\b/u;
const COOKIE_REJECT =
  /^(?:i )?(?:reject|decline|deny|refuse|disagree)(?: all)?(?: optional| non essential| additional)?(?: cookies)?$/u;
const COOKIE_NECESSARY =
  /^(?:(?:use|allow|accept) )?(?:only )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?(?: only)?$|^only (?:strictly )?(?:necessary|essential|required)(?: cookies)?$/u;
const COOKIE_ACCEPT =
  /^(?:i )?(?:accept|allow|agree|ok|okay|got it|understood)(?: all)?(?: cookies)?$/u;

/** How much a cookie choice keeps from the site: lower is preferred. */
function cookieChoiceRank(entry: Pressable): number | null {
  const label = normalizeSignal(entry.label);
  const section = normalizeSignal(entry.section ?? "");
  if (!COOKIE_PART.test(`${section} ${label}`)) return null;
  if (COOKIE_REJECT.test(label)) return 0;
  if (COOKIE_NECESSARY.test(label)) return 1;
  if (COOKIE_ACCEPT.test(label)) return 2;
  return null;
}

const OPENS_FORM =
  /^(?:apply|apply now|apply here|apply online|apply for (?:this|the) (?:job|position|role|vacancy|opening)|apply to (?:this|the) (?:job|position|role)|(?:start|begin)(?: (?:my|your|an))? application|i m interested|im interested)$/u;

const ADDS_ROW =
  /^add(?: (?:another|more|a|an|new|one more))*(?: [a-z]+){0,4}$/u;
const NOT_A_ROW =
  /\b(?:cart|basket|favou?rites?|wishlist|calendar|alert|alerts|watchlist|bookmark|follow|newsletter)\b|\bto my\b/u;

function pressables(observation: ApplyFormObservation): Pressable[] {
  return [...observation.actions, ...observation.clickables].filter(
    (entry) =>
      entry.visible && !("disabled" in entry && entry.disabled === true),
  );
}

/** Routine privacy mechanics, shared by Fill and Send modes. A banner with
 * only an opt-in is never permission to accept optional tracking. */
export function cookieConsentChoice(
  observation: ApplyFormObservation,
  ref: string,
):
  | Extract<FillPress, { kind: "cookie_banner" }>
  | { kind: "blocked_cookie_consent" }
  | null {
  const entries = pressables(observation);
  const entry = entries.find((candidate) => candidate.ref === ref);
  if (!entry || cookieChoiceRank(entry) === null) return null;
  const banner = entries.filter(
    (candidate) =>
      cookieChoiceRank(candidate) !== null &&
      candidate.section === entry.section &&
      !candidate.formAction &&
      !("submitsForm" in candidate && candidate.submitsForm),
  );
  const safe = banner
    .filter((candidate) => (cookieChoiceRank(candidate) ?? 2) < 2)
    .sort((a, b) => (cookieChoiceRank(a) ?? 2) - (cookieChoiceRank(b) ?? 2));
  const best = safe.find((candidate) => candidate.ref === ref) ?? safe[0];
  return best
    ? { kind: "cookie_banner", ref: best.ref, label: best.label }
    : { kind: "blocked_cookie_consent" };
}

/**
 * The press Fill in for me makes for the one the model asked for, or null
 * when that one is the person's. For a cookie banner it may be another
 * button on the same banner: the one that keeps the least.
 */
export function fillPressFor(input: {
  config: Pick<ApplyAgentConfig, "application" | "replay">;
  observation: ApplyFormObservation;
  ref: string;
  state: FillPressState;
}): FillPress | null {
  const { config, observation, ref, state } = input;
  if (observation.controls.some((control) => control.ref === ref))
    return { kind: "field_part", ref };
  const link = observation.links.find((entry) => entry.ref === ref);
  if (link)
    return fillMayOpen(config, observation.url, link.href)
      ? { kind: "link", ref }
      : null;
  const entry = pressables(observation).find(
    (candidate) => candidate.ref === ref,
  );
  if (!entry) return null;
  if ("role" in entry && FIELD_PART_ROLES.has(entry.role.toLowerCase()))
    return { kind: "field_part", ref };
  const label = normalizeSignal(entry.label);

  const cookie = cookieConsentChoice(observation, ref);
  if (cookie) return cookie.kind === "cookie_banner" ? cookie : null;

  // The button that opens the form, before anything on it is filled: the
  // run's first, on a page where no field holds an answer yet, and not a
  // button that would submit a form.
  if (
    OPENS_FORM.test(label) &&
    !entry.formAction &&
    !state.openedForm &&
    state.fieldWrites === 0 &&
    !config.application.continuation &&
    !observation.controls.some(
      (control) => control.visible && !control.disabled && control.answered,
    )
  )
    return { kind: "open_form", ref };

  // "Add another" inside the form being filled. Once a row is added, the
  // next one waits until something is written: no run of empty rows.
  if (
    ADDS_ROW.test(label) &&
    !FORM_STEP_WORDS.test(label) &&
    !NOT_A_ROW.test(label) &&
    entry.inForm === true &&
    observation.controls.some(
      (control) => control.visible && !control.disabled && !control.readOnly,
    )
  ) {
    const section = entry.section ?? "";
    const before = state.rowsAdded.get(section);
    if (before === undefined || state.fieldWrites > before)
      return { kind: "add_row", ref, section };
  }
  return null;
}

/** Records a press Fill made, so the next one is judged on it. */
export function recordFillPress(state: FillPressState, press: FillPress): void {
  if (press.kind === "open_form") state.openedForm = true;
  if (press.kind === "add_row")
    state.rowsAdded.set(press.section, state.fieldWrites);
}
