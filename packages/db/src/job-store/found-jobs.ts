import type {
  FoundJob,
  JobStage,
  SaveFoundJobsResult,
} from "@nestor/contracts";
import { toWorkModeMask } from "./job-list";
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

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      const lower = name.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMETERS.has(lower)) {
        url.searchParams.delete(name);
      }
    }
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
 * careers home page that every job of the employer shares.
 */
function isSpecificApplyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.search.length > 1 ||
      parsed.pathname.split("/").filter(Boolean).length >= 2
    );
  } catch {
    return false;
  }
}

interface JobKeys {
  /** Each one alone proves the same job, strongest first. */
  strong: string[];
  /** Same title, employer and place: the same job only across sites. */
  facts: string | null;
  site: string;
}

function keysOf(job: FoundJob): JobKeys {
  const listing = normalizeUrl(job.url);
  const strong: string[] = [];
  if (job.sourceJobId?.trim()) {
    strong.push(`id:${job.sourceId}:${job.sourceJobId.trim().toLowerCase()}`);
  }
  strong.push(`url:${listing}`);
  if (job.applyUrl && isSpecificApplyUrl(job.applyUrl)) {
    const apply = normalizeUrl(job.applyUrl);
    if (apply !== listing) strong.push(`url:${apply}`);
  }
  const title = normalizeText(job.title);
  const company = normalizeText(job.company);
  const location = normalizeText(job.location);
  return {
    strong,
    facts:
      title && company && location
        ? `facts:${title}|${company}|${location}`
        : null,
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
    "SELECT k.job_id, j.stage, j.found_by FROM job_keys k JOIN jobs j ON j.id = k.job_id WHERE k.key = ?",
  );
  const sameSite = sql(
    "SELECT 1 FROM job_sightings WHERE job_id = ? AND site = ? LIMIT 1",
  );
  const addKey = sql(
    "INSERT OR IGNORE INTO job_keys (key, job_id) VALUES (?, ?)",
  );
  const addSighting = sql(
    `INSERT INTO job_sightings (job_id, url, site, source_id, source_label, apply_url, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id, url) DO UPDATE SET seen_at = excluded.seen_at,
       apply_url = coalesce(excluded.apply_url, apply_url)`,
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
       apply_url = coalesce(apply_url, ?),
       work_modes = CASE WHEN work_modes = 0 THEN ? ELSE work_modes END,
       source_count = (SELECT count(DISTINCT site) FROM job_sightings WHERE job_id = ?)
     WHERE id = ?`,
  );
  const refreshDetails = sql(
    `UPDATE job_details SET
       description = CASE WHEN length(?) > length(description) THEN ? ELSE description END,
       summary = coalesce(summary, ?),
       seniority = coalesce(seniority, ?),
       employment_type = coalesce(employment_type, ?),
       salary_min = coalesce(salary_min, ?),
       salary_max = coalesce(salary_max, ?),
       salary_currency = coalesce(salary_currency, ?)
     WHERE job_id = ?`,
  );

  for (const job of jobs) {
    const keys = keysOf(job);
    let match: KeyMatch | undefined;
    for (const key of keys.strong) {
      match = findKey.get(key) as KeyMatch | undefined;
      if (match) break;
    }
    if (!match && keys.facts) {
      const candidate = findKey.get(keys.facts) as KeyMatch | undefined;
      if (candidate && !sameSite.get(candidate.job_id, keys.site)) {
        match = candidate;
      }
    }

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
    );
    for (const key of keys.strong) addKey.run(key, id);
    if (keys.facts) addKey.run(keys.facts, id);
    if (match) {
      refreshJob.run(
        now,
        job.salaryText,
        postedAt,
        job.applyUrl,
        workModes,
        id,
        id,
      );
      refreshDetails.run(
        job.description,
        job.description,
        job.summary,
        job.seniority,
        job.employmentType,
        job.salaryMin,
        job.salaryMax,
        job.salaryCurrency,
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
