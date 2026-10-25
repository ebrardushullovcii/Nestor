import { z } from "zod";

import type { JobStageCounts } from "./jobs";
import type { TrackerStatus, TrackerStatusCounts } from "./tracker";

/** How many days Home's activity chart covers, today included. */
export const HOME_ACTIVITY_DAYS = 28;
/** The window "sent recently" covers, for where those applications stand now. */
export const HOME_RECENT_DAYS = 30;

export const HOME_SUMMARY_CHANNEL = "home:summary";

export const HomeSummaryInputSchema = z
  .object({
    /** The person's offset from UTC, so days start at their midnight. */
    utcOffsetMinutes: z.number().int().min(-840).max(840),
  })
  .strict();
export type HomeSummaryInput = z.input<typeof HomeSummaryInputSchema>;

/** One local day of activity, oldest first. */
export interface HomeActivityDay {
  /** `YYYY-MM-DD` in the person's time. */
  day: string;
  sent: number;
  replies: number;
}

/** An interview or reminder that is due, soonest (or most overdue) first. */
export interface HomeUpcoming {
  jobId: number;
  company: string;
  title: string;
  kind: "interview" | "reminder";
  what: string;
  at: string;
  place: string | null;
}

/** Everything Home shows, read from indexed store columns in one call. */
export interface HomeSummary {
  jobs: JobStageCounts;
  tracker: TrackerStatusCounts;
  /** Shortlisted jobs by where their resume is. */
  resumes: { writing: number; toReview: number; failed: number };
  /** Approved resumes not yet handed to Apply. */
  readyToApply: number;
  /** Open Needs you items: questions for applications, site sign-ins, and CAPTCHA or verification codes. */
  needsYou: { questions: number; signIns: number; checks: number };
  /** Open interviews from the start of today through the next 7 days. */
  interviewsThisWeek: number;
  /** Applications whose next interview or reminder is due. */
  followUpsDue: number;
  /** Jobs found since the person's midnight that are still in Find jobs. */
  foundToday: number;
  days: HomeActivityDay[];
  /** Applications sent in the last `HOME_RECENT_DAYS`, by status now. */
  recent: Record<TrackerStatus, number>;
  upcoming: HomeUpcoming[];
}
