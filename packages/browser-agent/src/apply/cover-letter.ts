import { applicationFacts } from "./application-facts";
import type {
  CandidateProfile,
  CoverLetterPreference,
} from "@nestor/contracts";

import { normalizeSignal } from "./control-classification";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

/**
 * The letter that goes with an application.
 *
 * One application gets one letter. A form that asks for it as a file and a
 * form that asks for it in a box are the same request, and the person should
 * never end up having sent two different letters for the same job.
 *
 * Candidate claims must come from the outgoing resume and profile. The
 * posting supplies employer and role context, not candidate experience.
 * The preference shapes how the letter reads; it never adds a fact.
 */

/** True when this control is asking for the letter itself. */
export function isCoverLetterControl(control: ApplyFormControl): boolean {
  if (control.questionKind === "cover_letter") {
    return true;
  }
  // A file field beside a resume field that is not the resume is usually this.
  return (
    control.kind === "file" &&
    /\b(letter|motivation)\b/u.test(
      normalizeSignal(`${control.groupLabel} ${control.label}`),
    )
  );
}

/** Whether the saved applying preference allows this exact letter field. */
export function coverLetterPolicyAllows(
  control: ApplyFormControl,
  policy: "never" | "when_required" | "when_possible",
): boolean {
  if (policy === "never") return false;
  return policy === "when_possible" || control.required;
}

/** Whether the form wants the letter as a file or typed into a box. */
export function coverLetterDeliveryFor(
  control: ApplyFormControl,
): "file" | "text" {
  return control.kind === "file" ? "file" : "text";
}

/**
 * The file type a form insists on, when it says so.
 *
 * Read from the words around the field. A form that names one type and only
 * one is taken at its word; a form that lists several, or none, leaves the
 * choice open.
 */
export function requiredLetterFileType(
  control: ApplyFormControl,
): "pdf" | "docx" | null {
  const signal = normalizeSignal(
    `${control.groupLabel} ${control.label} ${control.placeholder}`,
  );
  const wantsPdf = /\bpdf\b/u.test(signal);
  const wantsDocx = /\b(docx|doc|word)\b/u.test(signal);
  if (wantsPdf && !wantsDocx) {
    return "pdf";
  }
  if (wantsDocx && !wantsPdf) {
    return "docx";
  }
  return null;
}

const LENGTH_GUIDANCE: Record<CoverLetterPreference["length"], string> = {
  short: "About 120 words. Three short paragraphs at most.",
  standard: "About 250 words. Roughly one page.",
  detailed: "About 400 words, still one page.",
};

const TONE_GUIDANCE: Record<CoverLetterPreference["tone"], string> = {
  plain_professional:
    "Plain and professional. No flourishes, no superlatives, no filler openings.",
  warm: "Warm and human, but still professional. Never gushing.",
  direct: "Direct and brief. Lead with the point of every paragraph.",
  formal: "Formal and measured. Full sentences, no contractions.",
};

/** What the letter is allowed to be built from, written out for the model. */
export interface CoverLetterRequest {
  /** The instruction the model is given. */
  prompt: string;
  /** What the letter is grounded in, in the person's words. */
  groundedIn: string[];
  /** The language the letter should be written in, when one was settled. */
  language: string | null;
}

/** Application-relevant profile facts, without internal storage metadata. */
export function buildApplicationProfileGrounding(
  profile: CandidateProfile,
): string {
  return `Profile facts:\n${JSON.stringify(applicationFacts({ profile, resumeText: null, posting: { title: "", company: "", location: "", description: "" }, reusableAnswers: profile.answerBank.customAnswers, documents: [] }, { payDisclosed: false }), null, 2)}`;
}

/**
 * Guesses the language of the posting from the words in it.
 *
 * Deliberately conservative: it only answers when the evidence is strong,
 * because writing a letter in the wrong language is worse than writing in the
 * language the posting was already read in.
 */
export function detectPostingLanguage(description: string): string | null {
  const text = ` ${normalizeSignal(description.slice(0, 4_000))} `;
  if (!text.trim()) {
    return null;
  }
  const markers: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["German", ["und", "wir", "sie", "eine", "fur", "mit", "bei", "das"]],
    ["French", ["et", "vous", "nous", "pour", "avec", "une", "les", "dans"]],
    ["Spanish", ["y", "usted", "para", "con", "una", "los", "las", "del"]],
    ["Dutch", ["en", "je", "voor", "met", "een", "van", "het", "wij"]],
    ["Portuguese", ["e", "voce", "para", "com", "uma", "dos", "das", "nao"]],
  ];
  let best: { language: string; hits: number } | null = null;
  for (const [language, words] of markers) {
    const hits = words.filter((word) => text.includes(` ${word} `)).length;
    if (hits >= 4 && (best === null || hits > best.hits)) {
      best = { language, hits };
    }
  }
  return best?.language ?? null;
}

