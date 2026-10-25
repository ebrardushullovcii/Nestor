import type {
  AssistantTaskPlan,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  AssistantTaskPlanStepSchema,
  AssistantJobViewSchema,
  AssistantTrackerViewSchema,
  JobIdSchema,
  JobDetailSchema,
  JobStageCountsSchema,
  JobSearchStatusSchema,
  NonEmptyStringSchema,
} from "@nestor/contracts";
import { z } from "zod";
import { projectWorkspaceAttention } from "../attention";
import { assertPersonAnswerAuthority } from "../person-answer-authority";
import {
  getAssistantSavedSearch,
  getAssistantSearchReadiness,
} from "../prompt";
import { AssistantToolError, defineTool, json } from "../tool-kit";
import { readAssistantWorkState, runningSearchState } from "../work-state";
import {
  allJobs,
  compactApplication,
  compactJob,
  outstandingReviews,
  plural,
} from "./format";

const Id = NonEmptyStringSchema.max(200);

/**
 * How long answering a Needs you step waits for its check before replying.
 * Several answers in one reply wait one after another, so a long wait here
 * made a two-answer turn take over a minute; the run is followed anyway.
 */
export const RESOLVE_SETTLE_WAIT_MS = 6_000;

export const getWorkspaceSummaryTool = defineTool({
  name: "get_workspace_summary",
  group: "workspace",
  description:
    "Where the job search stands: job and application counts, search progress, profile readiness and saved Apply mode. Read list_sites for current site IDs, addresses and enabled counts. A resume is not required for searching.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Reading your workspace",
  effect: "read",
  async execute(_input, context) {
    const { service, ports } = context;
    const snapshot = await service.getWorkspaceSnapshot();
    const countsCommand = ports.commands?.find((command) => command.name === "stage_counts");
    const searchCommand = ports.commands?.find((command) => command.name === "search_status");
    const trackerCommand = ports.commands?.find((command) => command.name === "list_applications");
    if (countsCommand && searchCommand) {
      const [countsResult, searchResult, trackerResult] = await Promise.all([
        countsCommand.execute({}, context), searchCommand.execute({}, context),
        trackerCommand?.execute({ limit: 1 }, context),
      ]);
      const counts = JobStageCountsSchema.parse(countsResult.data);
      const search = JobSearchStatusSchema.parse(searchResult.data);
      return {
        summary: `${counts.found} found, ${counts.hidden} hidden, ${counts.shortlisted} shortlisted, ${counts.resume} approved, ${counts.applied} applied.`,
        data: { jobs: counts, search, applications: trackerResult ? z.object({ counts: z.record(z.number()) }).parse(trackerResult.data).counts : null, profile: { setup: snapshot.profileSetupState.status, name: snapshot.profile.fullName }, applyMode: snapshot.settings.applicationAutomationMode, needsYou: projectWorkspaceAttention(snapshot).count },
      };
    }
    const work = readAssistantWorkState(ports, snapshot);
    const applications = snapshot.applicationRecords;
    const byStatus = new Map<string, number>();
    for (const record of applications) {
      byStatus.set(record.status, (byStatus.get(record.status) ?? 0) + 1);
    }
    const running = snapshot.applyRuns.filter((run) =>
      ["running", "awaiting_submit_approval", "paused_for_consent"].includes(
        run.state,
      ),
    );
    const attention = projectWorkspaceAttention(snapshot);
    const searchReadiness = getAssistantSearchReadiness(snapshot);
    return {
      summary: `${plural(snapshot.discoveryJobs.length, "job")} found, ${snapshot.reviewQueue.length} shortlisted, ${plural(applications.length, "application")}, ${attention.count} Needs you items, ${attention.readyToSend.length} ready to send, ${attention.resumeReviews.length} resume reviews. ${
        searchReadiness.runningRunId
          ? "A search is already running."
          : searchReadiness.canStartSearch
            ? `Ready to search ${plural(searchReadiness.enabledSourceCount, "enabled source")}.`
            : searchReadiness.missingRequirements.join(" ")
      }`,
      data: {
        ...work,
        profile: {
          setup: snapshot.profileSetupState.status,
          name: snapshot.profile.fullName,
          headline: snapshot.profile.headline,
          targetRoles: snapshot.searchPreferences.targetRoles,
        },
        jobs: {
          found: snapshot.discoveryJobs.length,
          shortlisted: snapshot.reviewQueue.length,
          dismissed: snapshot.dismissedDiscoveryJobs.length,
        },
        applications: Object.fromEntries(byStatus),
        runningApplyRuns: running.map((run) => ({
          id: run.id,
          state: run.state,
          jobIds: run.jobIds,
        })),
        search: {
          latestSavedSearch: getAssistantSavedSearch(snapshot),
          state: snapshot.discoveryRunState,
          activeRunId: snapshot.activeDiscoveryRun?.id ?? null,
          running: runningSearchState(snapshot),
          ...searchReadiness,
          enabledSources: searchReadiness.enabledSources.slice(0, 40),
        },
        needsYou: attention.count,
        readyToSend: attention.readyToSend.length,
        resumeReviews: attention.resumeReviews.length,
        applyMode:
          snapshot.settings.applicationAutomationMode ?? "confirm_before_submit",
        activityPaused: snapshot.activityControl.paused ?? false,
      },
    };
  },
});

