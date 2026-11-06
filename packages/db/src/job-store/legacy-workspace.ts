import {
  ApplicationRecordSchema,
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ResumeDocumentBundleSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  SavedJobSchema,
  SourceInstructionArtifactSchema,
  TrackerStatusSchema,
  canonicalJobSiteUrl,
  resumeImportAnswer,
  type CandidateProfile,
  type JobStage,
  type SavedJob,
} from "@nestor/contracts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { createSavedAnswersStore } from "./applications";
import { openJobStore, type JobStore } from "./job-store";
import { createProfileWorkspace } from "./profile-workspace";
import { createPreferencesStore } from "./preferences-store";

const SOURCE = "job-finder-workspace.sqlite";
const ms = (value: string | null | undefined) =>
  value ? Date.parse(value) || 0 : 0;

/** Restore saved preferences field by field, keeping newer choices. */
function restoreDefaults(
  current: unknown,
  defaults: unknown,
  incoming: unknown,
): unknown {
  if (incoming === undefined) return current;
  if (JSON.stringify(current) === JSON.stringify(defaults)) return incoming;
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(current) || !record(defaults) || !record(incoming))
    return current;
  return Object.fromEntries(
    [...new Set([...Object.keys(current), ...Object.keys(incoming)])].map(
      (key) => [
        key,
        restoreDefaults(current[key], defaults[key], incoming[key]),
      ],
    ),
  );
}

/** Schema failures must never put a person's saved values in an error log. */
function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new Error(
      "The older workspace could not be imported. Its data is unchanged.",
    );
  }
}

function readRows<T>(
  db: DatabaseSync,
  table: string,
  schema: { parse(value: unknown): T },
): T[] {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
  )
    return [];
  return db
    .prepare(`SELECT value FROM "${table}" ORDER BY rowid`)
    .all()
    .map((row) => parse(schema, JSON.parse(String(row.value)) as unknown));
}

function stage(status: SavedJob["status"]): JobStage {
  if (
    [
      "submitted",
      "assessment",
      "interview",
      "offer",
      "rejected",
      "withdrawn",
    ].includes(status)
  )
    return "applied";
  if (status === "archived") return "hidden";
  return status === "discovered" ? "found" : "shortlisted";
}

