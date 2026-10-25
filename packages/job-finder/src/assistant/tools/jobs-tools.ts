import {
  DiscoveryFeedbackReasonSchema,
  JobDiscoveryTargetSchema,
  JobFinderAssistantSearchInputSchema,
  JobFinderSourceQueryInputSchema,
  NonEmptyStringSchema,
  discoveryFeedbackReasonValues,
  normalizeCompanyName,
  type DiscoveryFeedbackBatchOutcome,
  type DiscoveryJobView,
} from "@nestor/contracts";
import { z } from "zod";
import { executeJobFinderAction } from "../action-registry";
import { diffValues } from "../change-diff";
import {
  AssistantToolError,
  defineTool,
  json,
  readAssistantWorkspace,
} from "../tool-kit";
import { recordTriageChange } from "../triage-changes";
import { runningSearchState } from "../work-state";
import {
  allJobs,
  assistantJobStatus,
  compactJob,
  createJobCaveats,
  describeApplicationStanding,
  findJob,
  jobDetail,
  jobEvidence,
  jobRowsPart,
  pausedByPersonMessage,
  plural,
} from "./format";

function feedbackOutcome(entry: DiscoveryFeedbackBatchOutcome) {
  return {
    jobId: entry.jobId,
    outcome:
      entry.status === "failed"
        ? `failed: ${entry.message}`
        : entry.status === "held"
          ? `held back: ${entry.message}`
          : entry.status === "stopped"
            ? "not started: stopped"
            : entry.status,
  };
}

const Id = NonEmptyStringSchema.max(200);

const QueryInput = z.object({
  scope: z.enum(["found", "shortlisted", "dismissed", "all"]).default("found"),
  text: z.string().trim().max(200).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  workMode: z.enum(["remote", "hybrid", "onsite"]).optional(),
  postedWithinDays: z.number().int().min(1).max(365).optional(),
  onlyIds: z.array(Id).max(3000).optional(),
  sourceIds: z.array(Id).min(1).max(1_000).optional(),
  listingOrigins: z.array(z.string().url()).min(1).max(200).optional(),
  sort: z.enum(["score", "recent", "shortlisted"]).default("score"),
  limit: z.number().int().min(1).max(25).default(10),
  includeExcludedEmployers: z.boolean().default(false),
  show: z.boolean().default(true),
});

