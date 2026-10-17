import { buildValuePreview } from "@nestor/ai-providers";
import type {
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
} from "@nestor/contracts";

import {
  isObject,
  stripImportFormatting,
  splitImportedSkills,
  toCandidateListValues,
  toStringArray,
} from "./resume-import-common";
import { canonicalizeRecordDateText } from "./resume-record-identity";
import { normalizeText } from "./shared";
import {
  importedRoleWordPattern as roleWordPattern,
  splitRoleTitleAndEmployer,
} from "./resume-role-title";

const headingPattern =
  /^(?:(?:work|professional|relevant|employment|career)(?: work)? (?:experience|history|background)|experience|employment|education(?: and training)?|(?:technical|core|key|additional) skills|skills|projects?|project experience|certifications?|certificates?|languages?|language skills|(?:career )?objective|target roles|(?:work|employment) preferences|(?:extracurricular )?activities|extracurricular|volunteer(?:ing| experience)?|summary|profile|about me|references|disclaimer)\s*[:–—-]?$/i;
const activityPattern =
  /^(?:(?:extracurricular )?activities|extracurricular|volunteer(?:ing| experience)?)\s*[:–—-]?$/i;
const proficiencyPattern =
  /^(?:native|mother tongue|fluent|bilingual|conversational|basic|beginner|intermediate|advanced|elementary|professional|limited|working|full professional|[ABC][12])\b/i;

export function splitImportedRole(
  value: string,
  companyName: string | null = null,
  bundle?: ResumeDocumentBundle,
): { title: string; companyName: string | null } {
  const lines = sourceLines(bundle);
  const sourceCompanyLine = lines.find((line, index) => {
    if (!containsValue(line.text, value)) return false;
    const next = lines[index + 1]?.text ?? "";
    return (
      Boolean(next) &&
      !headingPattern.test(next) &&
      !/^(?:[-*•]|<.*DATE)|\b(?:19|20)\d{2}\b/i.test(next) &&
      !roleWordPattern.test(next)
    );
  });
  const sourceCompany = sourceCompanyLine
    ? (lines[lines.indexOf(sourceCompanyLine) + 1]?.text ?? null)
    : null;
  const split = splitRoleTitleAndEmployer(
    value,
    Boolean(companyName || sourceCompany),
  );
  return {
    ...split,
    companyName: split.companyName || companyName || sourceCompany,
  };
}

export function isImportedLocationLine(value: string): boolean {
  return (
    !roleWordPattern.test(value) &&
    /^(?:remote|hybrid|on-?site|[\p{L}][\p{L}\s.'’-]+(?:,\s*[\p{L}][\p{L}\s.'’-]+){1,2})$/iu.test(
      value.trim(),
    )
  );
}

type SourceLine = {
  text: string;
  section: string;
  blockId: string;
  chrome: boolean;
};

function sourceLines(bundle?: ResumeDocumentBundle): SourceLine[] {
  if (!bundle) return [];
  const blocks = [...bundle.blocks].sort(
    (a, b) => a.readingOrder - b.readingOrder,
  );
  const pageEdges = new Map<string, Set<number>>();
  for (const page of new Set(blocks.map((block) => block.pageNumber))) {
    const pageLines = blocks
      .filter((block) => block.pageNumber === page)
      .flatMap((block) => block.text.split(/\r?\n/))
      .filter((line) => line.trim());
    for (const line of [...pageLines.slice(0, 2), ...pageLines.slice(-2)]) {
      const key = normalizeText(line.replace(/\b\d+\b/g, "#"));
      const pages = pageEdges.get(key) ?? new Set<number>();
      pages.add(page);
      pageEdges.set(key, pages);
    }
  }
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    if (
      block &&
      next &&
      /\p{L}-\s*$/u.test(block.text) &&
      /^\s*\p{Ll}/u.test(next.text)
    ) {
      blocks[index] = {
        ...block,
        text: block.text.replace(/-\s*$/, "") + next.text.trimStart(),
      };
      blocks[index + 1] = { ...next, text: "" };
    }
  }
  let section = "header";
  return blocks
    .flatMap((block) =>
      block.text
        .replace(/(\p{L})-\s*\r?\n\s*(?=\p{Ll})/gu, "$1")
        .split(/\r?\n/)
        .map((raw) => {
          const text = stripImportFormatting(raw);
          if (headingPattern.test(text))
            section = text
              .toLowerCase()
              .replace(/[:–—-]+$/, "")
              .trim();
          const key = normalizeText(text.replace(/\b\d+\b/g, "#"));
          const chrome =
            !headingPattern.test(text) &&
            ((pageEdges.get(key)?.size ?? 0) > 1 ||
              /^(?:page\s+\d+(?:\s+of\s+\d+)?|disclaimer\s*:|©|copyright\b)/i.test(
                text,
              ));
          return { text, section, blockId: block.id, chrome };
        }),
    )
    .filter((line) => line.text);
}

