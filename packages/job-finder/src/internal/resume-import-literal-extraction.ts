import type {
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
  ResumeImportFieldCandidateDraft,
} from "@nestor/contracts";

import { toCandidate } from "./resume-import-candidate-utils";
import { isClearlyResumeDateRange } from "./resume-import-common";

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

function cleanLocationCandidate(value: string): string | null {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.replace(/^Address:\s*/i, "");
  const withoutSuffix = withoutPrefix.replace(/\s*\([^)]*\)\s*$/u, "");
  return withoutSuffix.trim() || null;
}

function isLikelyNameToken(value: string): boolean {
  return /^[A-Z][A-Za-z.'-]*$/.test(value) || /^[A-Z]{2,}$/.test(value);
}

const nonNamePhrasePattern =
  /\b(software|engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|consulting|technical|mentorship|leadership|performance|productivity|quality|security|platform|platforms|systems|cloud|devops|support|experience|summary|profile|skills|project|projects|work|professional|staff|senior|principal|lead|frontend|backend|full-stack|scale)\b/i;

function trimTrailingContactFragments(value: string): string {
  return (
    cleanLocationCandidate(value.split(/\s*[·|]\s*/)[0] ?? value)
      ?.replace(
        /\s+(?:\(?\+?\d[\d\s().-]{7,}\d\)?|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/\S+|(?:www\.)?(?:linkedin|github)\.com\/\S+)$/i,
        "",
      )
      .trim() ?? ""
  );
}

function extractNameFromHeaderLine(line: string): string | null {
  const cleaned = line.trim().replace(/\s+/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  for (
    let tokenCount = 2;
    tokenCount <= Math.min(4, tokens.length);
    tokenCount += 1
  ) {
    const candidate = tokens.slice(0, tokenCount).join(" ");
    const remainder = tokens.slice(tokenCount).join(" ").trim();

    if (!candidate || !remainder) {
      continue;
    }

    const isName =
      candidate.length <= 48 &&
      !nonNamePhrasePattern.test(candidate) &&
      candidate.split(/\s+/).every(isLikelyNameToken);

    if (!isName) {
      continue;
    }

    if (
      /^\+?\d/.test(remainder) ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(remainder) ||
      /(?:https?:\/\/|(?:www\.)?(?:linkedin|github)\.com\/)/i.test(remainder) ||
      isLikelyLocationValue(trimTrailingContactFragments(remainder))
    ) {
      return candidate;
    }
  }

  return null;
}

function extractLocationFromHeaderLine(
  line: string,
  fullName: string | null,
): string | null {
  let candidate = line.trim().replace(/\s+/g, " ");

  if (fullName) {
    const escapedName = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    candidate = candidate.replace(new RegExp(`^${escapedName}\\s+`, "i"), "");
  }

  candidate = trimTrailingContactFragments(candidate);

  if (isLikelyLocationValue(candidate))
    return cleanLocationCandidate(candidate);
  const match = candidate.match(
    /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*,\s*(?:[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?|[A-Za-z][A-Za-z\s.'-]+))$/,
  );

  return cleanLocationCandidate(match?.[1] ?? candidate);
}

function isLikelyPersonName(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 48) {
    return false;
  }

  if (/[@\d]|https?:\/\//i.test(trimmed)) {
    return false;
  }

  if (
    /(about me|about|summary|profile|skills|experience|education|language skills|work experience)/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  if (nonNamePhrasePattern.test(trimmed)) {
    return false;
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  return (
    parts.length >= 2 &&
    parts.length <= 4 &&
    /^[A-Za-z][A-Za-z\s.'-]+$/.test(trimmed) &&
    parts.every(isLikelyNameToken)
  );
}

function isLikelyLocationValue(value: string): boolean {
  const cleaned = cleanLocationCandidate(value);

  if (!cleaned || cleaned.length > 80) {
    return false;
  }

  if (/[@]|https?:\/\//i.test(cleaned)) {
    return false;
  }

  if (/[.!?]/.test(cleaned)) {
    return false;
  }

  if (
    /\b(recently|decided|return|passion|experience|building|driven|improving)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  return (
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$/.test(
      cleaned,
    ) ||
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$/.test(cleaned) ||
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(
      cleaned,
    ) ||
    /^[A-Za-z][A-Za-z\s.'-]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(cleaned)
  );
}

function isLinkedInUrl(url: string): boolean {
  return /(?:https?:\/\/)?(?:www\.)?linkedin\.com\//i.test(url);
}

function isGithubUrl(url: string): boolean {
  return /(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(url);
}

function isPortfolioUrl(url: string): boolean {
  return /(?:https?:\/\/)?(?:www\.)?(?:behance\.net|dribbble\.com)\//i.test(
    url,
  );
}

function isPersonalWebsiteUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }

  return !isLinkedInUrl(url) && !isGithubUrl(url) && !isPortfolioUrl(url);
}

function extractHeaderWorkModes(documentBundle: ResumeDocumentBundle): {
  modes: Array<"remote" | "hybrid" | "onsite" | "flexible">;
  evidenceLines: string[];
  sourceBlockIds: string[];
} {
  const sectionHeadingPattern =
    /^(?:summary|profile|experience|work experience|employment|education|skills|projects?|certifications?|languages?)\s*:?$/i;
  const headerBlocks = [...documentBundle.blocks]
    .sort((left, right) => left.readingOrder - right.readingOrder)
    .slice(0, 12);
  const modes: Array<"remote" | "hybrid" | "onsite" | "flexible"> = [];
  const evidenceLines: string[] = [];
  const sourceBlockIds: string[] = [];
  let reachedBody = false;
  for (const block of headerBlocks) {
    for (const rawLine of block.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (sectionHeadingPattern.test(line)) {
        reachedBody = true;
        break;
      }
      const negated =
        /\b(?:not|no|never|without|avoid(?:ing)?|exclude(?:d|s|ing)?|unavailable)\b.{0,30}\b(?:remote|hybrid|on[- ]?site|flexible)\b/i.test(
          line,
        ) ||
        /\b(?:remote|hybrid|on[- ]?site|flexible)\b.{0,30}\b(?:not|never|unavailable|excluded)\b/i.test(
          line,
        );
      if (negated) continue;

      const matched: Array<"remote" | "hybrid" | "onsite" | "flexible"> = [];
      if (
        /^remote(?:[- ]first)?(?:\b|[,|])/i.test(line) ||
        /[|,]\s*remote(?:[- ]first)?\b/i.test(line) ||
        /\b(?:seeking|open to|prefer(?:red|ring)?|looking for)\s+(?:a\s+)?remote\b/i.test(
          line,
        ) ||
        /\bremote[- ](?:role|work|position|workplace|arrangement)s?\b/i.test(
          line,
        )
      ) {
        matched.push("remote");
      }
      if (
        /^hybrid(?:\b|[,|])/i.test(line) ||
        /\b(?:seeking|open to|prefer(?:red|ring)?|looking for)\s+(?:a\s+)?hybrid\b/i.test(
          line,
        ) ||
        /\bhybrid[- ](?:role|work|position|workplace|arrangement)s?\b/i.test(
          line,
        )
      ) {
        matched.push("hybrid");
      }
      if (
        /^on[- ]?site(?:\b|[,|])/i.test(line) ||
        /\b(?:seeking|open to|prefer(?:red|ring)?|looking for)\s+(?:an?\s+)?on[- ]?site\b/i.test(
          line,
        ) ||
        /\bon[- ]?site[- ](?:role|work|position|workplace|arrangement)s?\b/i.test(
          line,
        )
      ) {
        matched.push("onsite");
      }
      if (
        /^flexible$/i.test(line) ||
        /\bflexible[- ](?:work|location|work mode|arrangement|role|position)s?\b/i.test(
          line,
        ) ||
        /\b(?:seeking|open to|prefer(?:red|ring)?|looking for)\s+(?:a\s+)?flexible\s+(?:work|location|arrangement|role|position)/i.test(
          line,
        )
      ) {
        matched.push("flexible");
      }
      if (matched.length > 0) {
        modes.push(...matched);
        evidenceLines.push(line);
        sourceBlockIds.push(block.id);
      }
    }
    if (reachedBody) break;
  }
  return {
    modes: [...new Set(modes)],
    evidenceLines: [...new Set(evidenceLines)],
    sourceBlockIds: [...new Set(sourceBlockIds)],
  };
}

/**
 * Places a resume can name when it says where the person may work, in the
 * words forms use. Anything else must read as a proper name (capitalised
 * words) to be kept at all.
 */
const WORK_PLACE_ALIASES: Record<string, string> = {
  us: "United States",
  "u.s": "United States",
  "u.s.": "United States",
  usa: "United States",
  "u.s.a": "United States",
  "u.s.a.": "United States",
  "united states": "United States",
  "united states of america": "United States",
  america: "United States",
  uk: "United Kingdom",
  "u.k": "United Kingdom",
  "u.k.": "United Kingdom",
  "united kingdom": "United Kingdom",
  "great britain": "United Kingdom",
  britain: "United Kingdom",
  eu: "European Union",
  "e.u": "European Union",
  "e.u.": "European Union",
  "european union": "European Union",
  eea: "European Economic Area",
  "european economic area": "European Economic Area",
};

/** "EU citizen", "British passport holder": the adjective names the place. */
const NATIONALITY_PLACES: Record<string, string> = {
  us: "United States",
  "u.s.": "United States",
  american: "United States",
  uk: "United Kingdom",
  british: "United Kingdom",
  eu: "European Union",
  european: "European Union",
  "european union": "European Union",
  albanian: "Albania",
  australian: "Australia",
  austrian: "Austria",
  belgian: "Belgium",
  brazilian: "Brazil",
  bulgarian: "Bulgaria",
  canadian: "Canada",
  croatian: "Croatia",
  czech: "Czechia",
  danish: "Denmark",
  dutch: "Netherlands",
  estonian: "Estonia",
  finnish: "Finland",
  french: "France",
  german: "Germany",
  greek: "Greece",
  hungarian: "Hungary",
  indian: "India",
  irish: "Ireland",
  italian: "Italy",
  japanese: "Japan",
  kosovar: "Kosovo",
  latvian: "Latvia",
  lithuanian: "Lithuania",
  mexican: "Mexico",
  norwegian: "Norway",
  polish: "Poland",
  portuguese: "Portugal",
  romanian: "Romania",
  singaporean: "Singapore",
  slovak: "Slovakia",
  slovenian: "Slovenia",
  spanish: "Spain",
  swedish: "Sweden",
  swiss: "Switzerland",
  ukrainian: "Ukraine",
};

// A line about the work the person did for others ("helped clients obtain
// work permits for Canada") is not a statement about the person.
const THIRD_PARTY_CONTEXT =
  /\b(?:clients?|customers?|employees?|candidates?|applicants?|staff|team members?|users?|workers|students|nationals|hires)\b/i;

function normalizeWorkPlace(raw: string): string | null {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/^(?:the)\s+/i, "")
    .replace(/[\s,]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 40) {
    return null;
  }
  const alias = WORK_PLACE_ALIASES[cleaned.toLowerCase()];
  if (alias) {
    return alias;
  }
  const words = cleaned.split(" ");
  return words.length <= 4 &&
    words.every((word) => /^\p{Lu}[\p{L}.'-]*$/u.test(word))
    ? cleaned
    : null;
}

function splitWorkPlaces(raw: string): string[] {
  const bounded = raw.split(
    /\s+(?:without|with|for|since|until|as|on|under|via|through|but|who|which|while|and\s+(?:do|does|will|am|have|need|require))\b/i,
  )[0];
  return (bounded ?? "")
    .split(/\s*(?:,|&|\/|\band\b|\bor\b)\s*/i)
    .map((part) => normalizeWorkPlace(part))
    .filter((part): part is string => Boolean(part));
}

/**
 * "U.S." and friends carry periods that would end a clause early; spell
 * them without periods before anything reads the line.
 */
function normalizeEligibilityLine(line: string): string {
  return line
    .replace(/\bU\.\s?S\.\s?A\.?(?=\s|$|[^\p{L}])/giu, "USA")
    .replace(/\bU\.\s?S\.?(?=\s|$|[^\p{L}])/giu, "US")
    .replace(/\bU\.\s?K\.?(?=\s|$|[^\p{L}])/giu, "UK")
    .replace(/\bE\.\s?U\.?(?=\s|$|[^\p{L}])/giu, "EU")
    .replace(/[’‘]/g, "'");
}

/**
 * Words that turn a statement of eligibility into its opposite or into
 * something that is not true yet: "not authorized to work in", "awaiting
 * green card", "applied for a work permit in". A legal answer is never read
 * from such a clause; setup asks instead.
 */
const ELIGIBILITY_NEGATION =
  /\b(?:not|no|non|never|without|yet|pending|awaiting|await|applying|applied|apply|application|in\s+progress|expired|expiring|former|formerly|previously|seeking|once|upon|expect|expects|expected|expecting|cannot|lack|lacks|lacking)\b|n't\b|\bwill\s+be\b|\bwould\s+be\b/i;

/**
 * What may follow the place in the same clause without turning the
 * statement around. "Authorized to work in the US without sponsorship" is a
 * yes; "Eligible to work in Canada (pending)" and "Authorized to work in the
 * US: No" are not.
 */
const ELIGIBILITY_TAIL_NEGATION =
  /\b(?:yet|pending|awaiting|applying|applied|application|in\s+progress|expired|expiring|expected|from\s+\d{4}|starting|once|upon)\b|[:?]\s*(?:no|false|n)\b/i;

/** Text from the start of the clause that holds `index` up to `index`. */
function clauseLead(line: string, index: number): string {
  const before = line.slice(0, index);
  const boundary = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf(";"),
    before.lastIndexOf(","),
  );
  return before.slice(boundary + 1);
}

/** Text from `index` to the end of its clause. */
function clauseTail(line: string, index: number): string {
  const after = line.slice(index);
  const boundary = after.search(/[.;,]/);
  return boundary === -1 ? after : after.slice(0, boundary);
}

/**
 * `matchStart..claimEnd` is the claim ("authorized to work in", "US
 * citizen"); the clause before it must not negate it, and what follows it
 * in the clause must not say it is pending, expired or answered "No".
 */
function statesEligibility(
  line: string,
  matchStart: number,
  claimEnd: number,
): boolean {
  const lead = clauseLead(line, matchStart) + line.slice(matchStart, claimEnd);
  return (
    !ELIGIBILITY_NEGATION.test(lead) &&
    !ELIGIBILITY_TAIL_NEGATION.test(clauseTail(line, claimEnd))
  );
}

const SPONSORSHIP_WORD = /\b(?:visa\s+)?sponsor(?:ship)?\b/i;

/**
 * "Sponsorship required: No", "Need visa sponsorship? Yes": a form-style
 * answer. The value after the colon or question mark decides; a label that
 * is itself negated or is about an employer offering sponsorship is left
 * alone.
 */
function readFormStyleSponsorship(line: string): boolean | null {
  for (const match of line.matchAll(
    /([^.;,:?]*\b(?:sponsorship|visa\s+sponsor)\b[^.;,:?]*)[:?]\s*(yes|no|true|false|y|n)\b/gi,
  )) {
    const label = match[1] ?? "";
    if (
      ELIGIBILITY_NEGATION.test(label) ||
      /\b(?:offer|offers|offering|provide|provides|providing|available|company|employer|employers)\b/i.test(
        label,
      )
    ) {
      continue;
    }
    const answer = (match[2] ?? "").toLowerCase();
    return answer === "yes" || answer === "true" || answer === "y";
  }
  return null;
}

/**
 * Work-authorization and sponsorship facts the resume states outright.
 *
 * Application forms ask both on almost every job. A resume that says "EU
 * citizen, no visa sponsorship required" has answered them; nothing here is
 * inferred from where the person lives or wants to work. Negated, pending or
 * ambiguous statements yield nothing, so setup asks the person.
 */
export function extractExplicitWorkEligibility(
  documentBundle: ResumeDocumentBundle,
): {
  authorizedWorkCountries: {
    values: string[];
    evidence: string[];
    blockIds: string[];
  } | null;
  requiresVisaSponsorship: {
    value: boolean;
    evidence: string;
    blockIds: string[];
  } | null;
} {
  const countries: string[] = [];
  const countryEvidence: string[] = [];
  const countryBlockIds: string[] = [];
  let sponsorship: {
    value: boolean;
    evidence: string;
    blockIds: string[];
  } | null = null;

  const blocks = [...documentBundle.blocks].sort(
    (left, right) => left.readingOrder - right.readingOrder,
  );
  for (const block of blocks) {
    for (const rawLine of block.text.split(/\r?\n/)) {
      const evidenceLine = rawLine.replace(/^[\s•*·-]+/, "").trim();
      if (
        !evidenceLine ||
        evidenceLine.length > 240 ||
        THIRD_PARTY_CONTEXT.test(evidenceLine)
      ) {
        continue;
      }
      const line = normalizeEligibilityLine(evidenceLine);

      const found: string[] = [];
      for (const pattern of [
        /\b(?:legally\s+)?(?:authori[sz]ed|eligible|entitled|permitted|allowed|cleared)\s+to\s+work\s+(?:(?:full[- ]time|permanently|legally)\s+)?in\s+([^.;:?()\n]+)/gi,
        /\bright\s+to\s+work\s+in\s+([^.;:?()\n]+)/gi,
        /\bwork\s+(?:permit|visa|authori[sz]ation)\s+(?:for|in)\s+([^.;:?()\n]+)/gi,
        /\b(?:permanent\s+resident|citizen|national)\s+of\s+([^.;:?()\n]+)/gi,
      ]) {
        for (const match of line.matchAll(pattern)) {
          const placesText = match[1] ?? "";
          const places = splitWorkPlaces(placesText);
          const matchStart = match.index ?? 0;
          const claimEnd = matchStart + match[0].length - placesText.length;
          if (
            places.length > 0 &&
            statesEligibility(line, matchStart, claimEnd)
          ) {
            found.push(...places);
          }
        }
      }
      // An adjective names the place only as a citizenship, a passport the
      // person holds, or permanent residence: "German national team",
      // "EU citizenship portal" and "Irish passport office" say nothing
      // about the person.
      for (const match of line.matchAll(
        /\b([A-Z][A-Za-z]+(?:\s+Union)?)\s+([Cc]itizen|[Pp]assport\s+[Hh]older|[Pp]assport|[Pp]ermanent\s+[Rr]esident)\b(?!\s+(?:[Tt]eam|[Ss]ervices?|[Pp]ortal|[Oo]ffice|[Pp]rogram|[Pp]rogramme|[Aa]gency|[Dd]epartment)\b)/g,
      )) {
        const place = NATIONALITY_PLACES[(match[1] ?? "").toLowerCase()];
        const matchStart = match.index ?? 0;
        const noun = (match[2] ?? "").toLowerCase();
        const matchEnd = matchStart + match[0].length;
        if (
          !place ||
          (noun === "passport" &&
            !/\b(?:hold|holds|holding|have|has|having)\s+(?:an?\s+|my\s+)?$/i.test(
              line.slice(0, matchStart),
            ))
        ) {
          continue;
        }
        if (statesEligibility(line, matchStart, matchEnd)) {
          found.push(place);
        }
      }
      for (const match of line.matchAll(
        /\b(?:green[\s-]?card\s+holder|(?:hold|holds|holding|have|has|having)\s+(?:an?\s+|my\s+)?(?:(?:US|American)\s+)?green[\s-]?card)\b/gi,
      )) {
        const matchStart = match.index ?? 0;
        if (statesEligibility(line, matchStart, matchStart + match[0].length)) {
          found.push("United States");
        }
      }
      if (found.length > 0) {
        countries.push(...found);
        countryEvidence.push(evidenceLine);
        countryBlockIds.push(block.id);
      }

      if (!sponsorship && SPONSORSHIP_WORD.test(line)) {
        const formAnswer = readFormStyleSponsorship(line);
        if (formAnswer !== null) {
          sponsorship = {
            value: formAnswer,
            evidence: evidenceLine,
            blockIds: [block.id],
          };
          continue;
        }
        // Negation must sit in the same clause as the sponsorship words:
        // "Not open to relocation, requires sponsorship" needs it.
        const negative =
          /\b(?:no|not|never|without|don't|do\s+not|does\s+not|doesn't|won't|will\s+not|shall\s+not)\b[^.;,\n]{0,40}?\b(?:visa\s+)?sponsor(?:ship)?\b/i.test(
            line,
          ) ||
          /\bsponsorship\s*[:-]?\s*(?:is\s+)?(?:not|never)\s+(?:required|needed|necessary)\b/i.test(
            line,
          );
        const positive =
          /\b(?:require|requires|required|requiring|need|needs|needing|will\s+need)\b[^.;,\n]{0,30}?\b(?:visa\s+)?sponsor(?:ship)?\b/i.test(
            line,
          ) || /\bsponsorship\s+(?:is\s+)?(?:required|needed)\b/i.test(line);
        if (negative || positive) {
          sponsorship = {
            value: !negative,
            evidence: evidenceLine,
            blockIds: [block.id],
          };
        }
      }
    }
  }

  const uniqueCountries = [...new Set(countries)];
  return {
    authorizedWorkCountries:
      uniqueCountries.length > 0
        ? {
            values: uniqueCountries,
            evidence: [...new Set(countryEvidence)],
            blockIds: [...new Set(countryBlockIds)],
          }
        : null,
    requiresVisaSponsorship: sponsorship,
  };
}

export function extractLiteralCandidates(
  runId: string,
  documentBundle: ResumeDocumentBundle,
  createdAt: string,
): ResumeImportFieldCandidate[] {
  const text = documentBundle.fullText ?? "";
  const drafts: ResumeImportFieldCandidateDraft[] = [];
  const nameBlock = documentBundle.blocks
    .slice(0, 8)
    .find((block) => isLikelyPersonName(block.text));
  const emailMatches =
    text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const phoneMatches =
    text.match(
      /(\(?\+?\d[\d\s().-]{5,}\d\)?(?:\s*(?:ext\.?|x)\s*\d{1,6})?)/gi,
    ) ?? [];
  const urlMatches = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstBlockId = documentBundle.blocks[0]?.id;
  const literalName =
    nameBlock?.text ??
    lines
      .slice(0, 12)
      .map((line) => extractNameFromHeaderLine(line))
      .find(Boolean) ??
    lines.find((line) => isLikelyPersonName(line)) ??
    null;
  const inlineLocation =
    lines
      .slice(0, 12)
      .map((line) => extractLocationFromHeaderLine(line, literalName))
      .find((line) => line && isLikelyLocationValue(line)) ?? null;
  const locationLine =
    inlineLocation ??
    lines.find(
      (line) => /^Address:/i.test(line) && isLikelyLocationValue(line),
    ) ??
    lines.find((line) => isLikelyLocationValue(line)) ??
    null;

  if (literalName) {
    const normalizedName = literalName.trim();
    drafts.push({
      target: { section: "identity", key: "fullName", recordId: null },
      label: "Full name",
      value: normalizedName,
      normalizedValue: normalizedName,
      valuePreview: normalizedName,
      evidenceText:
        normalizedName.length > 400
          ? `${normalizedName.slice(0, 400)}...`
          : normalizedName,
      sourceBlockIds: nameBlock
        ? [nameBlock.id]
        : firstBlockId
          ? [firstBlockId]
          : [],
      confidence: 0.99,
      notes: [],
      alternatives: [],
    });
  }

  const email = normalizeEmail(emailMatches[0] ?? "");
  if (email) {
    drafts.push({
      target: { section: "contact", key: "email", recordId: null },
      label: "Email",
      value: email,
      normalizedValue: email,
      valuePreview: email,
      evidenceText: email,
      sourceBlockIds: documentBundle.blocks
        .filter((block) => block.text.includes(email))
        .map((block) => block.id),
      confidence: 0.99,
      notes: [],
      alternatives: [],
    });
  }

  const phone = phoneMatches
    .find((value) => !isClearlyResumeDateRange(value))
    ?.trim();
  if (phone) {
    drafts.push({
      target: { section: "contact", key: "phone", recordId: null },
      label: "Phone",
      value: phone,
      normalizedValue: phone,
      valuePreview: phone,
      evidenceText: phone,
      sourceBlockIds: documentBundle.blocks
        .filter((block) => block.text.includes(phone))
        .map((block) => block.id),
      confidence: 0.96,
      notes: [],
      alternatives: [],
    });
  }

  if (locationLine) {
    const normalizedLocation = cleanLocationCandidate(locationLine);

    if (normalizedLocation) {
      drafts.push({
        target: { section: "location", key: "currentLocation", recordId: null },
        label: "Current location",
        value: normalizedLocation,
        normalizedValue: normalizedLocation,
        valuePreview: normalizedLocation,
        evidenceText: normalizedLocation,
        sourceBlockIds: documentBundle.blocks
          .filter((block) => block.text.includes(locationLine))
          .map((block) => block.id),
        confidence: 0.88,
        notes: [],
        alternatives: [],
      });
    }
  }

  const headerWorkMode = extractHeaderWorkModes(documentBundle);
  if (headerWorkMode.modes.length > 0) {
    drafts.push({
      target: {
        section: "search_preferences",
        key: "workModes",
        recordId: null,
      },
      label: "Work mode",
      value: headerWorkMode.modes,
      normalizedValue: headerWorkMode.modes,
      valuePreview: headerWorkMode.modes.join(", "),
      evidenceText: headerWorkMode.evidenceLines.join(" "),
      sourceBlockIds: headerWorkMode.sourceBlockIds,
      confidence: 0.99,
      notes: ["explicit_header_work_mode"],
      alternatives: [],
    });
  }

  // Preferences are explicit statements, never inferred from hours or pay
  // mentioned in the person's employment history.
  let inPreferences = false;
  let inHeader = true;
  for (const block of [...documentBundle.blocks].sort(
    (a, b) => a.readingOrder - b.readingOrder,
  )) {
    for (const rawLine of block.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^(?:work|employment) preferences\s*:?$/i.test(line)) {
        inPreferences = true;
        continue;
      }
      if (
        /^(?:experience|work experience|education|skills|projects?|certifications?|languages?|activities|references|objective|summary)\s*:?$/i.test(
          line,
        )
      ) {
        inPreferences = false;
        inHeader = false;
      }
      const hours = line.match(
        /^(?:(?:hours|employment type|work preference)\s*:\s*)?(full[- ]time|part[- ]time)$/i,
      );
      if (hours && (inPreferences || inHeader || /:/.test(line))) {
        const value = [
          /^full/i.test(hours[1] ?? "") ? "Full-time" : "Part-time",
        ];
        drafts.push({
          target: {
            section: "search_preferences",
            key: "employmentTypes",
            recordId: null,
          },
          label: "Employment type",
          value,
          normalizedValue: value,
          valuePreview: value.join(", "),
          evidenceText: line,
          sourceBlockIds: [block.id],
          confidence: 0.97,
          notes: [],
          alternatives: [],
        });
      }
      const salary =
        line.match(
          /^(?:(?:annual (?:pay|salary)|salary|pay)\s*:\s*)?([A-Z]{3}|\$)\s*([\d,]+)\s+(?:minimum|min)(?:\s+(?:annually|per year|annual))?$/i,
        ) ??
        line.match(
          /^minimum(?: salary)?\s*:\s*(?:([A-Z]{3}|\$)\s*([\d,]+)|([\d,]+)\s*([A-Z]{3}))$/i,
        );
      if (
        salary &&
        (inPreferences || inHeader || /annual|salary|pay|per year/i.test(line))
      ) {
        const value = {
          minimum: Number((salary[2] ?? salary[3] ?? "").replace(/,/g, "")),
          maximum: null,
          interval: "year",
          currency:
            (salary[1] ?? salary[4]) === "$"
              ? null
              : (salary[1] ?? salary[4] ?? "").toUpperCase(),
          currencyStatus:
            (salary[1] ?? salary[4]) === "$"
              ? "needs_clarification"
              : "explicit",
        };
        drafts.push({
          target: {
            section: "search_preferences",
            key: "compensation",
            recordId: null,
          },
          label: "Pay preference",
          value,
          normalizedValue: value,
          valuePreview: line,
          evidenceText: line,
          sourceBlockIds: [block.id],
          confidence: 0.97,
          notes: [],
          alternatives: [],
        });
        if (value.currency !== null)
          drafts.push({
            target: {
              section: "search_preferences",
              key: "salaryCurrency",
              recordId: null,
            },
            label: "Salary currency",
            value: value.currency,
            normalizedValue: value.currency,
            valuePreview: value.currency,
            evidenceText: line,
            sourceBlockIds: [block.id],
            confidence: 0.97,
            notes: [],
            alternatives: [],
          });
      }
    }
  }

  const eligibility = extractExplicitWorkEligibility(documentBundle);
  if (eligibility.authorizedWorkCountries) {
    drafts.push({
      target: {
        section: "work_eligibility",
        key: "authorizedWorkCountries",
        recordId: null,
      },
      label: "Countries where you can work",
      value: eligibility.authorizedWorkCountries.values,
      normalizedValue: eligibility.authorizedWorkCountries.values,
      valuePreview: eligibility.authorizedWorkCountries.values.join(", "),
      evidenceText: eligibility.authorizedWorkCountries.evidence.join(" "),
      sourceBlockIds: eligibility.authorizedWorkCountries.blockIds,
      confidence: 0.97,
      notes: ["explicit_eligibility_statement"],
      alternatives: [],
    });
  }
  if (eligibility.requiresVisaSponsorship) {
    drafts.push({
      target: {
        section: "work_eligibility",
        key: "requiresVisaSponsorship",
        recordId: null,
      },
      label: "Needs visa sponsorship",
      value: eligibility.requiresVisaSponsorship.value,
      normalizedValue: eligibility.requiresVisaSponsorship.value,
      valuePreview: eligibility.requiresVisaSponsorship.value ? "Yes" : "No",
      evidenceText: eligibility.requiresVisaSponsorship.evidence,
      sourceBlockIds: eligibility.requiresVisaSponsorship.blockIds,
      confidence: 0.97,
      notes: ["explicit_eligibility_statement"],
      alternatives: [],
    });
  }

  const urlTargets: Array<{
    key: ResumeImportFieldCandidateDraft["target"]["key"];
    label: string;
    matches: (url: string) => boolean;
  }> = [
    { key: "linkedinUrl", label: "LinkedIn URL", matches: isLinkedInUrl },
    { key: "githubUrl", label: "GitHub URL", matches: isGithubUrl },
    { key: "portfolioUrl", label: "Portfolio URL", matches: isPortfolioUrl },
    {
      key: "personalWebsiteUrl",
      label: "Personal website",
      matches: isPersonalWebsiteUrl,
    },
  ];
  const usedUrls = new Set<string>();

  for (const target of urlTargets) {
    const url = urlMatches.find(
      (entry) => !usedUrls.has(entry) && target.matches(entry),
    );
    if (!url) {
      continue;
    }

    usedUrls.add(url);

    drafts.push({
      target: { section: "contact", key: target.key, recordId: null },
      label: target.label,
      value: url,
      normalizedValue: url,
      valuePreview: url,
      evidenceText: url,
      sourceBlockIds: documentBundle.blocks
        .filter((block) => block.text.includes(url))
        .map((block) => block.id),
      confidence: 0.95,
      notes: [],
      alternatives: [],
    });
  }

  return drafts.map((draft, index) =>
    toCandidate(
      documentBundle,
      runId,
      "parser_literal",
      createdAt,
      draft,
      index,
    ),
  );
}
