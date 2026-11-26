import { normalizeUrl, roleRangeEnd } from "./found-jobs";
import type { Statements } from "./statements";

interface SentRecord {
  outcome: string | null;
  execution: string | null;
  review: string | null;
}

function parse(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/**
 * The employer pages a sent application was sent from: the page of the
 * final send, the form it prepared, and the pages its confirmation names.
 */
function recordPages(record: SentRecord): string[] {
  const pages: string[] = [];
  const outcome = parse(record.outcome) as {
    evidence?: { destination?: { origin?: string; safePath?: string } }[];
  } | null;
  for (const entry of outcome?.evidence ?? [])
    if (entry.destination?.origin && entry.destination.safePath)
      pages.push(`${entry.destination.origin}${entry.destination.safePath}`);
  const execution = parse(record.execution) as {
    stepReceipts?: { kind?: string; url?: string | null }[];
  } | null;
  for (const receipt of execution?.stepReceipts ?? [])
    if (receipt.kind === "final" && receipt.url) pages.push(receipt.url);
  const review = parse(record.review) as { pageUrl?: string } | null;
  if (review?.pageUrl) pages.push(review.pageUrl);
  return pages;
}

/** A normalized URL's host and path segments. */
function segments(normalized: string): { host: string; path: string[] } {
  const url = new URL(`https://${normalized}`);
  return { host: url.host, path: url.pathname.split("/").filter(Boolean) };
}

/**
 * A page lies at or under an employer's posting: its form, its apply step or
 * its confirmation. A posting is at least two path segments deep, so an
 * employer's whole board ("/acme") never contains another posting's form.
 */
function atOrUnder(page: string, posting: string): boolean {
  try {
    const [a, b] = [segments(page), segments(posting)];
    return (
      a.host === b.host &&
      b.path.length >= 2 &&
      b.path.every((part, index) => a.path[index] === part)
    );
  } catch {
    return false;
  }
}

/** The employer pages this job's sent applications went through, normalized. */
export function sentPages(sql: Statements, id: number): Set<string> {
  const records = sql(
    `SELECT a.submission_outcome_json AS outcome, d.execution_json AS execution, d.review_json AS review
     FROM applications a LEFT JOIN application_details d ON d.application_id = a.id
     WHERE a.job_id = ? AND a.state = 'submitted'`,
  ).all(id) as unknown as SentRecord[];
  return new Set(records.flatMap(recordPages).map(normalizeUrl));
}

/** Whether one of these pages lies at or under this employer posting. */
export function sentThrough(
  pages: ReadonlySet<string>,
  posting: string,
): boolean {
  for (const page of pages) if (atOrUnder(page, posting)) return true;
  return false;
}

/**
 * A job's sent application went through another employer's site than every
 * employer target the other posting names: they are different postings.
 * Sites, not pages, are compared: the last page of a send (a Workday task
 * page, a confirmation) is often not the posting's own address.
 */
export function sentElsewhere(
  pages: ReadonlySet<string>,
  targets: ReadonlySet<string>,
): boolean {
  if (!pages.size || !targets.size) return false;
  const host = (url: string) => {
    try {
      return segments(url).host;
    } catch {
      return url;
    }
  };
  const hosts = new Set([...pages].map(host));
  for (const target of targets) if (hosts.has(host(target))) return false;
  return true;
}

/**
 * Saved jobs of this employer and title whose sent application went through
 * this employer posting. A board that only stored its own redirect for the
 * listing that was applied to (Working Nomads' /job/go/…) leaves nothing
 * else to tie its other listing of that posting to the application.
 */
export function sentThroughPosting(
  sql: Statements,
  role: string | null,
  posting: string,
): number[] {
  if (!role) return [];
  const ids = (
    sql(
      "SELECT DISTINCT job_id FROM job_keys WHERE key >= ? AND key < ? ORDER BY job_id",
    ).all(role, roleRangeEnd(role)) as { job_id: number }[]
  ).map((row) => row.job_id);
  return ids.filter((id) => sentThrough(sentPages(sql, id), posting));
}

/** Whether this job has a sent application. */
export function hasSentApplication(sql: Statements, id: number): boolean {
  return Boolean(
    sql(
      "SELECT 1 FROM applications WHERE job_id = ? AND state = 'submitted' LIMIT 1",
    ).get(id),
  );
}
