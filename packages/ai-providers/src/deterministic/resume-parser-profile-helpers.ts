import type {
  CandidateLinkKind,
  CandidateProfile,
  JobSearchPreferences,
} from "@nestor/contracts";

import { dateRangePattern, projectSectionAliases } from "./constants";
import {
  cleanLine,
  extractAllUrls,
  extractFirstUrl,
  findSectionBodyLinesByAliases,
  isBulletLine,
  isLikelyPersonalWebsiteUrl,
  isResumeSectionHeading,
  normalizeLocationLabel,
  splitInlineBulletLine,
  splitLines,
  stripBulletPrefix,
  titleCaseWords,
  uniqueStrings,
} from "./utils";
import { inferSkills } from "./resume-parser-skills";
import { isSpokenLanguageResumeChrome } from "./resume-skill-grounding";

export function inferTimeZoneFromLocation(
  location: string | null,
): string | null {
  if (!location) {
    return null;
  }

  const normalizedLocation = location.toLowerCase();
  const knownMappings: Array<[RegExp, string]> = [
    [/prishtina|kosovo/, "Europe/Belgrade"],
    [/london|united kingdom|uk\b|england/, "Europe/London"],
    [/new york/, "America/New_York"],
    [/berlin|germany/, "Europe/Berlin"],
    [/paris|france/, "Europe/Paris"],
    [/toronto/, "America/Toronto"],
    [/zurich|switzerland/, "Europe/Zurich"],
    [/sydney|melbourne/, "Australia/Sydney"],
    [/tokyo|japan/, "Asia/Tokyo"],
    [/mumbai|delhi|bangalore|india/, "Asia/Kolkata"],
    [/sao paulo/, "America/Sao_Paulo"],
    [/singapore/, "Asia/Singapore"],
    [/hong kong/, "Asia/Hong_Kong"],
    [/dubai|uae/, "Asia/Dubai"],
    [/tel aviv|israel/, "Asia/Jerusalem"],
    [/amsterdam|netherlands/, "Europe/Amsterdam"],
    [/stockholm|sweden/, "Europe/Stockholm"],
    [/oslo|norway/, "Europe/Oslo"],
    [/copenhagen|denmark/, "Europe/Copenhagen"],
    [/helsinki|finland/, "Europe/Helsinki"],
  ];

  for (const [pattern, timeZone] of knownMappings) {
    if (pattern.test(normalizedLocation)) {
      return timeZone;
    }
  }

  return null;
}

export function inferSalaryCurrencyFromLocation(
  location: string | null,
): string | null {
  if (!location) {
    return null;
  }

  const normalizedLocation = location.toLowerCase();
  const knownMappings: Array<[RegExp, string]> = [
    [
      /prishtina|kosovo|germany|berlin|france|paris|spain|italy|netherlands|belgium|austria|portugal|finland|ireland|greece/,
      "EUR",
    ],
    [/london|united kingdom|uk\b|england/, "GBP"],
    [/switzerland|zurich|geneva/, "CHF"],
    [/toronto|canada/, "CAD"],
    [/new york|usa|united states/, "USD"],
    [/sydney|melbourne|australia/, "AUD"],
    [/tokyo|japan/, "JPY"],
    [/mumbai|delhi|bangalore|india/, "INR"],
    [/sao paulo|brazil/, "BRL"],
    [/singapore/, "SGD"],
    [/hong kong/, "HKD"],
    [/dubai|uae/, "AED"],
    [/tel aviv|israel/, "ILS"],
  ];

  for (const [pattern, currency] of knownMappings) {
    if (pattern.test(normalizedLocation)) {
      return currency;
    }
  }

  return null;
}

export function inferProfessionalSummary(
  summary: string | null,
  headline: string | null,
  skills: readonly string[],
) {
  const firstSentence =
    cleanLine(summary?.split(/(?<=[.!?])\s+/)[0] ?? "") || null;

  return {
    shortValueProposition: firstSentence,
    fullSummary: summary,
    careerThemes: uniqueStrings([headline ?? "", ...skills.slice(0, 3)]),
    leadershipSummary: null,
    domainFocusSummary: null,
    strengths: uniqueStrings(skills.slice(0, 5)),
  };
}

