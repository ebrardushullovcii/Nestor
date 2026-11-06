import type { ApplyFormPathStep } from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import type { ApplyFormControl, ApplyFormObservation } from "./types";

/**
 * What an earlier run recorded. These are facts for the model; only a new
 * model tool call can write them to a page.
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
  savedSha256?: string | undefined;
  field: string;
  fileName: string;
  label: string;
}

/** One screen of a form: its address without query, and its step label. */
export function screenKey(observation: ApplyFormObservation): string {
  const step =
    observation.step.label ??
    (observation.step.index !== null && observation.step.total !== null
      ? `Step ${observation.step.index} of ${observation.step.total}`
      : "");
  return `${observation.url?.split(/[?#]/u)[0] ?? ""}|${step}`;
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
