import { splitRoleTitleAndEmployer } from "./resume-role-title";
import { normalizeText } from "./shared";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecordText(value: unknown): string {
  return typeof value === "string" ? normalizeText(value) : "";
}

/** A delivery-format label does not make a second copy of a certificate. */
export function areEquivalentCertificationReadings(
  left: unknown,
  right: unknown,
): boolean {
  if (!isObjectRecord(left) || !isObjectRecord(right)) return false;
  const name = (record: Record<string, unknown>) =>
    normalizeRecordText(
      typeof record.name === "string"
        ? record.name.replace(
            /\s+\((?:(?:online|virtual|in-person|self-paced)\s+)?(?:course|training)\)$/i,
            "",
          )
        : null,
    );
  const leftName = name(left);
  const leftIssuer = normalizeRecordText(left.issuer);
  const rightIssuer = normalizeRecordText(right.issuer);
  return Boolean(
    leftName &&
    leftName === name(right) &&
    (!leftIssuer || !rightIssuer || leftIssuer === rightIssuer) &&
    fieldsCompatible(
      normalizeRecordDate(left.issueDate),
      normalizeRecordDate(right.issueDate),
      "date",
    ),
  );
}

function normalizeRecordDate(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\./g, "");
  if (!trimmed) {
    return "";
  }

  if (trimmed === "present" || trimmed === "current") {
    return "present";
  }

  const isoMonthMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (isoMonthMatch) {
    return `${isoMonthMatch[1]}-${isoMonthMatch[2]}`;
  }

  const slashFullDateMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashFullDateMatch) {
    const firstToken = slashFullDateMatch[1] ?? "";
    const secondToken = slashFullDateMatch[2] ?? "";
    const first = Number.parseInt(firstToken, 10);
    const second = Number.parseInt(secondToken, 10);
    const year = slashFullDateMatch[3] ?? "";
    const month =
      first > 12
        ? second
        : second > 12
          ? first
          : firstToken.length === 2 && secondToken.length === 2
            ? second
            : first;

    if (Number.isInteger(month) && month >= 1 && month <= 12 && year) {
      return `${year}-${String(month).padStart(2, "0")}`;
    }
  }

  const slashMonthMatch = trimmed.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMonthMatch) {
    const month = Number.parseInt(slashMonthMatch[1] ?? "", 10);

    if (Number.isInteger(month) && month >= 1 && month <= 12) {
      return `${slashMonthMatch[2]}-${String(month).padStart(2, "0")}`;
    }
  }

  const monthByName: Record<string, string> = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };
  const monthYearMatch = trimmed.match(/^([a-z]+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const month = monthByName[monthYearMatch[1] ?? ""];
    const year = monthYearMatch[2] ?? "";
    return month && year ? `${year}-${month}` : trimmed;
  }

  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    return yearMatch[1] ?? trimmed;
  }

  return trimmed;
}

function normalizeRecordEndDate(value: unknown, isCurrent: unknown): string {
  if (isCurrent === true) {
    return "present";
  }

  const normalizedDate = normalizeRecordDate(value);
  return normalizedDate;
}

function fieldsMatch(left: string, right: string): boolean {
  return left.length > 0 && right.length > 0 && left === right;
}

function companyMatchesWithLocationSuffix(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  leftLocation: string,
  rightLocation: string,
): boolean {
  if (leftLocation && rightLocation && leftLocation !== rightLocation) {
    return false;
  }
  const locations = [leftLocation, rightLocation].filter(Boolean);
  if (locations.length === 0) return false;

  const matches = (company: unknown, otherCompany: unknown) => {
    if (typeof company !== "string") return false;
    const expected = normalizeRecordText(otherCompany);
    if (!expected) return false;
    const parts = company.split(",");
    for (let index = 1; index < parts.length; index += 1) {
      const employer = normalizeRecordText(parts.slice(0, index).join(","));
      const suffix = normalizeRecordText(parts.slice(index).join(","));
      if (employer === expected && locations.includes(suffix)) return true;
    }
    return false;
  };
  return (
    matches(left.companyName, right.companyName) ||
    matches(right.companyName, left.companyName)
  );
}

function fieldsCompatible(
  left: string,
  right: string,
  kind?: "text" | "date" | "substring",
): boolean {
  // Dates (start/end): strict normalized equality only
  if (kind === "date") {
    return !left || !right || left === right;
  }

  // Degree / fieldOfStudy: substring matching is appropriate for long structured phrases
  if (kind === "substring") {
    return (
      !left ||
      !right ||
      left === right ||
      left.includes(right) ||
      right.includes(left)
    );
  }

  // Company / title ("text"): equality or meaningful token overlap — prevents false positives
  // from short numbers or common substrings that substring matching would allow
  if (!left || !right) return true;
  if (left === right) return true;
  const leftTokens = new Set(left.split(/\s+/).filter((t) => t.length >= 3));
  return right.split(/\s+/).some((t) => t.length >= 3 && leftTokens.has(t));
}

