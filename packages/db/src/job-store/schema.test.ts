import type { FoundJob } from "@nestor/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addMissingColumns, openJobStore } from "./job-store";
import { JOB_STORE_ADDED_COLUMNS } from "./schema";

/**
 * Every column a store file people use can have: the layout their files were
 * created with (version 6), plus every table added since. None may go, and a
 * column added to one of these tables must be in JOB_STORE_ADDED_COLUMNS. A
 * new table adds its line here in the same change; a line never changes.
 */
const RELEASED_COLUMNS: Record<string, string> = {
  activity_control: "id paused paused_at reason pause_behavior",
  application_details:
    "application_id attempt resume_artifact_json execution_json review_json authority_envelope_id profile_digest access_recheck",
  application_instructions: "application_id conversation_id mode",
  application_needs_you: "application_id attempt field_key task_id",
  answer_approvals: "id profile_id revision value",
  application_origins: "application_id origin",
  applications:
    "id job_id mode state attempt queued_at updated_at submitted_at error submission_outcome_id submission_outcome_json",
  form_answer_undo: "id at items_json",
  form_answers:
    "id answer_key country site_origin prompt prompt_key answer kind label role_families_json proof_entry_ids_json needs_confirmation input options_json updated_at",
  form_answers_text: "prompt answer",
  job_details:
    "job_id description summary seniority employment_type salary_min salary_max salary_currency facts_json fit_json",
  job_keys: "key job_id",
  job_move_items: "move_id job_id from_stage from_stage_at from_stage_note",
  job_moves: "id at to_stage",
  job_sightings: "job_id url site source_id source_label apply_url seen_at",
  job_site_undo: "id at items_json",
  job_sites:
    "id label url enabled provider lane health last_searched_at sign_in_state custom_instructions instruction_status validated_instruction_id draft_instruction_id last_debug_run_id last_verified_at stale_reason",
  job_sites_fts: "label url",
  job_stage_counts: "stage n",
  jobs: "id stage stage_at stage_note title company location work_modes salary_text fit_score fit_summary posted_at found_at seen_at found_by source_label source_count url apply_url",
  jobs_text: "title company location",
  needs_you:
    "id kind answer_key country site_origin prompt prompt_key reuse_prompt input options_json opened_at resolved_at answer",
  needs_you_counts: "kind n",
  needs_you_drafts: "task_id answer remember revision",
  needs_you_text: "prompt",
  resume_pdf_assets: "job_id path approved_at sha256",
  resume_changes:
    "id job_id before_json before_stage after_stage expected_updated_at undone_at",
  profile:
    "id first_name last_name middle_name full_name preferred_display_name headline summary current_location current_city current_region current_country time_zone years_experience email secondary_email phone portfolio_url linkedin_url github_url personal_website_url work_eligibility_requires_visa_sponsorship work_eligibility_willing_to_relocate work_eligibility_willing_to_travel work_eligibility_remote_eligible work_eligibility_notice_period_days work_eligibility_available_start_date work_eligibility_security_clearance professional_summary_short_value_proposition professional_summary_full_summary professional_summary_leadership_summary professional_summary_domain_focus_summary narrative_professional_story narrative_next_chapter_summary narrative_career_transition_summary application_identity_preferred_email application_identity_preferred_phone",
  profile_certifications:
    "seq id name issuer issue_date expiry_date credential_url is_draft",
  profile_edit_draft: "id token value",
  profile_education:
    "seq id school_name degree field_of_study location start_date end_date summary is_draft",
  profile_experiences:
    "seq id company_name company_url title employment_type location start_date end_date summary people_management_scope ownership_scope is_current is_draft",
  profile_goals:
    "id search_selectivity shift_preference minimum_salary_usd target_salary_usd salary_currency approval_mode tailoring_mode compensation_basis compensation_minimum compensation_maximum compensation_interval compensation_currency compensation_currency_status weekly_hours_minimum weekly_hours_maximum",
  profile_history: "id created_at sequence trigger value",
  profile_identity: "id profile_id",
  profile_import_candidates: "id run_id resolution created_at value",
  profile_import_documents: "id run_id source_resume_id created_at value",
  profile_import_runs: "id source_resume_id status started_at value",
  profile_items: "id scope owner field value position",
  profile_links: "seq id label url kind is_draft",
  profile_messages: "id created_at role value",
  profile_projects:
    "seq id name project_type summary role outcome project_url repository_url case_study_url",
  profile_proof_bank: "seq id title claim hero_metric supporting_context",
  profile_resume_source:
    "id source_id file_name uploaded_at storage_path sha256 text_updated_at extraction_status last_analyzed_at analysis_provider_kind analysis_provider_label source_identity_full_name source_identity_email ownership_acknowledged_source_full_name ownership_acknowledged_source_email ownership_acknowledged_at",
  profile_resume_text: "id body",
  profile_revision: "id version",
  profile_settings:
    "id resume_format resume_template_id font_preset appearance_theme collapse_side_menu_with_assistant write_resumes_on_shortlist human_review_required allow_auto_submit_override application_automation_mode salary_disclosure keep_session_alive discovery_only resume_application_mode cover_letter_tone cover_letter_length cover_letter_language cover_letter_sample ai_behavior_profile_assistant_initiative ai_behavior_profile_assistant_reply_style ai_behavior_job_search_selectivity ai_behavior_job_search_remote_counts_as_any_location ai_behavior_applying_cover_letter_policy ai_behavior_applying_written_answer_length application_crm_no_response_automation_enabled application_crm_no_response_automation_after_days",
  prepared_forms: "id value",
  profile_setup:
    "id status current_step completed_at last_resumed_at reviewed_steps",
  profile_setup_reviews: "id position status critical section value",
  profile_spoken_languages:
    "seq id language proficiency notes interview_preference",
  profile_tracker_stages: "id label base_stage color position is_terminal",
  profile_work_permissions:
    "country conditions requires_future_sponsorship position",
  resumes:
    "job_id level state updated_at error draft_json previous_json approved_at pdf_path",
  search_sources:
    "id search_id source_id label url state lane phase cards related unrelated seen failed_reads found added hidden message",
  searches:
    "id state settings_json started_at finished_at sources_total sources_done found added merged scored error",
  seen_listing_cards: "url role_goals_key card_fingerprint verdict",
  send_authorities: "id status value",
  send_grants: "id preflight_id idempotency_key value",
  send_keys: "id idempotency_key preflight_id value",
  send_markers: "id idempotency_key preflight_id value",
  send_outcomes: "id job_id value",
  send_preflights: "id idempotency_key value",
  site_instructions: "id target_id updated_at value",
  source_needs_you: "source_id task_id requested_url",
  tracker:
    "job_id status status_at status_change_id applied_at next_at next_title",
  tracker_counts: "status n",
  tracker_events: "id job_id kind at title body due_at done_at place",
  tracker_tags: "tag job_id",
  tracker_undo: "id at items_json",
  tracker_views: "id name filter_json sort",
};