export function inferLinkKind(url: string): CandidateLinkKind {
  if (/linkedin\.com/i.test(url)) {
    return "linkedin";
  }

  if (/github\.com/i.test(url)) {
    return "github";
  }

  if (
    /(behance\.net|dribbble\.com|artstation\.com|adobe\.com\/portfolio)/i.test(
      url,
    )
  ) {
    return "portfolio";
  }

  if (
    /(gitlab\.com|bitbucket\.org)/i.test(url) ||
    /\/(?:repo|repository|tree|blob)\//i.test(url)
  ) {
    return "repository";
  }

  if (/\/(?:case[-_ ]study|case[-_ ]studies|work\/)/i.test(url)) {
    return "case_study";
  }

  if (/(portfolio|showcase|projects|my[-_ ]work)/i.test(url)) {
    return "portfolio";
  }

  if (/website|site/i.test(url)) {
    return "website";
  }

  return "other";
}

export function inferLinkLabel(url: string): string {
  if (/linkedin\.com/i.test(url)) {
    return "LinkedIn";
  }

  if (/github\.com/i.test(url)) {
    return "GitHub";
  }

  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Website";
  }
}

export function inferLinks(resumeText: string) {
  return extractAllUrls(resumeText).map((url) => ({
    label: inferLinkLabel(url),
    url,
    kind: inferLinkKind(url),
  }));
}

export function inferEducationEntries(resumeText: string) {
  const allLines = splitLines(resumeText);
  const section = findSectionBodyLinesByAliases(allLines, [
    "EDUCATION AND TRAINING",
    "EDUCATION",
  ]);
  // Several entries are read only inside an Education section. Without one,
  // school names elsewhere (a job at a university) are not education, so the
  // single best match over the whole text is kept, as before.
  if (section.length === 0) return inferEducationEntry(resumeText);
  const lines = section;
  const schoolPattern = /\b(?:college|university|school|institute|kolegji)\b/i;
  const degreePattern =
    /\b(?:degree|associate|bachelor|master|ph\.?d|b\.?sc|m\.?sc|diploma|bootcamp)\b/i;
  const anchors = lines.flatMap((line, index) =>
    (schoolPattern.test(line) ||
      /^([^,]+),\s*([^,]+)(?:,\s*([^,]+))?,\s*(?:19|20)\d{2}$/.test(line)) &&
    !isResumeSectionHeading(line)
      ? [index]
      : [],
  );
  const starts = anchors.map((index, position) => {
    const previous = lines[index - 1] ?? "";
    const previousAnchor = anchors[position - 1] ?? -10;
    return index - previousAnchor > 2 &&
      degreePattern.test(previous) &&
      !schoolPattern.test(previous)
      ? index - 1
      : index;
  });
  if (starts.length === 0) return inferEducationEntry(resumeText);
  return starts.flatMap((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    // A location before the first qualification belongs to it, not to the header.
    const blockStart = index === 0 ? 0 : start;
    return inferEducationEntry(
      ["EDUCATION", ...lines.slice(blockStart, end)].join("\n"),
    );
  });
}

