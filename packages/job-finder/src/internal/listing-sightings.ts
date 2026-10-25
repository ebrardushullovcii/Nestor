import type { SavedJob, SavedJobDiscoveryProvenance } from "@nestor/contracts";

/**
 * One job, seen on several sources (ADR 0030).
 *
 * Every source that listed a job keeps its own sighting in the job's
 * provenance: the listing page it linked to, the application link it carried,
 * and, once that page has been read, the apply link the page itself shows.
 * The saved job is built from exactly one sighting, never a mix of two:
 *
 * 1. The earliest-discovered sighting whose application route is the
 *    employer's own form wins.
 * 2. When no sighting is known to be one, the earliest-discovered sighting
 *    that is not an access gate wins.
 * 3. Equal discovery times go to the lower target id, so the result never
 *    depends on the order the sightings were merged in.
 *
 * "The employer's own form" is read from the route's shape, never from a site
 * name (ADR 0007): the sighting came from a public provider feed (the feed is
 * the applicant tracking system itself), or the apply link on its listing page
 * stays on the site the listing is on. A link that leaves that site is a
 * hand-off, and so is an in-board quick apply.
 */

export type SightingRoute = "employer_form" | "handoff" | "unknown";

type SightingInput = Pick<
  SavedJobDiscoveryProvenance,
  | "targetId"
  | "startingUrl"
  | "discoveredAt"
  | "providerKey"
  | "listingUrl"
  | "applicationUrl"
  | "pageApplyUrl"
  | "routeReadAt"
  | "applyPath"
>;

const ACCESS_GATE_SEGMENT =
  /^(?:auth|captcha|challenge|login|security|sign-?in|verify|verification)$/u;

export function isLikelyAccessGateListingUrl(value: string): boolean {
  try {
    return new URL(value).pathname
      .split("/")
      .filter(Boolean)
      .some((segment) => ACCESS_GATE_SEGMENT.test(segment.toLowerCase()));
  } catch {
    return false;
  }
}

function parseHttpUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * The part of a host that names one site: `jobs.example.com` and
 * `apply.example.com` are one site; an IP address or `localhost` is its own.
 * A two-letter second-level label (`co.uk`, `com.au`) keeps one more label.
 */
function siteOfHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/u, "");
  if (/^[\d.]+$/u.test(host) || host.includes(":") || !host.includes(".")) {
    return host;
  }
  const labels = host.split(".");
  const keep =
    labels.length >= 3 &&
    (labels[labels.length - 2]?.length ?? 0) <= 3 &&
    (labels[labels.length - 1]?.length ?? 0) === 2
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}

