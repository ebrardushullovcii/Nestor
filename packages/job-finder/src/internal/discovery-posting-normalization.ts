import {
  deriveListingDetailCapture,
  type JobDiscoveryTarget,
  type JobPosting,
  type JobSource,
} from "@nestor/contracts";
import { prepareDiscoveryPosting } from "./discovery-posting-preparation";
import { assessJobPostingDetailQuality } from "./job-posting-detail-quality";
import {
  normalizeListingText,
  stripPictographGlyphs,
} from "@nestor/browser-agent/listing-detail-extraction";
import {
  collapseRepeatedLocationTokens,
  isTruncatedLocationFragment,
  looksLikePlaceValue,
} from "./listing-field-shapes";

const EMPLOYER_ABSENCE_LABEL = "Employer not stated";

/** Letters and digits only, for comparing two names people would call equal. */
function toComparableName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The employer to store for one listing.
 *
 * A card that repeated the job title in its employer slot is not naming a
 * hirer. Empty values and repeated titles become the absence placeholder every
 * screen already knows to hide, so the Companies list stays useful.
 */
export function resolveListingEmployer(
  company: string | null | undefined,
  title: string,
): string {
  // A colour location pin or a flag beside the name is decoration the board
  // drew, not part of who is hiring.
  const normalized = stripPictographGlyphs(
    normalizeListingText(company ?? ""),
  ).trim();
  const comparable = toComparableName(normalized);
  if (comparable.length === 0) return EMPLOYER_ABSENCE_LABEL;
  if (comparable === toComparableName(title)) return EMPLOYER_ABSENCE_LABEL;
  // A place is not a hirer. When an extraction read the wrong cell — a whole
  // source once recorded "United States" as the employer — the honest answer
  // is that the employer was not stated, not a country printed under
  // "Company".
  if (looksLikePlaceValue(normalized)) return EMPLOYER_ABSENCE_LABEL;
  return normalized;
}

const LOCATION_ABSENCE_LABEL = "Location not stated";

/**
 * The location to store for one listing.
 *
 * A fragment that trails off mid-phrase ("Security Remote in") never named a
 * place, and the same mis-read that produced it is what put a country in the
 * employer cell. Storing the absence placeholder keeps the pair honest: the
 * screen says the location was not stated instead of printing half a sentence
 * where a city belongs.
 */
export function resolveListingLocation(
  location: string | null | undefined,
): string {
  const normalized = stripPictographGlyphs(
    normalizeListingText(location ?? ""),
  ).trim();
  if (normalized.length === 0) return LOCATION_ABSENCE_LABEL;
  if (isTruncatedLocationFragment(normalized)) return LOCATION_ABSENCE_LABEL;
  return collapseRepeatedLocationTokens(normalized) || LOCATION_ABSENCE_LABEL;
}

export function toProviderAwarePosting(input: {
  posting: JobPosting;
  target: JobDiscoveryTarget;
  collectionMethod: JobPosting["collectionMethod"];
  discoveryMethod: JobPosting["discoveryMethod"];
  intelligence: NonNullable<JobPosting["sourceIntelligence"]>;
  adapterKind: JobSource;
}): JobPosting {
  const provider = input.intelligence.provider;
  const normalizedDescription = normalizeListingText(input.posting.description);
  const detailQuality =
    input.posting.listingDetailFetch?.outcome === "enriched"
      ? "detail_enriched"
      : assessJobPostingDetailQuality(input.posting);

  return prepareDiscoveryPosting({
    ...input.posting,
    source: input.posting.source ?? input.adapterKind,
    discoveryMethod: input.discoveryMethod,
    collectionMethod: input.collectionMethod,
    // A source label ("Indeed", "Example Board") or a repeat of the job title
    // is not an employer. When extraction found no usable company, store the
    // absence placeholder that every screen already knows to hide instead of
    // naming the board, or the role, as the hirer.
    company: resolveListingEmployer(
      input.posting.company,
      normalizeListingText(input.posting.title),
    ),
    // Titles and places are short scraped fields a board decorates with emoji;
    // the body text keeps whatever punctuation the employer wrote.
    title: stripPictographGlyphs(normalizeListingText(input.posting.title)),
    location: resolveListingLocation(input.posting.location),
    description: normalizedDescription,
    // Every short scraped field a screen prints as a fact gets the same
    // treatment as the title: a board's decorative glyph is not part of the
    // pay line, the team name or the seniority label. The body keeps whatever
    // punctuation the employer wrote.
    summary: stripPictographGlyphs(normalizeListingText(input.posting.summary)),
    salaryText: stripPictographGlyphs(
      normalizeListingText(input.posting.salaryText),
    ),
    employmentType: stripPictographGlyphs(
      normalizeListingText(input.posting.employmentType),
    ),
    seniority: stripPictographGlyphs(
      normalizeListingText(input.posting.seniority),
    ),
    department: stripPictographGlyphs(
      normalizeListingText(input.posting.department),
    ),
    team: stripPictographGlyphs(normalizeListingText(input.posting.team)),
    providerKey: input.posting.providerKey ?? provider?.key ?? null,
    providerBoardToken:
      input.posting.providerBoardToken ?? provider?.boardToken ?? null,
    providerIdentifier:
      input.posting.providerIdentifier ?? provider?.providerIdentifier ?? null,
    atsProvider: input.posting.atsProvider ?? provider?.label ?? null,
    sourceIntelligence: input.intelligence,
    detailQuality,
    // One capture state per job, set the moment the posting is normalized, so
    // "was the listing text read?" has an answer for every retained row from
    // the first commit onward instead of only after a detail read.
    listingDetailCapture: deriveListingDetailCapture({
      description: normalizedDescription ?? "",
      detailQuality,
      listingDetailFetch: input.posting.listingDetailFetch,
    }),
  });
}
