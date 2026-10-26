import { getAssistantSearchReadiness } from "../prompt";
import type { AssistantTaskPlan } from "@nestor/contracts";
import {
  AssistantTaskPlanStepSchema,
  AssistantJobViewSchema,
  AssistantTrackerViewSchema,
  JobIdSchema,
  JobDetailSchema,
  NonEmptyStringSchema,
} from "@nestor/contracts";
import { z } from "zod";
import { AssistantToolError, defineTool, json } from "../tool-kit";
import { readAssistantWorkState } from "../work-state";
import { plural } from "./format";

const Id = NonEmptyStringSchema.max(200);

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
    const { ports } = context;
    const [counts, search, tracker, needs, personal] = await Promise.all([
      ports.readCommand("stage_counts", {}),
      ports.readCommand("search_status", {}),
      ports.readCommand("list_applications", { limit: 1 }),
      ports.readCommand("needs_you_counts", {}),
      ports.readPersonalState(),
    ]);
    return {
      summary: `${counts.found} found, ${counts.hidden} hidden, ${counts.shortlisted} shortlisted, ${counts.resume} approved, ${counts.applied} applied.`,
      data: {
        jobs: counts,
        search: { ...search, ...getAssistantSearchReadiness(personal) },
        applications: tracker.counts,
        profile: {
          setup: personal.profileSetupState.status,
          name: personal.profile.fullName,
        },
        applyMode: personal.settings.applicationAutomationMode,
        needsYou: needs.question + needs.sign_in + needs.captcha + needs.mfa,
        ...readAssistantWorkState(ports, personal),
      },
    };
  },
});

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
  async execute(input, { ports, session }) {
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
    const items = await Promise.all(
      ids.map(async (id, offset) => {
        const position = input.cursor + offset + 1;
        if (!/^\d+$/u.test(id)) return { position, id, missing: true };
        const value =
          resultSet.kind === "applications"
            ? await ports.readCommand("get_application", { jobId: Number(id) })
            : await ports.readCommand("get_job", { id: Number(id) });
        return value ? { position, ...value } : { position, id, missing: true };
      }),
    );
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
    jobId: json.number(
      "Opens that stored job (its resume when resume is true).",
    ),
    applicationView: json.looseObject(
      "Applications filter and selection: statuses, text, tag, due, quietForDays, sort (recent/applied/next), selectedIds (up to 50), all (selectedIds are exceptions when true).",
    ),
    resume: json.boolean(),
    view: json.looseObject(
      "Find jobs or Shortlisted filter and selection: stage, text; Find jobs also minFit and sort. selectedIds is up to 50 ids; all=true selects every matching job, with selectedIds as exceptions.",
    ),
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
    if (input.resume && input.screen && input.screen !== "shortlisted")
      throw new AssistantToolError(
        "invalid_input",
        "Choose one destination per call: a resume opens in Shortlisted.",
      );
    let screen = input.screen ?? (input.resume ? "shortlisted" : undefined);
    let jobView: z.infer<typeof AssistantJobViewSchema> | undefined;
    let applicationView = input.applicationView;
    const getJob = ports.commands?.find(
      (command) => command.name === "get_job",
    );
    if (input.jobId) {
      if (!screen && getJob) {
        const result = await getJob.execute({ id: input.jobId }, context);
        if (result.data === null)
          throw new AssistantToolError(
            "not_found",
            "That job no longer exists.",
          );
        const job = JobDetailSchema.parse(result.data);
        screen =
          job.stage === "applied"
            ? "applications"
            : ["shortlisted", "resume"].includes(job.stage)
              ? "shortlisted"
              : "find_jobs";
      }
      screen ??= "find_jobs";
      if (screen === "applications") {
        const getApplication = ports.commands?.find(
          (command) => command.name === "get_application",
        );
        if (
          !getApplication ||
          (await getApplication.execute({ jobId: input.jobId }, context))
            .data === null
        )
          throw new AssistantToolError(
            "not_found",
            "That job is not in Applications.",
          );
        applicationView ??= {
          statuses: [],
          text: "",
          tag: null,
          due: false,
          quietForDays: null,
        };
      } else {
        if (screen !== "find_jobs" && screen !== "shortlisted")
          throw new AssistantToolError(
            "invalid_input",
            "Choose the job's list screen.",
          );
        if (getJob) {
          const result = await getJob.execute({ id: input.jobId }, context);
          if (result.data === null)
            throw new AssistantToolError(
              "not_found",
              "That job no longer exists.",
            );
          const job = JobDetailSchema.parse(result.data);
          const stages =
            screen === "shortlisted"
              ? ["shortlisted", "resume"]
              : ["found", "hidden", "shortlisted"];
          if (!stages.includes(job.stage))
            throw new AssistantToolError(
              "invalid_input",
              "That job belongs to a different screen. Choose its current stage.",
            );
          jobView = {
            stage: job.stage,
            text: "",
            ...(screen === "shortlisted" ? {} : { minFit: null }),
          };
        }
      }
    }
    if (input.resume && screen !== "shortlisted")
      throw new AssistantToolError(
        "invalid_input",
        "A resume opens in Shortlisted.",
      );
    if (input.applicationView && input.screen !== "applications")
      throw new AssistantToolError(
        "invalid_input",
        "Application filters require screen applications.",
      );
    if (input.section && input.screen !== "profile")
      throw new AssistantToolError(
        "invalid_input",
        "A Profile tab requires screen profile.",
      );
    if (
      input.view &&
      input.screen !== "find_jobs" &&
      input.screen !== "shortlisted"
    )
      throw new AssistantToolError(
        "invalid_input",
        "Job filters and selection require Find jobs or Shortlisted.",
      );
    if (input.view && input.jobId)
      throw new AssistantToolError(
        "invalid_input",
        "Open a job or change the list's filters and selection in separate calls.",
      );
    if (
      input.view &&
      input.screen === "shortlisted" &&
      ((input.view.stage &&
        !["shortlisted", "resume"].includes(input.view.stage)) ||
        input.view.minFit !== undefined ||
        input.view.sort !== undefined)
    )
      throw new AssistantToolError(
        "invalid_input",
        "Shortlisted supports its shortlisted/resume stage, text filter and selection.",
      );
    if (
      input.view?.stage &&
      input.screen === "find_jobs" &&
      !["found", "hidden", "shortlisted"].includes(input.view.stage)
    )
      throw new AssistantToolError(
        "invalid_input",
        "Find jobs shows found, hidden or shortlisted jobs.",
      );
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
      destination.searchParams.set(
        "applications",
        JSON.stringify(applicationView),
      );
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
  readResultTool,
  searchConversationTool,
  updatePlanTool,
  askPersonTool,
  reportProgressTool,
  reportMissingCapabilityTool,
  openInAppTool,
];