/** Imports retained data, never old queues, browser pages or permission to send. */
export function importLegacyWorkspace(
  store: JobStore,
  file: string,
  destination?: string,
): void {
  if (
    store
      .sql("SELECT 1 FROM legacy_workspace_imports WHERE source=?")
      .get(SOURCE) ||
    !existsSync(file)
  )
    return;
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec("BEGIN");
    // A consistent snapshot includes any committed WAL rows. Never run the
    // retired migrations or open the source writable.
    const state = (key: string): unknown => {
      const row = source
        .prepare("SELECT value FROM singleton_state WHERE key=?")
        .get(key);
      return row ? (JSON.parse(String(row.value)) as unknown) : undefined;
    };
    const legacyProfile = state("profile");
    const profile =
      legacyProfile === undefined
        ? null
        : parse(CandidateProfileSchema, legacyProfile);
    const legacyGoals = state("search_preferences");
    const goals =
      legacyGoals === undefined
        ? null
        : parse(JobSearchPreferencesSchema, legacyGoals);
    const legacySettings = state("settings");
    const settings =
      legacySettings === undefined
        ? null
        : parse(JobFinderSettingsSchema, legacySettings);
    const jobs = readRows(source, "saved_jobs", SavedJobSchema);
    const drafts = readRows(source, "resume_drafts", ResumeDraftSchema);
    const exports = readRows(
      source,
      "resume_export_artifacts",
      ResumeExportArtifactSchema,
    );
    const applications = readRows(
      source,
      "application_records",
      ApplicationRecordSchema,
    );
    const instructions = readRows(
      source,
      "source_instruction_artifacts",
      SourceInstructionArtifactSchema,
    );
    const fresh = openJobStore(":memory:");
    let defaults;
    try {
      const prefs = createPreferencesStore(fresh);
      defaults = {
        goals: prefs.goals.read(),
        settings: prefs.settings.read(),
        profile: createProfileWorkspace(fresh).profile.read(),
      };
    } finally {
      fresh.close();
    }
    // Keep an immutable copy of the destination too, before changing its rows.
    if (destination) {
      const backup = `${destination}.pre-legacy-import-${randomUUID()}.sqlite`;
      store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      if (process.platform !== "win32") chmodSync(backup, 0o600);
    }
    store.transaction(() => {
      // Another opener may have completed the import while we read the source.
      if (
        store
          .sql("SELECT 1 FROM legacy_workspace_imports WHERE source=?")
          .get(SOURCE)
      )
        return;
      const personal = createProfileWorkspace(store);
      const current = personal.profile.read();
      const emptyProfile =
        JSON.stringify({ ...current, id: "" }) ===
        JSON.stringify({ ...defaults.profile, id: "" });
      if (profile && emptyProfile) personal.profile.replace(profile);
      if (goals)
        personal.preferences.goals.replace(
          parse(
            JobSearchPreferencesSchema,
            restoreDefaults(
              personal.preferences.goals.read(),
              defaults.goals,
              goals,
            ),
          ),
        );
      if (settings)
        personal.preferences.settings.replace(
          parse(
            JobFinderSettingsSchema,
            restoreDefaults(
              personal.preferences.settings.read(),
              defaults.settings,
              settings,
            ),
          ),
        );
      if (
        state("profile_setup_state") !== undefined &&
        !store.sql("SELECT 1 FROM profile_setup").get()
      )
        personal.writeSetup(state("profile_setup_state"));
      if (profile) importAnswers(store, profile);

      const siteIds = new Map<string, number>();
      for (const target of goals?.discovery?.targets ?? []) {
        const url = canonicalJobSiteUrl(target.startingUrl);
        store
          .sql(
            `INSERT OR IGNORE INTO job_sites(label,url,enabled,lane,custom_instructions,instruction_status,validated_instruction_id,draft_instruction_id,last_debug_run_id,last_verified_at,stale_reason)
          VALUES(?,?,?,'auto',?,?,?,?,?,?,?)`,
          )
          .run(
            target.label,
            url,
            Number(target.enabled),
            target.customInstructions,
            target.instructionStatus,
            target.validatedInstructionId,
            target.draftInstructionId,
            target.lastDebugRunId,
            target.lastVerifiedAt,
            target.staleReason,
          );
        siteIds.set(
          target.id,
          Number(
            store.sql("SELECT id FROM job_sites WHERE url=?").get(url)!.id,
          ),
        );
      }
      for (const artifact of instructions) {
        const siteId = siteIds.get(artifact.targetId);
        if (siteId === undefined) continue;
        const next = { ...artifact, targetId: String(siteId) };
        store
          .sql(
            "INSERT OR IGNORE INTO site_instructions(id,target_id,updated_at,value) VALUES(?,?,?,?)",
          )
          .run(next.id, next.targetId, next.updatedAt, JSON.stringify(next));
      }

      const ids = new Map<string, number>();
      for (const job of jobs) {
        const origin =
          job.provenance.find((item) => item.listingUrl === job.canonicalUrl) ??
          job.provenance[0];
        const sourceId = origin?.targetId ?? job.source;
        const {
          added,
          ids: [id],
        } = store.saveFoundJobs({
          searchId: null,
          jobs: [
            {
              title: job.title,
              company: job.company,
              location: job.location ?? "",
              workModes: job.workMode,
              url: job.canonicalUrl,
              applyUrl: job.applicationUrl,
              sourceId: String(siteIds.get(sourceId) ?? sourceId),
              sourceLabel:
                origin?.sourceLabel ??
                goals?.discovery?.targets.find((item) => item.id === sourceId)
                  ?.label ??
                job.source,
              // Old provider enums are shared by many boards; without a
              // source identity only the listing URL is a safe merge key.
              sourceJobId: origin ? job.sourceJobId : null,
              postedAt: job.postedAt,
              salaryText: job.salaryText,
              salaryMin: job.normalizedCompensation?.minAmount ?? null,
              salaryMax: job.normalizedCompensation?.maxAmount ?? null,
              salaryCurrency: job.normalizedCompensation?.currency ?? null,
              seniority: job.seniority,
              employmentType: job.employmentType,
              summary: job.summary,
              description: job.description,
              facts: {
                keySkills: job.keySkills,
                responsibilities: job.responsibilities,
                minimumQualifications: job.minimumQualifications,
                preferredQualifications: job.preferredQualifications,
                benefits: job.benefits,
                department: job.department,
                team: job.team,
                employerDomain: job.employerDomain,
                atsProvider: job.atsProvider,
              },
            },
          ],
        });
        if (id === undefined)
          throw new Error("An older saved job could not be imported.");
        ids.set(job.id, id);
        store
          .sql("INSERT INTO legacy_workspace_jobs(old_id,job_id) VALUES(?,?)")
          .run(job.id, id);
        // Existing current-store jobs keep their decisions and fit.
        if (
          !store
            .sql("SELECT 1 FROM job_keys WHERE key=?")
            .get(`legacy:${job.id}`)
        ) {
          const newlyAdded = added.includes(id);
          if (newlyAdded) {
            store
              .sql(
                "UPDATE jobs SET stage=?,stage_at=?,found_at=?,seen_at=? WHERE id=?",
              )
              .run(
                stage(job.status),
                ms(job.shortlistedAt ?? job.discoveredAt),
                ms(job.firstSeenAt ?? job.discoveredAt),
                ms(job.lastSeenAt ?? job.discoveredAt),
                id,
              );
            store.setFit([
              {
                id,
                score: job.matchAssessment.score,
                summary: job.matchAssessment.recommendationRationale,
                reasons: job.matchAssessment.reasons,
                gaps: job.matchAssessment.gaps,
              },
            ]);
          }
          store
            .sql("INSERT OR IGNORE INTO job_keys(key,job_id) VALUES(?,?)")
            .run(`legacy:${job.id}`, id);
        }
      }
      const requireJob = (oldId: string) => {
        const id = ids.get(oldId);
        if (id === undefined)
          throw new Error(
            "An older document or application has no saved job. Its data is unchanged.",
          );
        return id;
      };
      for (const draft of drafts.sort(
        (a, b) => ms(b.updatedAt) - ms(a.updatedAt),
      )) {
        const id = requireJob(draft.jobId);
        const exported = exports.find(
          (item) =>
            item.id === draft.approvedExportId &&
            item.format === "pdf" &&
            item.isApproved,
        );
        let digest: string | null = null;
        if (exported && existsSync(exported.filePath)) {
          const actual = createHash("sha256")
            .update(readFileSync(exported.filePath))
            .digest("hex");
          if (!exported.sha256 || actual === exported.sha256) digest = actual;
        }
        const approved =
          draft.status === "approved" && digest
            ? ms(draft.approvedAt) || null
            : null;
        const next = {
          ...draft,
          jobId: String(id),
          ...(approved
            ? {}
            : {
                approvedAt: null,
                approvedExportId: null,
                status:
                  draft.status === "approved"
                    ? ("needs_review" as const)
                    : draft.status,
              }),
        };
        const job = jobs.find((item) => item.id === draft.jobId)!;
        const level =
          job.resumeApplicationMode === "original_resume"
            ? "original"
            : job.resumeTailoringMode === "aggressive"
              ? "aggressive"
              : job.resumeTailoringMode === "conservative"
                ? "light"
                : "tailored";
        const inserted = store
          .sql(
            `INSERT OR IGNORE INTO resumes(job_id,level,state,updated_at,draft_json,approved_at,pdf_path)
          VALUES(?,?,'ready',?,?,?,?)`,
          )
          .run(
            id,
            level,
            ms(draft.updatedAt),
            JSON.stringify(next),
            approved,
            approved ? exported!.filePath : null,
          ).changes;
        if (inserted && approved) {
          store
            .sql(
              "INSERT INTO resume_pdf_assets(job_id,path,approved_at,sha256) VALUES(?,?,?,?)",
            )
            .run(id, exported!.filePath, approved, digest);
          if (store.getJob(id)?.stage === "shortlisted")
            store.setStage([id], "resume");
        }
      }
      for (const application of applications) {
        const id = requireJob(application.jobId);
        const sent =
          stage(application.status) === "applied" ||
          Boolean(application.crm?.appliedAt);
        const inserted = store
          .sql(
            `INSERT OR IGNORE INTO applications(job_id,mode,state,queued_at,updated_at,submitted_at,error)
          VALUES(?,'confirm_before_submit',?,?,?, ?,?)`,
          )
          .run(
            id,
            sent ? "submitted" : "stopped",
            ms(application.lastUpdatedAt),
            ms(application.lastUpdatedAt),
            sent
              ? ms(application.crm?.appliedAt ?? application.lastUpdatedAt)
              : null,
            sent
              ? null
              : "Imported from an earlier workspace. Open it to continue.",
          ).changes;
        if (!inserted) continue;
        if (sent) store.setStage([id], "applied");
        const status =
          application.crm?.stage ?? (sent ? "applied" : "applying");
        const mappedStatus =
          status === "no_response"
            ? "no_reply"
            : ["employer_viewed", "recruiter_contact"].includes(status)
              ? "replied"
              : status;
        const trackerStatus = TrackerStatusSchema.safeParse(mappedStatus);
        store
          .sql(
            "UPDATE tracker SET status=?,status_at=?,applied_at=? WHERE job_id=?",
          )
          .run(
            trackerStatus.success ? trackerStatus.data : "applying",
            ms(application.crm?.stageChangedAt ?? application.lastUpdatedAt),
            sent
              ? ms(application.crm?.appliedAt ?? application.lastUpdatedAt)
              : null,
            id,
          );
        for (const event of application.events)
          store
            .sql(
              "INSERT INTO tracker_events(job_id,kind,at,title,body) VALUES(?,'note',?,?,?)",
            )
            .run(id, ms(event.at), event.title, event.detail);
        for (const tag of application.crm?.tags ?? [])
          store
            .sql("INSERT OR IGNORE INTO tracker_tags(job_id,tag) VALUES(?,?)")
            .run(id, tag);
      }
      copyProfileRows(source, store);
      const mapped = Number(
        store.sql("SELECT count(*) AS n FROM legacy_workspace_jobs").get()!.n,
      );
      const present = (
        table: string,
        key: string,
        expected: readonly (number | string)[],
      ) =>
        Number(
          store
            .sql(
              `SELECT count(*) AS n FROM ${table} WHERE ${key} IN (SELECT value FROM json_each(?))`,
            )
            .get(JSON.stringify(expected))!.n,
        ) === new Set(expected).size;
      if (
        mapped !== jobs.length ||
        !present(
          "resumes",
          "job_id",
          drafts.map((r) => requireJob(r.jobId)),
        ) ||
        !present(
          "applications",
          "job_id",
          applications.map((r) => requireJob(r.jobId)),
        ) ||
        !present("job_sites", "id", [...siteIds.values()]) ||
        (profile &&
          emptyProfile &&
          createProfileWorkspace(store).profile.read().fullName !==
            profile.fullName) ||
        store.db.prepare("PRAGMA foreign_key_check").all().length ||
        store.db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok"
      )
        throw new Error(
          "The imported workspace did not pass verification. Its data is unchanged.",
        );
      store
        .sql(
          "INSERT INTO legacy_workspace_imports(source,completed_at,counts_json) VALUES(?,?,?)",
        )
        .run(
          SOURCE,
          new Date().toISOString(),
          JSON.stringify({
            jobs: jobs.length,
            resumes: drafts.length,
            applications: applications.length,
            sources: siteIds.size,
            targets: goals?.targetRoles.length ?? 0,
          }),
        );
    });
  } catch {
    // Native file errors and JSON errors can contain private paths or values.
    throw new Error(
      "The older workspace could not be imported. Its data is unchanged.",
    );
  } finally {
    if (source.isTransaction) source.exec("ROLLBACK");
    source.close();
  }
}

