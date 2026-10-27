import {
  isFreshStartCandidateProfile,
  resolveResumeContactIdentity,
  type CandidateProfile,
  type ResumeIdentityOwnershipAcknowledgement,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";

import { normalizeText } from "./shared";

export interface ResumeIdentityValues {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
}

export interface ResumeIdentityResolution {
  /** The one identity snapshot used by resume generation and rendering. */
  identity: ResumeIdentityValues;
  /** Profile/source contradictions that require review before rendering. */
  mismatchReasons: readonly string[];
}

const identityCandidateKeys = new Set([
  "firstName",
  "middleName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "currentLocation",
  "preferredEmail",
  "preferredPhone",
]);

const nonNamePhrasePattern =
  /\b(?:about(?:\s+me)?|summary|profile|skills?|experience|education|language\s+skills|work\s+experience|software|engineer(?:ing)?|developer|designer|manager|director|analyst|consultant|specialist|architect|technical|product|platform|frontend|front[- ]end|backend|back[- ]end|full[- ]stack|staff|senior|principal|lead|head|chief|associate|junior|intern|recruiter|marketing|sales|operations|finance|legal|customer|success|quality|security|cloud|devops|data|mobile|web|project|program)\b/iu;

const identityNameTokenPattern = /^\p{Lu}[\p{L}\p{M}.'’ʼ-]*$/u;
const identityNameLinePattern =
  /^\p{L}[\p{L}\p{M}.'’ʼ-]*(?:\s+\p{L}[\p{L}\p{M}.'’ʼ-]*)+$/u;

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function comparable(value: string | null | undefined): string {
  return (
    value
      ?.normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .replace(/[.,]/g, "")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function comparableEmail(value: string | null | undefined): string {
  return normalizeText(value ?? "");
}

function comparablePhone(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function composedProfileName(profile: CandidateProfile): string | null {
  return clean(
    [profile.firstName, profile.middleName, profile.lastName]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" "),
  );
}

function isLikelyPersonNamePart(value: string): boolean {
  const trimmed = value.trim();

  return (
    Boolean(trimmed) &&
    !nonNamePhrasePattern.test(trimmed) &&
    (identityNameTokenPattern.test(trimmed) || /^\p{Lu}{2,}$/u.test(trimmed))
  );
}

export function isLikelyPersonName(value: string): boolean {
  const trimmed = value.trim().replace(/\s+/g, " ");

  if (
    !trimmed ||
    trimmed.length > 48 ||
    /[@\d]|https?:\/\//i.test(trimmed) ||
    nonNamePhrasePattern.test(trimmed)
  ) {
    return false;
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  return (
    parts.length >= 2 &&
    parts.length <= 4 &&
    identityNameLinePattern.test(trimmed) &&
    parts.every(isLikelyPersonNamePart)
  );
}

/**
 * The person's name as it appears at the start of a header line, or null.
 *
 * Two rules that the plain line test lacked: every word must look like a name
 * part (capitalised, so a sentence tail such as "at scale." is never a name),
 * and a two-column header that the text extractor flattened into one line
 * ("Owen Mercer Tampa, FL") still yields the leading name rather than being
 * rejected for the trailing location.
 */
export function extractIdentityNameFromLine(line: string): string | null {
  const value = line.trim().replace(/\s+/g, " ");
  if (!value || value.length > 100 || /[@]|https?:\/\//i.test(value)) {
    return null;
  }

  if (
    /^(about|summary|profile|skills|experience|education|projects?|certifications?|contact|work history|professional summary)\b/i.test(
      value,
    )
  ) {
    return null;
  }
  // A document title ("Online Resume Sample", "Curriculum Vitae") is not the
  // person's name; reading it as one raised a false identity warning.
  if (/\b(r[eé]sum[eé]|cv|curriculum vitae)\b/iu.test(value)) {
    return null;
  }

  // Cut at the first token that cannot be part of a name: a digit, a pipe,
  // a bullet, a lowercase word. A token carrying a trailing comma belongs to
  // what follows it ("Tampa, FL"), so it ends the name and is not part of it.
  const words = value.split(" ");
  const nameWords: string[] = [];
  for (const word of words) {
    if (/[|•·]$/u.test(word)) {
      const bare = word.replace(/[|•·]+$/u, "");
      if (bare && isLikelyPersonNamePart(bare)) {
        nameWords.push(bare);
      }
      break;
    }
    if (/,$/u.test(word)) {
      break;
    }
    if (!isLikelyPersonNamePart(word)) {
      break;
    }
    nameWords.push(word);
    if (nameWords.length === 4) {
      break;
    }
  }
  if (nameWords.length < 2) {
    return null;
  }
  // A name never ends in a bare period unless it is an initial ("J.").
  const last = nameWords[nameWords.length - 1] ?? "";
  if (/\.$/u.test(last) && last.length > 2) {
    return null;
  }
  const candidate = nameWords.join(" ");
  return isLikelyPersonName(candidate) ? candidate : null;
}

function candidateEvidencePriority(
  candidate: ResumeImportFieldCandidate,
): number {
  switch (candidate.sourceKind) {
    case "parser_literal":
      return 4;
    case "model_identity_summary":
      return 3;
    case "model_experience":
    case "model_background":
      return 2;
    case "vision_omni":
      return 1;
    default:
      return 0;
  }
}

function candidateSourceName(
  candidates: readonly ResumeImportFieldCandidate[],
): string | null {
  const nameCandidates = candidates
    .filter(
      (candidate) =>
        candidate.target.section === "identity" &&
        candidate.target.key === "fullName" &&
        typeof candidate.value === "string" &&
        isLikelyPersonName(candidate.value),
    )
    .sort((left, right) => {
      const priorityDelta =
        candidateEvidencePriority(right) - candidateEvidencePriority(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      const evidenceDelta =
        right.sourceBlockIds.length - left.sourceBlockIds.length;
      if (evidenceDelta !== 0) {
        return evidenceDelta;
      }

      return (
        (right.confidenceBreakdown?.overall ?? right.confidence) -
        (left.confidenceBreakdown?.overall ?? left.confidence)
      );
    });
  const nameCandidate = nameCandidates[0];

  return typeof nameCandidate?.value === "string"
    ? nameCandidate.value.trim()
    : null;
}

function candidateSourceEmail(
  candidates: readonly ResumeImportFieldCandidate[],
): string | null {
  const emailCandidates = candidates
    .filter(
      (candidate) =>
        ["contact", "application_identity"].includes(
          candidate.target.section,
        ) &&
        ["email", "preferredEmail"].includes(candidate.target.key) &&
        typeof candidate.value === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.value.trim()),
    )
    .sort((left, right) => {
      const priorityDelta =
        candidateEvidencePriority(right) - candidateEvidencePriority(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return (
        (right.confidenceBreakdown?.overall ?? right.confidence) -
        (left.confidenceBreakdown?.overall ?? left.confidence)
      );
    });
  const emailCandidate = emailCandidates[0];

  return typeof emailCandidate?.value === "string"
    ? emailCandidate.value.trim()
    : null;
}

function extractCanonicalResumeIdentity(
  text: string | null | undefined,
  candidates: readonly ResumeImportFieldCandidate[] = [],
  sourceIdentity?: { fullName: string | null; email: string | null },
): Partial<ResumeIdentityValues> {
  if (sourceIdentity) {
    return {
      ...(sourceIdentity.fullName ? { fullName: sourceIdentity.fullName } : {}),
      ...(sourceIdentity.email ? { email: sourceIdentity.email } : {}),
    };
  }
  const candidateName = candidateSourceName(candidates);
  const candidateEmail = candidateSourceEmail(candidates);

  if (!text?.trim()) {
    return {
      ...(candidateName ? { fullName: candidateName } : {}),
      ...(candidateEmail ? { email: candidateEmail } : {}),
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  const name =
    candidateName ??
    lines
      .map((line) => extractIdentityNameFromLine(line))
      .find((extracted): extracted is string => extracted !== null) ??
    null;
  const sourceEmail = candidateEmail ?? email ?? null;

  return {
    ...(name ? { fullName: name } : {}),
    ...(sourceEmail ? { email: sourceEmail } : {}),
  };
}

function isFreshPlaceholderIdentityProfile(profile: CandidateProfile): boolean {
  if (!isFreshStartCandidateProfile(profile)) {
    return false;
  }

  return (
    !clean(profile.fullName) ||
    comparable(profile.fullName) === "new candidate" ||
    comparable(profile.firstName) === "new" ||
    comparable(profile.lastName) === "candidate"
  );
}

function isPlaceholderIdentityValue(
  profile: CandidateProfile,
  key: string,
  value: string | null,
): boolean {
  if (!value || !isFreshStartCandidateProfile(profile)) {
    return false;
  }

  const normalized = comparable(value);
  return (
    (key === "fullName" && normalized === "new candidate") ||
    (key === "firstName" && normalized === "new") ||
    (key === "lastName" && normalized === "candidate")
  );
}

function candidateIdentityValue(
  candidate: ResumeImportFieldCandidate,
): { key: string; value: string } | null {
  if (
    !identityCandidateKeys.has(candidate.target.key) ||
    !["identity", "contact", "location", "application_identity"].includes(
      candidate.target.section,
    ) ||
    typeof candidate.value !== "string" ||
    !candidate.value.trim()
  ) {
    return null;
  }

  if (
    candidate.target.key === "fullName" &&
    !isLikelyPersonName(candidate.value)
  ) {
    return null;
  }

  if (
    ["firstName", "middleName", "lastName"].includes(candidate.target.key) &&
    !isLikelyPersonNamePart(candidate.value)
  ) {
    return null;
  }

  return { key: candidate.target.key, value: candidate.value };
}

function currentValueForCandidate(
  profile: CandidateProfile,
  key: string,
): string | null {
  switch (key) {
    case "firstName":
      return profile.firstName;
    case "middleName":
      return profile.middleName;
    case "lastName":
      return profile.lastName;
    case "fullName":
      return (
        profile.preferredDisplayName ??
        profile.fullName ??
        composedProfileName(profile)
      );
    case "email":
      return profile.applicationIdentity.preferredEmail ?? profile.email;
    case "preferredEmail":
      return profile.applicationIdentity.preferredEmail ?? profile.email;
    case "phone":
      return profile.applicationIdentity.preferredPhone ?? profile.phone;
    case "preferredPhone":
      return profile.applicationIdentity.preferredPhone ?? profile.phone;
    case "currentLocation":
      return profile.currentLocation;
    default:
      return null;
  }
}

function valuesMatch(key: string, left: string, right: string): boolean {
  if (key.toLowerCase().includes("email")) {
    return comparableEmail(left) === comparableEmail(right);
  }
  if (key.toLowerCase().includes("phone")) {
    return comparablePhone(left) === comparablePhone(right);
  }
  return comparable(left) === comparable(right);
}

/**
 * The choice the person can make when a document names someone else.
 *
 * Returns the exact source values the block is about, so the screen can quote
 * them, and the acknowledgement to save if the person says the document is
 * theirs. Nothing here decides anything: writing the acknowledgement is the
 * person's action, and until they take it the mismatch still blocks.
 */
export function describeResumeIdentityOwnershipChoice(
  profile: CandidateProfile,
  sourceCandidates: readonly ResumeImportFieldCandidate[] = [],
  now: string = new Date().toISOString(),
): {
  sourceFullName: string | null;
  sourceEmail: string | null;
  profileFullName: string | null;
  acknowledgement: ResumeIdentityOwnershipAcknowledgement;
} {
  const { identity } = resolveResumeIdentity(profile, sourceCandidates);
  const sourceIdentity = extractCanonicalResumeIdentity(
    profile.baseResume.textContent,
    sourceCandidates,
    profile.baseResume.sourceIdentity,
  );

  return {
    sourceFullName: sourceIdentity.fullName ?? null,
    sourceEmail: sourceIdentity.email ?? null,
    profileFullName: identity.fullName,
    acknowledgement: {
      acknowledgedSourceFullName: sourceIdentity.fullName ?? null,
      acknowledgedSourceEmail: sourceIdentity.email ?? null,
      acknowledgedAt: now,
    },
  };
}

/**
 * Applies the imported resume's visible name to the editable profile after the
 * person explicitly chooses that direction. The source text remains intact;
 * only the profile identity used by future resumes and applications changes.
 */
export function useResumeSourceNameForProfile(
  profile: CandidateProfile,
  sourceCandidates: readonly ResumeImportFieldCandidate[] = [],
): CandidateProfile {
  const { sourceFullName } = describeResumeIdentityOwnershipChoice(
    profile,
    sourceCandidates,
  );
  if (!sourceFullName) {
    return profile;
  }

  const nameParts = sourceFullName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? null;
  const lastName = nameParts.length > 1 ? (nameParts.at(-1) ?? null) : null;
  const middleName =
    nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : null;

  return {
    ...profile,
    firstName,
    middleName,
    lastName,
    fullName: sourceFullName,
    preferredDisplayName: null,
    resumeIdentityOwnership: null,
  };
}

/**
 * Resolves all resume header fields from one coherent, user-visible identity.
 * Preferred display/contact values are treated as a single intentional choice;
 * the canonical imported source is retained only for contradiction detection.
 */
export function resolveResumeIdentity(
  profile: CandidateProfile,
  sourceCandidates: readonly ResumeImportFieldCandidate[] = [],
): ResumeIdentityResolution {
  // The parts the user edits on Profile win over the imported full name:
  // fixing "MARCUS BELL" to "Marcus Bell" in Basics used to leave the
  // resume header shouting, because fullName kept the imported spelling.
  const canonicalName = composedProfileName(profile) ?? clean(profile.fullName);
  const identity = resolveResumeContactIdentity(profile);
  const mismatchReasons: string[] = [];
  const derivedParts = canonicalName?.split(/\s+/).filter(Boolean) ?? [];

  if (
    profile.firstName &&
    derivedParts[0] &&
    comparable(profile.firstName) !== comparable(derivedParts[0])
  ) {
    mismatchReasons.push(
      "The visible first name does not match the resolved resume display name.",
    );
  }
  if (
    profile.lastName &&
    derivedParts.length > 1 &&
    comparable(profile.lastName) !==
      comparable(derivedParts[derivedParts.length - 1])
  ) {
    mismatchReasons.push(
      "The visible last name does not match the resolved resume display name.",
    );
  }

  const sourceIdentity = extractCanonicalResumeIdentity(
    profile.baseResume.textContent,
    sourceCandidates,
    profile.baseResume.sourceIdentity,
  );

  // A fresh placeholder profile is expected to be paired with a newly
  // imported source. Once a real identity is present, source text must agree
  // with the same visible identity used for rendering and applications —
  // unless the person has said in so many words that this document is theirs.
  const ownership = profile.resumeIdentityOwnership ?? null;
  const ownsSourceName =
    ownership !== null &&
    sourceIdentity.fullName !== null &&
    comparable(ownership.acknowledgedSourceFullName) ===
      comparable(sourceIdentity.fullName);
  const ownsSourceEmail =
    ownership !== null &&
    sourceIdentity.email !== null &&
    comparableEmail(ownership.acknowledgedSourceEmail) ===
      comparableEmail(sourceIdentity.email);

  if (
    !isFreshPlaceholderIdentityProfile(profile) &&
    !ownsSourceName &&
    sourceIdentity.fullName &&
    identity.fullName &&
    !valuesMatch("fullName", sourceIdentity.fullName, identity.fullName)
  ) {
    mismatchReasons.push(
      `The imported resume identifies '${sourceIdentity.fullName}', but the visible resume identity is '${identity.fullName}'.`,
    );
  }
  if (
    !isFreshPlaceholderIdentityProfile(profile) &&
    !ownsSourceEmail &&
    sourceIdentity.email &&
    identity.email &&
    !valuesMatch("email", sourceIdentity.email, identity.email)
  ) {
    mismatchReasons.push(
      `The imported resume email '${sourceIdentity.email}' conflicts with the visible resume email '${identity.email}'.`,
    );
  }

  return { identity, mismatchReasons };
}

/**
 * Returns candidates whose identity values contradict the current user-visible
 * profile. They remain review-only even when parser confidence would otherwise
 * permit auto-application.
 */
export function findResumeImportIdentityConflicts(
  profile: CandidateProfile,
  candidates: readonly ResumeImportFieldCandidate[],
): ReadonlyMap<string, string> {
  const conflicts = new Map<string, string>();

  for (const candidate of candidates) {
    const identityValue = candidateIdentityValue(candidate);
    if (!identityValue) {
      continue;
    }

    const currentValue = currentValueForCandidate(profile, identityValue.key);
    if (
      !currentValue ||
      isPlaceholderIdentityValue(profile, identityValue.key, currentValue) ||
      valuesMatch(identityValue.key, identityValue.value, currentValue)
    ) {
      continue;
    }

    conflicts.set(
      candidate.id,
      `Imported ${identityValue.key} '${identityValue.value}' conflicts with the current visible identity '${currentValue}'.`,
    );
  }

  return conflicts;
}

export function findResumeDraftIdentityConflicts(
  profile: CandidateProfile,
  draftIdentity: Partial<ResumeIdentityValues> | null | undefined,
): string[] {
  if (!draftIdentity) {
    return [];
  }

  const resolved = resolveResumeIdentity(profile).identity;
  const conflicts: string[] = [];
  const fields: Array<keyof ResumeIdentityValues> = [
    "fullName",
    "email",
    "phone",
    "location",
  ];

  for (const field of fields) {
    const draftValue = clean(draftIdentity[field]);
    const resolvedValue = clean(resolved[field]);
    if (
      draftValue &&
      resolvedValue &&
      !valuesMatch(field, draftValue, resolvedValue) &&
      !(
        field === "location" &&
        locationKeepsProfilePlace(draftValue, resolvedValue)
      )
    ) {
      conflicts.push(
        `The saved draft ${field} '${draftValue}' does not match the resolved profile identity '${resolvedValue}'.`,
      );
    }
  }

  return conflicts;
}

/**
 * A header location that still names the profile's place with a note added
 * ("Berlin, Germany (open to remote)") is the person describing where they
 * work, not a different person. It used to block the preview as an identity
 * mismatch. A location that drops the profile's place still counts.
 */
function locationKeepsProfilePlace(
  draftLocation: string,
  profileLocation: string,
): boolean {
  const draftComparable = comparable(draftLocation);
  const profileComparable = comparable(profileLocation);
  return (
    profileComparable.length > 0 &&
    ` ${draftComparable} `.includes(` ${profileComparable} `)
  );
}

export function resumeIdentityMismatchMessage(
  mismatchReasons: readonly string[],
): string {
  return [
    "Check the name and contact details on this resume:",
    ...mismatchReasons,
    "The resume uses your profile's details. If that is right, nothing else is needed.",
  ].join(" ");
}
