import {
  AnswerNeedsYouInputSchema,
  FormAnswerScopeSchema,
  NeedsYouTaskSchema,
  NeedsYouListQuerySchema,
  RequestNeedsYouInputSchema,
  type AnswerNeedsYouInput,
  type AnswerNeedsYouResult,
  type FormAnswerScope,
  type NeedsYouPage,
  type NeedsYouListQuery,
  type NeedsYouTask,
  type RequestNeedsYouInput,
  type RequestNeedsYouResult,
} from "@nestor/contracts";

import type { JobStore } from "./job-store";
import { toIso } from "./job-list";

type Task = {
  id: number;
  kind: NeedsYouTask["kind"];
  answer_key: string;
  country: string;
  site_origin: string;
  prompt: string;
  input: NeedsYouTask["input"];
  options_json: string;
  opened_at: number;
  resolved_at: number | null;
  answer: string | null;
};

function sameFormat(
  input: string,
  optionsJson: string,
  question: RequestNeedsYouInput,
): boolean {
  const options = JSON.parse(optionsJson) as string[];
  return (
    input === question.input &&
    JSON.stringify([...new Set(options)].sort()) ===
      JSON.stringify([...new Set(question.options)].sort())
  );
}

function toTask(row: Task): NeedsYouTask {
  const options: unknown = JSON.parse(row.options_json);
  return NeedsYouTaskSchema.parse({
    id: row.id,
    kind: row.kind,
    key: row.answer_key,
    scope: { country: row.country, siteOrigin: row.site_origin },
    prompt: row.prompt,
    input: row.input,
    options,
    openedAt: toIso(row.opened_at),
  });
}

