import {
  CandidateExperienceSchema,
  createFreshStartCandidateProfile,
  type CandidateProfile,
} from "@nestor/contracts";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "March 2021" as "2021-03"; anything else is kept as written. */
function isoMonth(value: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{4})$/u.exec(value.trim());
  if (!match) return /^\d{4}$/u.test(value.trim()) ? value.trim() : null;
  const month = MONTHS.indexOf(match[1]!.toLowerCase());
  return month < 0 ? null : `${match[2]}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * The profile import would build from one of the persona resumes. Their
 * plain layout (name, headline, contact line, SUMMARY, EXPERIENCE with
 * "Title - Company", a date line and bullets, SKILLS) is read directly, so
 * the lane measures writing rather than import.
 */
export function profileFromResumeText(
  persona: string,
  text: string,
  now: string,
): CandidateProfile {
  const lines = text.split(/\r?\n/u).map((line) => line.trimEnd());
  const [name = "", headline = "", contact = ""] = lines;
  const [email = null, location = null] = contact
    .split("|")
    .map((part) => part.trim());
  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of lines.slice(3)) {
    if (/^[A-Z][A-Z &]+$/u.test(line.trim())) {
      current = line.trim();
      sections.set(current, []);
    } else if (current && line.trim()) sections.get(current)!.push(line.trim());
  }
  const experiences: CandidateProfile["experiences"] = [];
  for (const line of sections.get("EXPERIENCE") ?? []) {
    if (line.startsWith("- ")) {
      experiences.at(-1)?.achievements.push(line.slice(2));
    } else if (/\d{4}/u.test(line) && experiences.at(-1)?.startDate === null) {
      const [start = "", end = ""] = line.split(/\s*[-–]\s*/u);
      const record = experiences.at(-1)!;
      record.startDate = isoMonth(start);
      record.isCurrent = /present/iu.test(end);
      record.endDate = record.isCurrent ? null : isoMonth(end);
    } else {
      const [title, company] = line.split(/\s+-\s+/u);
      experiences.push(
        CandidateExperienceSchema.parse({
          id: `${persona}_experience_${experiences.length + 1}`,
          title: title ?? null,
          companyName: company ?? null,
        }),
      );
    }
  }
  const words = name
    .split(/\s+/u)
    .map((word) => word[0] + word.slice(1).toLowerCase());
  const startYears = experiences
    .map((record) => Number(record.startDate?.slice(0, 4)))
    .filter((year) => year > 0);
  const fresh = createFreshStartCandidateProfile();
  return {
    ...fresh,
    id: `candidate_${persona}`,
    firstName: words[0] ?? null,
    lastName: words.at(-1) ?? null,
    fullName: words.join(" "),
    headline,
    summary: (sections.get("SUMMARY") ?? []).join(" ") || null,
    email,
    currentLocation: location,
    yearsExperience: startYears.length
      ? new Date(now).getUTCFullYear() - Math.min(...startYears)
      : null,
    skills: (sections.get("SKILLS") ?? [])
      .join(", ")
      .split(/\s*,\s*/u)
      .filter(Boolean),
    experiences,
    baseResume: {
      ...fresh.baseResume,
      id: `resume_${persona}`,
      fileName: `${persona}.txt`,
      uploadedAt: now,
      storagePath: `/synthetic/${persona}.txt`,
      textContent: text,
      textUpdatedAt: now,
      extractionStatus: "ready",
      lastAnalyzedAt: now,
    },
  };
}