function filterJobs(
  jobs: readonly DiscoveryJobView[],
  input: z.infer<typeof QueryInput>,
  now: number,
): DiscoveryJobView[] {
  const words = (input.text ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 1);
  const only = input.onlyIds ? new Set(input.onlyIds) : null;
  const sources = input.sourceIds ? new Set(input.sourceIds) : null;
  const origins = input.listingOrigins
    ? new Set(input.listingOrigins.map((url) => new URL(url).origin))
    : null;
  const filtered = jobs.filter((job) => {
    if (only && !only.has(job.id)) return false;
    if (sources && !job.provenance.some((entry) => sources.has(entry.targetId)))
      return false;
    if (origins) {
      try {
        if (!origins.has(new URL(job.canonicalUrl).origin)) return false;
      } catch {
        return false;
      }
    }
    if (
      input.scope === "found" &&
      !["discovered", "shortlisted"].includes(job.status)
    )
      return false;
    if (input.scope === "dismissed" && job.status !== "archived") return false;
    if (
      typeof input.minScore === "number" &&
      job.matchAssessment.score < input.minScore
    )
      return false;
    if (input.workMode && !job.workMode.includes(input.workMode)) return false;
    if (input.postedWithinDays) {
      const posted = Date.parse(job.postedAt ?? job.discoveredAt);
      if (
        !Number.isFinite(posted) ||
        now - posted > input.postedWithinDays * 86_400_000
      )
        return false;
    }
    if (words.length > 0) {
      const haystack =
        `${job.title} ${job.company} ${job.location} ${job.keySkills.join(" ")}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
  return filtered.sort((left, right) =>
    input.sort === "shortlisted"
      ? (right.shortlistedAt ?? "").localeCompare(left.shortlistedAt ?? "")
      : input.sort === "recent"
        ? (right.postedAt ?? right.discoveredAt).localeCompare(
            left.postedAt ?? left.discoveredAt,
          )
        : right.matchAssessment.score - left.matchAssessment.score,
  );
}

export const queryJobsTool = defineTool({
  name: "query_jobs",
  group: "jobs",
  description:
    "Lists saved jobs with fit evidence: found (not yet shortlisted), shortlisted, dismissed or all, filtered by words, minimum match score, work mode or recency, or restricted to given ids (a result set from the screen). All matches go into a result set in stable order; the rows shown are the first ones. Jobs from excluded employers are left out; rows marked alreadyApplied are the same posting as one the person applied to (one job across sources), so don't pick them without asking.",
  parameters: json.object({
    scope: json.enumOf(["found", "shortlisted", "dismissed", "all"]),
    text: json.string("Words in the title, company, location or skills."),
    minScore: json.number(),
    workMode: json.enumOf(["remote", "hybrid", "onsite"]),
    postedWithinDays: json.number(),
    onlyIds: json.ids("Restrict to these job ids."),
    sourceIds: json.ids(
      "Only jobs collected from these source IDs. Keep the person's source restriction when ranking or shortlisting.",
    ),
    listingOrigins: json.ids(
      "Only listing URLs on these exact origins, including port, such as http://127.0.0.1:47950. For local-only picks use the requested local origin.",
    ),
    sort: json.enumOf(
      ["score", "recent", "shortlisted"],
      "shortlisted orders by the recorded shortlist time; undated older rows are last.",
    ),
    limit: json.number("Rows to show, at most 25."),
    includeExcludedEmployers: json.boolean(
      "Only when the person names an excluded employer.",
    ),
    show: json.boolean(
      "False when you are only looking things up for your answer; the rows then are not shown as cards. Show your picks with show_jobs.",
    ),
  }),
  input: QueryInput,
  label: () => "Looking through your jobs",
  effect: "read",
  async execute(input, { service, session }) {
    const snapshot = await readAssistantWorkspace(service);
    const caveatsFor = createJobCaveats(snapshot);
    // Shortlisted is the active plan's curated list; company history also
    // contains jobs belonging only to other plans and jobs removed from it.
    const activePlan = snapshot.campaigns.find(
      (campaign) => campaign.id === snapshot.activeCampaignId,
    );
    const activePlanIds = new Set(activePlan?.jobIds ?? []);
    const shortlistIds = new Set(
      snapshot.reviewQueue
        .filter((item) => activePlanIds.has(item.jobId))
        .map((item) => item.jobId),
    );
    const candidates =
      input.scope === "shortlisted"
        ? allJobs(snapshot).filter((job) => shortlistIds.has(job.id))
        : allJobs(snapshot);
    const all = filterJobs(candidates, input, Date.now());
    // Jobs from an employer the person excluded never come back in a pick
    // unless asked for by name.
    const matches = input.includeExcludedEmployers
      ? all
      : all.filter((job) => !caveatsFor(job).excludedEmployer);
    const hiddenExcluded = all.length - matches.length;
    const resultSet = await session.createResultSet({
      kind: "jobs",
      label:
        `Jobs: ${input.scope}${input.text ? ` matching "${input.text}"` : ""}${input.sourceIds ? `; sources ${input.sourceIds.join(", ")}` : ""}${input.listingOrigins ? `; listing origins ${input.listingOrigins.join(", ")}` : ""}`.slice(
          0,
          200,
        ),
      itemIds: matches.map((job) => job.id),
      source: "tool_query",
    });
    const shown = matches.slice(0, input.limit);
    return {
      summary: `${plural(matches.length, "job")} match (result set ${resultSet.id}).${hiddenExcluded > 0 ? ` ${plural(hiddenExcluded, "job")} from employers the person excluded left out.` : ""}`,
      data: {
        resultSetId: resultSet.id,
        total: matches.length,
        sourceRestriction: {
          sourceIds: input.sourceIds ?? null,
          listingOrigins: input.listingOrigins ?? null,
        },
        jobs: shown.map((job, index) => {
          const caveats = caveatsFor(job);
          return {
            position: index + 1,
            ...jobEvidence(job),
            shortlistedAt: job.shortlistedAt ?? null,
            application: describeApplicationStanding(snapshot, job.id),
            ...(caveats.excludedEmployer ? { excludedEmployer: true } : {}),
            ...(caveats.alreadyAppliedAs
              ? {
                  alreadyApplied:
                    caveats.alreadyAppliedAs.jobId === job.id
                      ? `This job already has an application (${caveats.alreadyAppliedAs.status}).`
                      : `Same posting as job ${caveats.alreadyAppliedAs.jobId}, which already has an application (${caveats.alreadyAppliedAs.status}).`,
                }
              : {}),
          };
        }),
      },
      parts:
        input.show && shown.length > 0
          ? [
              jobRowsPart({
                jobs: shown,
                title: null,
                resultSetId: resultSet.id,
                totalCount: matches.length,
              }),
            ]
          : [],
    };
  },
});

/**
 * Shows exactly the jobs the answer is about as cards, in the order given:
 * the three it recommends, not the twenty-five it looked through.
 */
export const showJobsTool = defineTool({
  name: "show_jobs",
  group: "jobs",
  description:
    "Shows the given saved jobs to the person as cards under your reply, in this order, and returns their current saved fit evidence from the same read. Use those fit labels in prose, replacing any earlier scores. Use it for the jobs your answer is about (a top three, the ones you shortlisted).",
  parameters: json.object(
    {
      jobIds: json.ids(),
      title: json.string("A short heading, like 'Top three'."),
    },
    ["jobIds"],
  ),
  input: z.object({
    jobIds: z.array(Id).min(1).max(25),
    title: z.string().trim().max(120).optional(),
  }),
  label: () => "Showing the jobs",
  effect: "read",
  async execute(input, { service, session }) {
    const snapshot = await readAssistantWorkspace(service);
    const jobs = [...new Set(input.jobIds)]
      .map((jobId) => findJob(snapshot, jobId))
      .filter((job): job is NonNullable<typeof job> => job !== null);
    if (jobs.length === 0) {
      throw new AssistantToolError("not_found", "None of those jobs is saved.");
    }
    const resultSet = await session.createResultSet({
      kind: "jobs",
      label: input.title ?? "Jobs shown",
      itemIds: jobs.map((job) => job.id),
      source: "tool_query",
    });
    return {
      summary: `Showing ${plural(jobs.length, "job")} (result set ${resultSet.id}).`,
      data: { resultSetId: resultSet.id, jobs: jobs.map(jobEvidence) },
      parts: [
        jobRowsPart({
          jobs,
          title: input.title ?? null,
          resultSetId: resultSet.id,
        }),
      ],
    };
  },
});

export const getJobTool = defineTool({
  name: "get_job",
  group: "jobs",
  description:
    "Reads one job in full: the listing text, requirements, fit reasons and gaps, and its resume level.",
  parameters: json.object({ jobId: json.string() }, ["jobId"]),
  input: z.object({ jobId: Id }),
  label: () => "Reading the job",
  effect: "read",
  async execute(input, { service, ports, session }) {
    if (ports.readJobDetail) {
      const result = await ports.readJobDetail(
        input.jobId,
        session.context?.list?.campaignId ?? null,
      );
      return {
        summary: `${result.job.title} at ${result.job.company}.`,
        data: jobDetail(result.job),
      };
    }
    const snapshot = await readAssistantWorkspace(service);
    const job = findJob(snapshot, input.jobId);
    if (!job)
      throw new AssistantToolError("not_found", "No saved job with that id.");
    return { summary: `${job.title} at ${job.company}.`, data: jobDetail(job) };
  },
});

export const compareJobsTool = defineTool({
  name: "compare_jobs",
  group: "jobs",
  description:
    "Puts up to eight jobs side by side with their fit evidence (score, reasons, gaps, pay, location, work mode).",
  parameters: json.object({ jobIds: json.ids() }, ["jobIds"]),
  input: z.object({ jobIds: z.array(Id).min(2).max(8) }),
  label: (input) =>
    `Comparing ${plural(Array.isArray(input.jobIds) ? input.jobIds.length : 2, "job")}`,
  effect: "read",
  async execute(input, { service }) {
    const snapshot = await readAssistantWorkspace(service);
    const jobs = input.jobIds.map((id) => findJob(snapshot, id));
    const missing = input.jobIds.filter((_id, index) => !jobs[index]);
    const found = jobs.filter((job): job is DiscoveryJobView => job !== null);
    return {
      summary: `Compared ${plural(found.length, "job")}${missing.length ? `; not found: ${missing.join(", ")}` : ""}.`,
      data: found.map(jobEvidence),
    };
  },
});

const JobIdsInput = z.object({ jobIds: z.array(Id).min(1).max(1000) });

export const shortlistJobsTool = defineTool({
  name: "shortlist_jobs",
  group: "jobs",
  description:
    "Moves jobs to Shortlisted. Each job gets its own outcome: shortlisted, already there, or held back (a closed listing, an excluded employer, or the same posting as a job already applied to). Set evenIfExcludedOrApplied only when the person asked for that job knowing it.",
  parameters: json.object(
    { jobIds: json.ids(), evenIfExcludedOrApplied: json.boolean() },
    ["jobIds"],
  ),
  input: JobIdsInput.extend({
    evenIfExcludedOrApplied: z.boolean().default(false),
  }),
  label: (input) =>
    `Shortlisting ${plural(Array.isArray(input.jobIds) ? input.jobIds.length : 1, "job")}`,
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const readSnapshot = () => readAssistantWorkspace(service);
    const snapshot = await readSnapshot();
    const caveatsFor = createJobCaveats(snapshot);
    const uniqueIds = [...new Set(input.jobIds)];
    const outcomes = uniqueIds.map((jobId) => ({
      jobId,
      outcome: "not started: stopped",
    }));
    const eligible: string[] = [];
    const select = async (
      jobId: string,
    ): Promise<{ jobId: string; outcome: string }> => {
      const job = findJob(snapshot, jobId);
      if (!job) {
        return { jobId, outcome: "not found" };
      }
      const caveats = caveatsFor(job);
      if (!input.evenIfExcludedOrApplied && caveats.excludedEmployer) {
        return {
          jobId,
          outcome: `held back: the person excluded ${job.company}`,
        };
      }
      if (
        !input.evenIfExcludedOrApplied &&
        caveats.alreadyAppliedAs &&
        caveats.alreadyAppliedAs.jobId !== job.id
      ) {
        return {
          jobId,
          outcome: `held back: same posting as job ${caveats.alreadyAppliedAs.jobId}, already applied (${caveats.alreadyAppliedAs.status})`,
        };
      }
      if (!["discovered", "shortlisted"].includes(job.status)) {
        return { jobId, outcome: `already ${assistantJobStatus(job.status)}` };
      }
      if (job.listingActivity.status === "closed") {
        return {
          jobId,
          outcome: "refused: the listing says it is closed",
        };
      }
      session.assertCurrent();
      if (service.queueJobsForReview) {
        eligible.push(jobId);
        return { jobId, outcome: "ready" };
      }
      try {
        await service.queueJobForReview(jobId);
        return { jobId, outcome: "shortlisted" };
      } catch (error) {
        return {
          jobId,
          outcome: `failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`,
        };
      }
    };
    let next = 0;
    let processed = 0;
    const worker = async () => {
      while (next < uniqueIds.length) {
        const index = next++;
        const jobId = uniqueIds[index]!;
        if (session.signal?.aborted) {
          outcomes[index] = { jobId, outcome: "not started: stopped" };
          continue;
        }
        outcomes[index] = await select(jobId);
        processed++;
        if (processed % 10 === 0)
          await session
            .reportProgress?.(
              `Processed ${processed} of ${uniqueIds.length} jobs; ${uniqueIds.length - processed} remaining.`,
            )
            .catch(() => undefined);
      }
    };
    if (service.queueJobsForReview) {
      for (let index = 0; index < uniqueIds.length; index++) {
        if (session.signal?.aborted) break;
        outcomes[index] = await select(uniqueIds[index]!);
      }
      if (eligible.length > 0 && !session.signal?.aborted) {
        session.assertCurrent();
        let outcome = "shortlisted";
        try {
          await service.queueJobsForReview(eligible);
        } catch (error) {
          outcome = `failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`;
        }
        for (const entry of outcomes)
          if (entry.outcome === "ready") entry.outcome = outcome;
        await session
          .reportProgress?.(`Processed ${eligible.length} jobs in one batch.`)
          .catch(() => undefined);
      } else {
        for (const entry of outcomes)
          if (entry.outcome === "ready") entry.outcome = "not started: stopped";
      }
    } else {
      await Promise.all(
        Array.from({ length: Math.min(3, uniqueIds.length) }, () => worker()),
      );
    }
    ports.publishWorkspaceUpdate();
    const done = outcomes.filter(
      (entry) => entry.outcome === "shortlisted",
    ).length;
    const after = await readSnapshot();
    const shortlisted = outcomes
      .filter((entry) => entry.outcome === "shortlisted")
      .map((entry) => findJob(after, entry.jobId))
      .filter((job): job is DiscoveryJobView => job !== null);
    const undoParts = await recordTriageChange(
      session,
      snapshot,
      after,
      uniqueIds,
      "Shortlisted jobs",
    );
    return {
      canFinish: done === uniqueIds.length,
      summary: `Shortlisted ${plural(done, "job")} of ${uniqueIds.length}; ${outcomes.filter((entry) => entry.outcome === "not started: stopped").length} not started.`,
      data: outcomes,
      parts: [
        ...(shortlisted.length
          ? [
              jobRowsPart({
                jobs: shortlisted,
                title: "Shortlisted",
                resultSetId: null,
              }),
            ]
          : []),
        ...undoParts,
      ],
    };
  },
});

export const shortlistResultSetTool = defineTool({
  name: "shortlist_result_set",
  group: "jobs",
  description:
    "Shortlists a saved jobs result set in one call, using the same selection action as the UI. limit bounds how many new jobs to pick; already shortlisted jobs are preserved and do not consume it. Reports each held-back job and stopped progress. For 'all these' use this instead of one call per job.",
  parameters: json.object(
    {
      resultSetId: json.string(),
      limit: json.number("Maximum new jobs, up to 1000; omit for all."),
      evenIfExcludedOrApplied: json.boolean(),
    },
    ["resultSetId"],
  ),
  input: z.object({
    resultSetId: Id,
    limit: z.number().int().min(1).max(1000).optional(),
    evenIfExcludedOrApplied: z.boolean().default(false),
  }),
  label: () => "Shortlisting the selected jobs",
  effect: "local_write",
  async execute(input, context) {
    const set = await context.session.getResultSet(input.resultSetId);
    if (!set || set.kind !== "jobs")
      throw new AssistantToolError(
        "invalid_input",
        "Use a saved jobs result set; save collected page jobs first.",
      );
    const snapshot = await readAssistantWorkspace(context.service);
    const caveatsFor = createJobCaveats(snapshot);
    const eligible: string[] = [];
    const heldBack: { jobId: string; reason: string }[] = [];
    const alreadySelected: string[] = [];
    for (const id of [...new Set(set.itemIds)]) {
      const job = findJob(snapshot, id);
      if (!job) {
        heldBack.push({ jobId: id, reason: "not found" });
        continue;
      }
      if (!["discovered", "shortlisted"].includes(job.status)) {
        alreadySelected.push(id);
        continue;
      }
      if (job.listingActivity.status === "closed") {
        heldBack.push({ jobId: id, reason: "listing closed" });
        continue;
      }
      const caveats = caveatsFor(job);
      if (
        !input.evenIfExcludedOrApplied &&
        (caveats.excludedEmployer || caveats.alreadyAppliedAs)
      ) {
        heldBack.push({
          jobId: id,
          reason: caveats.excludedEmployer
            ? "excluded employer"
            : "already applied",
        });
        continue;
      }
      eligible.push(id);
    }
    const ids = eligible.slice(0, input.limit ?? 1000);
    const result = ids.length
      ? await shortlistJobsTool.execute(
          {
            jobIds: ids,
            evenIfExcludedOrApplied: input.evenIfExcludedOrApplied,
          },
          context,
        )
      : { summary: "No new eligible jobs to shortlist.", data: [] };
    return {
      ...result,
      summary: `${result.summary} ${alreadySelected.length} existing selections kept; ${heldBack.length} held back; ${eligible.length - ids.length} eligible jobs left beyond the requested limit.`,
      data: {
        outcomes: result.data,
        alreadySelected,
        heldBack,
        remainingBeyondLimit: eligible.length - ids.length,
      },
    };
  },
});

export const assessJobListingTool = defineTool({
  name: "assess_job_listing",
  group: "jobs",
  description:
    "Runs Judge fit for a saved job, exactly as its detail button does. Reads the listing, saves the model assessment and returns the current saved fit evidence. Use before ranking an unassessed job; never invent a score.",
  parameters: json.object({ jobId: json.string() }, ["jobId"]),
  input: z.object({ jobId: Id }),
  label: () => "Reading and assessing the listing",
  effect: "external",
  async execute(input, context) {
    context.session.assertCurrent();
    await context.service.assessJobListing(input.jobId);
    context.ports.publishWorkspaceUpdate();
    return getJobTool.execute(input, context);
  },
});

export const removeFromShortlistTool = defineTool({
  name: "remove_from_shortlist",
  group: "jobs",
  description: "Takes jobs off Shortlisted and back to the found list.",
  parameters: json.object({ jobIds: json.ids() }, ["jobIds"]),
  input: JobIdsInput,
  label: () => "Removing jobs from Shortlisted",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const before = await readAssistantWorkspace(service);
    const outcomes: { jobId: string; outcome: string }[] = [];
    for (const jobId of input.jobIds) {
      session.assertCurrent();
      try {
        await executeJobFinderAction(
          "remove-job-from-review",
          { jobId: jobId },
          { service },
        );
        outcomes.push({ jobId, outcome: "removed" });
      } catch (error) {
        outcomes.push({
          jobId,
          outcome: `failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`,
        });
      }
    }
    ports.publishWorkspaceUpdate();
    return {
      canFinish: outcomes.every((entry) => entry.outcome === "removed"),
      summary: `Removed ${plural(outcomes.filter((entry) => entry.outcome === "removed").length, "job")} from Shortlisted.`,
      data: outcomes,
      parts: await recordTriageChange(
        session,
        before,
        await readAssistantWorkspace(service),
        input.jobIds,
        "Moved jobs back to Find jobs",
      ),
    };
  },
});

export const dismissJobsTool = defineTool({
  name: "dismiss_jobs",
  group: "jobs",
  description: `Hides jobs from the found list with the reasons the person gave (${discoveryFeedbackReasonValues.join(", ")}). They can be restored.`,
  parameters: json.object(
    {
      jobIds: json.ids(),
      reasons: json.array(json.enumOf(discoveryFeedbackReasonValues)),
    },
    ["jobIds", "reasons"],
  ),
  input: z.object({
    jobIds: z.array(Id).min(1),
    reasons: z.array(DiscoveryFeedbackReasonSchema).min(1).max(9),
  }),
  label: () => "Hiding jobs",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const outcomes: { jobId: string; outcome: string }[] = [];
    const before = await readAssistantWorkspace(service);
    const shortlistedBefore = new Set(
      before.reviewQueue.map((item) => item.jobId),
    );
    const jobIds = [...new Set(input.jobIds)];
    const batch = service.dismissDiscoveryJobs
      ? await service.dismissDiscoveryJobs(
          jobIds.map((jobId) => ({ jobId, reasons: input.reasons })),
          {
            signal: session.signal,
            assertCurrent: () => session.assertCurrent(),
          },
        )
      : null;
    if (batch) outcomes.push(...batch.outcomes.map(feedbackOutcome));
    for (const jobId of batch ? [] : jobIds) {
      session.assertCurrent();
      try {
        await service.dismissDiscoveryJob({ jobId, reasons: input.reasons });
        outcomes.push({ jobId, outcome: "hidden" });
      } catch (error) {
        outcomes.push({
          jobId,
          outcome: `failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`,
        });
      }
    }
    if (!batch || batch.workspace) {
      session.assertCurrent();
      ports.publishWorkspaceUpdate();
    }
    // Say what hiding did to the shortlist, from the records.
    const after = batch
      ? (batch.workspace ?? before)
      : await readAssistantWorkspace(service);
    const shortlistedAfter = new Set(
      after.reviewQueue.map((item) => item.jobId),
    );
    const leftShortlist = input.jobIds.filter(
      (jobId) => shortlistedBefore.has(jobId) && !shortlistedAfter.has(jobId),
    );
    return {
      canFinish:
        leftShortlist.length === 0 &&
        outcomes.every((entry) => entry.outcome === "hidden"),
      summary: `Hid ${plural(outcomes.filter((entry) => entry.outcome === "hidden").length, "job")}.${leftShortlist.length > 0 ? ` These were on the shortlist and are no longer: ${leftShortlist.join(", ")}.` : ""}`,
      parts: await recordTriageChange(
        session,
        before,
        after,
        input.jobIds,
        "Hid jobs",
      ),
      data: outcomes.map((entry) => ({
        ...entry,
        leftShortlist: leftShortlist.includes(entry.jobId),
      })),
    };
  },
});

export const restoreJobsTool = defineTool({
  name: "restore_jobs",
  group: "jobs",
  description: "Brings hidden jobs back to the found list.",
  parameters: json.object({ jobIds: json.ids() }, ["jobIds"]),
  input: z.object({ jobIds: z.array(Id).min(1) }),
  label: () => "Restoring hidden jobs",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const before = await readAssistantWorkspace(service);
    const jobIds = [...new Set(input.jobIds)];
    const batch = service.restoreDismissedDiscoveryJobs
      ? await service.restoreDismissedDiscoveryJobs(jobIds, {
          signal: session.signal,
          assertCurrent: () => session.assertCurrent(),
        })
      : null;
    const outcomes = batch?.outcomes.map(feedbackOutcome) ?? [];
    for (const jobId of batch ? [] : jobIds) {
      session.assertCurrent();
      try {
        await service.restoreDismissedDiscoveryJob(jobId);
        outcomes.push({ jobId, outcome: "restored" });
      } catch (error) {
        outcomes.push({
          jobId,
          outcome: `failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`,
        });
      }
    }
    if (!batch || batch.workspace) {
      session.assertCurrent();
      ports.publishWorkspaceUpdate();
    }
    return {
      canFinish: outcomes.every((entry) => entry.outcome === "restored"),
      summary: `Restored ${plural(outcomes.filter((entry) => entry.outcome === "restored").length, "job")}.`,
      data: outcomes,
      parts: await recordTriageChange(
        session,
        before,
        batch?.workspace ?? (await readAssistantWorkspace(service)),
        jobIds,
        "Showed jobs again",
      ),
    };
  },
});

export const excludeEmployerTool = defineTool({
  name: "exclude_employer",
  group: "jobs",
  description:
    "Excludes the employer of this job (exact company name) from future searches and hides every found job from them. Jobs already shortlisted or applied to stay where they are. Reversible with include_employer (and restore_jobs for the hidden ones).",
  parameters: json.object({ jobId: json.string() }, ["jobId"]),
  input: z.object({ jobId: Id }),
  label: () => "Excluding an employer",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const preview = await service.previewEmployerExclusion(input.jobId);
    if (preview.status !== "available") {
      throw new AssistantToolError(
        "refused",
        `This employer cannot be excluded (${preview.reason.replaceAll("_", " ")}).`,
      );
    }
    session.assertCurrent();
    const before = await readAssistantWorkspace(service);
    const sameEmployer = (job: DiscoveryJobView) =>
      normalizeCompanyName(job.company) === preview.normalizedCompanyName;
    const others = allJobs(before).filter(
      (job) =>
        job.id !== input.jobId &&
        job.status === "discovered" &&
        sameEmployer(job),
    );
    const batch = service.excludeEmployerDiscoveryJobs
      ? await service.excludeEmployerDiscoveryJobs(
          {
            jobId: input.jobId,
            jobIds: others.map((job) => job.id),
            expectedNormalizedCompanyName: preview.normalizedCompanyName,
          },
          {
            signal: session.signal,
            assertCurrent: () => session.assertCurrent(),
          },
        )
      : null;
    const anchor = batch?.outcomes.find((entry) => entry.jobId === input.jobId);
    if (anchor && anchor.status !== "hidden") {
      throw new AssistantToolError(
        "refused",
        anchor.status === "stopped"
          ? "The employer exclusion was stopped."
          : `This employer cannot be excluded (${anchor.status === "held" || anchor.status === "failed" ? anchor.message : anchor.status}).`,
      );
    }
    if (!batch) {
      await service.dismissDiscoveryJob({
        jobId: input.jobId,
        reasons: ["company"],
        action: "hide_and_exclude_employer",
        expectedNormalizedCompanyName: preview.normalizedCompanyName,
      });
    }
    const failed =
      batch?.outcomes
        .filter((entry) => entry.status !== "hidden")
        .map((entry) => entry.jobId) ?? [];
    for (const job of batch ? [] : others) {
      session.assertCurrent();
      try {
        await service.dismissDiscoveryJob({
          jobId: job.id,
          reasons: ["company"],
          action: "hide_job",
        });
      } catch {
        failed.push(job.id);
      }
    }
    if (!batch || batch.workspace) {
      session.assertCurrent();
      ports.publishWorkspaceUpdate();
    }
    // Report what the workspace now shows, not what was intended.
    const after = batch
      ? (batch.workspace ?? before)
      : await readAssistantWorkspace(service);
    const stillFound = after.discoveryJobs.filter(
      (job) => job.status === "discovered" && sameEmployer(job),
    );
    const keptElsewhere = allJobs(after).filter(
      (job) =>
        sameEmployer(job) &&
        job.status !== "discovered" &&
        job.status !== "archived",
    );
    return {
      summary: [
        `Excluded ${preview.displayCompanyName} from future searches.`,
        `Hidden now: ${plural(others.length + 1 - failed.length, "found job")}.`,
        stillFound.length > 0
          ? `Still listed in Find jobs: ${plural(stillFound.length, "job")} (${stillFound
              .slice(0, 5)
              .map((job) => job.title)
              .join("; ")}).`
          : "No found jobs from them are listed any more.",
        keptElsewhere.length > 0
          ? `Left as they are (shortlisted or applied): ${plural(keptElsewhere.length, "job")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      data: {
        normalizedCompanyName: preview.normalizedCompanyName,
        hiddenJobIds: [input.jobId, ...others.map((job) => job.id)].filter(
          (id) => !failed.includes(id),
        ),
        stillListedJobIds: stillFound.map((job) => job.id),
        ...(batch ? { outcomes: batch.outcomes.map(feedbackOutcome) } : {}),
      },
    };
  },
});

export const includeEmployerTool = defineTool({
  name: "include_employer",
  group: "jobs",
  description:
    "Lifts an employer exclusion made earlier: give a job from that employer and the exact company name returned when it was excluded.",
  parameters: json.object(
    { jobId: json.string(), normalizedCompanyName: json.string() },
    ["jobId", "normalizedCompanyName"],
  ),
  input: z.object({
    jobId: Id,
    normalizedCompanyName: NonEmptyStringSchema.max(300),
  }),
  label: () => "Lifting an employer exclusion",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    await service.removeEmployerExclusion({
      jobId: input.jobId,
      normalizedCompanyName: input.normalizedCompanyName,
    });
    ports.publishWorkspaceUpdate();
    return { summary: `Jobs from ${input.normalizedCompanyName} show again.` };
  },
});

