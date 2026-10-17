import type { ResumeApplicationMode, TailoringMode } from "@nestor/contracts";

/**
 * The resume approaches a person may choose, in the order guided setup offers
 * them. Keeping the resume as it is comes first: it is the one choice that is
 * not a rewrite, and leaving it out of a list made the other three look like
 * the complete set.
 *
 * Every title and description says what happens to the person's own words.
 * The previous names ("Light edit", "Balanced rewrite", "Strong rewrite")
 * graded an effort nobody could see: seven of nine testers listed "Balanced
 * rewrite" as a phrase they could not interpret, and the strongest option was
 * read as a promise of "small deliberate stretches" rather than as a choice
 * about their own text. The behaviour and the default are unchanged (ADR
 * 0018); only the words are.
 *
 * `value` is either a tailoring strength or the sentinel `original_resume`,
 * which is stored as the application default rather than as a strength.
 */
export const RESUME_APPROACH_OPTIONS = [
  {
    description:
      "Job Finder uses the exact file you imported. Nothing is rewritten and no tailored copy is made; you still review each job before any prepare-only application work.",
    label: "Original: keep my resume as it is",
    value: "original_resume",
  },
  {
    description:
      "Small wording changes for the job. Every fact you wrote stays exactly as you wrote it.",
    label: "Light: small edits, every fact kept",
    value: "conservative",
  },
  {
    description:
      "More of your wording is rewritten for the job. Every fact you wrote still stays exactly as you wrote it.",
    label: "Tailored: a fuller rewrite, every fact kept",
    value: "balanced",
  },
  {
    description:
      "A fuller rewrite that may also go a little past what you wrote: it can state a number of years you have evidence for one year higher when the job asks for that figure, and name technologies the job asks for — including ones named only in the qualifications — when your own experience makes them credible. Every one of those lines is shown to you to confirm before the resume can be used.",
    label: "Aggressive: may stretch, with your say-so",
    value: "aggressive",
  },
] as const satisfies readonly {
  description: string;
  label: string;
  value: TailoringMode | Extract<ResumeApplicationMode, "original_resume">;
}[];

/**
 * One vocabulary for the resume tailoring styles, shared by guided setup and
 * Preferences so the same setting never carries two names or two warnings.
 */
export const TAILORING_MODE_DESCRIPTIONS: Record<string, string> = {
  conservative:
    "Small wording changes for the job. Every fact you wrote stays exactly as you wrote it.",
  balanced:
    "More of your wording is rewritten for the job. Every fact you wrote still stays exactly as you wrote it.",
  aggressive:
    "A fuller rewrite that may also go a little past what you wrote: it can state a number of years you have evidence for one year higher when the job asks for that figure, and name technologies the job asks for — including ones named only in the qualifications — when your own experience makes them credible. Every one of those lines is shown to you to confirm before the resume can be used.",
};

export const STRONG_REWRITE_WARNING =
  "This choice can write lines that go a little past what you wrote, to get you the first interview: a number of years you have evidence for can be stated one year higher when the job asks for that figure, and technologies the job asks for can appear when your saved experience makes them credible — including technologies named only in the qualifications. Those technologies are added to your skills section too. Every one of those lines and skills is marked, counted in the draft notes, and cannot be used until you confirm it yourself — the interview is where you prove each one. Aggressive resumes still need your approval; sending follows your Applying choice.";
