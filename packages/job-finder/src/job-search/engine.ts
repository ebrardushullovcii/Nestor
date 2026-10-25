import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  FoundJob,
  JobDetail,
  JobDiscoveryTarget,
  JobFitUpdate,
  JobSearchSettings,
  JobSource,
} from "@nestor/contracts";

import { abortable, createSlots } from "./async";
import { keepPosting, toFitPosting, toFoundJob } from "./postings";
import { planSource, searchSource, type SourcePlan } from "./sources";
import type { JobSearchContext } from "./types";

export interface SearchSiteInput {
  target: JobDiscoveryTarget;
  settings: JobSearchSettings;
  context: JobSearchContext;
  signal: AbortSignal;
  /** Which of these listing links are saved already, so they are not read again. */
  knownUrls(urls: readonly string[]): readonly string[];
  /**
   * Hands over each batch of jobs as it is found. A job the engine decided
   * not to keep carries `hiddenReason`; it is saved as hidden so the person
   * can see why and show it again, and a later search skips it.
   */
  found(jobs: readonly FoundJob[]): void;
  /** What the site is doing, in a few words. */
  message(text: string): void;
}

export interface SearchSiteResult {
  /** Sign-in, CAPTCHA or another step only the person can take. */
  needsYou: boolean;
  message: string | null;
}

/**
 * What a search does on the sites and how it judges fit. The runner owns
 * when and how many sites run, saving, counts, stopping and status; the
 * engine owns everything between a site and a list of found jobs.
 */
export interface JobSearchEngine {
  /** Feed sites are cheap reads; browser sites take a tab. Each lane is capped. */
  lane(
    target: JobDiscoveryTarget,
    context: JobSearchContext,
  ): "feed" | "browser";
  searchSite(input: SearchSiteInput): Promise<SearchSiteResult>;
  /** Fit for at most 20 saved jobs. Jobs it cannot judge are left out. */
  judgeFits(input: {
    jobs: readonly JobDetail[];
    context: JobSearchContext;
    signal: AbortSignal;
  }): Promise<JobFitUpdate[]>;
}

/** The search agent and fit judging as they work today. */
export function createCurrentSearchEngine(deps: {
  browserRuntime: Pick<BrowserSessionRuntime, "runAgentDiscovery">;
  aiClient: JobFinderAiClient;
  /** Once per adapter per search, before its first browser search. */
  openBrowserSession?(
    source: JobSource,
    target: JobDiscoveryTarget,
    signal: AbortSignal,
  ): Promise<void>;
  /** Browser tabs one search may use at once. */
  browserTabs?: number;
}): JobSearchEngine {
  // One search shares one context object; plans, the session and the tab
  // slots live as long as it does.
  const runs = new WeakMap<
    JobSearchContext,
    {
      plans: Map<string, SourcePlan>;
      session: Promise<void> | null;
      inBrowser: ReturnType<typeof createSlots> | null;
    }
  >();
  const runOf = (context: JobSearchContext) => {
    let run = runs.get(context);
    if (!run) {
      run = { plans: new Map(), session: null, inBrowser: null };
      runs.set(context, run);
    }
    return run;
  };
  const planOf = (target: JobDiscoveryTarget, context: JobSearchContext) => {
    const run = runOf(context);
    let plan = run.plans.get(target.id);
    if (!plan) {
      const artifacts = new Map(
        context.sourceInstructionArtifacts.map((artifact) => [
          artifact.id,
          artifact,
        ]),
      );
      plan = planSource(target, artifacts);
      run.plans.set(target.id, plan);
    }
    return plan;
  };

  return {
    lane: (target, context) =>
      planOf(target, context).feed ? "feed" : "browser",

    async searchSite(input) {
      const { target, context, settings, signal } = input;
      const run = runOf(context);
      run.inBrowser ??= createSlots(deps.browserTabs ?? 2, signal);
      return searchSource({
        deps,
        context,
        settings,
        plan: planOf(target, context),
        signal,
        inBrowser: run.inBrowser,
        openSession: (site) => {
          run.session ??= (
            deps.openBrowserSession?.("target_site", site, signal) ??
            Promise.resolve()
          ).catch((error: unknown) => {
            run.session = null;
            throw error;
          });
          return abortable(run.session, signal);
        },
        save: (postings) => {
          const now = Date.now();
          input.found(
            postings
              .filter((posting) =>
                keepPosting(posting, context.searchPreferences, settings, now),
              )
              .map((posting) => toFoundJob(posting, target)),
          );
        },
        message: (text) => input.message(text),
        knownUrls: (urls) => input.knownUrls(urls),
      });
    },

    async judgeFits({ jobs, context, signal }) {
      if (jobs.length === 0 || !deps.aiClient.judgeJobFits) return [];
      const judgments = await abortable(
        deps.aiClient.judgeJobFits({
          signal,
          assessmentDate: new Date().toISOString().slice(0, 10),
          profile: context.profile,
          searchPreferences: context.searchPreferences,
          jobs: jobs.map((job) => ({
            jobId: String(job.id),
            posting: toFitPosting(job),
          })),
        }),
        signal,
      );
      const expected = new Set(jobs.map((job) => String(job.id)));
      const updates: JobFitUpdate[] = [];
      for (const judgment of judgments) {
        if (
          !expected.delete(judgment.jobId) ||
          !Number.isFinite(judgment.score)
        )
          continue;
        updates.push({
          id: Number(judgment.jobId),
          score: Math.max(0, Math.min(100, Math.round(judgment.score))),
          summary: judgment.summary ?? "",
          reasons: judgment.reasons,
          gaps: judgment.gaps,
        });
      }
      return updates;
    },
  };
}
