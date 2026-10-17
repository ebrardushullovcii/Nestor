import type { ResumeImportFieldCandidate } from "@nestor/contracts";

import {
  areEquivalentEducationRecords,
  areEquivalentExperienceRecords,
} from "./resume-record-identity";
import { normalizeText } from "./shared";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isClearlyResumeDateRange(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  return /^(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}$/u.test(trimmed);
}

export function stringifyCandidateTarget(
  candidate: ResumeImportFieldCandidate,
): string {
  return [
    candidate.target.section,
    candidate.target.key,
    candidate.target.recordId ?? "",
  ]
    .join("|")
    .trim();
}

export function areEquivalentRecordCandidates(
  left: ResumeImportFieldCandidate,
  right: ResumeImportFieldCandidate,
): boolean {
  if (
    left.target.section !== right.target.section ||
    left.target.key !== right.target.key
  ) {
    return false;
  }

  switch (left.target.section) {
    case "experience":
      return (
        areEquivalentExperienceRecords(left.value, right.value) ||
        areEquivalentExperienceStubs(left.value, right.value)
      );
    case "education":
      return (
        areEquivalentEducationRecords(
          left.value,
          right.value,
          educationReadingsShareSource(left, right),
        ) || areEquivalentEducationStubs(left.value, right.value)
      );
    case "language":
      return sameRecordField(left.value, right.value, "language");
    case "link":
      return sameRecordField(left.value, right.value, "url");
    case "project":
    case "certification":
      return sameRecordField(left.value, right.value, "name");
    default:
      return false;
  }
}

function educationReadingsShareSource(
  left: ResumeImportFieldCandidate,
  right: ResumeImportFieldCandidate,
): boolean {
  if (left.sourceBlockIds.some((id) => right.sourceBlockIds.includes(id)))
    return true;

  const schools = [left.value, right.value].flatMap((value) =>
    isObject(value) && typeof value.schoolName === "string"
      ? [normalizeText(value.schoolName)]
      : [],
  );
  const evidenceParts = (candidate: ResumeImportFieldCandidate) =>
    [
      candidate.evidenceText ?? "",
      ...(candidate.evidenceText?.split(/\r?\n/) ?? []),
    ]
      .map(normalizeText)
      .filter((text) => {
        const beyondSchool = schools.reduce(
          (remaining, school) =>
            school ? remaining.replaceAll(school, "").trim() : remaining,
          text,
        );
        return /[a-z]/.test(beyondSchool);
      });
  const leftEvidence = evidenceParts(left);
  return evidenceParts(right).some((rightText) =>
    leftEvidence.some(
      (leftText) =>
        ` ${leftText} `.includes(` ${rightText} `) ||
        ` ${rightText} `.includes(` ${leftText} `),
    ),
  );
}

function recordFieldText(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string"
    ? field.trim().toLowerCase().replace(/\s+/g, " ").replace(/\/+$/, "")
    : "";
}

/**
 * The model read a role without its employer and with a shortened title;
 * the text reader found the employer line. Same start month plus a title
 * that shares its main words is the same job, not a second one.
 */