function inferEducationEntry(resumeText: string) {
  const lines = splitLines(resumeText);
  const educationLines = findSectionBodyLinesByAliases(lines, [
    "EDUCATION AND TRAINING",
    "EDUCATION",
  ] as const);
  const candidatePool = educationLines.length > 0 ? educationLines : lines;
  // A qualification, institution and graduation year are structural fields;
  // their wording need not belong to an English degree vocabulary.
  const inline = educationLines
    .map((line) =>
      line.match(/^([^,]+),\s*([^,]+)(?:,\s*([^,]+))?,\s*((?:19|20)\d{2})$/),
    )
    .find(Boolean);
  if (inline) {
    const qualification = (inline[1] ?? "").match(/^(.+?)\s+in\s+(.+)$/i);
    return [
      {
        schoolName: inline[2] ?? null,
        degree: qualification?.[1] ?? inline[1] ?? null,
        fieldOfStudy: qualification?.[2] ?? null,
        location: inline[3] ?? null,
        startDate: null,
        endDate: inline[4] ?? null,
        summary: null,
      },
    ];
  }
  const educationDegreePattern =
    /\b(?:degree|associate|bachelor|master|ph\.?d|b\.?sc|m\.?sc|b\.?a|m\.?a|btech|mtech)\b/i;

  const directEducationLineIndex = candidatePool.findIndex(
    (line) =>
      educationDegreePattern.test(line) &&
      /(college|university|school|institute|kolegji)/i.test(line) &&
      !isResumeSectionHeading(line),
  );
  const schoolOnlyLineIndex = candidatePool.findIndex(
    (line, index) =>
      /(college|university|school|institute|kolegji)/i.test(line) &&
      !isResumeSectionHeading(line) &&
      [
        candidatePool[index - 1],
        candidatePool[index + 1],
        candidatePool[index + 2],
      ].some((nearbyLine) => educationDegreePattern.test(nearbyLine ?? "")),
  );
  const degreeOnlyLineIndex = candidatePool.findIndex(
    (line, index) =>
      educationDegreePattern.test(line) &&
      !isResumeSectionHeading(line) &&
      [
        candidatePool[index - 2],
        candidatePool[index - 1],
        candidatePool[index + 1],
      ].some((nearbyLine) =>
        /(college|university|school|institute|kolegji)/i.test(nearbyLine ?? ""),
      ),
  );
  const educationLineIndex =
    directEducationLineIndex !== -1
      ? directEducationLineIndex
      : schoolOnlyLineIndex !== -1
        ? schoolOnlyLineIndex
        : degreeOnlyLineIndex;

  if (educationLineIndex === -1) {
    return [];
  }

  const educationLine = candidatePool[educationLineIndex] ?? "";
  const educationLineForParsing = cleanLine(
    educationLine
      .replace(dateRangePattern, "")
      .replace(/[,\s–—-]+(?:19|20)\d{2}\s*$/, "")
      .replace(/\s*\(([^)]*)\)/g, (match, content: string) =>
        dateRangePattern.test(content) ? "" : match,
      ),
  );
  const parsedEducationLine = educationLineForParsing
    .replace(/\(\s*\)/g, "")
    .trim();
  const nearbyEducationLines = [
    candidatePool[educationLineIndex - 2],
    candidatePool[educationLineIndex - 1],
    parsedEducationLine || educationLine,
    candidatePool[educationLineIndex + 1],
    candidatePool[educationLineIndex + 2],
  ]
    .map((line) => cleanLine(line ?? ""))
    .filter(Boolean);
  const combinedEducationLine = cleanLine(nearbyEducationLines.join(" "));
  const schoolMatch =
    (parsedEducationLine || educationLine).match(
      /((?:[A-Z][A-Za-z'().&-]*\s+){0,6}(?:College|University|School|Institute|Kolegji)(?:\s+(?:[A-Z][A-Za-z'().&-]*|of|the|and)){0,8}(?:\s*\([^)]*\))?)/i,
    ) ??
    combinedEducationLine.match(
      /((?:[A-Z][A-Za-z'().&-]*\s+){0,6}(?:College|University|School|Institute|Kolegji)(?:\s+(?:[A-Z][A-Za-z'().&-]*|of|the|and)){0,8}(?:\s*\([^)]*\))?)/i,
    );

  let schoolName: string | null = null;
  let degree: string | null = null;
  let fieldOfStudy: string | null = null;

  const splitParts = (parsedEducationLine || educationLine)
    .split(/\s+[–—-]\s+/)
    .map((part) => cleanLine(part))
    .filter(Boolean);

  if (splitParts.length >= 2) {
    const [left, right] = splitParts;
    const leftHasSchool = /(college|university|school|institute|kolegji)/i.test(
      left ?? "",
    );
    const rightHasSchool =
      /(college|university|school|institute|kolegji)/i.test(right ?? "");

    if (leftHasSchool && !rightHasSchool) {
      schoolName = left ?? null;
      degree = right ?? null;
    } else if (!leftHasSchool && rightHasSchool) {
      degree = left ?? null;
      schoolName = right?.replace(/,\s*(?:19|20)\d{2}\s*$/, "") ?? null;
    }
  }

  if (!degree) {
    const degreeLine = nearbyEducationLines.find(
      (line) =>
        educationDegreePattern.test(line) &&
        !/(college|university|school|institute|kolegji)/i.test(line),
    );
    degree = degreeLine ?? null;
  }

  const schoolKeywordIndex = (parsedEducationLine || educationLine).search(
    /\b(?:College|University|School|Institute|Kolegji)\b/i,
  );

  if (
    !schoolName &&
    schoolKeywordIndex !== -1 &&
    educationDegreePattern.test(
      (parsedEducationLine || educationLine).slice(0, schoolKeywordIndex),
    )
  ) {
    const beforeSchool = (parsedEducationLine || educationLine).slice(
      0,
      schoolKeywordIndex,
    );
    const separator = Math.max(
      beforeSchool.lastIndexOf(","),
      beforeSchool.lastIndexOf("—"),
      beforeSchool.lastIndexOf("–"),
    );
    const schoolStart =
      separator >= 0 && /\bin\s+.+/i.test(beforeSchool.slice(0, separator))
        ? separator + 1
        : schoolKeywordIndex;
    schoolName = cleanLine(
      (parsedEducationLine || educationLine).slice(schoolStart),
    );
    const detailParts = cleanLine(
      (parsedEducationLine || educationLine).slice(0, schoolStart),
    ).replace(/^[,\s–—-]+|[,\s–—-]+$/g, "");

    if (detailParts) {
      const segments = detailParts
        .split(",")
        .map((part) => cleanLine(part))
        .filter(Boolean);
      degree = segments[0] ?? detailParts;
      fieldOfStudy = segments.length > 1 ? segments.slice(1).join(", ") : null;
    }
  }

  if (!schoolName && schoolMatch?.[1]) {
    schoolName = cleanLine(schoolMatch[1]);
    const detailParts = cleanLine(
      (parsedEducationLine || educationLine).replace(schoolMatch[1], ""),
    ).replace(/^[,\s–—-]+|[,\s–—-]+$/g, "");

    if (detailParts) {
      const segments = detailParts
        .split(",")
        .map((part) => cleanLine(part))
        .filter(Boolean);
      degree = segments[0] ?? detailParts;
      fieldOfStudy = segments.length > 1 ? segments.slice(1).join(", ") : null;
    }
  }

  if (degree) {
    const degreeWithFieldMatch = degree.match(
      /^(.*?(?:degree|associate of (?:applied science|arts|science)))(?:\s+in\s+|,\s+)(.+)$/i,
    );

    if (degreeWithFieldMatch) {
      degree = cleanLine(degreeWithFieldMatch[1] ?? degree);
      fieldOfStudy =
        fieldOfStudy ?? (cleanLine(degreeWithFieldMatch[2] ?? "") || null);
    }

    const parenthesizedDegreeMatch = degree.match(
      /^(.*?\([^)]*\))\s*,\s*(.+)$/i,
    );
    if (parenthesizedDegreeMatch && !fieldOfStudy) {
      degree = cleanLine(parenthesizedDegreeMatch[1] ?? degree);
      fieldOfStudy = cleanLine(parenthesizedDegreeMatch[2] ?? "") || null;
    }
  }

  const dateLine =
    [
      educationLine,
      candidatePool[educationLineIndex + 1],
      candidatePool[educationLineIndex - 1],
      candidatePool[educationLineIndex + 2],
      candidatePool[educationLineIndex - 2],
    ]
      .map((line) => cleanLine(line ?? ""))
      .find((line) => dateRangePattern.test(line)) ?? null;
  const dateMatch = dateLine?.match(dateRangePattern) ?? null;
  const graduationYearMatch = dateMatch
    ? null
    : (educationLine.match(/(?:,\s*|\b)((?:19|20)\d{2})\s*$/) ??
      nearbyEducationLines
        .map((line) => line.match(/(?:,\s*|\b)((?:19|20)\d{2})\s*$/))
        .find((match) => match !== null));
  const locationLine =
    [
      candidatePool[educationLineIndex - 1],
      candidatePool[educationLineIndex + 1],
    ]
      .map((line) => cleanLine(line ?? ""))
      .find(
        (line) =>
          line.length > 0 &&
          line !== dateLine &&
          !educationDegreePattern.test(line) &&
          !/(college|university|school|institute|kolegji)/i.test(line) &&
          /^[A-Za-z][A-Za-z\s.'-]+,\s*(?:[A-Z]{2}|[A-Za-z][A-Za-z\s.'-]+)$/.test(
            line,
          ),
      ) ?? null;

  return [
    {
      schoolName: schoolName || null,
      degree: degree?.replace(/[,\s]+(?:19|20)\d{2}\s*$/, "").trim() || null,
      fieldOfStudy:
        fieldOfStudy?.replace(/[,\s]+(?:19|20)\d{2}\s*$/, "").trim() || null,
      location: normalizeLocationLabel(locationLine ?? null),
      startDate: dateMatch?.[1] ? cleanLine(dateMatch[1]) : null,
      endDate: dateMatch?.[2]
        ? cleanLine(dateMatch[2])
        : (graduationYearMatch?.[1] ?? null),
      summary: null,
    },
  ].filter((entry) => entry.schoolName || entry.degree || entry.fieldOfStudy);
}