export const searchForJobsTool = defineTool({
  name: "search_for_jobs",
  group: "jobs",
  description:
    "Starts a job search across all or chosen sources with the person's goal in plain words, as Find jobs does. It runs in the background; the conversation continues with the results when it ends. Criteria given only for this search stay in the goal and do not change saved preferences.",
  parameters: json.object(
    {
      goal: json.string(
        "What to look for, in the person's words plus what you know of their profile.",
      ),
      breadth: json.enumOf(["best_only", "wide"]),
      freshness: json.enumOf(["any", "recent"]),
      sourceIds: json.ids("Only these sources; omit for all."),
    },
    ["goal"],
  ),
  input: JobFinderAssistantSearchInputSchema,
  label: () => "Starting a job search",
  effect: "external",
  async execute(input, { ports, session, service }) {
    const before = await readAssistantWorkspace(service);
    const paused = pausedByPersonMessage(before.activityControl, "a search");
    if (paused) throw new AssistantToolError("refused", paused);
    if (before.activeDiscoveryRun?.state === "running") {
      await session.watchRun(
        { kind: "discovery", id: before.activeDiscoveryRun.id, jobIds: [] },
        "Waiting for the search already running",
      );
      return {
        summary: `A search is already running (run ${before.activeDiscoveryRun.id}); this conversation continues when it ends.`,
        data: {
          runId: before.activeDiscoveryRun.id,
          running: runningSearchState(before),
          started: false,
        },
      };
    }
    session.assertCurrent();
    const started = await ports.startSearch({
      searchRequest: {
        intent: input.goal,
        ...(input.breadth ? { breadth: input.breadth } : {}),
        freshness: input.freshness,
        sourceIds: input.sourceIds ?? "all",
      },
      targetId: null,
    });
    if (!started.runId) {
      throw new AssistantToolError("refused", started.message);
    }
    await session.watchRun(
      { kind: "discovery", id: started.runId, jobIds: [] },
      "Searching for jobs",
    );
    return {
      summary: `The search started. Results appear in Find jobs. This conversation continues when it ends.`,
      data: {
        runId: started.runId,
        running: runningSearchState(await readAssistantWorkspace(service)),
        started: true,
      },
    };
  },
});