function areEquivalentExperienceStubs(left: unknown, right: unknown): boolean {
  const leftCompany = recordFieldText(left, "companyName");
  const rightCompany = recordFieldText(right, "companyName");
  if (leftCompany && rightCompany) {
    return false;
  }
  const leftStart = recordFieldText(left, "startDate");
  const rightStart = recordFieldText(right, "startDate");
  if (!leftStart || leftStart !== rightStart) {
    return false;
  }
  const leftTitle = recordFieldText(left, "title");
  const rightTitle = recordFieldText(right, "title");
  if (!leftTitle || !rightTitle) {
    return false;
  }
  const tokens = (text: string) =>
    new Set(text.split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  const leftTokens = tokens(leftTitle);
  const rightTokens = tokens(rightTitle);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  return shared.length >= Math.min(leftTokens.size, rightTokens.size, 2);
}

/** Two reads of the same language, link, project or certificate. */
function sameRecordField(left: unknown, right: unknown, key: string): boolean {
  const leftText = recordFieldText(left, key);
  const rightText = recordFieldText(right, key);
  return leftText.length > 0 && leftText === rightText;
}

/**
 * The model often names the degree but not the school, while the text reader
 * finds the school line: same qualification, read twice. When one side has no
 * school, matching degree and field is enough to treat them as one.
 */
function areEquivalentEducationStubs(left: unknown, right: unknown): boolean {
  const leftSchool = recordFieldText(left, "schoolName");
  const rightSchool = recordFieldText(right, "schoolName");
  if (leftSchool && rightSchool) {
    return false;
  }
  const leftDegree = recordFieldText(left, "degree");
  const rightDegree = recordFieldText(right, "degree");
  const leftField = recordFieldText(left, "fieldOfStudy");
  const rightField = recordFieldText(right, "fieldOfStudy");
  const degreeMatches =
    leftDegree.length > 0 &&
    rightDegree.length > 0 &&
    (leftDegree === rightDegree ||
      leftDegree.includes(rightDegree) ||
      rightDegree.includes(leftDegree));
  const fieldMatches =
    leftField.length > 0 &&
    rightField.length > 0 &&
    (leftField === rightField ||
      leftField.includes(rightField) ||
      rightField.includes(leftField));
  return degreeMatches && (!leftField || !rightField || fieldMatches);
}

export function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? splitListString(trimmed) : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry) =>
      typeof entry === "string" ? splitListString(entry.trim()) : [],
    )
    .filter(Boolean);
}

export function toCandidateListValues(
  candidate: Pick<ResumeImportFieldCandidate, "target" | "value">,
): string[] {
  if (
    candidate.target.key === "locations" ||
    candidate.target.key === "targetRoles"
  ) {
    const entries =
      typeof candidate.value === "string"
        ? [candidate.value]
        : Array.isArray(candidate.value)
          ? candidate.value.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];

    return entries.map((entry) => entry.trim()).filter(Boolean);
  }

  return toStringArray(candidate.value);
}

export function toNarrativeStringArray(value: unknown): string[] {
  const entries =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

  return (
    entries
      .flatMap((entry) => entry.split(/\r?\n+/))
      // Inline bullet glyphs ("• a • b") and long multi-sentence blobs are one
      // resume's ten bullets glued together; downstream tailoring can only
      // select, reorder and rewrite what arrives as separate entries.
      .flatMap((entry) => entry.split(/\s+[•·▪◦‣]\s+/u))
      .flatMap((entry) => splitLongNarrativeBlob(entry))
      .map((entry) => entry.trim().replace(/^(?:[-*•·▪◦‣]\s+|\d+[.)]\s+)/u, ""))
      .filter(Boolean)
  );
}

const LONG_NARRATIVE_BLOB_MIN_LENGTH = 240;

function splitLongNarrativeBlob(entry: string): string[] {
  const trimmed = entry.trim();
  if (trimmed.length < LONG_NARRATIVE_BLOB_MIN_LENGTH) {
    return [trimmed];
  }
  const sentences = trimmed
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length >= 3 ? sentences : [trimmed];
}

export function stripImportFormatting(value: string): string {
  return value
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/g, "$2")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function cleanImportedValue(value: unknown): unknown {
  if (typeof value === "string") return stripImportFormatting(value);
  if (Array.isArray(value)) return value.map(cleanImportedValue);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cleanImportedValue(entry),
      ]),
    );
  return value;
}

export function splitImportedSkills(value: string): string[] {
  return splitListString(value)
    .flatMap((entry) => {
      const match = entry.match(/^([^()]+)\(([^()]*)\)$/);
      return match
        ? [match[1]?.trim() ?? "", ...splitListString(match[2] ?? "")]
        : [entry];
    })
    .filter(Boolean);
}

function splitListString(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;|•]/.test(char ?? "")) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}