export const listNeedsYouTool = defineTool({
  name: "list_needs_you",
  group: "workspace",
  description:
    "The steps waiting on the person (sign-ins, questions an application could not answer, checks), with their ids and revisions.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Checking what needs you",
  effect: "read",
  async execute(_input, { service }) {
    const snapshot = await service.getWorkspaceSnapshot();
    const attention = projectWorkspaceAttention(snapshot);
    const reviews = outstandingReviews(snapshot);
    const count = attention.count + reviews.length;
    return {
      summary:
        count === 0
          ? "Nothing is waiting on the person."
          : `${plural(attention.count, "Needs you item")}, ${attention.readyToSend.length} ready to send, ${attention.resumeReviews.length} resume reviews waiting on the person.`,
      data: {
        needsYou: {
          requests: attention.requests.map((request) => ({
            id: request.id,
            revision: request.revision,
            kind: request.kind,
            state: request.state,
            title: request.title,
            summary: request.summary,
            instructions: request.instructions.slice(0, 6),
            scope: request.scope,
            url: request.actionUrl,
          })),
          groupedDecisions: attention.groupedDecisions,
          applications: attention.applications.map((record) => ({
            id: record.id,
            jobId: record.jobId,
            title: record.title,
            company: record.company,
            reason: record.nextActionLabel ?? record.lastActionLabel,
            route: `/job-finder/applications?applicationRecordId=${encodeURIComponent(record.id)}`,
          })),
          safeguards: attention.safeguards,
          count: attention.count,
        },
        readyToSend: reviews.filter((item) => item.kind === "application_send"),
        resumeReviews: reviews.filter((item) => item.kind === "resume_review"),
      },
    };
  },
});

const ResolveNeedsYouInput = z.object({
  requestId: Id,
  action: z.enum(["answer", "open_page", "done", "skip"]),
  answer: z.string().trim().min(1).max(4_000).optional(),
  answers: z
    .array(
      z.object({ questionId: Id, answer: z.string().trim().min(1).max(4_000) }),
    )
    .max(50)
    .optional(),
  reason: z.string().max(400).optional(),
  saveForLater: z.boolean().default(false),
});