const projectRolePattern =
  /\b(?:engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|lead|owner|maintainer|founder|contributor)\b/i;

function isProjectRoleLine(value: string): boolean {
  const cleaned = cleanLine(value);
  return (
    cleaned.length > 0 &&
    cleaned.length <= 72 &&
    projectRolePattern.test(cleaned) &&
    !/[.!?;:]$/.test(cleaned)
  );
}

function isProjectBulletLine(value: string): boolean {
  return isBulletLine(value);
}

function isLikelyProjectHeadingLine(value: string): boolean {
  // Bullet-prefixed lines are project detail candidates. Treating a detail
  // bullet such as "Accessibility improvements" as a new project heading
  // would split one project's bullet list whenever another bullet follows.
  if (isProjectBulletLine(value)) {
    return false;
  }

  const cleaned = cleanLine(value);

  if (
    !cleaned ||
    cleaned.length > 72 ||
    /^(?:technologies|technology|tools|skills|url|repository)\s*:/i.test(
      cleaned,
    ) ||
    /^https?:\/\//i.test(cleaned) ||
    /[.!?;:]$/.test(cleaned)
  ) {
    return false;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) {
    return false;
  }

  // Unbulleted detail prose usually starts with a delivery verb. Keeping
  // those lines out of the heading candidates lets a later title followed by
  // bullets become a new project without relying on project names.
  return !/^(?:added|built|created|delivered|designed|developed|documented|fixed|implemented|improved|led|managed|maintained|reduced|wrote|supported|tested|used|worked|contributed|collaborated)\b/i.test(
    cleaned,
  );
}

