import type {
  FoundJob,
  JobStage,
  SaveFoundJobsResult,
} from "@nestor/contracts";
import { toWorkModeMask } from "./job-list";
import { joinSavedJobs } from "./same-postings";
import {
  hasSentApplication,
  sentElsewhere,
  sentPages,
  sentThroughPosting,
} from "./sent-postings";
import type { Statements } from "./statements";

const TRACKING_PARAMETERS = new Set([
  "gh_src",
  "lever-source",
  "ref",
  "referrer",
  "source",
  "sourceid",
  "trackingid",
  "trk",
]);

/** The URL without its fragment and tracking parameters. */
function withoutTracking(value: string): URL {
  const url = new URL(value.trim());
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMETERS.has(lower)) {
      url.searchParams.delete(name);
    }
  }
  return url;
}

export function normalizeUrl(value: string): string {
  try {
    const url = withoutTracking(value);
    url.searchParams.sort();
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return `${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();
}

/** A site is its host and first path segment: several boards share a host. */
function siteOf(url: string): string {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").find(Boolean) ?? "";
    return `${parsed.host.toLowerCase()}/${first.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * An apply link identifies a job only when it points at one form, not at a
 * careers home page that every job of the employer shares. Tracking
 * parameters name the board that sent the person, not the form.
 */
function isSpecificApplyUrl(url: string): boolean {
  try {
    const parsed = withoutTracking(url);
    return (
      parsed.search.length > 1 ||
      parsed.pathname.split("/").filter(Boolean).length >= 2
    );
  } catch {
    return false;
  }
}

/** Our own stand-ins for an unknown employer or title; they name nobody. */
const UNSTATED = new Set([
  "company not stated",
  "company not stated on card",
  "title not stated",
]);

/**
 * The prefix every role key of one employer and title shares. A role key is
 * this prefix plus the job id, so one role can name several saved jobs and a
 * key range finds them all.
 */
export function rolePrefix(company: string, title: string): string | null {
  const employer = normalizeText(company);
  const role = normalizeText(title);
  if (!employer || !role || UNSTATED.has(employer) || UNSTATED.has(role))
    return null;
  return `role:${employer}|${role}|`;
}

/** One employer, or one side does not name it. */
// A legal form names how an employer is registered, not which employer it is:
// "CircuitHub" and "Circuithub Ltd" are one company.
const LEGAL_FORMS = new Set([
  "ag",
  "ab",
  "as",
  "bv",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
  "inc",
  "incorporated",
  "kg",
  "limited",
  "llc",
  "llp",
  "ltd",
  "nv",
  "oy",
  "plc",
  "pty",
  "sa",
  "sarl",
  "sas",
  "se",
  "sl",
  "spa",
  "srl",
  "ug",
]);

function employerName(value: string): string {
  const words = normalizeText(value).split(" ").filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words.at(-1)!)) words.pop();
  return words.join(" ");
}

function sameEmployer(left: string, right: string): boolean {
  const [a, b] = [normalizeText(left), normalizeText(right)];
  if (!a || !b || UNSTATED.has(a) || UNSTATED.has(b) || a === b) return true;
  return employerName(left) === employerName(right);
}

/** The end of a role prefix's key range: "|" is followed by "}". */
export const roleRangeEnd = (prefix: string) => `${prefix.slice(0, -1)}}`;

/** One host within the other: "al.linkedin.com" and "www.linkedin.com" are one site. */
function sameHostSite(left: string, right: string): boolean {
  try {
    const [a, b] = [left, right].map((url) =>
      new URL(url).hostname.toLowerCase().replace(/^www\./u, ""),
    ) as [string, string];
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return true;
  }
}

/**
 * Where a board sends the person to apply when that is somewhere else: the
 * employer's or its applicant system's own form. A board's own sign-in or
 * apply page is not an employer target.
 */
export function employerApplyTarget(
  listingUrl: string,
  applyUrl: string | null | undefined,
): string | null {
  if (!applyUrl || !isSpecificApplyUrl(applyUrl)) return null;
  return sameHostSite(listingUrl, applyUrl) ? null : normalizeUrl(applyUrl);
}

/** Two postings with different employer targets are different postings. */
export function targetsConflict(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (!left.size || !right.size) return false;
  for (const target of left) if (right.has(target)) return false;
  return true;
}

/**
 * The board a listing URL belongs to, across its country and "www" hosts:
 * "al.linkedin.com" and "nl.linkedin.com" are one board, where two listings
 * with one title are two openings.
 */
export function boardOf(url: string): string {
  try {
    const labels = new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./u, "")
      .split(".");
    return (labels.length >= 3 ? labels.slice(1) : labels).join(".");
  } catch {
    return url.toLowerCase();
  }
}