/** Every table but SQLite's own and the full-text indexes' shadow tables. */
function columnsOf(db: DatabaseSync): Map<string, string[]> {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string; sql: string }[];
  const virtual = tables
    .filter(({ sql }) => /^CREATE VIRTUAL TABLE/i.test(sql))
    .map(({ name }) => name);
  const shadow = (name: string) =>
    virtual.some(
      (v) =>
        /^_(config|content|data|docsize|idx)$/.test(name.slice(v.length)) &&
        name.startsWith(v),
    );
  return new Map(
    tables
      .filter(({ name }) => !shadow(name))
      .map(({ name }) => [
        name,
        (
          db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as {
            name: string;
          }[]
        ).map((column) => column.name),
      ]),
  );
}

function foundJob(n: number): FoundJob {
  return {
    title: `Analyst ${n}`,
    company: `Spool ${n}`,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
    sourceJobId: String(n),
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: `Listing ${n}`,
  };
}

/** One row in each of `tables` that has none, with placeholder values. */
function seedRows(db: DatabaseSync, tables: ReadonlySet<string>) {
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
  for (const table of tables) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    };
    if (n > 0) continue;
    const columns = (
      db.prepare("SELECT * FROM pragma_table_info(?)").all(table) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[]
    ).filter(
      // Key columns too: a WITHOUT ROWID table has no rowid to fill them.
      (column) => (column.notnull && column.dflt_value === null) || column.pk,
    );
    const values = columns.map((column) => {
      // Adding a CHECK column makes SQLite validate the existing row as well.
      if (table === "applications" && column.name === "mode")
        return "confirm_before_submit";
      if (table === "applications" && column.name === "state") return "queued";
      return /INT|REAL|NUM/iu.test(column.type) ? 1 : "seed";
    });
    db.prepare(
      columns.length
        ? `INSERT INTO "${table}" (${columns.map((c) => `"${c.name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
        : `INSERT INTO "${table}" DEFAULT VALUES`,
    ).run(...values);
  }
  db.exec("PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON");
}

