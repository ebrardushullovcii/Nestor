import {
  normalizeFormQuestionPrompt,
  RememberFormAnswerInputSchema,
  type RememberFormAnswerInput,
  type FormAnswerLookup,
  type FormAnswerMatch,
  AnswerNeedsYouInputSchema,
  FormAnswerScopeSchema,
  NeedsYouTaskSchema,
  NeedsYouCountsSchema,
  SaveNeedsYouDraftInputSchema,
  SavedFormAnswersQuerySchema,
  SaveFormAnswerInputSchema,
  ForgetFormAnswersInputSchema,
  type NeedsYouCounts,
  type NeedsYouDetails,
  type SaveNeedsYouDraftInput,
  type SaveNeedsYouDraftResult,
  type SavedFormAnswersQuery,
  type SavedFormAnswersPage,
  type SavedFormAnswer,
  type SaveFormAnswerInput,
  type ForgetFormAnswersInput,
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

import type { SQLInputValue } from "node:sqlite";
import type { JobStore } from "./job-store";
import { toIso } from "./job-list";

type Task = {
  id: number;
  kind: NeedsYouTask["kind"];
  answer_key: string;
  country: string;
  site_origin: string;
  prompt: string;
  prompt_key: string;
  reuse_prompt: number;
  input: NeedsYouTask["input"];
  options_json: string;
  opened_at: number;
  resolved_at: number | null;
  answer: string | null;
  source_id?: number | null;
  source_label?: string | null;
  source_url?: string | null;
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
    ...(row.source_id != null
      ? {
          source: {
            id: row.source_id,
            label: row.source_label,
            url: row.source_url,
          },
        }
      : {}),
  });
}