/**
 * A saved job's boards and employer apply targets, from every sighting, and
 * the employer pages its sent application went through.
 */
export function savedPostingFacts(
  sql: Statements,
  id: number,
): { boards: Set<string>; targets: Set<string>; sent: Set<string> } {
  const rows = sql(
    `SELECT url, apply_url FROM job_sightings WHERE job_id = ?
     UNION ALL SELECT url, apply_url FROM jobs WHERE id = ?`,
  ).all(id, id) as { url: string; apply_url: string | null }[];
  const boards = new Set<string>();
  const targets = new Set<string>();
  for (const row of rows) {
    boards.add(boardOf(row.url));
    const target = employerApplyTarget(row.url, row.apply_url);
    if (target) targets.add(target);
  }
  return { boards, targets, sent: sentPages(sql, id) };
}

/**
 * Saved jobs with this employer and title that may be the same posting seen
 * on another board: none of them is on `boards` and none applies somewhere
 * other than `targets`. Exactly one candidate is that posting; several are
 * separate openings that share a title, and stay apart.
 */
export function samePostingCandidates(
  sql: Statements,
  prefix: string,
  boards: ReadonlySet<string>,
  targets: ReadonlySet<string>,
  except?: number,
  sent: ReadonlySet<string> = new Set(),
): number[] {
  const ids = (
    sql(
      "SELECT DISTINCT job_id FROM job_keys WHERE key >= ? AND key < ? ORDER BY job_id",
    ).all(prefix, roleRangeEnd(prefix)) as { job_id: number }[]
  ).map((row) => row.job_id);
  return ids.filter((id) => {
    if (id === except) return false;
    const saved = savedPostingFacts(sql, id);
    for (const board of boards) if (saved.boards.has(board)) return false;
    return !(
      targetsConflict(saved.targets, targets) ||
      sentElsewhere(saved.sent, targets) ||
      sentElsewhere(sent, saved.targets)
    );
  });
}

interface JobKeys {
  /** Each one alone proves the same job, strongest first. */
  strong: string[];
  /** Same title, employer and place: the same job only across sites. */
  facts: string | null;
  /** Same employer and title on another board, decided with its apply target. */
  role: string | null;
  target: string | null;
  site: string;
}

function keysOf(job: FoundJob): JobKeys {
  const listing = normalizeUrl(job.url);
  const strong: string[] = [];
  if (job.sourceJobId?.trim()) {
    strong.push(`id:${job.sourceId}:${job.sourceJobId.trim().toLowerCase()}`);
  }
  strong.push(`url:${listing}`);
  // Only the employer's own form names one posting. A board's own apply,
  // sign-in or help page can be shared by every listing on that board.
  const target = employerApplyTarget(job.url, job.applyUrl);
  if (target && target !== listing) strong.push(`url:${target}`);
  const title = normalizeText(job.title);
  const company = normalizeText(job.company);
  const location = normalizeText(job.location);
  return {
    strong,
    facts:
      title && company && location
        ? `facts:${title}|${company}|${location}`
        : null,
    role: rolePrefix(job.company, job.title),
    target,
    site: siteOf(job.url),
  };
}

type KeyMatch = { job_id: number; stage: JobStage; found_by: string | null };