export const resolveNeedsYouTool = defineTool({
  name: "resolve_needs_you",
  group: "workspace",
  description:
    "Acts on one Needs you step: answer its question(s) with what the person told you (answers tie each answer to its question id), open its page in the browser, mark it done after the person did it, or skip it. Set saveForLater only when the person chose to save the answers for future applications. Never save an answer you inferred or chose as the person's own answer; get their approval first. Never enter passwords or create accounts; those steps belong to the person.",
  parameters: json.object(
    {
      requestId: json.string(),
      action: json.enumOf(["answer", "open_page", "done", "skip"]),
      answer: json.string("One answer for a single-question step."),
      answers: json.array(
        json.object({ questionId: json.string(), answer: json.string() }, [
          "questionId",
          "answer",
        ]),
        "Each answer with its question id, for a step with several questions.",
      ),
      reason: json.string("For skip: why, in the person's words."),
      saveForLater: json.boolean(
        "For answer: also keep it for the same question on later applications.",
      ),
    },
    ["requestId", "action"],
  ),
  input: ResolveNeedsYouInput,
  label: (input) =>
    input.action === "answer"
      ? "Answering a question for an application"
      : input.action === "open_page"
        ? "Opening the page that needs you"
        : "Updating a step that needs you",
  effect: "local_write",
  async execute(input, { service, session }) {
    const snapshot = await service.getWorkspaceSnapshot();
    const request = snapshot.userActionRequests.find(
      (candidate) => candidate.id === input.requestId,
    );
    if (!request) {
      throw new AssistantToolError(
        "not_found",
        "That step is not waiting any more.",
      );
    }
    const base = {
      requestId: request.id,
      commandId: session.createId("assistant_user_action"),
      expectedRevision: request.revision,
      credentialsPolicy: "browser_only" as const,
      submitAuthorized: false as const,
      accountCreationAuthorized: false as const,
    };
    session.assertCurrent();
    // Checking an answered step can mean carrying the application on, which
    // may wait for the site. The answer is saved at once; the check goes on
    // in the background and the conversation follows the run.
    const settle = async (work: Promise<unknown>) => {
      const outcome = await Promise.race([
        work.then(
          () => "done" as const,
          (error: unknown) => error,
        ),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), RESOLVE_SETTLE_WAIT_MS),
        ),
      ]);
      if (outcome !== "done" && outcome !== "pending") throw outcome;
      return outcome;
    };
    let pending = false;
    if (input.action === "answer") {
      const answers = input.answers ?? [];
      const answer = input.answer ?? answers[0]?.answer;
      if (!answer) {
        throw new AssistantToolError(
          "missing_information",
          "Give the answer the person stated; ask them if they have not said it.",
        );
      }
      const details =
        request.scope.type === "application"
          ? await service.getApplyRunDetails(
              request.scope.runId,
              request.scope.jobId,
              request.scope.applicationRecordId ?? null,
            )
          : null;
      const promptFor = (questionId?: string) =>
        details?.questionRecords.find((question) =>
          questionId
            ? question.id === questionId
            : question.status !== "answered",
        )?.prompt ?? `${request.title}: ${request.summary ?? ""}`;
      await assertPersonAnswerAuthority(session, {
        answers: answers.length
          ? answers.map((entry) => ({
              question: promptFor(entry.questionId),
              answer: entry.answer,
            }))
          : [{ question: promptFor(), answer }],
        saveForFuture: input.saveForLater,
      });
      pending =
        (await settle(
          service.performUserAction({
            ...base,
            action: "submit_manual_answer",
            answer,
            ...(answers.length > 0 ? { answers } : {}),
            ...(input.saveForLater ? { saveForFuture: true } : {}),
          }),
        )) === "pending";
    } else if (input.action === "open_page") {
      await service.performUserAction({ ...base, action: "open_page" });
    } else if (input.action === "done") {
      pending =
        (await settle(
          service.performUserAction({ ...base, action: "confirm_done" }),
        )) === "pending";
    } else {
      await service.performUserAction({
        ...base,
        action: "skip",
        reason: input.reason ?? null,
      });
    }
    const afterSnapshot = await service.getWorkspaceSnapshot();
    const after = afterSnapshot.userActionRequests.find(
      (candidate) => candidate.id === request.id,
    );
    // An answered or completed application step lets that application carry
    // on in the background; follow it so the conversation continues when it
    // ends instead of waiting for the person to ask.
    const resumes =
      request.scope.type === "application" &&
      (input.action === "answer" || input.action === "done");
    if (resumes && request.scope.type === "application") {
      await session.watchRun(
        {
          kind: "apply_run",
          id: request.scope.runId,
          jobIds: [request.scope.jobId],
        },
        "The application carried on after the answer",
        { resumed: true },
      );
    }
    // Say what the application is actually doing, from its run.
    const progress =
      request.scope.type === "application"
        ? describeApplicationProgress(afterSnapshot, request.scope.jobId)
        : null;
    return {
      summary: [
        `The step "${request.title}" is now ${(after?.state ?? "resolved").replaceAll("_", " ")}.`,
        pending
          ? "The answer is saved; checking it is still going on in the background."
          : "",
        progress ? `Application: ${progress}.` : "",
        resumes
          ? "The conversation continues when the application's run ends; do not describe it as sent or running beyond what this says."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      data: {
        requestId: request.id,
        state: after?.state ?? "resolved",
        application: progress,
      },
    };
  },
});