const totalCap = 1000;
const matchText = (text: string) =>
  (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((word) => `"${word}"*`)
    .join(" AND ");
function validateAnswer(
  task: Pick<Task, "input" | "options_json">,
  answer: string,
): string {
  answer = answer.trim();
  const options = JSON.parse(task.options_json) as string[];
  if (
    !answer ||
    (task.input === "boolean" && !["Yes", "No"].includes(answer)) ||
    (task.input === "choice" && !options.includes(answer)) ||
    (task.input === "number" && !Number.isFinite(Number(answer)))
  )
    throw new Error("Choose a valid answer for this question.");
  return answer;
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
    sql("DELETE FROM needs_you_drafts WHERE task_id = ?").run(task.id);
    changed();
    return Number(queued.changes);
  };

  const counts = (): NeedsYouCounts => {
    const value = { question: 0, sign_in: 0, captcha: 0, mfa: 0, saved: 0 };
    for (const row of sql(
      "SELECT kind, n FROM needs_you_counts",
    ).all() as Array<{ kind: keyof NeedsYouCounts; n: number }>)
      value[row.kind] = row.n;
    return NeedsYouCountsSchema.parse(value);
  };
  const savedAnswer = (id: number): SavedFormAnswer | null => {
    const row = sql("SELECT * FROM form_answers WHERE id = ?").get(id) as
      | {
          id: number;
          answer_key: string;
          country: string;
          site_origin: string;
          prompt: string;
          answer: string;
          input: Task["input"];
          options_json: string;
          updated_at: number;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          prompt: row.prompt,
          answer: row.answer,
          preview: row.answer.slice(0, 140),
          scope: { country: row.country, siteOrigin: row.site_origin },
          input: row.input,
          options: JSON.parse(row.options_json) as string[],
          updatedAt: toIso(row.updated_at),
        }
      : null;
  };

  function writeAnswer(input: RememberFormAnswerInput): number {
    const value = RememberFormAnswerInputSchema.parse(input);
    const result =
      sql(`INSERT INTO form_answers(answer_key,country,site_origin,prompt,prompt_key,answer,input,options_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(answer_key,country,site_origin) DO UPDATE SET
      prompt=excluded.prompt,prompt_key=excluded.prompt_key,answer=excluded.answer,input=excluded.input,options_json=excluded.options_json,updated_at=excluded.updated_at RETURNING id`).get(
        value.key,
        value.scope.country,
        value.scope.siteOrigin,
        value.prompt,
        normalizeFormQuestionPrompt(value.prompt),
        value.answer,
        value.input,
        JSON.stringify(value.options),
        Date.now(),
      ) as { id: number };
    return result.id;
  }
  function resolveMatching(
    key: string,
    prompt: string,
    country: string,
    origin: string,
    answer: string,
  ): number {
    const waiting =
      sql(`SELECT * FROM needs_you WHERE kind='question' AND resolved_at IS NULL AND answer_key=? AND country=? AND site_origin=?
      UNION SELECT * FROM needs_you WHERE kind='question' AND resolved_at IS NULL AND reuse_prompt=1 AND prompt_key=? AND country=? AND site_origin=?`).all(
        key,
        country,
        origin,
        prompt,
        country,
        origin,
      ) as Task[];
    return waiting.reduce((queued, task) => queued + resolve(task, answer), 0);
  }

  return {
    counts,
    remember(input: RememberFormAnswerInput): SavedFormAnswer {
      return store.transaction(() => {
        const value = RememberFormAnswerInputSchema.parse(input);
        const id = writeAnswer(value);
        resolveMatching(
          value.key,
          normalizeFormQuestionPrompt(value.prompt),
          value.scope.country,
          value.scope.siteOrigin,
          value.answer,
        );
        changed();
        return savedAnswer(id)!;
      });
    },
    details(id: number): NeedsYouDetails | null {
      const task = get(id);
      if (!task || task.resolved_at !== null) return null;
      const applications =
        sql(`SELECT a.id, a.job_id AS jobId, j.title, j.company, j.location, a.state
        FROM application_needs_you n JOIN applications a ON a.id = n.application_id JOIN jobs j ON j.id = a.job_id
        WHERE n.task_id = ? AND n.attempt = a.attempt AND a.state = 'needs_you' ORDER BY a.id LIMIT 50`).all(
          id,
        ) as NeedsYouDetails["applications"];
      const draft = sql(
        "SELECT answer, remember, revision FROM needs_you_drafts WHERE task_id = ?",
      ).get(id) as
        | { answer: string; remember: number; revision: number }
        | undefined;
      return {
        task: toTask(task),
        applications,
        draft: draft
          ? {
              answer: draft.answer,
              remember: draft.remember === 1,
              revision: draft.revision,
            }
          : null,
      };
    },
    saveDraft(input: SaveNeedsYouDraftInput): SaveNeedsYouDraftResult {
      const value = SaveNeedsYouDraftInputSchema.parse(input);
      return store.transaction(() => {
        const task = get(value.id);
        const draft = sql(
          "SELECT revision FROM needs_you_drafts WHERE task_id = ?",
        ).get(value.id) as { revision: number } | undefined;
        const revision = draft?.revision ?? 0;
        if (
          !task ||
          task.resolved_at !== null ||
          task.kind !== "question" ||
          revision !== value.revision
        )
          return { saved: false, revision };
        sql(`INSERT INTO needs_you_drafts(task_id,answer,remember,revision) VALUES(?,?,?,?)
          ON CONFLICT(task_id) DO UPDATE SET answer=excluded.answer,remember=excluded.remember,revision=excluded.revision`).run(
          value.id,
          value.answer,
          value.remember ? 1 : 0,
          revision + 1,
        );
        return { saved: true, revision: revision + 1 };
      });
    },
    savedAnswer,
    listAnswers(input: SavedFormAnswersQuery = {}): SavedFormAnswersPage {
      const query = SavedFormAnswersQuerySchema.parse(input);
      const countsNow = counts();
      const match = matchText(query.text);
      const where = query.text
        ? match
          ? "id IN (SELECT rowid FROM form_answers_text WHERE form_answers_text MATCH ?)"
          : "0"
        : "1";
      const params: SQLInputValue[] = match && query.text ? [match] : [];
      const records =
        sql(`SELECT id,prompt,substr(answer,1,140) AS preview,country,site_origin,input,updated_at
        FROM form_answers WHERE ${where} AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT ?`).all(
          ...params,
          query.after,
          query.after,
          query.limit + 1,
        ) as Array<{
          id: number;
          prompt: string;
          preview: string;
          country: string;
          site_origin: string;
          input: Task["input"];
          updated_at: number;
        }>;
      const total = query.text
        ? (
            sql(
              `SELECT count(*) AS n FROM (SELECT id FROM form_answers WHERE ${where} LIMIT ?)`,
            ).get(...params, totalCap + 1) as { n: number }
          ).n
        : countsNow.saved;
      const rows = records.slice(0, query.limit).map((row) => ({
        id: row.id,
        prompt: row.prompt,
        preview: row.preview,
        scope: { country: row.country, siteOrigin: row.site_origin },
        input: row.input,
        updatedAt: toIso(row.updated_at),
      }));
      return {
        rows,
        nextCursor: records.length > query.limit ? rows.at(-1)!.id : null,
        total: Math.min(total, totalCap),
        totalCapped: total > totalCap,
      };
    },
    saveAnswer(input: SaveFormAnswerInput): boolean {
      const value = SaveFormAnswerInputSchema.parse(input);
      return store.transaction(() => {
        const previous = sql(
          "SELECT input,options_json,answer_key,prompt_key,country,site_origin FROM form_answers WHERE id = ?",
        ).get(value.id) as
          | Pick<
              Task,
              | "input"
              | "options_json"
              | "answer_key"
              | "prompt_key"
              | "country"
              | "site_origin"
            >
          | undefined;
        if (!previous) return false;
        const answer = validateAnswer(previous, value.answer);
        sql(
          "UPDATE form_answers SET answer = ?, updated_at = ? WHERE id = ?",
        ).run(answer, Date.now(), value.id);
        resolveMatching(
          previous.answer_key,
          previous.prompt_key,
          previous.country,
          previous.site_origin,
          answer,
        );
        changed();
        return true;
      });
    },
    forgetAnswers(input: ForgetFormAnswersInput): number {
      const selection = ForgetFormAnswersInputSchema.parse(input);
      return store.transaction(() => {
        const match =
          "filter" in selection ? matchText(selection.filter.text) : "";
        const result =
          "ids" in selection
            ? sql(
                "DELETE FROM form_answers WHERE id IN (SELECT value FROM json_each(?))",
              ).run(JSON.stringify(selection.ids))
            : selection.filter.text && !match
              ? { changes: 0 }
              : sql(
                  `DELETE FROM form_answers WHERE id NOT IN (SELECT value FROM json_each(?))${match ? " AND id IN (SELECT rowid FROM form_answers_text WHERE form_answers_text MATCH ?)" : ""}`,
                ).run(
                  JSON.stringify(selection.except),
                  ...(match ? [match] : []),
                );
        if (result.changes) changed();
        return Number(result.changes);
      });
    },
    /** Read only visible questions. The same fact may fill numeric, text or choice controls. */
    answersForQuestions(
      applicationId: number,
      questions: readonly FormAnswerLookup[],
      siteOrigin: string,
    ): FormAnswerMatch[] {
      const origin = FormAnswerScopeSchema.parse({ siteOrigin }).siteOrigin;
      return questions.flatMap<FormAnswerMatch>((question) => {
        const key = question.reusePrompt
          ? normalizeFormQuestionPrompt(question.prompt)
          : question.key;
        const local =
          sql(`SELECT t.id,t.prompt,t.answer FROM application_needs_you n JOIN needs_you t ON t.id=n.task_id
          WHERE n.application_id=? AND t.kind='question' AND t.answer IS NOT NULL AND ${question.reusePrompt ? "t.reuse_prompt=1 AND t.prompt_key=?" : "t.answer_key=?"}
          ORDER BY t.resolved_at DESC,t.id DESC LIMIT 1`).get(
            applicationId,
            key,
          ) as { id: number; prompt: string; answer: string } | undefined;
        if (local)
          return [
            {
              id: `application:${local.id}`,
              key: question.key,
              prompt: local.prompt,
              answer: local.answer,
              local: true,
            },
          ];
        const saved =
          sql(`SELECT id,prompt,answer FROM form_answers WHERE ${question.reusePrompt ? "prompt_key" : "answer_key"}=? AND country='' AND site_origin IN ('',?)
          ORDER BY (site_origin=?) DESC,updated_at DESC,id DESC LIMIT 1`).get(
            key,
            origin,
            origin,
          ) as { id: number; prompt: string; answer: string } | undefined;
        return saved
          ? [
              {
                id: `saved:${saved.id}`,
                key: question.key,
                prompt: saved.prompt,
                answer: saved.answer,
                local: false,
              },
            ]
          : [];
      });
    },
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
          const saved = value.reusePrompt
            ? (sql(
                "SELECT answer,input,options_json FROM form_answers WHERE prompt_key=? AND country=? AND site_origin=? ORDER BY updated_at DESC,id DESC LIMIT 1",
              ).get(
                normalizeFormQuestionPrompt(value.prompt),
                value.scope.country,
                value.scope.siteOrigin,
              ) as
                | { answer: string; input: string; options_json: string }
                | undefined)
            : findAnswerRecord(value.key, value.scope);
          if (saved) {
            if (
              !value.reusePrompt &&
              !sameFormat(saved.input, saved.options_json, value)
            )
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
             (kind, answer_key, country, site_origin, prompt, input, options_json, opened_at, prompt_key, reuse_prompt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            value.kind,
            value.key,
            value.scope.country,
            value.scope.siteOrigin,
            value.prompt,
            value.input,
            JSON.stringify(value.options),
            Date.now(),
            normalizeFormQuestionPrompt(value.prompt),
            value.reusePrompt ? 1 : 0,
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
      const { after, limit, kind, text } = NeedsYouListQuerySchema.parse(input);
      const match = matchText(text);
      const filters = ["resolved_at IS NULL"];
      const params: SQLInputValue[] = [];
      if (kind !== null) {
        filters.push("kind = ?");
        params.push(kind);
      }
      if (text) {
        filters.push(
          match
            ? "id IN (SELECT rowid FROM needs_you_text WHERE needs_you_text MATCH ?)"
            : "0",
        );
        if (match) params.push(match);
      }
      const where = filters.join(" AND ");
      const records = sql(
        `SELECT t.*, s.id AS source_id, s.label AS source_label, s.url AS source_url
         FROM (SELECT * FROM needs_you WHERE ${where} AND id > ? ORDER BY id LIMIT ?) t
         LEFT JOIN source_needs_you n ON n.task_id = t.id
         LEFT JOIN job_sites s ON s.id = n.source_id ORDER BY t.id`,
      ).all(...params, after, limit + 1) as Task[];
      const rows = records.slice(0, limit).map(toTask);
      const countsNow = counts();
      const total = text
        ? (
            sql(
              `SELECT count(*) AS n FROM (SELECT id FROM needs_you WHERE ${where} LIMIT ?)`,
            ).get(...params, totalCap + 1) as { n: number }
          ).n
        : kind
          ? countsNow[kind]
          : countsNow.question +
            countsNow.sign_in +
            countsNow.captcha +
            countsNow.mfa;
      return {
        rows,
        nextCursor: records.length > limit ? rows.at(-1)!.id : null,
        total: Math.min(total, totalCap),
        totalCapped: total > totalCap,
        counts: countsNow,
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
        const answer = validateAnswer(task, value.answer);
        if (value.remember)
          writeAnswer({
            key: task.answer_key,
            scope: { country: task.country, siteOrigin: task.site_origin },
            prompt: task.prompt,
            input: task.input,
            options: JSON.parse(task.options_json) as string[],
            answer,
          });
        let queued = resolve(task, answer);
        if (value.remember && task.reuse_prompt === 1)
          queued += resolveMatching(
            task.answer_key,
            task.prompt_key,
            task.country,
            task.site_origin,
            answer,
          );
        return { resolved: true, queued };
      });
    },

    accessForApplication(applicationId: number): NeedsYouTask[] {
      return (
        sql(`SELECT t.* FROM application_needs_you n JOIN needs_you t ON t.id = n.task_id
        JOIN applications a ON a.id = n.application_id
        WHERE n.application_id = ? AND n.attempt = a.attempt AND t.kind <> 'question'
          AND t.resolved_at IS NULL`).all(applicationId) as Task[]
      ).map(toTask);
    },

    /** The browser watcher verifies one exact bound page before completing its task. */
    completeAccess(id: number, verifiedApplicationId: number): boolean {
      return store.transaction(() => {
        const task = get(id);
        if (!task || task.kind === "question" || task.resolved_at !== null)
          return false;
        const linked =
          sql(`SELECT 1 FROM application_needs_you n JOIN applications a ON a.id = n.application_id
          WHERE n.task_id = ? AND n.application_id = ? AND n.attempt = a.attempt AND a.state = 'needs_you'`).get(
            id,
            verifiedApplicationId,
          );
        if (!linked) return false;
        // A shared sign-in changes the session for other pages. Those pages
        // need a GET at their checkpoint; the page the person finished keeps
        // its current form and answers.
        if (task.kind === "sign_in")
          sql(`UPDATE application_details SET access_recheck = 1
          WHERE application_id <> ? AND application_id IN (
            SELECT n.application_id FROM application_needs_you n JOIN applications a ON a.id = n.application_id
            WHERE n.task_id = ? AND n.attempt = a.attempt AND a.state = 'needs_you'
          )`).run(verifiedApplicationId, id);
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