export const listSourcesTool = defineTool({
  name: "list_sources",
  group: "jobs",
  description:
    "Lists job sources with ids, addresses, enabled state and last check. Use query to match words in a source's name or address; cursor and limit page the matches. For a simple switch by name, update_sources enableMatching/disableMatching does the lookup and change in one action.",
  parameters: json.object({
    query: json.string(),
    cursor: json.number(),
    limit: json.number(),
  }),
  input: JobFinderSourceQueryInputSchema,
  label: () => "Reading your job sources",
  effect: "read",
  async execute(input, { service }) {
    const snapshot = await readAssistantWorkspace(service);
    const targets = snapshot.searchPreferences.discovery.targets.filter(
      (target) => !input.query || sourceMatches(target, input.query),
    );
    const shown = targets
      .slice(input.cursor ?? 0, (input.cursor ?? 0) + (input.limit ?? 200))
      .map((target) => ({
        id: target.id,
        label: target.label,
        url: target.startingUrl,
        enabled: target.enabled,
        instructions: target.instructionStatus,
        lastVerifiedAt: target.lastVerifiedAt,
        staleReason: target.staleReason,
      }));
    return {
      summary: `${plural(targets.length, "source")}, ${targets.filter((target) => target.enabled).length} on.`,
      data:
        input.query || input.cursor !== undefined || input.limit !== undefined
          ? {
              sources: shown,
              total: targets.length,
              next:
                (input.cursor ?? 0) + shown.length < targets.length
                  ? (input.cursor ?? 0) + shown.length
                  : null,
            }
          : shown,
    };
  },
});

