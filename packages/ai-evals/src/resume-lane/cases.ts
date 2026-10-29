import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The resume lane's inputs: synthetic people from the blind-persona fixtures
 * and real public listings recorded once (`fixtures/resume-lane`), so every
 * run writes against the same text.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../..");
const personaDir = path.join(
  repositoryRoot,
  "apps/desktop/test-fixtures/job-finder/blind-personas/resumes",
);

export interface RecordedListing {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  recordedAt: string;
  description: string;
  /** Reviewed technology/credential vocabulary, not a capitalization guess. */
  technologies?: readonly string[];
  credentials?: readonly string[];
}

export interface ResumeLaneCase {
  id: string;
  persona: string;
  listingId: string;
  /** A listing the person only partly fits; tailoring must still stay true. */
  stretch: boolean;
  /** The language the resume must be written in; English when absent. */
  language?: string;
}

export const RESUME_LANE_CASES: readonly ResumeLaneCase[] = [
  {
    id: "frontend-staff",
    persona: "experienced-technical",
    listingId: "datadog-frontend",
    stretch: false,
  },
  {
    id: "frontend-to-analytics",
    persona: "experienced-technical",
    listingId: "samsara-analytics-engineer",
    stretch: true,
  },
  {
    id: "marketing-lifecycle",
    persona: "marketing-manager",
    listingId: "stripe-lifecycle-marketing",
    stretch: false,
  },
  {
    id: "qa-support-engineer",
    persona: "remote-qa-support",
    listingId: "gitlab-support-engineer",
    stretch: false,
  },
  {
    id: "driver-operations",
    persona: "logistics-transition",
    listingId: "gopuff-operations-associate",
    stretch: false,
  },
  // Keyword-heavy posting: two dozen named tools the person mostly lacks.
  {
    id: "support-tool-list",
    persona: "remote-qa-support",
    listingId: "brex-developer-support",
    stretch: true,
  },
  // Non-software fields.
  {
    id: "hotel-to-support",
    persona: "hospitality-support",
    listingId: "instacart-bilingual-cx-spanish",
    stretch: false,
  },
  {
    id: "payroll-specialist",
    persona: "payroll-admin",
    listingId: "sofi-payroll-specialist",
    stretch: false,
  },
  // Long career: 22 years across two roles.
  {
    id: "retail-to-customer-care",
    persona: "older-nontechnical",
    listingId: "carvana-customer-care",
    stretch: false,
  },
  // German posting: the resume is written in German; the dental training it
  // asks for is not in the source.
  {
    id: "claims-german",
    persona: "healthcare-admin",
    listingId: "ottonova-claims-german",
    stretch: true,
    language: "German",
  },
];

export function readPersonaResume(persona: string): string {
  return readFileSync(path.join(personaDir, `${persona}.txt`), "utf8");
}

export function readRecordedListings(): ReadonlyMap<string, RecordedListing> {
  const listings = JSON.parse(
    readFileSync(
      path.join(here, "../../fixtures/resume-lane/listings.json"),
      "utf8",
    ),
  ) as RecordedListing[];
  return new Map(listings.map((listing) => [listing.id, listing]));
}

/** Named technologies reviewed against the recorded listings. */
export function resumeTechnologyNames(): readonly string[] {
  return [
    ...new Set(
      [...readRecordedListings().values()].flatMap(
        (listing) => listing.technologies ?? [],
      ),
    ),
  ];
}
