import {
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import type { ApplyFormObservation } from "./types";

/** Keep the first occurrence across resumptions; later equal wording is ambiguous. */
export function createQuestionOccurrences(
  initial: ReadonlyArray<{ prompt: string; step: string }> = [],
) {
  const first = new Map(
    initial.map((entry) => [normalizeFormQuestionPrompt(entry.prompt), entry]),
  );
  return {
    observe(page: ApplyFormObservation) {
      const step = JSON.stringify([
        page.url?.split(/[?#]/u)[0],
        page.step.index ?? (page.step.label?.trim() || null),
      ]);
      for (const control of page.controls) {
        if (
          !control.visible ||
          control.kind === "file" ||
          control.credentialRole
        )
          continue;
        delete control.repeatedQuestion;
        const prompt = questionPrompt(control);
        const key = normalizeFormQuestionPrompt(prompt);
        const earlier = first.get(key);
        if (!earlier) first.set(key, { prompt, step });
        else if (earlier.step !== step) {
          control.repeatedQuestion = {
            prompt: `${cleanFormQuestionPrompt(prompt)} (repeated question on ${page.step.index !== null ? `step ${page.step.index}` : page.step.label || "another step"})`,
            step,
          };
        }
      }
    },
    snapshot: () => [...first.values()],
  };
}