function isProjectHeadingStart(
  lines: readonly string[],
  index: number,
): boolean {
  const line = lines[index] ?? "";
  const nextLine = lines[index + 1] ?? "";

  if (!isLikelyProjectHeadingLine(line)) {
    return false;
  }

  return (
    isProjectBulletLine(nextLine) ||
    isProjectRoleLine(nextLine) ||
    /^https?:\/\//i.test(cleanLine(nextLine)) ||
    /^(?:technologies|technology|tools|skills)\s*:/i.test(cleanLine(nextLine))
  );
}

export function inferProjects(resumeText: string) {
  const lines = findSectionBodyLinesByAliases(
    splitLines(resumeText),
    projectSectionAliases,
  ).flatMap((line) => splitInlineBulletLine(line));
  const projects: Array<{
    name: string | null;
    projectType: string | null;
    summary: string | null;
    role: string | null;
    skills: string[];
    outcome: string | null;
    projectUrl: string | null;
    repositoryUrl: string | null;
    caseStudyUrl: string | null;
  }> = [];

  let index = 0;
  while (index < lines.length) {
    const name = stripBulletPrefix(cleanLine(lines[index] ?? ""));
    if (!name || /^https?:\/\//i.test(name)) {
      index += 1;
      continue;
    }

    const role = isProjectRoleLine(lines[index + 1] ?? "")
      ? cleanLine(lines[index + 1] ?? "")
      : null;
    let cursor = index + (role ? 2 : 1);
    const detailLines: string[] = [];
    let projectUrl: string | null = null;

    while (cursor < lines.length) {
      const line = cleanLine(lines[cursor] ?? "");
      if (/^https?:\/\//i.test(line)) {
        projectUrl = extractFirstUrl(line, /https?:\/\/[^\s]+/i);
        cursor += 1;
        continue;
      }

      if (
        (detailLines.length > 0 || projectUrl) &&
        isProjectHeadingStart(lines, cursor)
      ) {
        break;
      }

      detailLines.push(stripBulletPrefix(line));
      cursor += 1;
    }

    const combinedText = [name, role ?? "", ...detailLines].join("\n");
    const repositoryUrl = /github\.com|gitlab\.com|bitbucket\.org/i.test(
      projectUrl ?? "",
    )
      ? projectUrl
      : null;

    projects.push({
      name,
      projectType: null,
      summary: cleanLine(detailLines.join(" ")) || null,
      role,
      skills: uniqueStrings([
        ...inferSkills(combinedText, []),
        ...detailLines
          .filter((line) =>
            /^(?:technologies|technology|tools|skills)\s*:/i.test(line),
          )
          .flatMap((line) =>
            line
              .replace(/^[^:]+:\s*/, "")
              .split(/[,;|]/)
              .map(cleanLine),
          ),
      ]),
      outcome:
        detailLines.find((line) => /\b\d+(?:\.\d+)?\s*%|\b\d+\+/i.test(line)) ??
        null,
      projectUrl: repositoryUrl ? null : projectUrl,
      repositoryUrl,
      caseStudyUrl: null,
    });
    index = Math.max(cursor, index + 1);
  }

  return projects;
}