function containsValue(line: string, value: string): boolean {
  const normalized = normalizeText(value);
  return (
    normalized.length > 0 &&
    ` ${normalizeText(line)} `.includes(` ${normalized} `)
  );
}

function onlyInActivities(value: string, lines: SourceLine[]): boolean {
  const matches = lines.filter((line) => containsValue(line.text, value));
  return (
    matches.length > 0 &&
    matches.every((line) => activityPattern.test(line.section))
  );
}

function objectiveRolesFromSource(lines: SourceLine[]) {
  return lines
    .filter(
      (line) =>
        (/objective$|target roles$/.test(line.section) ||
          /\b(?:seeking|looking for|target(?:ing)? roles?)\b/i.test(
            line.text,
          )) &&
        !headingPattern.test(line.text),
    )
    .flatMap((line) => {
      const match = line.text.match(
        /(?:seeking|looking for|objective:)\s+(?:an?\s+)?(.+?)(?:\s+(?:roles?|positions?|jobs?|with|where|at)\b|[.!]|$)/i,
      );
      const role = (match?.[1] ?? line.text).trim().replace(/[.!]+$/, "");
      return role
        .split(/\s+(?:or|and)\s+|\s*[/;]\s*/)
        .flatMap((entry) =>
          entry.length <= 80 && roleWordPattern.test(entry)
            ? [{ role: entry.trim(), line }]
            : [],
        );
    });
}

function statedHeaderTitle(lines: SourceLine[]): SourceLine | undefined {
  const header = lines.filter(
    (line) => line.section === "header" && !headingPattern.test(line.text),
  );
  const isTitle = (line: SourceLine) =>
    line.text.length <= 80 &&
    !/@|(?:https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|io)\b)|^\+?[\d(]|^address:/i.test(
      line.text,
    ) &&
    !isImportedLocationLine(line.text) &&
    !/,.*\d/.test(line.text) &&
    line.text.split(/\s+/).length <= 10 &&
    /\p{L}/u.test(line.text);
  const role = header.find(
    (line) => isTitle(line) && roleWordPattern.test(line.text),
  );
  // A short identity directly under the name can also be a headline, such as
  // a student's field of study. Later contact lines are not title candidates.
  const identity = header[1];
  return role ?? (identity && isTitle(identity) ? identity : undefined);
}

