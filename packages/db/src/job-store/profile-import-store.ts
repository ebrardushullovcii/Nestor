import {
  createSavedAnswersStore,
  readSavedApplicationAnswers,
} from "./applications";
import {
  CandidateProfileSchema,
  ResumeImportRunSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  type ResumeImportRun,
  type ResumeDocumentBundle,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import type {
  JobFinderRepository,
  JobFinderRepositorySeed,
} from "../repository-types";
import type { JobStore } from "./job-store";
import type { ProfileStore } from "./profile-store";
import type { PreferencesStore } from "./preferences-store";
import type { SQLInputValue } from "node:sqlite";
export const PROFILE_IMPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_import_runs(id TEXT PRIMARY KEY,source_resume_id TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_import_runs_source ON profile_import_runs(source_resume_id,started_at DESC,id);
CREATE INDEX IF NOT EXISTS profile_import_runs_status ON profile_import_runs(status,started_at DESC,id);
CREATE TABLE IF NOT EXISTS profile_import_documents(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,source_resume_id TEXT NOT NULL,created_at TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_import_documents_run ON profile_import_documents(run_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS profile_import_candidates(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,resolution TEXT NOT NULL,created_at TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_import_candidates_run ON profile_import_candidates(run_id,resolution,created_at DESC,id);
`;
type ImportMethods = Pick<
  JobFinderRepository,
  | "listResumeImportRuns"
  | "getLatestResumeImportRun"
  | "upsertResumeImportRun"
  | "listResumeImportDocumentBundles"
  | "listResumeImportFieldCandidates"
  | "replaceResumeImportRunArtifacts"
  | "finalizeResumeImportRun"
>;
export function createProfileImportStore(
  store: JobStore,
  profile: ProfileStore,
  preferences: PreferencesStore,
) {
  const answers = createSavedAnswersStore(store);
  const changed = () =>
    store.notify({
      cause: "profile_activity",
      stages: [],
      ids: [],
      searchId: null,
    });
  const version = () =>
    Number(
      store.sql("SELECT version FROM profile_revision WHERE id=1").get()!
        .version,
    );
  const current = () => CandidateProfileSchema.parse(profile.read());
  const runs = (where = "1", args: SQLInputValue[] = [], limit?: number) =>
    store
      .sql(
        `SELECT value FROM profile_import_runs WHERE ${where} ORDER BY started_at DESC,id ${limit !== undefined ? "LIMIT ?" : ""}`,
      )
      .all(
        ...args,
        ...(limit !== undefined ? [Math.max(0, Math.floor(limit))] : []),
      )
      .map((row) => ResumeImportRunSchema.parse(JSON.parse(String(row.value))));
  const documents = (where = "1", args: SQLInputValue[] = []) =>
    store
      .sql(
        `SELECT value FROM profile_import_documents WHERE ${where} ORDER BY created_at DESC,id`,
      )
      .all(...args)
      .map((row) =>
        ResumeDocumentBundleSchema.parse(JSON.parse(String(row.value))),
      );
  const candidates = (where = "1", args: SQLInputValue[] = []) =>
    store
      .sql(
        `SELECT value FROM profile_import_candidates WHERE ${where} ORDER BY created_at DESC,id`,
      )
      .all(...args)
      .map((row) =>
        ResumeImportFieldCandidateSchema.parse(JSON.parse(String(row.value))),
      );
  const writeRun = (input: ResumeImportRun) => {
    const row = ResumeImportRunSchema.parse(input);
    if (
      store
        .sql(
          `INSERT INTO profile_import_runs(id,source_resume_id,status,started_at,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_resume_id=excluded.source_resume_id,status=excluded.status,started_at=excluded.started_at,value=excluded.value WHERE value<>excluded.value`,
        )
        .run(
          row.id,
          row.sourceResumeId,
          row.status,
          row.startedAt,
          JSON.stringify(row),
        ).changes
    )
      changed();
  };
  const writeDocument = (input: ResumeDocumentBundle) => {
    const row = ResumeDocumentBundleSchema.parse(input);
    if (
      store
        .sql(
          `INSERT INTO profile_import_documents(id,run_id,source_resume_id,created_at,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,source_resume_id=excluded.source_resume_id,created_at=excluded.created_at,value=excluded.value WHERE value<>excluded.value`,
        )
        .run(
          row.id,
          row.runId,
          row.sourceResumeId,
          row.createdAt,
          JSON.stringify(row),
        ).changes
    )
      changed();
  };
  const writeCandidate = (input: ResumeImportFieldCandidate) => {
    const row = ResumeImportFieldCandidateSchema.parse(input);
    if (
      store
        .sql(
          `INSERT INTO profile_import_candidates(id,run_id,resolution,created_at,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,resolution=excluded.resolution,created_at=excluded.created_at,value=excluded.value WHERE value<>excluded.value`,
        )
        .run(
          row.id,
          row.runId,
          row.resolution,
          row.createdAt,
          JSON.stringify(row),
        ).changes
    )
      changed();
  };
  const replace: ImportMethods["replaceResumeImportRunArtifacts"] extends (
    input: infer I,
  ) => unknown
    ? (input: I) => void
    : never = (input) => {
    const run = ResumeImportRunSchema.parse(input.run),
      bundles = ResumeDocumentBundleSchema.array().parse(input.documentBundles),
      fields = ResumeImportFieldCandidateSchema.array().parse(
        input.fieldCandidates,
      );
    if (
      bundles.some((row) => row.runId !== run.id) ||
      fields.some((row) => row.runId !== run.id)
    )
      throw new Error("Import artifacts must belong to their provided run.");
    writeRun(run);
    for (const [table, rows] of [
      ["profile_import_documents", bundles],
      ["profile_import_candidates", fields],
    ] as const) {
      if (
        store
          .sql(
            `DELETE FROM ${table} WHERE run_id=? AND id NOT IN (SELECT value FROM json_each(?))`,
          )
          .run(run.id, JSON.stringify(rows.map((row) => row.id))).changes
      )
        changed();
    }
    for (const row of bundles) writeDocument(row);
    for (const row of fields) writeCandidate(row);
  };
  const methods: ImportMethods = {
    listResumeImportRuns: (options) =>
      Promise.resolve().then(() => {
        const where: string[] = [],
          args: SQLInputValue[] = [];
        if (options?.sourceResumeId) {
          where.push("source_resume_id=?");
          args.push(options.sourceResumeId);
        }
        if (options?.statuses?.length) {
          where.push("status IN (SELECT value FROM json_each(?))");
          args.push(JSON.stringify(options.statuses));
        }
        return runs(where.join(" AND ") || "1", args, options?.limit);
      }),
    getLatestResumeImportRun: (source) =>
      Promise.resolve().then(
        () =>
          runs(
            source ? "source_resume_id=?" : "1",
            source ? [source] : [],
            1,
          )[0] ?? null,
      ),
    upsertResumeImportRun: (row) =>
      Promise.resolve().then(() => store.transaction(() => writeRun(row))),
    listResumeImportDocumentBundles: (options) =>
      Promise.resolve().then(() => {
        const where: string[] = [],
          args: SQLInputValue[] = [];
        if (options?.sourceResumeId) {
          where.push("source_resume_id=?");
          args.push(options.sourceResumeId);
        }
        if (options?.runId) {
          where.push("run_id=?");
          args.push(options.runId);
        }
        return documents(where.join(" AND ") || "1", args);
      }),
    listResumeImportFieldCandidates: (options) =>
      Promise.resolve().then(() => {
        const where: string[] = [],
          args: SQLInputValue[] = [];
        if (options?.runId) {
          where.push("run_id=?");
          args.push(options.runId);
        }
        const resolutions = options?.resolution
          ? [options.resolution]
          : options?.resolutions;
        if (resolutions?.length) {
          where.push("resolution IN (SELECT value FROM json_each(?))");
          args.push(JSON.stringify(resolutions));
        }
        return candidates(where.join(" AND ") || "1", args);
      }),
    replaceResumeImportRunArtifacts: (input) =>
      Promise.resolve().then(() => store.transaction(() => replace(input))),
    finalizeResumeImportRun: (input) =>
      Promise.resolve().then(() =>
        store.transaction(() => {
          if (
            input.expectedProfileRevision !== undefined &&
            input.expectedProfileRevision !== version()
          )
            return {
              status: "stale" as const,
              profile: current(),
              searchPreferences: preferences.goals.read(),
              revision: version(),
            };
          profile.replace(input.profile);
          preferences.goals.replace(input.searchPreferences);
          replace(input);
          for (const answer of input.savedAnswers ?? []) {
            if (
              !answers.get({ key: answer.key, scope: answer.scope }) &&
              (!answer.kind ||
                readSavedApplicationAnswers(store, [answer.kind]).length === 0)
            )
              answers.upsert(answer);
          }
          return {
            status: "applied" as const,
            profile: current(),
            searchPreferences: preferences.goals.read(),
            revision: version(),
          };
        }),
      ),
  };
  const reset = (seed: JobFinderRepositorySeed) =>
    store.transaction(() => {
      for (const table of [
        "profile_import_runs",
        "profile_import_documents",
        "profile_import_candidates",
      ])
        store.sql(`DELETE FROM ${table}`).run();
      for (const row of seed.resumeImportRuns) writeRun(row);
      for (const row of seed.resumeImportDocumentBundles) writeDocument(row);
      for (const row of seed.resumeImportFieldCandidates) writeCandidate(row);
    });
  return {
    methods,
    reset,
    state: () => ({
      resumeImportRuns: runs(),
      resumeImportDocumentBundles: documents(),
      resumeImportFieldCandidates: candidates(),
    }),
  };
}
