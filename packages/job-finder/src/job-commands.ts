import {
  JOB_COMMANDS,
  type JobPosting,
  type SaveFoundJobsResult,
  type JobCommandName,
  type JobCommandOutputs,
  type JobSearchSettings,
  type JobSearchStatus,
} from "@nestor/contracts";
import {
  createJobSitesStore,
  createSearchSourcesStore,
  type JobStore,
} from "@nestor/db/job-store";
import type { z } from "zod";

/** What the commands need from the search runner. */
export interface JobSearchControl {
  start(settings: JobSearchSettings): Promise<unknown>;
  stop(): void;
  retrySource(id: number): Promise<unknown>;
  status(): JobSearchStatus;
  /** Scores saved jobs in Find jobs or Shortlisted that have no fit yet. */
  scoreUnscored(): Promise<number>;
}

/**
 * Saves postings the Assistant read from a browser page into Find jobs. Only
 * verified collections reach this (save_page_jobs, apply_here, page-item
 * grants); it is not a model tool. A posting that matches a saved job keeps
 * that job's stage. `applyOnThisPage` is the person choosing where to apply:
 * the job applies on this page's form even when it was saved from another
 * site first.
 */
export function savePageJobs(
  store: JobStore,
  input: {
    postings: readonly JobPosting[];
    pageUrl: string;
    applyOnThisPage?: boolean;
  },
): SaveFoundJobsResult {
  const site = new URL(input.pageUrl).hostname;
  return store.transaction(() => {
    const saved = store.saveFoundJobs({
      searchId: null,
      jobs: input.postings.map((posting) => ({
        title: posting.title,
        company: posting.company,
        location: posting.location,
        workModes: posting.workMode,
        url: posting.canonicalUrl,
        applyUrl: posting.applicationUrl,
        sourceId: `page:${site}`,
        sourceLabel: site,
        sourceJobId: posting.sourceJobId,
        postedAt: posting.postedAt,
        salaryText: posting.salaryText,
        salaryMin: posting.normalizedCompensation.minAmount ?? null,
        salaryMax: posting.normalizedCompensation.maxAmount ?? null,
        salaryCurrency: posting.normalizedCompensation.currency ?? null,
        seniority: posting.seniority,
        employmentType: posting.employmentType,
        summary: posting.summary,
        description: posting.description,
      })),
    });
    const [posting] = input.postings;
    const [id] = saved.ids;
    if (input.applyOnThisPage && input.postings.length === 1 && posting && id)
      store
        .sql("UPDATE jobs SET apply_url = ? WHERE id = ?")
        .run(posting.applicationUrl ?? input.pageUrl, id);
    return saved;
  });
}

type Handlers = {
  [K in JobCommandName]: (
    input: z.output<(typeof JOB_COMMANDS)[K]["input"]>,
  ) => JobCommandOutputs[K] | Promise<JobCommandOutputs[K]>;
};

export type RunJobCommand = <K extends JobCommandName>(
  name: K,
  input: unknown,
) => Promise<JobCommandOutputs[K]>;

export class UnknownJobCommandError extends Error {
  constructor(name: string) {
    super(`There is no job command named ${name}.`);
  }
}

/**
 * Runs one job command after checking its input. The preload bridge and the
 * Assistant both call this, so a person and the chat can do the same things.
 * `search` is resolved on first use: the runner needs the browser and AI.
 */
export function createJobCommandRunner(deps: {
  store: JobStore;
  /** Builds or returns the search runner; without it searches cannot start. */
  search?: () => Promise<JobSearchControl>;
  /** The runner if it already exists, so status reads never start it. */
  currentSearch?: () => JobSearchControl | null;
}): RunJobCommand {
  const { store } = deps;
  const sites = createJobSitesStore(store);
  const search = () =>
    deps.search?.() ??
    Promise.reject(new Error("Searching is not available here."));
  const current = () => deps.currentSearch?.() ?? null;
  const status = (): JobSearchStatus =>
    current()?.status() ?? {
      search: store.searches.latest(),
      sources: [],
      progress: null,
      sourceRevision: 0,
    };
  const handlers: Handlers = {
    list_jobs: (input) => store.listJobs(input),
    get_job: ({ id }) => store.getJob(id),
    stage_counts: () => store.stageCounts(),
    move_jobs: (input) => {
      const result = store.moveJobs(input);
      // A job shown again after the search hid it has no fit yet.
      if (
        result.moved > 0 &&
        input.to !== "hidden" &&
        store.unscoredJobIds(1).length > 0
      ) {
        void search()
          .then((runner) => runner.scoreUnscored())
          .catch(() => undefined);
      }
      return result;
    },
    undo_move: ({ moveId }) => store.undoMove(moveId),
    list_sites: (input) => sites.list(input),
    get_site: ({ id }) => sites.get(id),
    add_sites: (input) => ({ ...sites.add(input), ...sites.takeUndo() }),
    update_site: (input) => {
      const site = sites.update(input);
      const undo = sites.takeUndo();
      return site ? { ...site, ...undo } : null;
    },
    remove_site: ({ id }) => ({
      removed: sites.remove(id),
      ...sites.takeUndo(),
    }),
    set_sites_enabled: (input) => ({
      changed: sites.setEnabled(input),
      ...sites.takeUndo(),
    }),
    undo_site_change: ({ undoId }) => sites.undo(undoId),
    start_search: async (settings) => {
      const runner = await search();
      await runner.start(settings);
      return runner.status();
    },
    retry_source: async ({ id }) => {
      const runner = await search();
      await runner.retrySource(id);
      return runner.status();
    },
    stop_search: () => {
      current()?.stop();
      return status();
    },
    search_status: () => status(),
    list_search_sources: (query) => createSearchSourcesStore(store).list(query),
  };

  return async (name, input) => {
    if (!Object.hasOwn(JOB_COMMANDS, name)) {
      throw new UnknownJobCommandError(String(name));
    }
    const parsed: unknown = JOB_COMMANDS[name].input.parse(input ?? {});
    const handler = handlers[name] as (value: unknown) => unknown;
    return (await handler(parsed)) as JobCommandOutputs[typeof name];
  };
}
