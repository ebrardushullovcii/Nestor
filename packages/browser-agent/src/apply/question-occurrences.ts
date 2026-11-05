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
        // A read that could not tell the step (a page between steps or
        // just after sign-in) is not evidence of another step. On the same
        // page, a known step replaces an unknown first record (workday
        // replica, candidate 4: the Review terms box was asked as repeated).
        const unknownStep = (value: string): [unknown, unknown] | [] => {
          try {
            const parsed: unknown = JSON.parse(value);
            if (!Array.isArray(parsed)) return [];
            const entries: readonly unknown[] = parsed;
            return [entries[0], entries[1] ?? null];
          } catch {
            return [];
          }
        };
        const [earlierPage, earlierStep] = earlier
          ? unknownStep(earlier.step)
          : [];
        const [currentPage, currentStep] = unknownStep(step);
        const samePageUnknown =
          !!earlier &&
          earlierPage === currentPage &&
          (earlierStep === null || currentStep === null);
        if (!earlier || (samePageUnknown && earlierStep === null))
          first.set(key, { prompt, step });
        else if (!samePageUnknown && earlier.step !== step) {
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
