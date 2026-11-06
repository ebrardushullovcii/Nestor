import { createHash } from "node:crypto";
import type { FoundJob, ListingCard } from "@nestor/contracts";
import { normalizeUrl } from "./found-jobs";
import { toWorkModeMask } from "./job-list";
import type { Statements } from "./statements";

export const LISTING_CARD_EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS listing_card_evidence (
  url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  record_fingerprint TEXT NOT NULL,
  PRIMARY KEY (url, source_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS listing_card_evidence_by_job ON listing_card_evidence(job_id);
`;

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: string) => value.replace(/\s+/gu, " ").trim();
function cardFingerprint(card: ListingCard): string {
  return hash({
    title: card.title,
    // A relative age badge is a clock, not changed posting content (as in profession screening).
    text: text(
      card.text.replace(
        /^(?:Posted\s+)?\d+\s+(?:minutes?|hours?|days?|weeks?)\s+ago\s*$/gimu,
        "",
      ),
    ),
    company: card.companyHint,
    location: card.locationHint,
    closed: card.closed ?? false,
    sourceJobId: card.sourceJobId,
    listingText:
      card.listingText === undefined ? undefined : text(card.listingText),
    providerFacts: card.providerFacts
      ? {
          company: card.providerFacts.company,
          location: card.providerFacts.location,
          workModes: [...card.providerFacts.workModes].sort(),
          employmentType: card.providerFacts.employmentType,
          salaryText: card.providerFacts.salaryText,
          applyUrl: card.providerFacts.applyUrl,
        }
      : undefined,
  });
}

interface StoredListing {
  id: number;
  title: string;
  company: string;
  location: string;
  work_modes: number;
  salary_text: string | null;
  apply_url: string | null;
  description: string;
  seniority: string | null;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  full_read: number;
}
function storedListing(sql: Statements, id: number): StoredListing {
  return sql(`SELECT j.id,j.title,j.company,j.location,j.work_modes,j.salary_text,j.apply_url,
    d.description,d.seniority,d.employment_type,d.salary_min,d.salary_max,d.salary_currency,
    coalesce(json_extract(d.facts_json,'$.fullListingRead'),0) AS full_read
    FROM jobs j JOIN job_details d ON d.job_id=j.id WHERE j.id=?`).get(
    id,
  ) as unknown as StoredListing;
}

/** Legacy application routes without a demonstrated connection need one own-page read.
 * A successful read records that binding, including legitimate external forms. */
function unboundApplyUrl(card: ListingCard, applyUrl: string): boolean {
  if (normalizeUrl(card.url) === normalizeUrl(applyUrl)) return false;
  try {
    const own = new URL(card.url),
      apply = new URL(applyUrl);
    const ownPath = own.pathname.replace(/\/$/u, ""),
      applyPath = apply.pathname.replace(/\/$/u, "");
    return (
      own.host !== apply.host ||
      ownPath === applyPath ||
      !applyPath.startsWith(`${ownPath}/`)
    );
  } catch {
    return true;
  }
}

function legacyNeedsRead(card: ListingCard, row: StoredListing): boolean {
  if (!row.full_read || !row.description.trim() || !row.apply_url) return true;
  if (text(card.title) !== text(row.title)) return true;
  if (card.companyHint && text(card.companyHint) !== text(row.company))
    return true;
  if (card.locationHint && text(card.locationHint) !== text(row.location))
    return true;
  if (
    card.listingText !== undefined &&
    text(card.listingText) !== text(row.description)
  )
    return true;
  const facts = card.providerFacts;
  if (
    facts &&
    (facts.company !== row.company ||
      facts.location !== row.location ||
      toWorkModeMask(facts.workModes) !== row.work_modes ||
      facts.applyUrl !== row.apply_url ||
      facts.salaryText !== row.salary_text ||
      facts.employmentType !== row.employment_type)
  )
    return true;
  return unboundApplyUrl(card, row.apply_url);
}

/** Reuse verified, unchanged source evidence across searches and restarts.
 * Old trustworthy rows acquire a baseline without a page/model call. Suspect
 * legacy rows are repaired once; failed repairs remain due. */
export function prepareListingCards(
  sql: Statements,
  cards: readonly ListingCard[],
): {
  cards: ListingCard[];
  refreshUrls: string[];
} {
  const refreshUrls: string[] = [];
  const findJob = sql("SELECT job_id FROM job_keys WHERE key=?");
  const findEvidence = sql(
    "SELECT fingerprint,record_fingerprint FROM listing_card_evidence WHERE url=? AND source_id=?",
  );
  const remember = sql(
    "INSERT INTO listing_card_evidence(url,source_id,job_id,fingerprint,record_fingerprint) VALUES(?,?,?,?,?)",
  );
  return {
    cards: cards.map((card) => {
      const fingerprint = cardFingerprint(card),
        url = normalizeUrl(card.url);
      const match = findJob.get(`url:${url}`) as { job_id: number } | undefined;
      if (match) {
        const row = storedListing(sql, match.job_id),
          recordFingerprint = hash(row);
        const prior = findEvidence.get(url, card.sourceId) as
          | { fingerprint: string; record_fingerprint: string }
          | undefined;
        if (
          prior
            ? prior.fingerprint !== fingerprint ||
              prior.record_fingerprint !== recordFingerprint
            : legacyNeedsRead(card, row)
        )
          refreshUrls.push(card.url);
        else if (!prior)
          remember.run(
            url,
            card.sourceId,
            match.job_id,
            fingerprint,
            recordFingerprint,
          );
      }
      return { ...card, evidenceFingerprint: fingerprint };
    }),
    refreshUrls,
  };
}

/** Bind only the exact card whose full read succeeded. A new model decision,
 * not a lookup or failed attempt, supplies the replacement posting facts. */
export function rememberListingCardReads(
  sql: Statements,
  jobs: readonly FoundJob[],
  ids: readonly number[],
): void {
  for (const [index, job] of jobs.entries()) {
    const evidence = job.listingCardEvidence,
      id = ids[index];
    if (!evidence || id === undefined || job.facts?.fullListingRead !== true)
      continue;
    const recordFingerprint = hash(storedListing(sql, id));
    // Other source cards keep their own fingerprints. A legitimate merged read
    // updates the record binding without making every unchanged alias due again.
    sql(
      "UPDATE listing_card_evidence SET record_fingerprint=? WHERE job_id=?",
    ).run(recordFingerprint, id);
    sql(`INSERT INTO listing_card_evidence(url,source_id,job_id,fingerprint,record_fingerprint) VALUES(?,?,?,?,?)
      ON CONFLICT(url,source_id) DO UPDATE SET job_id=excluded.job_id,fingerprint=excluded.fingerprint,record_fingerprint=excluded.record_fingerprint`).run(
      normalizeUrl(evidence.url),
      evidence.sourceId,
      id,
      evidence.fingerprint,
      recordFingerprint,
    );
  }
}