export function inferCertifications(resumeText: string) {
  const lines = findSectionBodyLinesByAliases(splitLines(resumeText), [
    "CERTIFICATIONS",
    "CERTIFICATES",
  ] as const);
  const certifications: Array<{
    name: string | null;
    issuer: string | null;
    issueDate: string | null;
    expiryDate: string | null;
    credentialUrl: string | null;
  }> = [];
  let index = 0;

  while (index < lines.length) {
    const rawName = stripBulletPrefix(cleanLine(lines[index] ?? ""));
    const yearMatch = rawName.match(
      /^(.*?)\s*(?:\(((?:19|20)\d{2})\)|[,–—-]\s*((?:19|20)\d{2}))\s*$/,
    );
    const datedName = yearMatch?.[1]?.trim() ?? rawName;
    const inlineParts = datedName.split(/\s+[–—]\s+|\s+-\s+/);
    // "Data Analytics - Coursera" names an issuer; "PMP - Project Management
    // Professional" or "... - Associate" spells out the credential itself.
    const inlineIssuer =
      inlineParts.length === 2 &&
      !/\b(?:associate|professional|foundation|advanced|certified|certificate|certification|specialist|practitioner|expert)\b/i.test(
        inlineParts[1] ?? "",
      )
        ? (inlineParts[1] ?? null)
        : null;
    const name = inlineIssuer ? (inlineParts[0] ?? datedName) : datedName;
    if (!name || /^(?:issued|expires?|credential)\b/i.test(name)) {
      index += 1;
      continue;
    }

    const possibleIssuer = cleanLine(lines[index + 1] ?? "");
    const issuer =
      inlineIssuer ??
      (possibleIssuer &&
      !isBulletLine(lines[index + 1] ?? "") &&
      !/\b(?:19|20)\d{2}\b/.test(possibleIssuer) &&
      !yearMatch &&
      (/^(?:issued|awarded|expires?|expiration|credential|https?:\/\/)\b/i.test(
        lines[index + 2] ?? "",
      ) ||
        /^issuer\s*:/i.test(possibleIssuer)) &&
      !/^(?:issued|expires?|credential)\b/i.test(possibleIssuer) &&
      !/^https?:\/\//i.test(possibleIssuer)
        ? possibleIssuer
        : null);
    let cursor = index + (issuer && !inlineIssuer ? 2 : 1);
    let issueDate: string | null = yearMatch?.[2] ?? yearMatch?.[3] ?? null;
    let expiryDate: string | null = null;
    let credentialUrl: string | null = null;

    while (cursor < lines.length) {
      const line = cleanLine(lines[cursor] ?? "");
      const issuedMatch = line.match(/^(?:issued|awarded)\s+(.+)$/i);
      const expiryMatch = line.match(/^(?:expires?|expiration)\s+(.+)$/i);

      if (issuedMatch?.[1]) {
        issueDate = cleanLine(issuedMatch[1]);
        cursor += 1;
        continue;
      }
      if (expiryMatch?.[1]) {
        expiryDate = cleanLine(expiryMatch[1]);
        cursor += 1;
        continue;
      }
      if (/^https?:\/\//i.test(line)) {
        credentialUrl = extractFirstUrl(line, /https?:\/\/[^\s]+/i);
        cursor += 1;
      }
      break;
    }

    certifications.push({
      name,
      issuer,
      issueDate,
      expiryDate,
      credentialUrl,
    });
    index = Math.max(cursor, index + 1);
  }

  return certifications;
}