function countTruthyFields(values: readonly unknown[]): number {
  return values.reduce<number>((count, value) => {
    if (typeof value === "string") {
      return value.trim().length > 0 ? count + 1 : count;
    }

    if (typeof value === "boolean") {
      return value ? count + 1 : count;
    }

    if (Array.isArray(value)) {
      return value.length > 0 ? count + 1 : count;
    }

    return value !== null && value !== undefined ? count + 1 : count;
  }, 0);
}

export function areEquivalentExperienceRecords(
  left: unknown,
  right: unknown,
): boolean {
  if (!isObjectRecord(left) || !isObjectRecord(right)) {
    return false;
  }

  const roleParts = (record: Record<string, unknown>) => {
    const rawTitle = typeof record.title === "string" ? record.title : "";
    const companyName =
      typeof record.companyName === "string" ? record.companyName.trim() : "";
    const split = companyName
      ? { title: rawTitle, companyName }
      : splitRoleTitleAndEmployer(rawTitle);
    return {
      company: normalizeRecordText(split.companyName),
      title: normalizeRecordText(split.title),
      hasSpecialty: split.title.includes(","),
    };
  };
  const leftRole = roleParts(left);
  const rightRole = roleParts(right);
  const leftCompany = leftRole.company;
  const rightCompany = rightRole.company;
  const leftTitle = leftRole.title;
  const rightTitle = rightRole.title;
  const leftLocation = normalizeRecordText(left.location);
  const rightLocation = normalizeRecordText(right.location);
  const leftStart = normalizeRecordDate(left.startDate);
  const rightStart = normalizeRecordDate(right.startDate);
  const leftEnd = normalizeRecordEndDate(left.endDate, left.isCurrent);
  const rightEnd = normalizeRecordEndDate(right.endDate, right.isCurrent);

  const strongCompany = fieldsMatch(leftCompany, rightCompany);
  const strongTitle = fieldsMatch(leftTitle, rightTitle);
  if ((leftRole.hasSpecialty || rightRole.hasSpecialty) && !strongTitle)
    return false;
  const strongStart = fieldsMatch(leftStart, rightStart);
  const strongEnd = fieldsMatch(leftEnd, rightEnd);
  const strongLocation = fieldsMatch(leftLocation, rightLocation);
  const companyCompatible = fieldsCompatible(leftCompany, rightCompany, "text");
  const titleCompatible = fieldsCompatible(leftTitle, rightTitle, "text");
  const startCompatible = fieldsCompatible(leftStart, rightStart, "date");
  const endCompatible = fieldsCompatible(leftEnd, rightEnd, "date");

  // A role read twice rarely agrees on every field: one reading keeps the
  // title and dates but loses the employer line, the other has the employer
  // and the bullets. Same title, same month, and an employer named on at
  // most one side is the same role, not a second one.
  const employerMissingOnOneSide = !leftCompany || !rightCompany;
  const skeletonOfSameRole =
    strongTitle &&
    employerMissingOnOneSide &&
    (strongStart || (strongEnd && startCompatible));
  // One extraction can keep "Employer, City, Country" in the employer
  // field while the other separates the location. Only a stated exact
  // location suffix plus the same title and complete dates identifies
  // that twin; an arbitrary employer suffix or different office does not.
  const sameDatedRoleWithLocationSuffix =
    strongTitle &&
    strongStart &&
    strongEnd &&
    companyMatchesWithLocationSuffix(left, right, leftLocation, rightLocation);

  return (
    (strongTitle &&
      strongStart &&
      companyCompatible &&
      (strongCompany || strongLocation)) ||
    (strongCompany &&
      strongStart &&
      titleCompatible &&
      (strongTitle || strongEnd || strongLocation)) ||
    (strongTitle &&
      strongCompany &&
      (strongStart || strongEnd) &&
      startCompatible &&
      endCompatible) ||
    skeletonOfSameRole ||
    sameDatedRoleWithLocationSuffix
  );
}

/**
 * "March 2021", "3/2021", "2021-03-01" → "2021-03". Text that is not a date
 * comes back unchanged so a person's own wording is never thrown away.
 */
export function canonicalizeRecordDateText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeRecordDate(trimmed);
  return /^\d{4}(?:-\d{2})?$/.test(normalized) ? normalized : trimmed;
}

