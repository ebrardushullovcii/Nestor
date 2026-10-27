import type { ApplyFormPathStep } from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import { holdsAnswer } from "./submit-preflight";
import type {
  ApplyAnswer,
  ApplyFormControl,
  ApplyFormObservation,
} from "./types";

/**
 * What an earlier run left on this application's form, so a closed page can
 * come back without the model: each field's answer as the review card keeps
 * it (by field identity, step by step), the files it attached, and the path
 * it took between screens.
 */
export interface FormReplay {
  answers: readonly FormReplayAnswer[];
  attachments: readonly FormReplayAttachment[];
  path: readonly ApplyFormPathStep[];
}

export interface FormReplayAnswer {
  fieldKey?: string | undefined;
  question: string;
  answer: string;
  source: string;
  sourceId?: string | undefined;
  written: boolean;
  groundedIn: readonly string[];
}

export interface FormReplayAttachment {
  fieldKey?: string | undefined;
  field: string;
  fileName: string;
  label: string;
}

/** One screen of a form: its address without query, and its step label. */
export function screenKey(observation: ApplyFormObservation): string {
  return `${observation.url?.split(/[?#]/u)[0] ?? ""}|${observation.step.label ?? ""}`;
}

/** The review card's identity for one field, as the run records it. */
export function reviewFieldKey(
  observation: ApplyFormObservation,
  control: ApplyFormControl,
): string {
  const label = questionPrompt(control);
  const ordinal = observation.controls
    .filter((entry) => questionPrompt(entry) === label)
    .indexOf(control);
  const questionKey =
    control.choiceGroupKey && !control.choiceGroupKey.startsWith("ref:")
      ? control.choiceGroupKey
      : `field:${control.kind}:${ordinal}`;
  return `${screenKey(observation)}|${questionKey}|${label}`.slice(0, 2_000);
}

/** One write a replay makes, with the hands call that makes it. */
export type ReplayWrite =
  | { kind: "text"; control: ApplyFormControl; value: string }
  | { kind: "choose"; control: ApplyFormControl; value: string }
  | { kind: "toggle"; control: ApplyFormControl; value: string };

export interface ReplayPlan {
  writes: Array<{ write: ReplayWrite; answer: FormReplayAnswer }>;
  /** Stored answers this screen already holds: the site's own draft, or the person's. */
  kept: number;
  /** Stored answers for this screen that no field here matches any more. */
  missing: FormReplayAnswer[];
}

/** The same question or option, whatever its spacing, case or required mark. */
const plain = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\s*[*✱]+\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
const same = (a: string, b: string) => plain(a) === plain(b);

/**
 * Matches each stored answer for this screen to its field: by the field's
 * identity, else by its question when only one field on the screen asks
 * it. Only an empty field is written; one that holds anything is kept, so a
 * site's server-side draft or the person's own edit is never retyped.
 */