function withFile(run: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "job-store-schema-"));
  try {
    run(path.join(dir, "jobs.sqlite"));
  } finally {
    // A handle a failing test left open keeps Windows from deleting the
    // file; the test's own failure is the one to report.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left in the temp folder.
    }
  }
}

describe("job store schema", () => {
  it("keeps every released column, and lists each column added since", () => {
    withFile((file) => {
      openJobStore(file).close();
      const db = new DatabaseSync(file);
      const current = columnsOf(db);
      db.close();
      const added = new Set(
        JOB_STORE_ADDED_COLUMNS.map(
          ({ table, column }) => `${table}.${column}`,
        ),
      );
      for (const [table, list] of Object.entries(RELEASED_COLUMNS)) {
        const columns = list.split(" ");
        expect(
          current.get(table),
          `table ${table} was removed or renamed`,
        ).toBeDefined();
        for (const column of columns)
          expect(
            current.get(table),
            `${table}.${column} was removed or renamed`,
          ).toContain(column);
      }
      for (const [table, columns] of current) {
        const released = RELEASED_COLUMNS[table]?.split(" ");
        expect(
          released,
          `table ${table} is new: add its line to RELEASED_COLUMNS`,
        ).toBeDefined();
        if (!released) continue;
        for (const column of columns)
          if (!released.includes(column))
            expect(
              added.has(`${table}.${column}`),
              `${table}.${column} is new: add it to JOB_STORE_ADDED_COLUMNS so files that exist get it`,
            ).toBe(true);
      }
      for (const { table, column } of JOB_STORE_ADDED_COLUMNS)
        expect(
          current.get(table),
          `${table}.${column} is listed as added but no fresh store has it`,
        ).toContain(column);
    });
  });

  it("seeds a row in every table, keyed ones included", () => {
    withFile((file) => {
      openJobStore(file).close();
      const db = new DatabaseSync(file);
      const tables = new Set(
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'table'
               AND name NOT LIKE 'sqlite%' AND sql NOT LIKE 'CREATE VIRTUAL%'
               AND name NOT IN (SELECT name || suffix FROM sqlite_master,
                 (SELECT '_data' AS suffix UNION SELECT '_idx' UNION SELECT '_content'
                  UNION SELECT '_docsize' UNION SELECT '_config')
                 WHERE sql LIKE 'CREATE VIRTUAL%')`,
            )
            .all() as { name: string }[]
        ).map(({ name }) => name),
      );
      expect(tables).toContain("resume_pdf_assets");
      seedRows(db, tables);
      const empty = [...tables].filter(
        (table) =>
          (
            db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
              n: number;
            }
          ).n === 0,
      );
      db.close();
      expect(empty).toEqual([]);
    });
  });

  it("gives every added NOT NULL column a default", () => {
    // SQLite adds a NOT NULL column without a default to an empty table but
    // refuses it on one with rows, which is every table in a real file.
    for (const { table, column, definition } of JOB_STORE_ADDED_COLUMNS)
      if (/\bNOT\s+NULL\b/iu.test(definition))
        expect(
          /\bDEFAULT\b/iu.test(definition),
          `${table}.${column} is NOT NULL without a DEFAULT; files with rows can't add it`,
        ).toBe(true);
  });

  it("opens a version-6 file with rows, keeping them and adding every listed column", () => {
    withFile((file) => {
      const store = openJobStore(file);
      store.saveFoundJobs({ searchId: null, jobs: [foundJob(1), foundJob(2)] });
      store.close();
      // Take the added columns back out, so the file is shaped like one a
      // version-6 build wrote: what the person's file looks like on update.
      const old = new DatabaseSync(file);
      // Every table that gains a column has a row, as a real file would.
      seedRows(old, new Set(JOB_STORE_ADDED_COLUMNS.map(({ table }) => table)));
      for (const { table, column } of JOB_STORE_ADDED_COLUMNS) {
        const users = old
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql LIKE ?",
          )
          .all(table, `%${column}%`) as { type: string; name: string }[];
        for (const { type, name } of users)
          old.exec(`DROP ${type.toUpperCase()} "${name}"`);
        old.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
      }
      old.exec("PRAGMA user_version = 6");
      old.close();

      // A definition SQLite can't add to a file with rows fails here.
      const reopened = openJobStore(file);
      expect(reopened.stageCounts().found).toBe(2);
      reopened.close();
      const check = new DatabaseSync(file);
      const columns = columnsOf(check);
      check.close();
      for (const { table, column } of JOB_STORE_ADDED_COLUMNS)
        expect(columns.get(table)).toContain(column);
    });
  });

  describe("a failed open", () => {
    afterEach(() => vi.restoreAllMocks());

    it("closes its handle when the file is locked", () => {
      withFile((file) => {
        openJobStore(file).close();
        // Called below with the instance it belongs to.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const exec = DatabaseSync.prototype.exec;
        vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
          this: DatabaseSync,
          sql: string,
        ) {
          if (sql === "BEGIN IMMEDIATE") throw new Error("database is locked");
          return exec.call(this, sql);
        });
        const close = vi.spyOn(DatabaseSync.prototype, "close");
        expect(() => openJobStore(file)).toThrow("database is locked");
        expect(close).toHaveBeenCalledOnce();
      });
    });

    it("closes its handle when stopping a cut-off search fails", () => {
      withFile((file) => {
        openJobStore(file).close();
        // Called below with the instance it belongs to.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const prepare = DatabaseSync.prototype.prepare;
        vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
          function (this: DatabaseSync, sql: string) {
            if (sql.startsWith("UPDATE searches SET state = 'stopped'"))
              throw new Error("database is locked");
            return prepare.call(this, sql);
          },
        );
        const close = vi.spyOn(DatabaseSync.prototype, "close");
        expect(() => openJobStore(file)).toThrow("database is locked");
        expect(close).toHaveBeenCalledOnce();
      });
    });
  });

  it("adds a missing column to a file that exists and keeps its rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    db.exec("INSERT INTO notes (body) VALUES ('kept')");
    const columns = [
      {
        table: "notes",
        column: "pinned",
        definition: "INTEGER NOT NULL DEFAULT 0",
      },
      { table: "not_created_yet", column: "x", definition: "TEXT" },
    ];
    addMissingColumns(db, columns);
    addMissingColumns(db, columns);
    expect(db.prepare("SELECT body, pinned FROM notes").all()).toEqual([
      { body: "kept", pinned: 0 },
    ]);
    db.close();
  });
});