function firstPathSegment(url: URL): string {
  return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

/**
 * Where one source's own pages live. Normally the whole site. When another
 * source of the same job starts on the same host under a different path, the
 * host is shared (several boards on one host), and the source's first path
 * segment is part of its scope.
 */
function sourceScope(
  sighting: SightingInput,
  all: readonly SightingInput[],
): { site: string; host: string; pathSegment: string | null } | null {
  const start = parseHttpUrl(sighting.startingUrl);
  if (!start) return null;
  const segment = firstPathSegment(start);
  const sharedHost = all.some((other) => {
    if (other === sighting) return false;
    const otherStart = parseHttpUrl(other.startingUrl);
    return (
      otherStart !== null &&
      otherStart.host === start.host &&
      firstPathSegment(otherStart) !== segment
    );
  });
  return {
    site: siteOfHost(start.hostname),
    host: start.host,
    pathSegment: sharedHost && segment ? segment : null,
  };
}

function isInsideScope(
  url: URL,
  scope: NonNullable<ReturnType<typeof sourceScope>>,
): boolean {
  if (scope.pathSegment !== null) {
    return (
      url.host === scope.host && firstPathSegment(url) === scope.pathSegment
    );
  }
  return siteOfHost(url.hostname) === scope.site;
}

export function classifySightingRoute(
  sighting: SightingInput,
  all: readonly SightingInput[] = [sighting],
): SightingRoute {
  if (
    !sighting.listingUrl ||
    isLikelyAccessGateListingUrl(sighting.listingUrl)
  ) {
    return "handoff";
  }
  if (
    sighting.applyPath === "easy_apply" ||
    sighting.applyPath === "external_redirect"
  ) {
    return "handoff";
  }
  if (sighting.providerKey) {
    return "employer_form";
  }
  const listing = parseHttpUrl(sighting.listingUrl);
  const scope = sourceScope(sighting, all);
  if (!listing || !scope) return "unknown";
  // The link the collection itself carried counts when it is not just the
  // listing page repeated; otherwise only a read of the page can tell.
  const collected =
    sighting.applicationUrl && sighting.applicationUrl !== sighting.listingUrl
      ? parseHttpUrl(sighting.applicationUrl)
      : null;
  const evidence = sighting.routeReadAt
    ? parseHttpUrl(sighting.pageApplyUrl)
    : (parseHttpUrl(sighting.pageApplyUrl) ?? collected);
  if (!evidence) {
    // A read page with no separate apply link is still not proof either way.
    return "unknown";
  }
  return isInsideScope(evidence, scope) ? "employer_form" : "handoff";
}

function compareDiscovery(left: SightingInput, right: SightingInput): number {
  const leftAt = Date.parse(left.discoveredAt);
  const rightAt = Date.parse(right.discoveredAt);
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.targetId < right.targetId
    ? -1
    : left.targetId > right.targetId
      ? 1
      : 0;
}

/** Sightings that carry their own listing link, oldest first. */
export function listJobSightings<T extends SightingInput>(
  provenance: readonly T[],
): T[] {
  return provenance
    .filter((entry) => Boolean(entry.listingUrl))
    .sort(compareDiscovery);
}

/** The one sighting the saved job is built from, or null when none records a link. */
export function selectCanonicalSighting<T extends SightingInput>(
  provenance: readonly T[],
): T | null {
  const sightings = listJobSightings(provenance);
  if (sightings.length === 0) return null;
  const employerForm = sightings.find(
    (entry) => classifySightingRoute(entry, sightings) === "employer_form",
  );
  if (employerForm) return employerForm;
  return (
    sightings.find(
      (entry) => !isLikelyAccessGateListingUrl(entry.listingUrl ?? ""),
    ) ?? sightings[0]!
  );
}

/**
 * The source an application for this job starts on: the sighting whose own
 * listing or application link is the job's, or else the one source whose
 * pages the job's application link lives on. A job merged from several
 * sources applies on its canonical listing (ADR 0030), so its application
 * is named after that source, not after whichever source saw it last.
 * Null when no sighting can be tied to the link.
 */
export function selectApplicationSighting<T extends SightingInput>(job: {
  canonicalUrl: string;
  applicationUrl?: string | null;
  provenance: readonly T[];
}): T | null {
  const applicationLink = job.applicationUrl ?? job.canonicalUrl;
  const byLink = job.provenance.find(
    (entry) =>
      (entry.listingUrl != null &&
        (entry.listingUrl === job.canonicalUrl ||
          entry.listingUrl === applicationLink)) ||
      (entry.applicationUrl != null &&
        entry.applicationUrl === applicationLink),
  );
  if (byLink) return byLink;
  const link = parseHttpUrl(applicationLink);
  if (!link) return null;
  const inScope = job.provenance.filter((entry) => {
    const scope = sourceScope(entry, job.provenance);
    return scope !== null && isInsideScope(link, scope);
  });
  return inScope.length === 1 ? inScope[0]! : null;
}

/**
 * Sightings worth reading for their apply link: the job has more than one,
 * none is yet known to be the employer's own form, and this one has not been
 * read. Reading them is what lets the rule above choose.
 */
export function listUnreadSightings<T extends SightingInput>(
  provenance: readonly T[],
): T[] {
  const sightings = listJobSightings(provenance);
  if (sightings.length < 2) return [];
  if (
    sightings.some(
      (entry) => classifySightingRoute(entry, sightings) === "employer_form",
    )
  ) {
    return [];
  }
  return sightings.filter(
    (entry) =>
      !entry.routeReadAt &&
      classifySightingRoute(entry, sightings) === "unknown",
  );
}

/**
 * Only jobs nobody has started work on may change which listing they show.
 * From a resume draft on, the listing and application link stay put so a
 * later sighting can neither stale an approved resume nor move an
 * application in flight.
 */
export function canSwitchCanonicalSighting(
  job: Pick<SavedJob, "status">,
): boolean {
  return job.status === "discovered" || job.status === "shortlisted";
}

/**
 * Provenance written before sightings kept their own links: give the job's
 * current listing to its earliest entry, so the listing it shows today stays
 * the incumbent instead of disappearing from the choice.
 */
export function attributeLegacySighting(
  provenance: readonly SavedJobDiscoveryProvenance[],
  job: Pick<
    SavedJob,
    | "canonicalUrl"
    | "applicationUrl"
    | "sourceJobId"
    | "applyPath"
    | "title"
    | "company"
    | "location"
    | "salaryText"
    | "seniority"
    | "description"
    | "summary"
  >,
): SavedJobDiscoveryProvenance[] {
  if (provenance.some((entry) => entry.listingUrl === job.canonicalUrl)) {
    return [...provenance];
  }
  const legacy = [...provenance]
    .filter((entry) => !entry.listingUrl)
    .sort(compareDiscovery)[0];
  if (!legacy) return [...provenance];
  return provenance.map((entry) =>
    entry === legacy
      ? {
          ...entry,
          listingFacts: {
            title: job.title,
            company: job.company,
            location: job.location,
            salaryText: job.salaryText,
            seniority: job.seniority,
            description: job.description,
            summary: job.summary,
          },
          listingUrl: job.canonicalUrl,
          applicationUrl: job.applicationUrl,
          sourceJobId: job.sourceJobId,
          applyPath: job.applyPath,
        }
      : entry,
  );
}