function mostRecentSourceRole(
  lines: SourceLine[],
  candidates: readonly ResumeImportFieldCandidate[],
  bundle?: ResumeDocumentBundle,
) {
  return candidates
    .filter(
      (candidate) =>
        candidate.target.section === "experience" && isObject(candidate.value),
    )
    .flatMap((candidate) => {
      const checked = validateResumeImportSourceCandidate(
        candidate,
        bundle,
        candidates,
      );
      if (checked.reject || checked.review) return [];
      candidate = checked.candidate;
      if (
        !isObject(candidate.value) ||
        typeof candidate.value.title !== "string"
      )
        return [];
      const role = candidate.value.title;
      const current = candidate.value.isCurrent === true;
      const start =
        typeof candidate.value.startDate === "string"
          ? candidate.value.startDate
          : "";
      const end =
        typeof candidate.value.endDate === "string"
          ? candidate.value.endDate
          : "";
      const date = current ? start || end : end || start;
      const line = lines.find(
        (line) =>
          /(?:experience|employment|history|background)$/.test(line.section) &&
          !headingPattern.test(line.text) &&
          containsValue(line.text, role),
      );
      return line
        ? [
            {
              role,
              line,
              current,
              date: /^(?:19|20)\d{2}(?:-\d{2})?$/.test(date) ? date : "",
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        right.date.localeCompare(left.date),
    )[0];
}

function sourceIdentifiesLocation(
  title: string,
  lines: SourceLine[],
  records: readonly ResumeImportFieldCandidate[],
): boolean {
  const exact = (line: string) => normalizeText(line) === normalizeText(title);
  const identifiedContactLocation = records.some(
    (record) =>
      record.target.section === "location" &&
      record.target.key === "currentLocation" &&
      typeof record.value === "string" &&
      exact(record.value),
  );
  if (
    lines.some(
      (line, index) =>
        line.section === "header" &&
        line.text.split(/[|·]/).some((part) => exact(part.trim())) &&
        (identifiedContactLocation ||
          (lines[index + 1]?.section === "header" &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lines[index + 1]?.text ?? "") &&
            !lines.some(
              (entry) => entry.section !== "header" && exact(entry.text),
            ))),
    )
  )
    return true;
  return lines.some((line, index) => {
    if (!exact(line.text)) return false;
    const previous = lines[index - 1]?.text ?? "";
    if (headingPattern.test(previous) || /^[-*•]/.test(previous)) return false;
    return (
      roleWordPattern.test(previous) ||
      Boolean(splitRoleTitleAndEmployer(previous).companyName) ||
      records.some(
        (record) =>
          record.target.section === "experience" &&
          isObject(record.value) &&
          typeof record.value.title === "string" &&
          !exact(record.value.title) &&
          containsValue(previous, record.value.title),
      )
    );
  });
}

function onlyInSection(
  value: string,
  lines: SourceLine[],
  section: RegExp,
): boolean {
  const matches = lines.filter((line) => containsValue(line.text, value));
  return (
    matches.length > 0 && matches.every((line) => section.test(line.section))
  );
}

const dateToken = String.raw`(?:\d{4}-\d{2}(?:-\d{2})?|\d{1,2}/(?:\d{1,2}/)?\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}|(?:19|20)\d{2})`;
const sourceDateRange = new RegExp(
  `(${dateToken})\\s*[-–—]\\s*(${dateToken}|present|current|ongoing)`,
  "i",
);

/** Match the source entry before repairing its dates or location. */
function groundSourceRecord(
  value: { [key: string]: ResumeImportFieldCandidate["value"] },
  section: string,
  lines: SourceLine[],
): { [key: string]: ResumeImportFieldCandidate["value"] } {
  const identityKey = section === "experience" ? "companyName" : "schoolName";
  const titleKey = section === "experience" ? "title" : "degree";
  const identity =
    typeof value[identityKey] === "string" ? String(value[identityKey]) : "";
  const title =
    typeof value[titleKey] === "string" ? String(value[titleKey]) : "";
  const sectionPattern =
    section === "experience"
      ? /(?:experience|employment|history|background)$/
      : /education/;
  const matches = lines
    .flatMap((line, index) => {
      if (
        !sectionPattern.test(line.section) ||
        headingPattern.test(line.text) ||
        /^[-•]/.test(line.text)
      )
        return [];
      const identityMatch =
        identity &&
        containsValue(line.text, identity.split(",")[0] ?? identity);
      const titleMatch = title && containsValue(line.text, title);
      const nearbyRange = lines
        .slice(index, index + 3)
        .map((entry) => entry.text.match(sourceDateRange))
        .find(Boolean);
      const sourceStart = canonicalizeRecordDateText(nearbyRange?.[1]);
      const candidateStart = canonicalizeRecordDateText(value.startDate);
      const matchingStart =
        sourceStart &&
        candidateStart &&
        sourceStart.slice(0, 4) === candidateStart.slice(0, 4);
      if (
        (!identityMatch && !titleMatch) ||
        (section === "education" && identity && !identityMatch)
      )
        return [];
      return [
        {
          line,
          index,
          score:
            Number(Boolean(matchingStart)) * 4 +
            Number(Boolean(identityMatch)) * 2 +
            Number(Boolean(titleMatch)) * 3 +
            Number(
              Boolean(
                titleMatch &&
                identity &&
                lines
                  .slice(Math.max(0, index - 1), index + 3)
                  .some((entry) =>
                    containsValue(
                      entry.text,
                      identity.split(",")[0] ?? identity,
                    ),
                  ),
              ),
            ) *
              3,
        },
      ];
    })
    .sort((left, right) => right.score - left.score);
  const match = matches[0];
  if (section === "experience" && isImportedLocationLine(title)) return value;
  if (
    !match ||
    (matches[1]?.score === match.score &&
      matches[1].line.text !== match.line.text &&
      !identity)
  )
    return value;
  const nearby = lines
    .slice(match.index, match.index + 3)
    .filter(
      (line) =>
        sectionPattern.test(line.section) &&
        !headingPattern.test(line.text) &&
        !/^[-•]/.test(line.text),
    );
  const ownLines = [
    match.line,
    ...nearby.filter((line) => line !== match.line),
  ];
  const rangeLine = ownLines.find((line) => sourceDateRange.test(line.text));
  const range = rangeLine?.text.match(sourceDateRange);
  const result = { ...value };
  if (range) {
    result.startDate = canonicalizeRecordDateText(range[1]);
    result.isCurrent = /^(present|current|ongoing)$/i.test(range[2] ?? "");
    result.endDate = result.isCurrent
      ? null
      : canonicalizeRecordDateText(range[2]);
    if (section === "education") delete result.isCurrent;
  } else if (section === "education") {
    const graduation = ownLines
      .find((line) => /(?:19|20)\d{2}/.test(line.text))
      ?.text.match(/\b((?:19|20)\d{2})\b/);
    if (graduation) {
      result.startDate = null;
      result.endDate = graduation[1] ?? null;
    }
  }
  if (section === "experience" && identity) {
    const employerLine = ownLines.find(
      (line) =>
        containsValue(line.text, identity) ||
        (identity.includes(",") &&
          containsValue(line.text, identity.split(",")[0] ?? "")),
    );
    if (employerLine) {
      let employerText =
        employerLine.text
          .replace(sourceDateRange, "")
          .split(/\s*[|·]\s*/)
          .find((part) => containsValue(part, identity.split(",")[0] ?? ""))
          ?.trim() ?? "";
      const employerStart = employerText
        .toLowerCase()
        .indexOf((identity.split(",")[0] ?? identity).toLowerCase());
      if (employerStart > 0) employerText = employerText.slice(employerStart);
      const parts = employerText.split(",").map((part) => part.trim());
      const location = parts.slice(1).join(", ");
      if (parts.length >= 3 && isImportedLocationLine(location)) {
        result.companyName = parts[0] ?? null;
        result.location = location;
      } else {
        const roleLocation = ownLines.find(
          (line) =>
            isImportedLocationLine(line.text) &&
            !containsValue(line.text, identity),
        );
        if (roleLocation) result.location = roleLocation.text;
        else if (
          typeof value.location === "string" &&
          lines.some(
            (line) =>
              line.section === "header" &&
              containsValue(
                line.text,
                typeof value.location === "string" ? value.location : "",
              ),
          )
        )
          result.location = null;
      }
    }
  }
  if (section === "education") {
    const inline = match.line.text.match(
      /^([^,]+),\s*([^,]+)(?:,\s*([^,]+))?,\s*((?:19|20)\d{2})$/,
    );
    if (inline) {
      const qualification = (inline[1] ?? "").match(/^(.+?)\s+in\s+(.+)$/i);
      result.schoolName = inline[2] ?? null;
      result.degree = qualification?.[1] ?? inline[1] ?? null;
      result.fieldOfStudy = qualification?.[2] ?? null;
      result.location = inline[3] ?? null;
    }
  }
  return result;
}

/** Validate every extraction branch against source structure before auto-apply. */
export function validateResumeImportSourceCandidate(
  candidate: ResumeImportFieldCandidate,
  bundle?: ResumeDocumentBundle,
  recordCandidates: readonly ResumeImportFieldCandidate[] = [],
): { candidate: ResumeImportFieldCandidate; reject: boolean; review: boolean } {
  const lines = sourceLines(bundle);
  let value = candidate.value;
  let reject = false;
  let review = false;
  const section = candidate.target.section;
  const key = candidate.target.key;
  const sourceSkills = lines
    .filter(
      (line) => /skills$/.test(line.section) && !headingPattern.test(line.text),
    )
    .flatMap((line) =>
      splitImportedSkills(
        line.text.replace(/^(?:tools|core|technical skills)\s*:\s*/i, ""),
      ),
    )
    .map((entry) => entry.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  const wrappedSkills = Array.from(
    (
      bundle?.fullText ??
      bundle?.blocks.map((block) => block.text).join("\n") ??
      ""
    ).matchAll(/(\p{L}+)-\s*\r?\n\s*(\p{Ll}+)/gu),
    (match) => `${match[1]}${match[2]}`.toLowerCase(),
  );
  const validSkill = (skill: string) => {
    if (headingPattern.test(skill) || /[()]/.test(skill)) return false;
    if (onlyInSection(skill, lines, /languages?$|language skills$/))
      return false;
    const normalized = normalizeText(skill);
    if (sourceSkills.some((item) => normalizeText(item) === normalized))
      return true;
    // Reject parts of a source word broken by a soft line break, without
    // treating substrings of unrelated skills as fragments.
    if (wrappedSkills.some((entry) => entry.includes(skill.toLowerCase())))
      return false;
    return !sourceSkills.some(
      (item) =>
        normalizeText(item) !== normalized &&
        item.split(/\s+/).length <= 4 &&
        !/[()\d]/.test(item) &&
        !/\b(?:and|or|with|in|using|including)\b/i.test(item) &&
        containsValue(item, skill),
    );
  };

  if (
    section === "identity" &&
    key === "yearsExperience" &&
    value === 0 &&
    !/\b0\s+years?\b/i.test(bundle?.fullText ?? "")
  ) {
    // A default numeric zero is not evidence that the person has no work.
    value = null;
    review = true;
  }
  if (section === "skill") {
    const skills = toStringArray(value)
      .flatMap(splitImportedSkills)
      .filter(validSkill);
    reject = skills.length === 0;
    value =
      typeof value === "string" && skills.length === 1
        ? (skills[0] ?? "")
        : skills;
  }
  if (section === "experience" && isObject(value)) {
    value = groundSourceRecord(value, section, lines);
    const title = typeof value.title === "string" ? value.title : "";
    const split = splitImportedRole(
      title,
      typeof value.companyName === "string" ? value.companyName : null,
      bundle,
    );
    const hasEmployer = Boolean(value.companyName || split.companyName);
    const hasDates =
      value.isCurrent === true ||
      [value.startDate, value.endDate].some(
        (date) => typeof date === "string" && date.trim().length > 0,
      );
    const locationShape = isImportedLocationLine(title);
    const locationEvidence =
      locationShape &&
      ((!hasEmployer && !hasDates) ||
        sourceIdentifiesLocation(title, lines, recordCandidates));
    review = locationShape && !locationEvidence && (!hasEmployer || !hasDates);
    value = {
      ...value,
      title: split.title,
      companyName: value.companyName || split.companyName,
      skills: toStringArray(value.skills)
        .flatMap(splitImportedSkills)
        .filter(validSkill),
    };
    const activityEvidence =
      candidate.visualEvidence?.some((entry) =>
        activityPattern.test(
          (entry.regionHint ?? "").replace(/\s+section\b.*$/i, ""),
        ),
      ) ?? false;
    reject =
      !/\p{L}/u.test(title) ||
      locationEvidence ||
      headingPattern.test(title) ||
      onlyInActivities(title, lines) ||
      activityEvidence;
  }
  if (
    section === "identity" &&
    key === "headline" &&
    typeof value === "string"
  ) {
    const invalidHeadline = (headline: string) =>
      onlyInActivities(headline, lines) ||
      isImportedLocationLine(headline) ||
      headingPattern.test(headline);
    reject = invalidHeadline(value);
    value = splitImportedRole(value, null, bundle).title;
    const title = value;
    const derivedFromRole = lines.some(
      (line) =>
        /(?:experience|employment|history|background)$/.test(line.section) &&
        containsValue(line.text, title),
    );
    const statedHeadline = lines.some(
      (line) =>
        line.section === "header" &&
        normalizeText(line.text) === normalizeText(title),
    );
    const header = statedHeaderTitle(lines);
    if (!reject && !statedHeadline && (header || derivedFromRole)) {
      const preferred = header
        ? { role: header.text, line: header }
        : (objectiveRolesFromSource(lines)[0] ??
          mostRecentSourceRole(lines, recordCandidates, bundle));
      if (preferred && !invalidHeadline(preferred.role)) {
        value = preferred.role;
        candidate = {
          ...candidate,
          evidenceText: preferred.line.text,
          sourceBlockIds: [preferred.line.blockId],
        };
      }
    }
    reject ||= !/\p{L}/u.test(String(value));
  }

  if (section === "search_preferences" && key === "targetRoles") {
    const objectives = objectiveRolesFromSource(lines);
    const objectiveLines = objectives.map((entry) => entry.line);
    const objectiveRoles = objectives.map((entry) => entry.role);
    const headerRole = statedHeaderTitle(lines);
    value =
      objectiveRoles.length > 0
        ? objectiveRoles
        : headerRole
          ? [headerRole.text]
          : toCandidateListValues(candidate)
              .filter(
                (role) =>
                  /\p{L}/u.test(role) &&
                  !onlyInActivities(role, lines) &&
                  !isImportedLocationLine(role) &&
                  !headingPattern.test(role),
              )
              .map((role) => splitImportedRole(role, null, bundle).title);
    if (objectiveRoles.length > 0)
      candidate = {
        ...candidate,
        evidenceText: objectiveLines.map((line) => line.text).join(" "),
        sourceBlockIds: objectiveLines.map((line) => line.blockId),
      };
    reject = value.length === 0;
  }

  if (
    section === "location" &&
    key === "currentLocation" &&
    typeof value === "string"
  ) {
    const current = value;
    const complete = lines
      .filter((line) => line.section === "header")
      .flatMap((line) => line.text.split(/[|·]/).map((entry) => entry.trim()))
      .find(
        (line) =>
          line.split(",").length === 3 &&
          isImportedLocationLine(line) &&
          containsValue(line, current),
      );
    if (complete) value = complete;
  }
  if (section === "language" && isObject(value)) {
    const language =
      typeof value.language === "string" ? value.language.trim() : "";
    const matchingLines = lines.filter((line) =>
      containsValue(line.text, language),
    );
    reject =
      headingPattern.test(language) ||
      /^(?:page\b|disclaimer\b|copyright\b|©)/i.test(language) ||
      language.length > 40 ||
      language.split(/\s+/).length > 4 ||
      /[\d$€£]/.test(language) ||
      (matchingLines.length > 0 &&
        matchingLines.every(
          (line) =>
            line.chrome ||
            /preferences|disclaimer|references/.test(line.section),
        ));
    review =
      !reject &&
      (typeof value.proficiency !== "string" ||
        !proficiencyPattern.test(value.proficiency));
  }
  if (section === "education" && isObject(value)) {
    value = groundSourceRecord(value, section, lines);
    const school = typeof value.schoolName === "string" ? value.schoolName : "";
    const evidence = normalizeText(candidate.evidenceText ?? "");
    const schoolIndex = school ? evidence.indexOf(normalizeText(school)) : -1;
    const qualificationEvidence =
      schoolIndex > 0 ? evidence.slice(0, schoolIndex).trim() : "";
    const unsupportedQualification =
      /\p{L}/u.test(qualificationEvidence) &&
      [value.degree, value.fieldOfStudy].some(
        (field) =>
          typeof field === "string" &&
          field.trim() &&
          !containsValue(candidate.evidenceText ?? "", field),
      );
    review =
      unsupportedQualification ||
      (!value.degree &&
        !value.fieldOfStudy &&
        !value.startDate &&
        !value.endDate) ||
      /\b(?:degree|bachelor|master|associate|diploma)\b|\b(?:19|20)\d{2}\b/i.test(
        school,
      );
  }
  if (
    (section === "project" || section === "certification") &&
    isObject(value)
  ) {
    const name = typeof value.name === "string" ? value.name : "";
    review =
      name.length > 100 ||
      /https?:\/\/|\n|\b(?:technologies|tools|skills)\s*:/i.test(name);
  }
  if (
    (section === "project" ||
      section === "certification" ||
      section === "education") &&
    typeof value === "string"
  ) {
    // Raw section text is not one record. Keep it available for review.
    review = true;
  }
  return {
    candidate: {
      ...candidate,
      value,
      normalizedValue: value,
      valuePreview: buildValuePreview(value),
    },
    reject,
    review,
  };
}
