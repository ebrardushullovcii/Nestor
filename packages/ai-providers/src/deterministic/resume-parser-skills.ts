import { looksLikeSpokenLanguageSkillEntry } from "./resume-skill-grounding";
import {
  knownSkillPhrases,
  knownSoftSkillPhrases,
  skillCategoryHeadingPattern,
  skillSectionAliases,
} from "./constants";
import {
  cleanLine,
  findSectionBodyLinesByAliases,
  splitLines,
  uniqueStrings,
} from "./utils";

function inferKnownPhrases(text: string, phrases: readonly string[]): string[] {
  return uniqueStrings(
    phrases.filter((phrase) => containsPhrase(text, phrase)),
  );
}

function containsPhrase(text: string, phrase: string): boolean {
  const escapedPhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9])${escapedPhrase}(?=$|[^A-Za-z0-9])`,
    "i",
  ).test(text);
}

export function inferSkills(
  resumeText: string,
  fallbackSkills: readonly string[],
): string[] {
  const sectionLines = findSectionBodyLinesByAliases(
    splitLines(repairWrappedSkills(resumeText)),
    skillSectionAliases,
  );
  const sectionSkills = uniqueStrings(
    sectionLines
      .filter((line) => !skillCategoryHeadingPattern.test(line))
      .flatMap(splitSkillLine),
  );

  if (sectionSkills.length > 0) {
    return sectionSkills;
  }

  const extractedSkills = knownSkillPhrases.filter((skill) =>
    containsPhrase(resumeText, skill),
  );
  const nonNestedExtracted = extractedSkills.filter(
    (skill) =>
      !extractedSkills.some(
        (other) =>
          other !== skill && other.toLowerCase().includes(skill.toLowerCase()),
      ),
  );
  return nonNestedExtracted.length > 0
    ? uniqueStrings(nonNestedExtracted)
    : uniqueStrings(fallbackSkills);
}

function stripInlineSkillCategory(line: string): string {
  return line.replace(
    /^(?:core(?: skills)?|technical skills|frameworks|programming languages|languages|databases|tools|security(?:\s*&\s*authentication)?|soft skills)\s*:\s*/i,
    "",
  );
}

function repairWrappedSkills(text: string): string {
  return text.replace(
    /([\p{L}]+)\r?\n(?=([\p{L}]+)\b)/gu,
    (match, left: string, right: string) =>
      knownSkillPhrases.some(
        (skill) => skill.toLowerCase() === `${left}${right}`.toLowerCase(),
      )
        ? left
        : match,
  );
}

function splitSkillLine(line: string): string[] {
  line = stripInlineSkillCategory(line);
  // Remove complete spoken-language entries before parentheses are expanded;
  // otherwise "English (fluent)" becomes two unrelated skills.
  line = line
    .split(/[,;|](?![^()]*\))/)
    .filter((entry) => !looksLikeSpokenLanguageSkillEntry(entry.trim()))
    .join(", ");
  line = line.replace(/([^(),;|]+)\(([^()]*)\)/g, "$1, $2");
  const rawEntries = line
    .split(/[,;]|\||[\u2022\u25cf\u25aa\u25e6\u2023]| {2,}/)
    .map(cleanLine)
    .filter((entry) => entry.length >= 2)
    .filter((entry) => !looksLikeSpokenLanguageSkillEntry(entry));

  return uniqueStrings(
    rawEntries.flatMap((entry) => {
      const isListItem =
        entry.split(/\s+/).length <= 4 &&
        !/\b(?:and|or|with|in|using|including)\b/i.test(entry) &&
        !/^(?:proficient in|experience with|familiar with)\b/i.test(entry);
      if (isListItem) return [entry];
      const matches = inferKnownPhrases(entry, knownSkillPhrases).sort(
        (left, right) =>
          entry.toLowerCase().indexOf(left.toLowerCase()) -
          entry.toLowerCase().indexOf(right.toLowerCase()),
      );
      const known = matches.filter(
        (skill) =>
          !matches.some(
            (other) =>
              other !== skill &&
              other.toLowerCase().includes(skill.toLowerCase()),
          ),
      );
      // "Health and Safety" names one skill; with no known skill inside,
      // a short entry stays whole instead of disappearing.
      if (known.length === 0 && entry.split(/\s+/).length <= 6) {
        return [entry];
      }
      return known;
    }),
  );
}

export function inferSkillGroups(
  resumeText: string,
  fallbackSkills: readonly string[],
) {
  const sectionLines = findSectionBodyLinesByAliases(
    splitLines(repairWrappedSkills(resumeText)),
    skillSectionAliases,
  );
  const groups = {
    coreSkills: [] as string[],
    tools: [] as string[],
    languagesAndFrameworks: [] as string[],
    softSkills: [] as string[],
    highlightedSkills: [] as string[],
  };
  let activeGroup: keyof typeof groups = "coreSkills";

  for (const line of sectionLines) {
    if (/^(frameworks|programming languages|languages)$/i.test(line)) {
      activeGroup = "languagesAndFrameworks";
      continue;
    }

    if (/^(databases|tools|security(?:\s*&\s*authentication)?)$/i.test(line)) {
      activeGroup = "tools";
      continue;
    }

    if (/^soft skills$/i.test(line)) {
      activeGroup = "softSkills";
      continue;
    }

    if (skillCategoryHeadingPattern.test(line)) {
      continue;
    }

    if (activeGroup === "softSkills") {
      groups.softSkills.push(...inferKnownPhrases(line, knownSoftSkillPhrases));
      continue;
    }

    groups[activeGroup].push(...splitSkillLine(line));
  }

  const allSkills = inferSkills(resumeText, fallbackSkills);

  return {
    coreSkills: uniqueStrings(
      groups.coreSkills.length > 0 ? groups.coreSkills : allSkills.slice(0, 8),
    ),
    tools: uniqueStrings(groups.tools),
    languagesAndFrameworks: uniqueStrings(groups.languagesAndFrameworks),
    softSkills: uniqueStrings(groups.softSkills),
    highlightedSkills: uniqueStrings([
      ...groups.coreSkills.slice(0, 4),
      ...groups.languagesAndFrameworks.slice(0, 4),
      ...allSkills.slice(0, 4),
    ]).slice(0, 8),
  };
}