export function planReplay(
  observation: ApplyFormObservation,
  replay: FormReplay,
): ReplayPlan {
  const screen = screenKey(observation);
  const usable = observation.controls.filter(
    (control) =>
      control.visible &&
      !control.disabled &&
      !control.readOnly &&
      control.kind !== "file" &&
      control.kind !== "other",
  );
  const onScreen = replay.answers.filter(
    (answer) => !answer.fieldKey || answer.fieldKey.startsWith(`${screen}|`),
  );
  const plan: ReplayPlan = { writes: [], kept: 0, missing: [] };
  const used = new Set<FormReplayAnswer>();
  const groups = new Map<string, ApplyFormControl[]>();
  for (const control of usable) {
    const key = reviewFieldKey(observation, control);
    const group = control.choiceGroupKey ?? key;
    if (control.kind === "radio" || control.kind === "checkbox") {
      groups.set(group, [...(groups.get(group) ?? []), control]);
      continue;
    }
    const answer = matchAnswer(
      onScreen,
      used,
      key,
      questionPrompt(control),
      usable,
    );
    if (!answer) continue;
    used.add(answer);
    if (holdsAnswer(control)) {
      plan.kept += 1;
      continue;
    }
    plan.writes.push({
      write: {
        kind:
          control.kind === "select" || control.kind === "combobox"
            ? "choose"
            : "text",
        control,
        value: answer.answer,
      },
      answer,
    });
  }
  for (const members of groups.values()) {
    const [first] = members;
    if (!first) continue;
    const answer = matchAnswer(
      onScreen,
      used,
      reviewFieldKey(observation, first),
      questionPrompt(first),
      usable,
    );
    if (!answer) continue;
    used.add(answer);
    if (members.some((member) => member.checked)) {
      plan.kept += 1;
      continue;
    }
    // A single box answered "Yes"; a group by the options it named.
    const wanted =
      members.length === 1 && first.kind === "checkbox"
        ? /^(?:yes|true|on|checked)$/iu.test(answer.answer)
          ? [first]
          : []
        : members.filter((member) =>
            (first.kind === "checkbox"
              ? answer.answer.split(/\s*,\s*/u)
              : [answer.answer]
            ).some((part) => same(part, member.label || member.value)),
          );
    if (!wanted.length) {
      plan.missing.push(answer);
      continue;
    }
    for (const member of wanted)
      plan.writes.push({
        write: { kind: "toggle", control: member, value: answer.answer },
        answer,
      });
  }
  plan.missing.push(
    ...onScreen.filter(
      (answer) =>
        answer.fieldKey && !used.has(answer) && !plan.missing.includes(answer),
    ),
  );
  return plan;
}

function matchAnswer(
  answers: readonly FormReplayAnswer[],
  used: ReadonlySet<FormReplayAnswer>,
  key: string,
  question: string,
  controls: readonly ApplyFormControl[],
): FormReplayAnswer | null {
  const open = answers.filter((answer) => !used.has(answer));
  const exact = open.find((answer) => answer.fieldKey === key);
  if (exact) return exact;
  // A question asked by more than one field (a group's options are one).
  const askers = new Set(
    controls
      .filter((control) => same(questionPrompt(control), question))
      .map((control) => control.choiceGroupKey ?? control.ref),
  );
  if (askers.size > 1) return null;
  const byQuestion = open.filter((answer) => same(answer.question, question));
  const [only] = byQuestion;
  return byQuestion.length === 1 && only ? only : null;
}

/** The answer a replayed field records, as the earlier run recorded it. */
export function replayedAnswer(
  answer: FormReplayAnswer,
  control: ApplyFormControl,
): ApplyAnswer {
  const sourceId = answer.sourceId ?? `observed.${control.ref}`;
  return {
    value: answer.answer,
    kind: control.questionKind,
    sourceKind: answer.written
      ? "generated"
      : sourceId.startsWith("answerLibrary.")
        ? "answer_library"
        : sourceId.startsWith("posting.") || sourceId.startsWith("listing.")
          ? "posting"
          : sourceId.startsWith("resume.")
            ? "resume"
            : "profile",
    sourceId,
    provenanceLabel: answer.source,
    groundedIn: [...answer.groundedIn],
  };
}

/** The recorded move to make from this screen, by what it said: a ref is never stored. */
export function nextPathStep(
  observation: ApplyFormObservation,
  replay: FormReplay,
  taken: ReadonlySet<number>,
): { index: number; step: ApplyFormPathStep; ref: string | null } | null {
  const screen = screenKey(observation);
  const index = replay.path.findIndex(
    (step, position) => !taken.has(position) && step.from === screen,
  );
  if (index < 0) return null;
  const step = replay.path.at(index);
  if (!step) return null;
  const ref =
    step.tool === "click"
      ? ([...observation.actions, ...observation.clickables].find((entry) =>
          same(entry.label, step.label),
        )?.ref ?? null)
      : step.tool === "follow_link"
        ? (observation.links.find(
            (link) =>
              (step.href && link.href === step.href) ||
              same(link.label, step.label),
          )?.ref ?? null)
        : null;
  return { index, step, ref };
}
