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
      "A fuller rewrite that stretches toward the job to get you the first interview: it can use a close job title, add adjacent tools and languages the job asks for when your background makes them credible (including ones named only in the qualifications), and frame your real work in the job's words. It keeps your employers, dates, degrees, certifications and real roles, and it will not move you into a different profession or invent leadership or licensed duties. Read the draft before you approve it; what you send is your call.",
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
    "A fuller rewrite that stretches toward the job to get you the first interview: it can use a close job title, add adjacent tools and languages the job asks for when your background makes them credible (including ones named only in the qualifications), and frame your real work in the job's words. It keeps your employers, dates, degrees, certifications and real roles, and it will not move you into a different profession or invent leadership or licensed duties. Read the draft before you approve it; what you send is your call.",
};

export const STRONG_REWRITE_WARNING =
  "This choice can write lines that go past what you wrote, to get you the first interview: a close job title, adjacent tools and languages the job asks for when your saved experience makes them credible (including ones named only in the qualifications), and your real work in the job's words. It keeps your employers, dates, degrees, certifications and real roles, and it will not move you into a different profession or invent leadership or licensed duties. Read the draft before you approve it: you decide what to keep, and the interview is where you prove each line. Aggressive resumes still need your approval; sending follows your Applying choice.";