function importAnswers(store: JobStore, profile: CandidateProfile): void {
  const answers = createSavedAnswersStore(store);
  for (const [field, value] of Object.entries(profile.answerBank)) {
    const descriptor = resumeImportAnswer(field);
    if (
      descriptor &&
      typeof value === "string" &&
      value.trim() &&
      !answers.get({ key: descriptor.key })
    )
      answers.upsert({
        ...descriptor,
        prompt: field.replace(/[A-Z]/gu, (c) => ` ${c.toLowerCase()}`),
        answer: value,
      });
  }
  for (const answer of profile.answerBank.customAnswers) {
    const key = `legacy:${answer.id}`;
    const country = answer.applicationScope?.hiringCountry ?? "";
    const scoped = Boolean(answer.applicationScope);
    const validCountry = /^[a-z]{2}$/iu.test(country) ? country : "";
    if (answers.get({ key, scope: { country: validCountry } })) continue;
    answers.upsert({
      key,
      kind: answer.kind,
      label: answer.label,
      prompt: answer.question,
      answer: answer.answer,
      scope: { country: validCountry },
      roleFamilies: answer.roleFamilies,
      proofEntryIds: answer.proofEntryIds,
      optionFallback: answer.optionFallback,
      // A legacy location string is not proof of a country or field binding.
      needsConfirmation:
        answer.needsConfirmation ||
        (scoped &&
          (!validCountry ||
            Boolean(answer.applicationScope?.currentFieldBinding))),
    });
  }
}