export function areEquivalentEducationRecords(
  left: unknown,
  right: unknown,
  sharedSourceEntry = false,
): boolean {
  if (!isObjectRecord(left) || !isObjectRecord(right)) {
    return false;
  }

  const leftSchool = normalizeRecordText(left.schoolName);
  const rightSchool = normalizeRecordText(right.schoolName);
  const leftDegree = normalizeRecordText(left.degree);
  const rightDegree = normalizeRecordText(right.degree);
  const leftField = normalizeRecordText(left.fieldOfStudy);
  const rightField = normalizeRecordText(right.fieldOfStudy);
  const leftStart = normalizeRecordDate(left.startDate);
  const rightStart = normalizeRecordDate(right.startDate);
  const leftEnd = normalizeRecordDate(left.endDate);
  const rightEnd = normalizeRecordDate(right.endDate);

  const strongSchool = fieldsMatch(leftSchool, rightSchool);
  const strongDegree = fieldsMatch(leftDegree, rightDegree);
  const strongField = fieldsMatch(leftField, rightField);
  const strongStart = fieldsMatch(leftStart, rightStart);
  const strongEnd = fieldsMatch(leftEnd, rightEnd);
  const qualification = (degree: string, field: string) =>
    `${degree} ${field}`
      .replace(/\b(?:in|of|degree|s)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const sameQualification = fieldsMatch(
    qualification(leftDegree, leftField),
    qualification(rightDegree, rightField),
  );
  const degreeCompatible = fieldsCompatible(
    leftDegree,
    rightDegree,
    "substring",
  );
  const fieldCompatible = fieldsCompatible(leftField, rightField, "substring");

  if (
    (!sameQualification && (!degreeCompatible || !fieldCompatible)) ||
    !fieldsCompatible(leftStart, rightStart, "date") ||
    !fieldsCompatible(leftEnd, rightEnd, "date")
  )
    return false;

  // Complementary readings can share only the school: one has a graduation
  // year, the other the qualification. They also need shared source-entry
  // evidence; a school name and missing fields alone remain ambiguous.
  // A reading with the school and dates but no degree or field cannot invent
  // a qualification when it is matched by its dates: a dated stub against a
  // saved full record is the same entry read twice. A degree-only reading and
  // a field-only reading still need shared source evidence (see below).
  const datedStub =
    (!leftDegree && !leftField) || (!rightDegree && !rightField);
  const complementaryReadings =
    sharedSourceEntry &&
    strongSchool &&
    degreeCompatible &&
    fieldCompatible &&
    fieldsCompatible(leftStart, rightStart, "date") &&
    fieldsCompatible(leftEnd, rightEnd, "date") &&
    (!left.location ||
      !right.location ||
      normalizeRecordText(left.location) ===
        normalizeRecordText(right.location)) &&
    Boolean(leftDegree || leftField || leftStart || leftEnd) &&
    Boolean(rightDegree || rightField || rightStart || rightEnd);

  return (
    complementaryReadings ||
    (strongSchool &&
      sameQualification &&
      fieldsCompatible(leftStart, rightStart, "date") &&
      fieldsCompatible(leftEnd, rightEnd, "date")) ||
    (strongSchool &&
      strongDegree &&
      (strongStart || strongEnd || fieldCompatible)) ||
    (strongSchool &&
      strongStart &&
      (strongDegree || strongField || datedStub) &&
      degreeCompatible &&
      fieldCompatible) ||
    (strongSchool &&
      degreeCompatible &&
      fieldCompatible &&
      (strongDegree || strongField || (datedStub && strongEnd))) ||
    // A stub of the same degree at the same school (no dates, no field) is
    // the same degree read twice, not a second qualification: both ended up
    // printed on an approved PDF.
    (strongSchool &&
      strongDegree &&
      ((!leftField && !leftStart && !leftEnd) ||
        (!rightField && !rightStart && !rightEnd)))
  );
}

export function scoreExperienceRecordCompleteness(value: unknown): number {
  if (!isObjectRecord(value)) {
    return 0;
  }

  return countTruthyFields([
    value.companyName,
    value.companyUrl,
    value.title,
    value.employmentType,
    value.location,
    value.startDate,
    value.endDate,
    value.isCurrent,
    value.summary,
    value.peopleManagementScope,
    value.ownershipScope,
    value.workMode,
    value.achievements,
    value.skills,
    value.domainTags,
  ]);
}

export function scoreEducationRecordCompleteness(value: unknown): number {
  if (!isObjectRecord(value)) {
    return 0;
  }

  return countTruthyFields([
    value.schoolName,
    value.degree,
    value.fieldOfStudy,
    value.location,
    value.startDate,
    value.endDate,
    value.summary,
  ]);
}
