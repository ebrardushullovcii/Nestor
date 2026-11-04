import type { ApplyFormPathStep } from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import { holdsAnswer } from "./submit-preflight";
import { choiceAnswerValues, matchOption } from "./option-match";
import { addedHistoryKind } from "./history-row-policy";
import { savedAnswerForQuestion } from "./application-facts";
import {
  answerSourceCatalog,
  knownLiteralField,
  literalValueMatches,
} from "./answer-source-catalog";
import type { ApplicationAttestationKind } from "@nestor/contracts";
import type {
  ApplyAnswer,
  ApplyAnswerSources,
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
  /** The page the earlier run's form was on. */
  formUrl?: string | undefined;
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
  | {
      kind: "toggle";
      control: ApplyFormControl;
      value: string;
      /** The state this member must end in; stale members are unchecked. */
      checked: boolean;
    };

export interface ReplayPlan {
  writes: Array<{ write: ReplayWrite; answer: FormReplayAnswer }>;
  /** Stored answers this screen already holds: the site's own draft, or the person's. */
  kept: number;
  /** Stored answers for this screen that no field here matches any more. */
  missing: FormReplayAnswer[];
  /** Stored answers whose source no longer grants them; decided afresh. */
  withdrawn: FormReplayAnswer[];
  /** Complete intended choice sets, including initially correct members. */
  groups: Array<{
    label: string;
    key: string | null;
    members: Array<{ ref: string; checked: boolean }>;
  }>;
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
 * site's server-side draft or the person's own edit is never retyped. The
 * exception is a stored answer the person has since changed: their current
 * answer replaces the old value.
 *
 * `current` says whether a stored answer still holds now: null when its
 * source no longer grants it (a revoked declaration, a forgotten saved
 * answer, a changed Profile fact), or the person's current value.
 */
export type ReplayCurrent = (
  answer: FormReplayAnswer,
  control: ApplyFormControl,
) => { value: string; changed: boolean } | null;

/**
 * A stored answer restores only while its source still grants it: an
 * approved declaration, a saved answer the person has not since changed or
 * forgotten (a changed one restores as their current value), or the same
 * Profile fact. Anything else goes back to the ordinary decision.
 */
export function replayStillCurrent(input: {
  controls: readonly ApplyFormControl[];
  sources: ApplyAnswerSources;
  approvedAttestations: readonly ApplicationAttestationKind[];
}): ReplayCurrent {
  return (answer, control) => {
    const id = answer.sourceId ?? "";
    const unchanged = { value: answer.answer, changed: false };
    const declaration = /^authority\.attestation\.(.+)$/u.exec(id)?.[1];
    if (declaration)
      return input.approvedAttestations.some((kind) => kind === declaration)
        ? unchanged
        : null;
    if (id.startsWith("answerLibrary.")) {
      const saved = input.sources.reusableAnswers.find(
        (entry) => `answerLibrary.${entry.id}` === id,
      );
      if (!saved) return null;
      return saved.answer === answer.answer
        ? unchanged
        : { value: saved.answer, changed: true };
    }
    // A selection made from the recorded skills list: every option still
    // has to be a recorded skill, or the group is decided afresh.
    if (id === "profile.skills") {
      const skills = answerSourceCatalog(input.sources)
        .filter((row) => /^profile\.skills\.\d+$/u.test(row.id))
        .map((row) => row.value);
      const chosen = choiceAnswerValues(answer.answer, skills);
      return chosen?.length ? unchanged : null;
    }
    // A field that takes the Profile value verbatim (a name, an email) must
    // still hold the current value. Answers derived from a fact (Yes from an
    // authorized country) are re-checked against Profile at Send instead.
    if (/^profile\.[^#]+$/u.test(id)) {
      const fact = answerSourceCatalog(input.sources).find(
        (row) => row.id === id,
      );
      if (fact && !knownLiteralField(fact, control)) return unchanged;
      return fact &&
        literalValueMatches(
          fact,
          control,
          answer.answer,
          input.controls,
          input.sources,
        )
        ? unchanged
        : null;
    }
    // An answer the earlier run only observed on the page grants nothing by
    // itself: the person's current saved answer to this question wins.
    const saved = savedAnswerForQuestion(
      control,
      input.sources.reusableAnswers,
      input.controls,
    );
    if (saved && saved.answer !== answer.answer)
      return { value: saved.answer, changed: true };
    return unchanged;
  };
}

export function planReplay(
  observation: ApplyFormObservation,
  replay: FormReplay,
  current: ReplayCurrent = (answer) => ({
    value: answer.answer,
    changed: false,
  }),
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
  const plan: ReplayPlan = {
    writes: [],
    kept: 0,
    missing: [],
    withdrawn: [],
    groups: [],
  };
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
    const now = current(answer, control);
    // No longer granted: not restored; the ordinary decision reads it again.
    if (!now) {
      plan.withdrawn.push(answer);
      continue;
    }
    const shown = control.selectedOptionLabel || control.value;
    const savedChoice =
      (control.kind === "select" || control.kind === "combobox") &&
      answer.sourceId?.startsWith("answerLibrary.");
    const desired = savedChoice
      ? matchOption(control.options, now.value)
      : now.value;
    if (savedChoice && !desired) {
      plan.missing.push(answer);
      continue;
    }
    if (
      holdsAnswer(control) &&
      ((!savedChoice && !now.changed) || same(shown, desired ?? now.value))
    ) {
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
        value: desired ?? now.value,
      },
      answer: { ...answer, answer: now.value },
    });
  }
  for (const members of groups.values()) {
    const [first] = members;
    if (!first) continue;
    const stored = matchAnswer(
      onScreen,
      used,
      reviewFieldKey(observation, first),
      questionPrompt(first),
      usable,
    );
    if (!stored) continue;
    used.add(stored);
    // A single box answered Yes or No; a radio by its one option; a
    // checkbox group by the exact set it named (a JSON list keeps a label
    // that contains a comma whole).
    const single = members.length === 1 && first.kind === "checkbox";
    const label = (member: ApplyFormControl) => member.label || member.value;
    const membersFor = (value: string) => {
      const names =
        single || first.kind !== "checkbox"
          ? null
          : choiceAnswerValues(value, members.map(label));
      return single
        ? /^(?:yes|true|on|checked)$/iu.test(value)
          ? [first]
          : /^(?:no|false|off|unchecked)$/iu.test(value)
            ? []
            : null
        : first.kind === "checkbox"
          ? names && members.filter((member) => names.includes(label(member)))
          : members.filter((member) => same(value, label(member)));
    };
    const now = current(stored, first);
    if (!now) {
      plan.withdrawn.push(stored);
      // A box the old answer ticked (a declaration since revoked) is
      // unticked rather than left looking approved. A radio cannot be
      // cleared; its question goes back to the ordinary decision.
      if (first.kind === "checkbox")
        for (const member of membersFor(stored.answer) ?? [])
          if (member.checked)
            plan.writes.push({
              write: {
                kind: "toggle",
                control: member,
                value: stored.answer,
                checked: false,
              },
              answer: stored,
            });
      continue;
    }
    const answer = { ...stored, answer: now.value };
    const wanted = membersFor(now.value);
    if (
      !wanted ||
      (!single && !wanted.length) ||
      (first.kind === "radio" && wanted.length !== 1)
    ) {
      plan.missing.push(answer);
      continue;
    }
    // Kept only when the page holds exactly the stored choice. A different
    // checked member (a site default or a stale value) is replaced.
    plan.groups.push({
      label: questionPrompt(first),
      key: first.choiceGroupKey ?? null,
      members: members.map((member) => ({
        ref: member.ref,
        checked: wanted.includes(member),
      })),
    });
    const changes = members.filter(
      (member) => member.checked !== wanted.includes(member),
    );
    if (!changes.length) {
      plan.kept += 1;
      continue;
    }
    for (const member of first.kind === "radio" ? wanted : changes)
      plan.writes.push({
        write: {
          kind: "toggle",
          control: member,
          value: answer.answer,
          checked: wanted.includes(member),
        },
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
  // Adding a history row is decided by the current form and the Profile's
  // records, never by an old press: a recovered page would otherwise grow a
  // row each time the path is replayed, and a row with no bound record gets
  // filled from the wrong one (council D2).
  const index = replay.path.findIndex(
    (step, position) =>
      !taken.has(position) &&
      step.from === screen &&
      !(step.tool === "click" && addedHistoryKind(step.label)),
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
