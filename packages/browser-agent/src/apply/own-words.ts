import type { ApplyFormObservation } from "./types";
/** Site instructions are complete page facts, interpreted by the application model. */
export function formWritingInstructions(
  page:
    | Pick<ApplyFormObservation, "bodyTextExcerpt" | "bodyTextForQuestions">
    | null
    | undefined,
): string {
  return page?.bodyTextForQuestions ?? page?.bodyTextExcerpt ?? "";
}
