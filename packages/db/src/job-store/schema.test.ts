import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { addMissingColumns, openJobStore } from "./job-store";
import { JOB_STORE_ADDED_COLUMNS } from "./schema";

/**
 * Every column a store file people use can have: the layout their files were
 * created with (version 6), plus every table added since. None may go, and a
 * column added to one of these tables must be in JOB_STORE_ADDED_COLUMNS. A
 * new table adds its line here in the same change; a line never changes.
 */
const RELEASED_COLUMNS: Record<string, string> = {
  application_details:
    "application_id attempt resume_artifact_json execution_json review_json authority_envelope_id profile_digest access_recheck",
  application_instructions: "application_id conversation_id mode",
  application_needs_you: "application_id attempt field_key task_id",
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
  resumes:
    "job_id level state updated_at error draft_json previous_json approved_at pdf_path",
  search_sources:
    "id search_id source_id label url state lane phase cards related unrelated seen failed_reads found added hidden message",
  searches:
    "id state settings_json started_at finished_at sources_total sources_done found added merged scored error",
  seen_listing_cards: "url role_goals_key card_fingerprint verdict",
  source_needs_you: "source_id task_id requested_url",
  tracker:
    "job_id status status_at status_change_id applied_at next_at next_title",
  tracker_counts: "status n",
  tracker_events: "id job_id kind at title body due_at done_at place",
  tracker_tags: "tag job_id",
  tracker_undo: "id at items_json",
  tracker_views: "id name filter_json sort",
};

function columnsOf(db: DatabaseSync): Map<string, string[]> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  return new Map(
    tables.map(({ name }) => [
      name,
      (
        db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as {
          name: string;
        }[]
      ).map((column) => column.name),
    ]),
  );
}

function withFile(run: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "job-store-schema-"));
  try {
    run(path.join(dir, "jobs.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
        if (!released) continue;
        for (const column of columns)
          if (!released.includes(column))
            expect(
              added.has(`${table}.${column}`),
              `${table}.${column} is new: add it to JOB_STORE_ADDED_COLUMNS so files that exist get it`,
            ).toBe(true);
      }
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