export function buildCoverLetterRequest(input: {
  sources: ApplyAnswerSources;
  preference: CoverLetterPreference;
  today?: string;
}): CoverLetterRequest {
  const { sources, preference } = input;
  const language =
    preference.language ?? detectPostingLanguage(sources.posting.description);
  const resumeText =
    sources.resumeText ?? sources.profile.baseResume.textContent;

  // Review evidence is readable source facts; full writer input stays in the prompt.
  const profile = sources.profile;
  const groundedIn = [
    profile.summary ? `Profile summary: ${profile.summary}` : null,
    ...profile.experiences
      .filter((entry) => !entry.isDraft)
      .map((entry) =>
        [entry.title, entry.companyName, entry.summary, ...entry.achievements]
          .filter(Boolean)
          .map((part) => part!.replace(/[.\s]+$/u, ""))
          .join(". "),
      ),
    ...profile.proofBank.map((entry) =>
      [entry.title, entry.claim, entry.heroMetric, entry.supportingContext]
        .filter(Boolean)
        .map((part) => part!.replace(/[.\s]+$/u, ""))
        .join(". "),
    ),
    ...profile.projects.map((entry) =>
      [entry.name, entry.role, entry.summary, entry.outcome]
        .filter(Boolean)
        .map((part) => part!.replace(/[.\s]+$/u, ""))
        .join(". "),
    ),
    profile.skills.length ? `Saved skills: ${profile.skills.join(", ")}` : null,
    resumeText ? "Resume sent with this application" : null,
    `Job context: ${sources.posting.title} at ${sources.posting.company}`,
    preference.sample ? "Saved sample letter (voice only)" : null,
  ].filter((value): value is string => Boolean(value));

  const prompt = [
    `Write a cover letter for ${sources.posting.title} at ${sources.posting.company}.`,
    "",
    "Rules:",
    "- Claims about the person's skills, experience, achievements, and qualifications must be supported by their resume or profile. The posting describes the employer and role; it is not evidence of the person's experience. Do not state anything else as fact.",
    "- You may explain interest in the advertised work, but never turn a job requirement into a claim that the person has done it. Leave unsupported candidate claims out.",
    "- Use only the current saved profile name and contact details, even if the resume or sample has older or rejected details. Include the current saved email when one exists. Omit a missing contact detail; never recover it from the resume.",
    "- Compare this role’s employment type, hours and location with the person’s goals and availability. Do not repeat an incompatible generic career goal or promise hours or relocation they have not agreed to. State known material limits plainly. Do not ask the employer to accommodate incompatible hours, location or employment type unless the person has agreed to that wording for this application. If the role needs a change of intent, flag it for the person rather than claiming that change.",
    "- No invented employers, dates, numbers, qualifications, or enthusiasm for things not in the posting.",
    "- Choose two or three supported examples and explain how each meets a stated need in the posting. Do not recap the full career or skills list.",
    "- Use the role dates and today’s date for any duration. If the dates do not establish it, omit the duration.",
    `- ${TONE_GUIDANCE[preference.tone]}`,
    `- ${LENGTH_GUIDANCE[preference.length]}`,
    language
      ? `- Write it in ${language}.`
      : "- Write it in the language the posting is written in.",
    "- No placeholder text of any kind. No square brackets. If a fact is missing, leave it out rather than marking it.",
    preference.sample
      ? "- A letter the person wrote themselves is included below as an example of how they sound. Match the voice, not the content."
      : null,
    "",
    `Posting:\n${sources.posting.description.slice(0, 6_000)}`,
    "",
    resumeText
      ? `Resume going out with this application:\n${resumeText.trim().slice(0, 8_000)}`
      : null,
    "",
    `Today: ${input.today ?? new Date().toISOString().slice(0, 10)}`,
    buildApplicationProfileGrounding(sources.profile),
    sources.preferences
      ? `Saved work and location preferences:\n${JSON.stringify(sources.preferences)}`
      : null,
    preference.sample
      ? `\nTheir own letter, for voice only:\n${preference.sample.slice(0, 4_000)}`
      : null,
    "",
    "Return only the letter text.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { prompt, groundedIn, language };
}

/** Rejects text that would embarrass the person if it went out as written. */
export function looksLikeUsableLetter(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200) {
    return false;
  }
  // Anything a template would have left behind for a person to fill in.
  return !/\[[^\]]{2,40}\]|\{\{|<insert|xxxx|lorem ipsum|your name here/iu.test(
    trimmed,
  );
}