export function createNeedsYouStore(store: JobStore, changed: () => void) {
  const { sql } = store;
  const get = (id: number) =>
    sql("SELECT * FROM needs_you WHERE id = ?").get(id) as Task | undefined;
  const findAnswerRecord = (
    key: string,
    inputScope: Partial<FormAnswerScope> = {},
  ) => {
    const scope = FormAnswerScopeSchema.parse(inputScope);
    const row = sql(
      `SELECT answer, input, options_json FROM form_answers WHERE answer_key = ? AND country = ? AND site_origin = ?`,
    ).get(key, scope.country, scope.siteOrigin) as
      | { answer: string; input: string; options_json: string }
      | undefined;
    return row ?? null;
  };
  const link = (input: RequestNeedsYouInput, taskId: number) =>
    sql(
      `INSERT INTO application_needs_you (application_id, attempt, field_key, task_id)
     VALUES (?, ?, ?, ?) ON CONFLICT(application_id, field_key) DO UPDATE SET
       attempt = excluded.attempt, task_id = excluded.task_id`,
    ).run(input.applicationId, input.attempt, input.fieldKey, taskId);

  const resolve = (task: Task, answer: string | null): number => {
    sql("UPDATE needs_you SET resolved_at = ?, answer = ? WHERE id = ?").run(
      Date.now(),
      answer,
      task.id,
    );
    const queued = sql(
      `UPDATE applications SET state = 'queued', queued_at = ?, updated_at = ?
       WHERE id IN (
         SELECT n.application_id FROM application_needs_you n
         JOIN applications a ON a.id = n.application_id
         WHERE n.task_id = ? AND n.attempt = a.attempt AND a.state = 'needs_you'
       ) AND NOT EXISTS (
         SELECT 1 FROM application_needs_you n JOIN needs_you t ON t.id = n.task_id
         WHERE n.application_id = applications.id AND n.attempt = applications.attempt
           AND t.resolved_at IS NULL
       )`,
    ).run(Date.now(), Date.now(), task.id);
    changed();
    return Number(queued.changes);
  };

  return {
    findAnswer: (key: string, scope: Partial<FormAnswerScope> = {}) =>
      findAnswerRecord(key, scope)?.answer ?? null,

    request(input: RequestNeedsYouInput): RequestNeedsYouResult {
      const value = RequestNeedsYouInputSchema.parse(input);
      return store.transaction(() => {
        const application = sql(
          "SELECT state, attempt FROM applications WHERE id = ?",
        ).get(value.applicationId) as
          | { state: string; attempt: number }
          | undefined;
        if (
          !application ||
          application.attempt !== value.attempt ||
          !["running", "needs_you"].includes(application.state)
        )
          return { status: "stale" };

        if (value.kind === "question") {
          const previous = sql(
            `SELECT t.* FROM needs_you t JOIN application_needs_you n ON n.task_id = t.id
             WHERE n.application_id = ? AND t.kind = 'question' AND t.answer_key = ?
               AND t.country = ? AND t.site_origin = ? AND t.answer IS NOT NULL
             ORDER BY t.id DESC LIMIT 1`,
          ).get(
            value.applicationId,
            value.key,
            value.scope.country,
            value.scope.siteOrigin,
          ) as Task | undefined;
          if (previous?.answer !== undefined && previous?.answer !== null) {
            if (!sameFormat(previous.input, previous.options_json, value))
              throw new Error(
                "A shared question key must use the same answer format.",
              );
            link(value, previous.id);
            return { status: "answered", answer: previous.answer };
          }
          const saved = findAnswerRecord(value.key, value.scope);
          if (saved !== null) {
            if (!sameFormat(saved.input, saved.options_json, value))
              throw new Error(
                "A shared question key must use the same answer format.",
              );
            return { status: "answered", answer: saved.answer };
          }
        }

        let task = sql(
          `SELECT * FROM needs_you WHERE kind = ? AND answer_key = ? AND country = ?
           AND site_origin = ? AND resolved_at IS NULL`,
        ).get(
          value.kind,
          value.key,
          value.scope.country,
          value.scope.siteOrigin,
        ) as Task | undefined;
        if (task && !sameFormat(task.input, task.options_json, value)) {
          throw new Error(
            "A shared question key must use the same answer format.",
          );
        }
        if (!task) {
          const created = sql(
            `INSERT INTO needs_you
             (kind, answer_key, country, site_origin, prompt, input, options_json, opened_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            value.kind,
            value.key,
            value.scope.country,
            value.scope.siteOrigin,
            value.prompt,
            value.input,
            JSON.stringify(value.options),
            Date.now(),
          );
          task = get(Number(created.lastInsertRowid))!;
        }
        link(value, task.id);
        sql(
          "UPDATE applications SET state = 'needs_you', updated_at = ? WHERE id = ?",
        ).run(Date.now(), value.applicationId);
        changed();
        return { status: "needs_you", task: toTask(task) };
      });
    },

    /** Oldest first: newly arriving cards never insert above the one being answered. */
    list(input: NeedsYouListQuery = {}): NeedsYouPage {
      const { after, limit } = NeedsYouListQuerySchema.parse(input);
      const records = sql(
        "SELECT * FROM needs_you WHERE resolved_at IS NULL AND id > ? ORDER BY id LIMIT ?",
      ).all(after, limit + 1) as Task[];
      const rows = records.slice(0, limit).map(toTask);
      return {
        rows,
        nextCursor: records.length > limit ? rows.at(-1)!.id : null,
      };
    },

    answer(input: AnswerNeedsYouInput): AnswerNeedsYouResult {
      const value = AnswerNeedsYouInputSchema.parse(input);
      return store.transaction(() => {
        const task = get(value.id);
        if (!task || task.resolved_at !== null)
          return { resolved: false, queued: 0 };
        if (task.kind !== "question")
          throw new Error("Finish this step in the browser.");
        const options = toTask(task).options;
        const answer = value.answer.trim();
        if (
          !answer ||
          (task.input === "boolean" && !["Yes", "No"].includes(answer)) ||
          (task.input === "choice" && !options.includes(answer)) ||
          (task.input === "number" && !Number.isFinite(Number(answer)))
        ) {
          throw new Error("Choose a valid answer for this question.");
        }
        if (value.remember)
          sql(
            `INSERT INTO form_answers (answer_key, country, site_origin, prompt, answer, input, options_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(answer_key, country, site_origin)
           DO UPDATE SET prompt = excluded.prompt, answer = excluded.answer, input = excluded.input,
             options_json = excluded.options_json, updated_at = excluded.updated_at`,
          ).run(
            task.answer_key,
            task.country,
            task.site_origin,
            task.prompt,
            answer,
            task.input,
            task.options_json,
            Date.now(),
          );
        return { resolved: true, queued: resolve(task, answer) };
      });
    },

    /** The browser watcher calls this after verifying sign-in/CAPTCHA/MFA is done. */
    completeAccess(id: number): boolean {
      return store.transaction(() => {
        const task = get(id);
        if (!task || task.kind === "question" || task.resolved_at !== null)
          return false;
        resolve(task, null);
        return true;
      });
    },

    forgetAnswer(
      key: string,
      inputScope: Partial<FormAnswerScope> = {},
    ): boolean {
      const scope = FormAnswerScopeSchema.parse(inputScope);
      return store.transaction(() => {
        const result = sql(
          "DELETE FROM form_answers WHERE answer_key = ? AND country = ? AND site_origin = ?",
        ).run(key, scope.country, scope.siteOrigin);
        if (result.changes) changed();
        return !!result.changes;
      });
    },
  };
}
