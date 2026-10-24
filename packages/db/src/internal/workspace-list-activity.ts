import type { DatabaseSync } from "node:sqlite";
import { discoveryLedgerValueSql } from "./discovery-ledger-storage";
import type {
  ApplicationAttempt,
  DiscoveryLedgerEntry,
  ListingSignalRecord,
  WorkspaceJobListingActivity,
} from "@nestor/contracts";
import {
  createJobIdentityIndex,
  projectDiscoveryJobViews,
  type ListingActivityJob,
  type JobIdentityInput,
} from "@nestor/job-list-policy";

/** TEMP rows contain only the existing activity projection and never alter canonical data. */
export function createWorkspaceListActivityReader(
  db: DatabaseSync,
  includeAllSaved = false,
) {
  db.exec(`CREATE TEMP TABLE workspace_listing_activity (
    plan_id TEXT, origin TEXT, id TEXT, status TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(plan_id,origin,id))`);
  type Identity = JobIdentityInput & { id: string; origin: string };
  const identities = new Map<string, { text: string; value: Identity }>();
  const index = createJobIdentityIndex<Identity>([], (job) => job);
  const planVersions = new Map<string, string>();
  const ensure = (planId: string, version: string) => {
    if (planVersions.get(planId) === version) return;
    const present = new Set<string>();
    for (const row of db
      .prepare(
        `SELECT origin,id,identity_value FROM workspace_job_index i WHERE plan_id=''
      AND (origin='saved_jobs' OR NOT EXISTS (SELECT 1 FROM workspace_job_index s WHERE s.origin='saved_jobs' AND s.plan_id='' AND s.id=i.id))`,
      )
      .all()) {
      const key = `${String(row.origin)}:${String(row.id)}`,
        text = String(row.identity_value);
      present.add(key);
      const old = identities.get(key);
      if (old?.text === text) continue;
      if (old) index.remove(old.value);
      const value: Identity = {
        ...(JSON.parse(text) as JobIdentityInput),
        id: String(row.id),
        origin: String(row.origin),
      };
      identities.set(key, { text, value });
      index.add(value);
    }
    for (const [key, old] of identities)
      if (!present.has(key)) {
        index.remove(old.value);
        identities.delete(key);
      }
    const identityJobs = [...identities.values()].map((row) => row.value);
    const byKey = new Map(
      identityJobs.map((job) => [`${job.origin}:${job.id}`, job]),
    );
    const jobs: Array<ListingActivityJob & { origin: string }> = [];
    for (const row of db
      .prepare(
        includeAllSaved
          ? `SELECT i.origin,i.id,i.first_seen_at,i.last_seen_at,i.last_verified_active_at,i.discovered_at,
        CASE WHEN verdict.value IS NOT NULL THEN COALESCE(json_extract(verdict.value,'$.judgment.listingClosed'),0)
          ELSE COALESCE(p.closed,i.closed) END AS closed,
        CASE WHEN verdict.value IS NOT NULL THEN json_extract(verdict.value,'$.judgment.listingClosedEvidence')
          WHEN p.id IS NOT NULL THEN p.listing_closed_evidence ELSE i.listing_closed_evidence END AS listing_closed_evidence
      FROM workspace_job_index i LEFT JOIN workspace_job_index p
        ON p.origin=i.origin AND p.id=i.id AND p.plan_id=?
      LEFT JOIN job_plan_assessments verdict ON i.origin='saved_jobs' AND verdict.job_id=i.id AND verdict.plan_id=?
      WHERE i.plan_id=''`
          : `SELECT origin,id,first_seen_at,last_seen_at,last_verified_active_at,discovered_at,closed,listing_closed_evidence
      FROM workspace_job_index WHERE plan_id=?`,
      )
      .all(...(includeAllSaved ? [planId, planId] : [planId]))) {
      const identity = byKey.get(`${String(row.origin)}:${String(row.id)}`);
      if (!identity) continue;
      jobs.push({
        ...identity,
        firstSeenAt: row.first_seen_at as string | null,
        lastSeenAt: row.last_seen_at as string | null,
        lastVerifiedActiveAt: row.last_verified_active_at as string | null,
        discoveredAt: String(row.discovered_at),
        matchAssessment: {
          judgment:
            row.closed === 1
              ? {
                  listingClosed: true,
                  listingClosedEvidence: row.listing_closed_evidence as
                    | string
                    | null,
                }
              : null,
        },
      });
    }
    const normalizedLedger = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_ledger_observations'",
        )
        .get(),
    );
    const ledger = db
      .prepare(
        normalizedLedger
          ? `SELECT ${discoveryLedgerValueSql()} AS value FROM discovery_ledger
      WHERE json_extract(value,'$.latestStatus')='inactive' AND EXISTS (
        SELECT 1 FROM discovery_ledger_observations observation
        WHERE observation.id=discovery_ledger.id AND observation.inactive_at IS NOT NULL) ORDER BY position`
          : `SELECT value FROM discovery_ledger WHERE json_extract(value,'$.latestStatus')='inactive'
          AND json_extract(value,'$.inactiveAt') IS NOT NULL ORDER BY position`,
      )
      .all()
      .map((row) => JSON.parse(String(row.value)) as DiscoveryLedgerEntry);
    const signals = db
      .prepare(
        "SELECT json_extract(value,'$.safeguards.listingSignals') AS value FROM singleton_state WHERE key='intelligence_state'",
      )
      .get()?.value;
    const attempts = db
      .prepare(
        "SELECT value FROM application_attempts WHERE json_extract(value,'$.blocker.code')='application_closed'",
      )
      .all()
      .map((row) => JSON.parse(String(row.value)) as ApplicationAttempt);
    const projected = projectDiscoveryJobViews({
      jobs,
      discoveryLedger: ledger,
      listingSignals: signals
        ? (JSON.parse(String(signals)) as ListingSignalRecord[])
        : [],
      applicationAttempts: attempts,
      identityIndex: { sync: () => index },
    });
    db.prepare("DELETE FROM workspace_listing_activity WHERE plan_id=?").run(
      planId,
    );
    const put = db.prepare(
      "INSERT INTO workspace_listing_activity VALUES (?,?,?,?,?)",
    );
    for (const job of projected)
      put.run(
        planId,
        job.origin,
        job.id,
        job.listingActivity.status,
        JSON.stringify(job.listingActivity),
      );
    planVersions.set(planId, version);
  };
  return {
    ensure,
    read(
      jobIds: readonly string[],
      planId: string | null,
    ): WorkspaceJobListingActivity[] {
      if (!jobIds.length) return [];
      const version =
        String(
          db
            .prepare(
              "SELECT value FROM workspace_read_meta WHERE key='activity_revision'",
            )
            .get()?.value ?? "0",
        ) +
        (includeAllSaved && planId
          ? `:${String(db.prepare("SELECT MAX(revision) AS revision FROM workspace_changes").get()?.revision ?? 0)}`
          : "");
      // Out-of-plan verdicts have no plan index row. Their committed feed
      // revision also invalidates Home's complete saved-job activity view.
      ensure(planId ?? "", version);
      // The existing activity primary key gives one lookup per requested id.
      // Keep the complete inventory for identity ambiguity checks inside ensure.
      return db
        .prepare(
          `SELECT a.id,a.value FROM json_each(?) requested
        CROSS JOIN workspace_listing_activity a ON a.plan_id=? AND a.origin='saved_jobs' AND a.id=requested.value`,
        )
        .all(JSON.stringify([...new Set(jobIds)]), planId ?? "")
        .map((row) => ({
          jobId: String(row.id),
          listingActivity: JSON.parse(
            String(row.value),
          ) as WorkspaceJobListingActivity["listingActivity"],
        }));
    },
    invalidate: () => planVersions.clear(),
  };
}
