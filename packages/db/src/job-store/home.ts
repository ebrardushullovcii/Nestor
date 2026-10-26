import {
  HOME_ACTIVITY_DAYS,
  HOME_RECENT_DAYS,
  HomeSummaryInputSchema,
  trackerStatusValues,
  type HomeActivityDay,
  type HomeSummary,
  type HomeSummaryInput,
  type HomeUpcoming,
  type TrackerStatus,
} from "@nestor/contracts";

import type { JobStore } from "./job-store";
import { HAS_APPROVED_RESUME } from "./applications";
import { toIso } from "./job-list";
import { createTrackerStore } from "./tracker";

const DAY_MS = 86_400_000;
/** Interviews and reminders this far ahead show on Home. */
const UPCOMING_MS = 7 * DAY_MS;
const UPCOMING_LIMIT = 6;

/**
 * Home's numbers. Each one is a count or a day bucket over an indexed column
 * (stage counts, tracker counts, `applied_at`, event kind and time, `next_at`),
 * so Home stays as fast at thousands of applications as at ten.
 */
export function createHomeStore(store: JobStore) {
  const { sql } = store;
  const tracker = createTrackerStore(store);

  // Times can come back as REAL, so each day is cast to a whole number.
  const perDay = (query: string, since: number, offset: number) => {
    const counts = new Map<number, number>();
    for (const row of sql(query).all(offset, since) as {
      d: number;
      n: number;
    }[])
      counts.set(row.d, row.n);
    return counts;
  };

  return {
    summary(input: HomeSummaryInput, now = Date.now()): HomeSummary {
      const { utcOffsetMinutes } = HomeSummaryInputSchema.parse(input);
      const offset = utcOffsetMinutes * 60_000;
      const today = Math.floor((now + offset) / DAY_MS);
      const firstDay = today - HOME_ACTIVITY_DAYS + 1;
      const since = firstDay * DAY_MS - offset;

      const sent = perDay(
        `SELECT CAST((applied_at + ?) / ${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
         FROM tracker WHERE applied_at >= ? GROUP BY d`,
        since,
        offset,
      );
      const replies = perDay(
        `SELECT CAST((at + ?) / ${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
         FROM tracker_events WHERE kind = 'reply' AND at >= ? GROUP BY d`,
        since,
        offset,
      );
      const days: HomeActivityDay[] = [];
      for (let day = firstDay; day <= today; day += 1)
        days.push({
          day: new Date(day * DAY_MS).toISOString().slice(0, 10),
          sent: sent.get(day) ?? 0,
          replies: replies.get(day) ?? 0,
        });

      const recent = Object.fromEntries(
        trackerStatusValues.map((status) => [status, 0]),
      ) as Record<TrackerStatus, number>;
      for (const row of sql(
        `SELECT status, COUNT(*) AS n FROM tracker
         WHERE applied_at >= ? GROUP BY status`,
      ).all(now - HOME_RECENT_DAYS * DAY_MS) as {
        status: TrackerStatus;
        n: number;
      }[])
        recent[row.status] = row.n;

      const resumes = { writing: 0, toReview: 0, failed: 0 };
      let withResume = 0;
      for (const row of sql(
        `SELECT r.state AS state, r.approved_at IS NULL AS open, COUNT(*) AS n
         FROM jobs j JOIN resumes r ON r.job_id = j.id
         WHERE j.stage = 'shortlisted' GROUP BY state, open`,
      ).all() as { state: string; open: number; n: number }[]) {
        withResume += row.n;
        if (row.state === "ready" && row.open) resumes.toReview += row.n;
        else if (row.state === "failed") resumes.failed += row.n;
        else if (row.state !== "ready") resumes.writing += row.n;
      }
      const jobs = store.stageCounts();
      // Shortlisted with no resume row yet are waiting for their listing read.
      resumes.writing += Math.max(0, jobs.shortlisted - withResume);

      const count = (query: string, ...params: number[]) =>
        (sql(query).get(...params) as { n: number }).n;
      const needsYou = (kind: string) =>
        (
          sql(`SELECT n FROM needs_you_counts WHERE kind = ?`).get(kind) as
            | { n: number }
            | undefined
        )?.n ?? 0;

      // Every open interview and reminder, not just each application's next
      // one: an overdue reminder must not hide an interview on the same job.
      // Interviews come first so a pile of overdue reminders can't push
      // today's interview off the list.
      const upcoming = (
        sql(
          `SELECT e.job_id AS jobId, j.company, j.title, e.due_at AS at, e.title AS what,
             e.kind, e.place
           FROM tracker_events e JOIN jobs j ON j.id = e.job_id
           WHERE e.kind IN ('interview', 'reminder') AND e.due_at IS NOT NULL
             AND e.done_at IS NULL AND e.due_at <= ?
           ORDER BY e.kind = 'interview' DESC, e.due_at, e.id
           LIMIT ${UPCOMING_LIMIT}`,
        ).all(now + UPCOMING_MS) as {
          jobId: number;
          company: string;
          title: string;
          at: number;
          what: string;
          kind: string | null;
          place: string | null;
        }[]
      ).map(
        (row): HomeUpcoming => ({
          jobId: row.jobId,
          company: row.company,
          title: row.title,
          kind: row.kind === "interview" ? "interview" : "reminder",
          what: row.what,
          at: toIso(row.at),
          place: row.place,
        }),
      );

      return {
        jobs,
        tracker: tracker.counts(),
        resumes,
        readyToApply: count(
          `SELECT COUNT(*) AS n FROM jobs j WHERE j.stage = 'resume'
           AND ${HAS_APPROVED_RESUME}
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)`,
        ),
        applyWorking: count(
          `SELECT COUNT(*) AS n FROM applications
           WHERE state IN ('queued', 'running', 'needs_you', 'ready', 'submitting')`,
        ),
        needsYou: {
          questions: needsYou("question"),
          signIns: needsYou("sign_in"),
          checks: needsYou("captcha") + needsYou("mfa"),
        },
        interviewsThisWeek: count(
          `SELECT COUNT(*) AS n FROM tracker_events
           WHERE kind = 'interview' AND due_at IS NOT NULL AND done_at IS NULL
             AND due_at >= ? AND due_at <= ?`,
          today * DAY_MS - offset,
          now + UPCOMING_MS,
        ),
        followUpsDue: count(
          `SELECT COUNT(*) AS n FROM tracker WHERE next_at IS NOT NULL AND next_at <= ?`,
          now,
        ),
        foundToday: count(
          `SELECT COUNT(*) AS n FROM jobs WHERE stage = 'found' AND found_at >= ?`,
          today * DAY_MS - offset,
        ),
        days,
        recent,
        upcoming,
      };
    },
  };
}

export type HomeStore = ReturnType<typeof createHomeStore>;