function sourceMatches(
  source: { label: string; startingUrl: string },
  query: string,
): boolean {
  const text = `${source.label} ${source.startingUrl}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./u, "");
    const first = parsed.pathname.split("/").filter(Boolean)[0];
    return ["localhost", "127.0.0.1", "[::1]"].includes(host) && first
      ? `${parsed.host}/${first}`
      : host;
  } catch {
    return url;
  }
}

export const updateSourcesTool = defineTool({
  name: "update_sources",
  group: "jobs",
  description:
    "Adds job sources by address, with optional custom names through namedSources, renames saved sources through renameSources, or turns sources on or off by id. Source names are supported (Profile > Job sources > Source name). Added sources are on and ready for searching; a check is optional.",
  parameters: json.object({
    addUrls: json.ids("Addresses to add."),
    namedSources: json.array(
      json.object(
        {
          url: json.string(),
          label: json.string("The person's source name, such as the employer."),
        },
        ["url", "label"],
      ),
    ),
    renameSources: json.array(
      json.object({ sourceId: json.string(), label: json.string() }, [
        "sourceId",
        "label",
      ]),
    ),
    enableIds: json.ids(),
    disableIds: json.ids(),
    enableMatching: json.string(
      "Turn on sources whose names or addresses match these words.",
    ),
    disableMatching: json.string(
      "Turn off sources whose names or addresses match these words.",
    ),
  }),
  input: z.object({
    addUrls: z.array(z.string().trim().url()).max(200).default([]),
    namedSources: z
      .array(
        z.object({
          url: z.string().trim().url(),
          label: z.string().trim().min(1).max(200),
        }),
      )
      .max(200)
      .optional(),
    renameSources: z
      .array(
        z.object({ sourceId: Id, label: z.string().trim().min(1).max(200) }),
      )
      .max(500)
      .optional(),
    enableIds: z.array(Id).max(500).default([]),
    disableIds: z.array(Id).max(500).default([]),
    enableMatching: z.string().trim().min(1).max(200).optional(),
    disableMatching: z.string().trim().min(1).max(200).optional(),
  }),
  label: () => "Updating your job sources",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const snapshot = await readAssistantWorkspace(service);
    const preferences = snapshot.searchPreferences;
    const existing = new Set(
      preferences.discovery.targets.map((target) =>
        target.startingUrl.replace(/\/+$/u, ""),
      ),
    );
    const renames = new Map(
      (input.renameSources ?? []).map((source) => [
        source.sourceId,
        source.label,
      ]),
    );
    for (const id of renames.keys()) {
      if (!preferences.discovery.targets.some((target) => target.id === id))
        throw new AssistantToolError(
          "not_found",
          "One of the sources to rename is no longer saved. Nothing changed.",
        );
    }
    const named = new Map(
      (input.namedSources ?? []).map((source) => [
        source.url.replace(/\/+$/u, ""),
        source.label,
      ]),
    );
    const additions = [
      ...input.addUrls,
      ...(input.namedSources ?? []).map((source) => source.url),
    ].flatMap((url) => {
      const key = url.replace(/\/+$/u, "");
      if (existing.has(key)) return [];
      existing.add(key);
      return [
        JobDiscoveryTargetSchema.parse({
          id: session.createId("target"),
          label: named.get(key) ?? sourceLabel(url),
          startingUrl: url,
          enabled: true,
          adapterKind: "auto",
        }),
      ];
    });
    const targets = [
      ...preferences.discovery.targets.map((target) => ({
        ...target,
        label:
          renames.get(target.id) ??
          named.get(target.startingUrl.replace(/\/+$/u, "")) ??
          target.label,
        enabled:
          input.enableIds.includes(target.id) ||
          (input.enableMatching && sourceMatches(target, input.enableMatching))
            ? true
            : input.disableIds.includes(target.id) ||
                (input.disableMatching &&
                  sourceMatches(target, input.disableMatching))
              ? false
              : target.enabled,
      })),
      ...additions,
    ];
    session.assertCurrent();
    const savedSnapshot = await service.saveSearchPreferences({
      ...preferences,
      discovery: { ...preferences.discovery, targets },
    });
    const savedTargets = savedSnapshot.searchPreferences.discovery.targets;
    const enabledCount = savedTargets.filter(
      (target) =>
        target.enabled &&
        preferences.discovery.targets.some(
          (before) => before.id === target.id && !before.enabled,
        ),
    ).length;
    const disabledCount = savedTargets.filter(
      (target) =>
        !target.enabled &&
        preferences.discovery.targets.some(
          (before) => before.id === target.id && before.enabled,
        ),
    ).length;
    const changes = diffValues(preferences.discovery.targets, savedTargets).map(
      (entry) => ({
        ...entry,
        path: ["search_preferences", "discovery", "targets", ...entry.path],
      }),
    );
    const sourceParts = [];
    if (changes.length && session.recordChange) {
      for (let cursor = 0; cursor < changes.length; cursor += 600) {
        sourceParts.push(
          (
            await session.recordChange({
              target: "search_preferences",
              targetId: null,
              summary: "Updated job sources",
              entries: changes.slice(cursor, cursor + 600),
            })
          ).part,
        );
      }
    }
    ports.publishWorkspaceUpdate();
    return {
      parts: sourceParts,
      canFinish:
        additions.length + enabledCount + disabledCount > 0 &&
        [...input.enableIds, ...input.disableIds].every((id) =>
          preferences.discovery.targets.some((target) => target.id === id),
        ),
      summary: `Added ${plural(additions.length, "source")}; ${enabledCount} turned on, ${disabledCount} turned off.${targets.some((target) => preferences.discovery.targets.some((before) => before.id === target.id && before.label !== target.label)) ? " Updated source names." : ""}`,
      data: {
        sources: savedTargets
          .filter(
            (target) =>
              (!input.enableMatching && !input.disableMatching) ||
              Boolean(
                input.enableMatching &&
                sourceMatches(target, input.enableMatching),
              ) ||
              Boolean(
                input.disableMatching &&
                sourceMatches(target, input.disableMatching),
              ),
          )
          .slice(
            0,
            input.enableMatching || input.disableMatching
              ? 25
              : savedTargets.length,
          )
          .map((target) => ({
            id: target.id,
            label: target.label,
            enabled: target.enabled,
          })),
        resultsPlanName:
          savedSnapshot.campaigns.find(
            (plan) => plan.id === savedSnapshot.activeCampaignId,
          )?.name ?? null,
        added: additions.map((target) => ({
          id: target.id,
          url: target.startingUrl,
          label: target.label,
        })),
        renamed: targets
          .filter((target) =>
            preferences.discovery.targets.some(
              (before) =>
                before.id === target.id && before.label !== target.label,
            ),
          )
          .map((target) => ({
            id: target.id,
            label: target.label,
            url: target.startingUrl,
          })),
      },
    };
  },
});

export const checkSourceTool = defineTool({
  name: "check_source",
  group: "jobs",
  description:
    "Runs a source check (the agent learns how to read the site) for one source by id. Optional: sources are searched without one.",
  parameters: json.object({ sourceId: json.string() }, ["sourceId"]),
  input: z.object({ sourceId: Id }),
  label: () => "Checking a job source",
  effect: "external",
  async execute(input, { ports, session }) {
    session.assertCurrent();
    await ports.checkSource(input.sourceId, { signal: session.signal });
    return {
      summary: "The source check finished; list_sources shows its result.",
    };
  },
});

export const jobsTools = [
  queryJobsTool,
  showJobsTool,
  getJobTool,
  compareJobsTool,
  shortlistJobsTool,
  shortlistResultSetTool,
  assessJobListingTool,
  removeFromShortlistTool,
  dismissJobsTool,
  restoreJobsTool,
  excludeEmployerTool,
  includeEmployerTool,
  searchForJobsTool,
  listSourcesTool,
  updateSourcesTool,
  checkSourceTool,
];

export { compactJob };
