import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  browserAgentPermissionsOf,
  intendedAccountEmail,
  toJobSearchGoals,
  type BrowserAgentPermissions,
  type CandidateProfile,
  type DiscoveryRunResult,
  type JobDetail,
  type JobListingFactsInput,
  type JobPosting,
  type JobFinderSettings,
  type JobSearchPreferences,
} from "@nestor/contracts";

/** What the model reading a vacancy in Nestor's browser is given about the person. */
export interface BrowserListingReadContext {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  browserPermissions?: BrowserAgentPermissions;
  readIntendedAccountEmail?: () => string | null | Promise<string | null>;
  readBrowserPermissions?: () =>
    | BrowserAgentPermissions
    | Promise<BrowserAgentPermissions>;
}

export interface BrowserListingReadDeps {
  browserRuntime: Pick<BrowserSessionRuntime, "runAgentDiscovery">;
  aiClient: JobFinderAiClient;
}

export function listingFactsFromPosting(
  posting: JobPosting,
  fullListingRead: boolean,
): JobListingFactsInput {
  if (!fullListingRead) return { fullListingRead };
  return {
    fullListingRead,
    keySkills: posting.keySkills,
    responsibilities: posting.responsibilities,
    minimumQualifications: posting.minimumQualifications,
    preferredQualifications: posting.preferredQualifications,
    benefits: posting.benefits,
    department: posting.department,
    team: posting.team,
    employerDomain: posting.employerDomain,
    atsProvider: posting.atsProvider,
  };
}

/**
 * The model reads one vacancy in full in Nestor's browser, with the page
 * tools a person has: it sees the page as it renders, can wait for it, scroll
 * it and follow it to the employer's own posting. Search reads every listing
 * it keeps this way, and so does anything that needs a posting's text later.
 */
export async function readListingInBrowser(
  deps: BrowserListingReadDeps,
  input: {
    listing: { url: string; title: string; text: string };
    sourceId: string;
    sourceLabel: string;
    context: BrowserListingReadContext;
    signal: AbortSignal;
  },
): Promise<DiscoveryRunResult> {
  if (!deps.browserRuntime.runAgentDiscovery)
    throw new Error("Browser navigation is unavailable.");
  const { context } = input;
  const browserPermissions = context.readBrowserPermissions
    ? await context.readBrowserPermissions()
    : context.browserPermissions;
  return deps.browserRuntime.runAgentDiscovery("target_site", {
    ...(browserPermissions ? { browserPermissions } : {}),
    ...(context.readBrowserPermissions
      ? { readBrowserPermissions: context.readBrowserPermissions }
      : {}),
    ...(context.readIntendedAccountEmail
      ? { readIntendedAccountEmail: context.readIntendedAccountEmail }
      : {}),
    dedicatedPage: true,
    requestedListing: input.listing,
    retainAllFound: true,
    userProfile: context.profile,
    searchPreferences: toJobSearchGoals(context.searchPreferences),
    startingUrls: [input.listing.url],
    searchRequest: {
      intent:
        "Read this supplied vacancy in full and keep its complete text. This is a listing read, not a fit decision; do not reject it for preferences or expected fit.",
      breadth: "wide",
      freshness: "any",
      sourceIds: [input.sourceId],
    },
    navigationHostnames: [new URL(input.listing.url).hostname],
    siteLabel: input.sourceLabel,
    siteInstructions: [
      "Read the supplied vacancy in full, including every requirement and the application link. This is a full listing read, not a fit decision: retain this vacancy regardless of its expected fit. Preserve its complete text in description. Missing metadata is unknown, not a reason to drop a vacancy. Do not apply.",
      "When this page shows only part of the vacancy and points to the employer's own posting, such as an Apply on company website link, open that posting and read the vacancy there.",
      "If the supplied URL leads to an index and the requested vacancy is absent, return the index address in finish.listingIndexUrl. The search can collect that index once for all the postings that led there.",
      "Use this browser's imported session and the saved vault sign-in or Google sign-in when needed. Attempt permitted sign-in and site checks before asking the person. Never ask for or expose a password the vault can type. If a real attempt fails, hand off on the open page with exactly what happened.",
    ],
    targetJobCount: 1,
    maxSteps: Number.MAX_SAFE_INTEGER,
    signal: input.signal,
    aiClient: deps.aiClient,
  });
}

/** Reads a saved job's posting: the vacancy the model read in full. */
export type PostingReader = (
  job: JobDetail,
  signal: AbortSignal,
) => Promise<JobPosting>;

/** A saved job's posting, read by the model in Nestor's browser. */
export function createBrowserPostingReader(
  deps: BrowserListingReadDeps & {
    /** The person's profile and settings, read fresh for each read. */
    readInputs(): Promise<{
      profile: CandidateProfile;
      searchPreferences: JobSearchPreferences;
      settings: JobFinderSettings;
    }>;
  },
): PostingReader {
  return async (job, signal) => {
    const { profile, searchPreferences } = await deps.readInputs();
    const sighting =
      job.sightings.find((entry) => entry.url === job.url) ?? job.sightings[0];
    const discovery = await readListingInBrowser(deps, {
      listing: {
        url: job.url,
        title: job.title,
        text: [job.title, job.company, job.location, job.description].join(
          "\n",
        ),
      },
      sourceId: sighting?.sourceId ?? job.sourceLabel,
      sourceLabel: sighting?.sourceLabel ?? job.sourceLabel,
      context: {
        profile,
        searchPreferences,
        readIntendedAccountEmail: async () =>
          intendedAccountEmail((await deps.readInputs()).profile),
        readBrowserPermissions: async () =>
          browserAgentPermissionsOf((await deps.readInputs()).settings),
      },
      signal,
    });
    signal.throwIfAborted();
    const read = discovery.jobs.filter(
      (candidate) => candidate.listingDetailFetch?.outcome === "enriched",
    );
    // The reading model says which vacancy it read is the requested one.
    const posting =
      read.find((candidate) => candidate.requestedListingMatch?.same) ??
      read.find(
        (candidate) => candidate.requestedListingMatch?.same !== false,
      ) ??
      read[0];
    if (!posting)
      throw new Error(
        discovery.warning ??
          "The browser agent did not finish reading this vacancy.",
      );
    return posting;
  };
}