export function inferSpokenLanguages(resumeText: string) {
  const lines = splitLines(resumeText);
  const entries: Array<{
    language: string | null;
    proficiency: string | null;
    interviewPreference: boolean;
    notes: string | null;
  }> = [];
  const motherTongueMatch = resumeText.match(
    /Mother\s+tongue(?:\(s\))?\s*[:\-–—]\s*([A-Za-z]+)/i,
  );

  if (motherTongueMatch?.[1]) {
    entries.push({
      language: titleCaseWords(motherTongueMatch[1]),
      proficiency: "Native",
      interviewPreference: true,
      notes: null,
    });
  }

  for (const line of lines) {
    const proficiencyMatch = line.match(
      /^([A-Z][A-Z\s]+?)\s+(A1|A2|B1|B2|C1|C2)(?:\s+(A1|A2|B1|B2|C1|C2)){4}$/,
    );

    if (!proficiencyMatch) {
      continue;
    }

    entries.push({
      language: titleCaseWords(proficiencyMatch[1] ?? ""),
      proficiency: proficiencyMatch[2] ?? null,
      interviewPreference: false,
      notes: null,
    });
  }

  const languageSectionLines = findSectionBodyLinesByAliases(lines, [
    "LANGUAGE SKILLS",
    "LANGUAGES",
  ] as const);

  for (const line of languageSectionLines) {
    const match = line.match(
      /^([A-Za-z][A-Za-z .'()-]*?)\s*(?:[:|]|\s+[–—-]\s+)\s*(.+)$/,
    );
    const language = cleanLine(match?.[1] ?? "");
    const proficiency = cleanLine(match?.[2] ?? "");

    if (!language || !proficiency || /^https?:\/\//i.test(line)) {
      continue;
    }

    if (
      /mother\s*tongue/i.test(language) &&
      /^[A-Za-z][A-Za-z .'-]*$/.test(proficiency)
    ) {
      entries.push({
        language: titleCaseWords(proficiency),
        proficiency: "Native",
        interviewPreference: true,
        notes: null,
      });
      continue;
    }

    if (
      isSpokenLanguageResumeChrome(language) ||
      isSpokenLanguageResumeChrome(line)
    ) {
      continue;
    }

    if (
      language.split(/\s+/).length > 4 ||
      language.length > 40 ||
      /^(?:page\b|disclaimer\b|copyright\b)/i.test(language)
    )
      continue;

    entries.push({
      language: titleCaseWords(language),
      proficiency,
      interviewPreference: false,
      notes: null,
    });
  }

  return entries.filter(
    (entry, index) =>
      entry.language &&
      entries.findIndex(
        (candidate) =>
          candidate.language?.toLowerCase() === entry.language?.toLowerCase(),
      ) === index,
  );
}

export function buildProfileExtractionNotes(input: {
  fullName: string | null;
  headline: string | null;
  summary: string | null;
  currentLocation: string | null;
}): string[] {
  const notes: string[] = [];

  if (!input.fullName) {
    notes.push(
      "Review the imported name because the parser could not confidently extract it.",
    );
  }

  if (!input.headline) {
    notes.push(
      "Add a preferred headline if the resume does not expose a clear current role.",
    );
  }

  if (!input.summary) {
    notes.push(
      "Add a short professional summary if the resume does not include one.",
    );
  }

  if (!input.currentLocation) {
    notes.push(
      "Confirm the preferred location because the resume did not expose a clear location line.",
    );
  }

  return notes;
}

export function inferLocations(
  currentLocation: string | null,
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
): string[] {
  if (currentLocation) {
    return uniqueStrings([currentLocation]);
  }

  if (profile.locations.length > 0) {
    return uniqueStrings(profile.locations);
  }

  if (searchPreferences.locations.length > 0) {
    return uniqueStrings(searchPreferences.locations);
  }

  return profile.currentLocation
    ? uniqueStrings([profile.currentLocation])
    : [];
}

export function inferGithubUrl(resumeText: string): string | null {
  const match = extractFirstUrl(
    resumeText,
    /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_-]+\/?$/i,
  );
  if (match) {
    try {
      const url = new URL(match);
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length === 1) {
        return match.replace(/\/$/, "");
      }
    } catch {
      // Ignore URL parsing errors
    }
  }
  return null;
}

export function inferPersonalWebsiteUrl(resumeText: string): string | null {
  return (
    extractAllUrls(resumeText).find((url) => isLikelyPersonalWebsiteUrl(url)) ??
    null
  );
}