/** A plain account of one job's application, read from its runs. */
export function describeApplicationProgress(
  snapshot: JobFinderWorkspaceSnapshot,
  jobId: string,
): string | null {
  const runsById = new Map(snapshot.applyRuns.map((run) => [run.id, run]));
  const latest = snapshot.applyJobResults
    .filter((result) => result.jobId === jobId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!latest) return null;
  const run = runsById.get(latest.runId);
  const waitingSameSite =
    latest.state === "planned" && run?.state === "running";
  return `${latest.state.replaceAll("_", " ")} in run ${latest.runId} (${(run?.state ?? "unknown").replaceAll("_", " ")})${waitingSameSite ? ", not started yet" : ""}`;
}

export const readResultTool = defineTool({
  name: "read_result",
  group: "workspace",
  description:
    "Reads more of a long result: a result set (resultSetId, stable order, so position 2 is always the same job) or a stored tool output (handle).",
  parameters: json.object({
    resultSetId: json.string(),
    handle: json.string(),
    cursor: json.number("Position to start from; 0 is the first item."),
    limit: json.number("At most 50."),
  }),
  input: z.object({
    resultSetId: Id.optional(),
    handle: Id.optional(),
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  label: () => "Reading more results",
  effect: "read",
  async execute(input, { service, session }) {
    if (input.handle) {
      const page = session.handles.read(
        input.handle,
        input.cursor,
        input.limit,
      );
      if (!page) {
        throw new AssistantToolError(
          "not_found",
          "That stored result has expired. Run the tool again.",
        );
      }
      return {
        summary: `${page.summary} (items ${input.cursor + 1}–${input.cursor + page.items.length} of ${page.total}).`,
        data: { items: page.items, next: page.next },
      };
    }
    if (!input.resultSetId) {
      throw new AssistantToolError(
        "invalid_input",
        "Give a resultSetId or a handle.",
      );
    }
    const resultSet = await session.getResultSet(input.resultSetId);
    if (!resultSet) {
      throw new AssistantToolError("not_found", "No result set with that id.");
    }
    const ids = resultSet.itemIds.slice(
      input.cursor,
      input.cursor + input.limit,
    );
    const snapshot = await service.getWorkspaceSnapshot();
    const jobs = allJobs(snapshot);
    const items = ids.map((id, offset) => {
      const position = input.cursor + offset + 1;
      if (resultSet.kind === "applications") {
        const record = snapshot.applicationRecords.find(
          (entry) => entry.id === id,
        );
        return record
          ? { position, ...compactApplication(record) }
          : { position, id, missing: true };
      }
      const job = jobs.find((entry) => entry.id === id);
      return job
        ? { position, ...compactJob(job) }
        : { position, id, missing: true };
    });
    const next = input.cursor + ids.length;
    return {
      summary: `${resultSet.label}: items ${input.cursor + 1}–${next} of ${resultSet.itemIds.length}.`,
      data: {
        items,
        next: next < resultSet.itemIds.length ? next : null,
        coverage: resultSet.coverage,
      },
    };
  },
});

export const searchConversationTool = defineTool({
  name: "search_conversation",
  group: "workspace",
  description:
    "Finds earlier messages in this conversation by words, including parts no longer in view. Use it before asking the person to repeat something.",
  parameters: json.object({ query: json.string() }, ["query"]),
  input: z.object({ query: z.string().trim().min(1).max(200) }),
  label: () => "Looking back through this conversation",
  effect: "read",
  async execute(input, { session }) {
    const results = await session.searchConversation(input.query, 12);
    return {
      summary:
        results.length === 0
          ? "No earlier message matches."
          : `${plural(results.length, "earlier message")} match.`,
      data: results,
    };
  },
});

const PlanInput = z.object({
  title: z.string().trim().min(1).max(200),
  steps: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(60).optional(),
        label: z.string().trim().min(1).max(300),
        status: AssistantTaskPlanStepSchema.shape.status.optional(),
        dependsOn: z.array(z.string().max(60)).max(10).optional(),
        note: z.string().max(600).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const updatePlanTool = defineTool({
  name: "update_plan",
  group: "workspace",
  description:
    "Keeps a checklist for multi-part work (several steps, or steps that wait on a background run). Send the whole list each time with each step's status: pending, running, waiting, done, failed, skipped. Steps that wait on a search or an application batch continue automatically when that run ends. Not needed for one-step requests.",
  parameters: json.object(
    {
      title: json.string(),
      steps: json.array(
        json.object(
          {
            id: json.string("Stable id, such as 'search' or 'shortlist'."),
            label: json.string(),
            status: json.enumOf([
              "pending",
              "running",
              "waiting",
              "done",
              "failed",
              "skipped",
            ]),
            dependsOn: json.ids(),
            note: json.string(),
          },
          ["label"],
        ),
      ),
    },
    ["title", "steps"],
  ),
  input: PlanInput,
  label: () => "Updating the checklist",
  effect: "local_write",
  async execute(input, { session }) {
    const existing = await session.plans.active();
    const now = session.now();
    const steps = input.steps.map((step, index) => {
      const id = step.id ?? `step_${index + 1}`;
      const previous = existing?.steps.find((candidate) => candidate.id === id);
      return AssistantTaskPlanStepSchema.parse({
        id,
        label: step.label,
        status: step.status ?? previous?.status ?? "pending",
        dependsOn: step.dependsOn ?? previous?.dependsOn ?? [],
        operationId: previous?.operationId ?? null,
        run: previous?.run ?? null,
        note: step.note ?? previous?.note ?? null,
      });
    });
    const allFinished = steps.every((step) =>
      ["done", "failed", "skipped", "cancelled"].includes(step.status),
    );
    const plan: AssistantTaskPlan = {
      id: existing?.id ?? session.createId("assistant_plan"),
      conversationId: session.conversationId,
      title: input.title,
      steps,
      grantId: existing?.grantId ?? null,
      sourceMessageId:
        existing?.sourceMessageId ?? session.sourceMessage?.id ?? null,
      status: allFinished ? "completed" : "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await session.plans.save(plan);
    return {
      summary: `Checklist "${plan.title}": ${steps.filter((step) => step.status === "done").length} of ${steps.length} done.`,
      data: {
        planId: plan.id,
        steps: steps.map(({ id, status }) => ({ id, status })),
      },
    };
  },
});

export const askPersonTool = defineTool({
  name: "ask_person",
  group: "workspace",
  description:
    "Asks the person one question when only they know the answer or a real conflict needs their choice. The turn ends and continues when they answer. Offer short options when there are a few clear choices. When the question is a Needs you step's question, pass its requestId as needsYouRequestId: if they answer it on the Needs you screen instead, the question here closes and you are told.",
  parameters: json.object(
    {
      question: json.string(),
      options: json.array(
        json.string(),
        "Up to 6 short answers they can pick.",
      ),
      needsYouRequestId: json.string(
        "The Needs you step this question is about, from list_needs_you.",
      ),
    },
    ["question"],
  ),
  input: z.object({
    question: z.string().trim().min(1).max(1_000),
    options: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
    needsYouRequestId: Id.optional(),
  }),
  label: () => "Asking you a question",
  effect: "read",
  async execute(input, { session }) {
    const questionId = await session.askQuestion(
      input.question,
      input.options,
      input.needsYouRequestId ?? null,
    );
    return {
      summary: "The question is shown to the person; wait for their answer.",
      data: { questionId },
      endTurn: { reason: "waiting_for_person" },
    };
  },
});

export const reportProgressTool = defineTool({
  name: "report_progress",
  group: "workspace",
  description:
    "Shows the person a short progress note while you keep working, only when there is something new to say (what you found, what is next). Not needed if you already write a sentence alongside your tool calls.",
  parameters: json.object({ text: json.string() }, ["text"]),
  input: z.object({ text: z.string().trim().min(1).max(500) }),
  label: () => "Noting progress",
  effect: "read",
  async execute(input, { session }) {
    await session.reportProgress(input.text);
    return { summary: "Shown." };
  },
});

export const reportMissingCapabilityTool = defineTool({
  name: "report_missing_capability",
  group: "workspace",
  description:
    "Records an action the person asked you to perform that none of your tools can do, so it can be added. This is a write, not a lookup. Never call for advice-only questions, privacy explanations, or when the person says not to change anything. Then tell the person plainly what you could not do; never claim it was done.",
  parameters: json.object({ description: json.string() }, ["description"]),
  input: z.object({ description: z.string().trim().min(1).max(1_000) }),
  label: () => "Noting something I cannot do yet",
  effect: "local_write",
  async execute(input, { session }) {
    await session.reportGap(input.description);
    return { summary: "Recorded." };
  },
});

const APP_ROUTES = {
  home: "/job-finder/home",
  profile: "/job-finder/profile",
  find_jobs: "/job-finder/discovery",
  shortlisted: "/job-finder/review-queue",
  applications: "/job-finder/applications",
  needs_you: "/job-finder/actions",
  settings: "/job-finder/settings",
} as const;

export const openInAppTool = defineTool({
  name: "open_in_app",
  group: "workspace",
  description:
    "Opens a screen or a record in the app for the person. Use screen applications for the tracker (statuses, notes, interviews and reminders), optionally with its numeric jobId. Open screens only when asked to see them.",
  parameters: json.object({
    screen: json.enumOf(Object.keys(APP_ROUTES)),
    jobId: json.number("Opens that stored job (its resume when resume is true)."),
    applicationView: json.looseObject("Applications filter and selection: statuses, text, tag, due, quietForDays, sort (recent/applied/next), selectedIds (up to 50), all (selectedIds are exceptions when true)."),
    resume: json.boolean(),
    view: json.looseObject("Find jobs or Shortlisted filter and selection: stage, text; Find jobs also minFit and sort. selectedIds is up to 50 ids; all=true selects every matching job, with selectedIds as exceptions."),
    section: json.enumOf(
      ["basics", "experience", "background", "preferences", "sources", "files"],
      "Profile tab to show. Languages are in background.",
    ),
  }),
  input: z.object({
    screen: z
      .enum(Object.keys(APP_ROUTES) as [keyof typeof APP_ROUTES])
      .optional(),
    jobId: JobIdSchema.optional(),
    applicationView: AssistantTrackerViewSchema.optional(),
    resume: z.boolean().optional(),
    view: AssistantJobViewSchema.optional(),
    section: z
      .enum([
        "basics",
        "experience",
        "background",
        "preferences",
        "sources",
        "files",
      ])
      .optional(),
  }),
  label: () => "Opening it in the app",
  effect: "read",
  async execute(input, context) {
    const { session, ports } = context;
    if (input.resume && input.screen && input.screen !== "shortlisted") throw new AssistantToolError("invalid_input", "Choose one destination per call: a resume opens in Shortlisted.");
    let screen = input.screen ?? (input.resume ? "shortlisted" : undefined);
    let jobView: z.infer<typeof AssistantJobViewSchema> | undefined;
    let applicationView = input.applicationView;
    const getJob = ports.commands?.find((command) => command.name === "get_job");
    if (input.jobId) {
      if (!screen && getJob) {
        const result = await getJob.execute({ id: input.jobId }, context);
        if (result.data === null) throw new AssistantToolError("not_found", "That job no longer exists.");
        const job = JobDetailSchema.parse(result.data);
        screen = job.stage === "applied" ? "applications" : ["shortlisted", "resume"].includes(job.stage) ? "shortlisted" : "find_jobs";
      }
      screen ??= "find_jobs";
      if (screen === "applications") {
        const getApplication = ports.commands?.find((command) => command.name === "get_application");
        if (!getApplication || (await getApplication.execute({ jobId: input.jobId }, context)).data === null)
          throw new AssistantToolError("not_found", "That job is not in Applications.");
        applicationView ??= { statuses: [], text: "", tag: null, due: false, quietForDays: null };
      } else {
        if (screen !== "find_jobs" && screen !== "shortlisted") throw new AssistantToolError("invalid_input", "Choose the job's list screen.");
        if (getJob) {
          const result = await getJob.execute({ id: input.jobId }, context);
          if (result.data === null) throw new AssistantToolError("not_found", "That job no longer exists.");
          const job = JobDetailSchema.parse(result.data);
          const stages = screen === "shortlisted" ? ["shortlisted", "resume"] : ["found", "hidden", "shortlisted"];
          if (!stages.includes(job.stage)) throw new AssistantToolError("invalid_input", "That job belongs to a different screen. Choose its current stage.");
          jobView = { stage: job.stage, text: "", ...(screen === "shortlisted" ? {} : { minFit: null }) };
        }
      }
    }
    if (input.resume && screen !== "shortlisted") throw new AssistantToolError("invalid_input", "A resume opens in Shortlisted.");
    if (input.applicationView && input.screen !== "applications") throw new AssistantToolError("invalid_input", "Application filters require screen applications.");
    if (input.section && input.screen !== "profile")
      throw new AssistantToolError(
        "invalid_input",
        "A Profile tab requires screen profile.",
      );
    if (input.view && input.screen !== "find_jobs" && input.screen !== "shortlisted")
      throw new AssistantToolError("invalid_input", "Job filters and selection require Find jobs or Shortlisted.");
    if (input.view && input.jobId)
      throw new AssistantToolError("invalid_input", "Open a job or change the list's filters and selection in separate calls.");
    if (input.view && input.screen === "shortlisted" &&
      ((input.view.stage && !["shortlisted", "resume"].includes(input.view.stage)) || input.view.minFit !== undefined || input.view.sort !== undefined))
      throw new AssistantToolError("invalid_input", "Shortlisted supports its shortlisted/resume stage, text filter and selection.");
    if (input.view?.stage && input.screen === "find_jobs" && !["found", "hidden", "shortlisted"].includes(input.view.stage))
      throw new AssistantToolError("invalid_input", "Find jobs shows found, hidden or shortlisted jobs.");
    let route = input.jobId
      ? screen === "applications"
        ? `/job-finder/applications?jobId=${input.jobId}`
        : screen === "shortlisted"
          ? `/job-finder/review-queue?jobId=${input.jobId}`
          : `/job-finder/discovery?job=${input.jobId}`
      : input.screen === "profile" && input.section
        ? `${APP_ROUTES.profile}?section=${input.section}`
        : APP_ROUTES[input.screen ?? "home"];
    if (applicationView) {
      const destination = new URL(route, "https://nestor.local");
      destination.searchParams.set("applications", JSON.stringify(applicationView));
      route = `${destination.pathname}${destination.search}`;
    }
    const view = input.view ?? jobView;
    if (view) {
      const destination = new URL(route, "https://nestor.local");
      destination.searchParams.set("jobs", JSON.stringify(view));
      route = `${destination.pathname}${destination.search}`;
    }
    const display = await session.openInApp(route);
    return {
      summary:
        display?.status === "displayed"
          ? `The renderer confirms ${display.displayedRoute}${display.section ? ` (${display.section})` : ""} is displayed with no covering overlay.`
          : `Navigation was not confirmed: ${display?.reason ?? "no renderer acknowledgment"}. Do not claim the destination is visible.`,
      data: { route, requested: true, display: display ?? null },
    };
  },
});

export const workspaceTools = [
  getWorkspaceSummaryTool,
  listNeedsYouTool,
  resolveNeedsYouTool,
  readResultTool,
  searchConversationTool,
  updatePlanTool,
  askPersonTool,
  reportProgressTool,
  reportMissingCapabilityTool,
  openInAppTool,
];
