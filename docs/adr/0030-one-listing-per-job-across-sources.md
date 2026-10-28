# ADR 0030: A job seen on several sources shows the employer's own listing

Status: partly superseded: job-store deduplication keeps sightings but retains the first job URL, fills missing scalar facts and may keep a longer description (db925711), replacing employer-route selection and whole-sighting display facts. Cross-source identity merging remains.

## Context

The same job often appears on a job board and on the employer's applicant tracking system. Discovery merged the two sightings into one saved job, but `enrichDiscoveredPosting` let the latest sighting overwrite the listing link and kept the older application link when the new one had none. The saved job's listing and application link could therefore come from two different sites, and which site won depended on which source finished first. A later search could flip it again, which also staled resumes, since the application link is part of the resume's staleness signature.

## Decision

- Every source that lists a job keeps its own sighting in the job's provenance: its listing link, the application link it carried, and, once read, the apply link its page shows. Older provenance without these fields stays valid.
- The saved job is built from exactly one sighting. The earliest-discovered sighting whose application route is the employer's own form wins; if none is known to be, the earliest-discovered sighting that is not an access gate wins. Equal discovery times go to the lower target id. The result does not depend on merge order.
- "The employer's own form" is read from the route's shape, never from a site name (ADR 0007): a public provider feed, or an apply link that stays on the site the listing is on. When several sources share one host, the source's first path segment is part of its site. A link that leaves the site, a quick apply inside a board, a redirect, and an access-gate listing are hand-offs.
- After a search, the other listings of a job seen on several sources are read once each over plain HTTP (ADR 0016) for their apply link. The first 429 ends those reads until the next search.
- A new sighting also matches a saved job listed on a different site when the title, employer and place are the same, seniority is compatible, and the two do not name different application forms (compared by path, not host). The host is never part of this match: a board and the employer's own form rarely share one, and a sign-in board can serve the same listings from another host. Two listings on one site with the same facts stay two jobs, and more than a handful of saved jobs sharing the facts match none. Only discovery's merge uses this; the search ledger and company duplicate hints keep to link and content identity.
- Only jobs nobody has started work on (`discovered`, `shortlisted`) may switch. From a resume draft on, the listing and application link stay put.
- The job id and where Apply starts (`applicationUrl ?? canonicalUrl`) are unchanged. The displayed title, employer, location, salary and listing text travel with the selected sighting; they cannot come from another source. Older sightings without stored display facts keep the current route until rediscovery supplies those facts.

## Consequences

- A Board plus Greenhouse duplicate shows the Greenhouse listing and application link whichever search ran first.
- Matching a new sighting to a saved job also uses the listing links of its other sources, so a job whose shown listing moved is still recognised.
- Two employer forms for one job resolve to the first discovered; the rule never prefers an easier form.