function copyProfileRows(source: DatabaseSync, store: JobStore): void {
  function copy<T extends { id: string }>(
    from: string,
    to: string,
    schema: { parse(value: unknown): T },
    fields: (row: T) => Record<string, SQLInputValue>,
  ) {
    for (const row of readRows(source, from, schema)) {
      const values = { id: row.id, ...fields(row), value: JSON.stringify(row) };
      store
        .sql(
          `INSERT OR IGNORE INTO ${to}(${Object.keys(values).join(",")}) VALUES(${Object.keys(
            values,
          )
            .map(() => "?")
            .join(",")})`,
        )
        .run(...Object.values(values));
    }
  }
  copy(
    "resume_import_runs",
    "profile_import_runs",
    ResumeImportRunSchema,
    (r) => ({
      source_resume_id: r.sourceResumeId,
      status: r.status,
      started_at: r.startedAt,
    }),
  );
  copy(
    "resume_import_document_bundles",
    "profile_import_documents",
    ResumeDocumentBundleSchema,
    (r) => ({
      run_id: r.runId,
      source_resume_id: r.sourceResumeId,
      created_at: r.createdAt,
    }),
  );
  copy(
    "resume_import_field_candidates",
    "profile_import_candidates",
    ResumeImportFieldCandidateSchema,
    (r) => ({
      run_id: r.runId,
      resolution: r.resolution,
      created_at: r.createdAt,
    }),
  );
  copy(
    "profile_copilot_messages",
    "profile_messages",
    ProfileCopilotMessageSchema,
    (r) => ({ created_at: r.createdAt, role: r.role }),
  );
  copy("profile_revisions", "profile_history", ProfileRevisionSchema, (r) => ({
    created_at: r.createdAt,
    sequence: r.sequence,
    trigger: r.trigger,
  }));
}