function toMs(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Writes one batch of found jobs in the caller's transaction. A job that
 * shares a key with a saved one is merged into it and keeps its stage, so a
 * repeat search adds only new jobs and never brings back a hidden one.
 */
export function writeFoundJobs(
  sql: Statements,
  searchId: string | null,
  jobs: readonly FoundJob[],
  now: number,
): SaveFoundJobsResult & { mergedStages: Set<JobStage> } {
  const added: number[] = [];
  const hidden: number[] = [];
  const merged = new Set<number>();
  const alreadySaved = new Set<number>();
  const mergedStages = new Set<JobStage>();
  const ids: number[] = [];
  const findKey = sql(
    "SELECT k.job_id, j.stage, j.found_by, j.company FROM job_keys k JOIN jobs j ON j.id = k.job_id WHERE k.key = ?",
  );
  const sameSite = sql(
    "SELECT 1 FROM job_sightings WHERE job_id = ? AND site = ? LIMIT 1",
  );
  const jobMatch = sql(
    "SELECT id AS job_id, stage, found_by FROM jobs WHERE id = ?",
  );
  const addKey = sql(
    "INSERT OR IGNORE INTO job_keys (key, job_id) VALUES (?, ?)",
  );
  const addSighting = sql(
    `INSERT INTO job_sightings (job_id, url, site, source_id, source_label, apply_url, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id, url) DO UPDATE SET seen_at = excluded.seen_at,
       apply_url = CASE WHEN ? THEN excluded.apply_url ELSE coalesce(excluded.apply_url, apply_url) END`,
  );
  const insertJob = sql(
    `INSERT INTO jobs (stage, stage_at, stage_note, title, company, location, work_modes,
       salary_text, posted_at, found_at, seen_at, found_by, source_label, url, apply_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDetails = sql(
    `INSERT INTO job_details (job_id, description, summary, seniority, employment_type,
       salary_min, salary_max, salary_currency, facts_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const refreshJob = sql(
    `UPDATE jobs SET seen_at = max(seen_at, ?),
       salary_text = coalesce(salary_text, ?),
       posted_at = CASE WHEN posted_at = 0 THEN ? ELSE posted_at END,
       apply_url = CASE WHEN ? THEN ? ELSE coalesce(apply_url, ?) END,
       work_modes = CASE WHEN work_modes = 0 THEN ? ELSE work_modes END,
       source_count = (SELECT count(DISTINCT site) FROM job_sightings WHERE job_id = ?)
     WHERE id = ?`,
  );
  const rebindListing = sql(
    `UPDATE jobs SET title=?, company=?, location=?, work_modes=?, salary_text=?, apply_url=? WHERE id=?`,
  );
  const oldListing = sql("SELECT url, apply_url FROM jobs WHERE id=?");
  const refreshDetails = sql(
    `UPDATE job_details SET
       description = CASE WHEN ? THEN ?
         WHEN coalesce(json_extract(facts_json, '$.fullListingRead'), 0) = 0 AND length(?) > length(description) THEN ?
         ELSE description END,
       facts_json = CASE WHEN ? THEN json_patch(facts_json, ?) ELSE facts_json END,
       summary = CASE WHEN ? THEN ? ELSE coalesce(summary, ?) END,
       seniority = CASE WHEN ? THEN ? ELSE coalesce(seniority, ?) END,
       employment_type = CASE WHEN ? THEN ? ELSE coalesce(employment_type, ?) END,
       salary_min = CASE WHEN ? THEN ? ELSE coalesce(salary_min, ?) END,
       salary_max = CASE WHEN ? THEN ? ELSE coalesce(salary_max, ?) END,
       salary_currency = CASE WHEN ? THEN ? ELSE coalesce(salary_currency, ?) END
     WHERE job_id = ?`,
  );

  for (const job of jobs) {
    const fullRead = job.facts?.fullListingRead === true ? 1 : 0;
    const keys = keysOf(job);
    let match: KeyMatch | undefined;
    for (const key of keys.strong) {
      const found = findKey.get(key) as
        | (KeyMatch & { company: string })
        | undefined;
      // An external apply destination or a board's repeated number can
      // represent multiple employers, for example a shared application portal.
      if (
        found &&
        (key.startsWith("id:") ||
          (keys.target && key === `url:${keys.target}`)) &&
        !sameEmployer(found.company, job.company)
      )
        continue;
      match = found;
      if (match) break;
    }
    // Facts and role matches join another board's sighting of the posting.
    // That board's page never rewrites the saved listing's own facts.
    let otherBoard = false;
    if (!match && keys.facts) {
      const candidate = findKey.get(keys.facts) as KeyMatch | undefined;
      if (candidate && !sameSite.get(candidate.job_id, keys.site)) {
        match = candidate;
        otherBoard = true;
      }
    }
    if (!match && keys.role) {
      const candidates = samePostingCandidates(
        sql,
        keys.role,
        new Set([boardOf(job.url)]),
        new Set(keys.target ? [keys.target] : []),
      );
      if (candidates.length === 1) {
        match = jobMatch.get(candidates[0]!) as KeyMatch;
        otherBoard = true;
      }
    }

    // A saved job that already holds this listing's employer posting, or
    // sent an application through it, is this posting too. A listing first
    // saved under its board's redirect meets it only now that the redirect
    // was followed.
    if (keys.target) {
      const holder = findKey.get(`url:${keys.target}`) as
        | (KeyMatch & { company: string })
        | undefined;
      const others = new Set<number>(
        sentThroughPosting(sql, keys.role, keys.target),
      );
      if (holder && sameEmployer(holder.company, job.company))
        others.add(holder.job_id);
      for (const other of others) {
        if (!match) match = jobMatch.get(other) as KeyMatch;
        else if (other !== match.job_id) {
          const kept = joinSavedJobs(sql, match.job_id, other);
          if (kept !== null) match = jobMatch.get(kept) as KeyMatch;
        }
      }
    }

    // A job with a sent application keeps the employer, role and posting it
    // was applied to. Only its own listing's read rewrites them; any other
    // listing of it adds its sighting.
    const held =
      match !== undefined &&
      hasSentApplication(sql, match.job_id) &&
      normalizeUrl((oldListing.get(match.job_id) as { url: string }).url) !==
        normalizeUrl(job.url);
    if (held) otherBoard = true;

    const postedAt = toMs(job.postedAt);
    const workModes = toWorkModeMask(job.workModes);
    let id = match?.job_id ?? 0;
    if (!match) {
      id = Number(
        insertJob.run(
          job.hiddenReason ? "hidden" : "found",
          now,
          job.hiddenReason?.trim() || null,
          job.title,
          job.company,
          job.location,
          workModes,
          job.salaryText,
          postedAt,
          now,
          now,
          searchId,
          job.sourceLabel,
          job.url,
          job.applyUrl,
        ).lastInsertRowid,
      );
      insertDetails.run(
        id,
        job.description,
        job.summary,
        job.seniority,
        job.employmentType,
        job.salaryMin,
        job.salaryMax,
        job.salaryCurrency,
        JSON.stringify(job.facts ?? {}),
      );
      if (job.hiddenReason)
        sql("UPDATE jobs SET hide_owner=? WHERE id=?").run(
          job.hideOwner ?? "person",
          id,
        );
      if (job.hiddenReason) hidden.push(id);
      else added.push(id);
    }
    ids.push(id);
    addSighting.run(
      id,
      job.url,
      keys.site,
      job.sourceId,
      job.sourceLabel,
      job.applyUrl,
      now,
      fullRead,
    );
    for (const key of keys.strong) addKey.run(key, id);
    if (keys.facts) addKey.run(keys.facts, id);
    if (keys.role && (!match || !otherBoard)) {
      // Its own page names the role now; another board's wording joins it
      // only through that board's sighting.
      if (match && fullRead)
        sql(
          "DELETE FROM job_keys WHERE job_id=? AND key >= 'role:' AND key < 'role;'",
        ).run(id);
      addKey.run(`${keys.role}${id}`, id);
    }
    if (match) {
      if (fullRead && !otherBoard) {
        const previous = oldListing.get(id) as {
          url: string;
          apply_url: string | null;
        };
        if (
          previous.apply_url &&
          normalizeUrl(previous.apply_url) !==
            normalizeUrl(job.applyUrl ?? job.url)
        ) {
          // An obsolete application link must not keep binding other postings
          // to this row after its own page corrected it.
          const obsoleteKey = `url:${normalizeUrl(previous.apply_url)}`;
          sql(
            "UPDATE job_sightings SET apply_url=NULL WHERE job_id=? AND apply_url=? AND url<>?",
          ).run(id, previous.apply_url, job.url);
          if (
            obsoleteKey !== `url:${normalizeUrl(previous.url)}` &&
            obsoleteKey !== `url:${normalizeUrl(job.url)}`
          )
            sql("DELETE FROM job_keys WHERE job_id=? AND key=?").run(
              id,
              obsoleteKey,
            );
        }
        rebindListing.run(
          job.title,
          job.company,
          job.location,
          workModes,
          job.salaryText,
          job.applyUrl,
          id,
        );
        sql(
          "DELETE FROM job_keys WHERE job_id=? AND key LIKE 'facts:%' AND key IS NOT ?",
        ).run(id, keys.facts);
      }
      // The employer's form replaces a board's own link the job had.
      const stored = oldListing.get(id) as {
        url: string;
        apply_url: string | null;
      };
      refreshJob.run(
        now,
        job.salaryText,
        postedAt,
        keys.target !== null &&
          employerApplyTarget(stored.url, stored.apply_url) === null
          ? 1
          : 0,
        job.applyUrl,
        job.applyUrl,
        workModes,
        id,
        id,
      );
      const replaces = held ? 0 : fullRead;
      refreshDetails.run(
        replaces,
        job.description,
        job.description,
        job.description,
        fullRead,
        JSON.stringify(
          held
            ? { applyLinkFollowed: job.facts?.applyLinkFollowed }
            : (job.facts ?? {}),
        ),
        ...[
          job.summary,
          job.seniority,
          job.employmentType,
          job.salaryMin,
          job.salaryMax,
          job.salaryCurrency,
        ].flatMap((value) => [replaces, value, value]),
        id,
      );
      merged.add(id);
      if (searchId === null || match.found_by !== searchId)
        alreadySaved.add(id);
      mergedStages.add(match.stage);
    }
  }
  // A second sighting in this batch is a duplicate too. alreadySaved alone
  // distinguishes jobs that predate the current search.
  return {
    added,
    hidden,
    merged: [...merged],
    alreadySaved: [...alreadySaved],
    ids,
    mergedStages,
  };
}
