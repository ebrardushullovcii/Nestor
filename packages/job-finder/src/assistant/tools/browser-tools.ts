import {
  createApplyPageHands,
  createPageTools,
  type PageTools,
} from "@nestor/browser-agent";
import {
  JobPostingSchema,
  NonEmptyStringSchema,
  type ApplyRawPageHands,
  type JobPosting,
} from "@nestor/contracts";
import { z } from "zod";

import type { AssistantBrowserLease } from "../ports";
import {
  AssistantToolError,
  defineTool,
  json,
  type AssistantToolContext,
  type AssistantToolDefinition,
} from "../tool-kit";
import { findJob, jobRowsPart, plural } from "./format";

const Id = NonEmptyStringSchema.max(200);

/**
 * The browser tools work in the tab the person lent (ADR 0038): its
 * observation, clicks, typing, keys, scrolling and the tabs the task opens.
 * They share the page-tool pack every Job Finder agent uses. Two things are
 * added for the sidebar: a control that would send an application is never
 * pressed here (sending goes through the application service, checked and
 * recorded), and collecting and saving jobs from the page.
 */

const pageToolsByLease = new WeakMap<AssistantBrowserLease, PageTools>();

function pageToolsFor(lease: AssistantBrowserLease): PageTools {
  const existing = pageToolsByLease.get(lease);
  if (existing) return existing;
  const tools = createPageTools(createApplyPageHands(lease.hands), {});
  pageToolsByLease.set(lease, tools);
  return tools;
}

async function leaseFor(
  context: AssistantToolContext,
): Promise<AssistantBrowserLease> {
  if (!context.ports.browser) {
    throw new AssistantToolError(
      "refused",
      "The browser is not available here.",
    );
  }
  const lease = await context.session.browserLease();
  if (lease.revoked.aborted) {
    throw new AssistantToolError(
      "refused",
      "The person took this tab back. Ask before working in the browser again.",
    );
  }
  return lease;
}

/**
 * The page's text with its links spelled out. Visible text alone has no
 * addresses, so a job list read from it has nothing to tell its jobs apart
 * by and every posting was dropped.
 */
export async function readPageTextWithLinks(
  lease: AssistantBrowserLease,
): Promise<string> {
  const [text, page] = await Promise.all([
    lease.hands.readText(),
    Promise.resolve()
      .then(() => lease.hands.readPage())
      .catch(() => null),
  ]);
  const links = (page?.links ?? [])
    .filter((link) => /^https?:/iu.test(link.href) && link.label.trim())
    .slice(0, 250)
    .map((link) => `${link.label.trim().slice(0, 160)} -> ${link.href}`);
  return links.length > 0
    ? `${text}\n\nLinks on this page (text -> address):\n${links.join("\n")}`
    : text;
}

/** Tool definitions of the shared pack, read once without a page. */
const TEMPLATE_HANDS: ApplyRawPageHands = {
  readPage: () => Promise.reject(new Error("template")),
  fillText: () => Promise.reject(new Error("template")),
  chooseOption: () => Promise.reject(new Error("template")),
  setToggle: () => Promise.reject(new Error("template")),
  uploadFile: () => Promise.reject(new Error("template")),
  clickAction: () => Promise.reject(new Error("template")),
  followLink: () => Promise.reject(new Error("template")),
  navigate: () => Promise.reject(new Error("template")),
  clickElement: () => Promise.reject(new Error("template")),
  pressKey: () => Promise.reject(new Error("template")),
  scroll: () => Promise.reject(new Error("template")),
  wait: () => Promise.resolve(),
  goBack: () => Promise.reject(new Error("template")),
  readText: () => Promise.resolve(""),
};
const TEMPLATE = createPageTools(createApplyPageHands(TEMPLATE_HANDS), {});

const LABELS: Record<string, string> = {
  observe: "Looking at the page",
  read_text: "Reading the page",
  navigate: "Opening a page",
  follow_link: "Following a link",
  click: "Pressing a control on the page",
  press_key: "Pressing a key",
  type: "Typing into the page",
  select: "Choosing an option",
  set_checkbox: "Ticking a box",
  scroll: "Scrolling the page",
  wait: "Waiting for the page",
  go_back: "Going back",
};

function refuseFinalSend(
  tools: PageTools,
  name: string,
  args: Record<string, unknown>,
): string | null {
  const observation = tools.state.observation;
  if (!observation) return null;
  const ref = typeof args.ref === "string" ? args.ref : null;
  if (name === "click" && ref) {
    const action = observation.actions.find((entry) => entry.ref === ref);
    if (action?.kind === "final") {
      return `"${action.label}" sends this application. Sending goes through apply_here and send_applications, so it is checked and recorded; it is not pressed from the browser tools.`;
    }
  }
  if (
    name === "press_key" &&
    typeof args.key === "string" &&
    args.key.split("+").some((key) => key.toLowerCase() === "enter") &&
    observation.actions.some((entry) => entry.kind === "final")
  ) {
    return "Pressing Enter in this form could send the application. Sending goes through apply_here and send_applications.";
  }
  return null;
}

function forwardedTool(name: string): AssistantToolDefinition | null {
  const template = TEMPLATE.tools.find(
    (tool) => tool.definition.function.name === name,
  );
  if (!template) return null;
  const fn = template.definition.function;
  return defineTool({
    name: `browser_${name}`,
    group: "browser",
    description: `${fn.description} (Browser: the tab the person lent you.)`,
    parameters: fn.parameters,
    input: z.record(z.unknown()),
    label: () => LABELS[name] ?? "Working in the browser",
    effect:
      name === "observe" || name === "read_text" || name === "wait"
        ? "read"
        : "external",
    async execute(input, context) {
      const lease = await leaseFor(context);
      const tools = pageToolsFor(lease);
      if (
        (name === "navigate" ||
          name === "go_back" ||
          name === "follow_link" ||
          name === "click" ||
          name === "press_key" ||
          name === "type" ||
          name === "select" ||
          name === "set_checkbox") &&
        (await lease.isApplicationBound()) === true &&
        (!lease.applicationResultId ||
          ["navigate", "go_back", "follow_link"].includes(name))
      ) {
        throw new AssistantToolError(
          "refused",
          "This tab holds a prepared application. Use retry_application with openPage:true to edit its exact form. Use browser_open for unrelated pages.",
        );
      }
      if (name !== "observe" && !tools.state.observation) {
        await tools.observe();
      }
      const refusal = refuseFinalSend(tools, name, input);
      if (refusal) {
        return { summary: refusal, status: "refused" };
      }
      context.session.assertCurrent();
      const tool = tools.tools.find(
        (entry) => entry.definition.function.name === name,
      );
      if (!tool)
        throw new AssistantToolError(
          "refused",
          "That browser action is not available.",
        );
      const outcome = await tool.execute(JSON.stringify(input), {
        step: 0,
        signal: context.session.signal,
      });
      if (outcome.kind !== "ok") {
        return { summary: outcome.kind === "stop" ? outcome.reason : "Done." };
      }
      return { summary: outcome.content };
    },
  });
}

const FORWARDED = [
  "observe",
  "read_text",
  "navigate",
  "follow_link",
  "click",
  "press_key",
  "type",
  "select",
  "set_checkbox",
  "scroll",
  "wait",
  "go_back",
]
  .map(forwardedTool)
  .filter((tool): tool is AssistantToolDefinition => tool !== null);

export const browserOpenTool = defineTool({
  name: "browser_open",
  group: "browser",
  description:
    "Opens an address in a new task-owned tab, preserving every existing form and attachment. To inspect an existing prepared form, use browser_use_application; never open a blank copy.",
  parameters: json.object({ url: json.string() }, ["url"]),
  input: z.object({ url: z.string().trim().url() }),
  label: () => "Opening a page",
  effect: "external",
  async execute(input, context) {
    if (!context.ports.browser) {
      throw new AssistantToolError(
        "refused",
        "The browser is not available here.",
      );
    }
    const lease = await context.session.browserLease({
      openUrl: input.url,
      newTab: true,
    });
    context.session.assertCurrent();
    await context.ports.browser.show?.();
    const observation = await pageToolsFor(lease).observe();
    return {
      summary: `The new tab shows ${observation.url}. Inspect its fields and files before claiming any form was recovered.`,
      data: observation,
    };
  },
});

export const browserUseApplicationTool = defineTool({
  name: "browser_use_application",
  group: "browser",
  description:
    "Inspects the exact retained tab for a saved application, preserving fields and attachments. Never opens or reloads a copy. Use before discussing or editing a prepared form. If its tab cannot be identified, say so; do not claim recovery.",
  parameters: json.object({ jobId: json.string() }, ["jobId"]),
  input: z.object({ jobId: Id }),
  label: () => "Checking the prepared application",
  effect: "read",
  async execute(input, context) {
    const snapshot = await context.service.getWorkspaceSnapshot();
    const latest = snapshot.applyJobResults
      .filter((result) => result.jobId === input.jobId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (
      !latest?.applicationRecordId ||
      !["awaiting_review", "paused", "blocked"].includes(latest.state)
    ) {
      throw new AssistantToolError(
        "refused",
        "I cannot identify this application's retained tab. Nothing was opened or restored.",
      );
    }
    context.session.assertCurrent();
    const raw = await context.service.inspectPreparedApplicationPage({
      jobId: input.jobId,
      runId: latest.runId,
      resultId: latest.id,
      applicationRecordId: latest.applicationRecordId,
    });
    context.session.assertCurrent();
    const observation = await createPageTools(
      createApplyPageHands({
        ...TEMPLATE_HANDS,
        readPage: () => Promise.resolve(raw),
      }),
      {},
    ).observe();
    return {
      summary: `Inspected the retained application tab at ${observation.url} with submit windows closed. This inspection is read-only and did not show the page to the person or select it for later browser tools. Use retry_application with openPage:true to show and safely edit this exact form. Report recovery only if its fields and attachment are present.`,
      data: observation,
    };
  },
});

export const browserFindTool = defineTool({
  name: "browser_find",
  group: "browser",
  description:
    "Finds controls, buttons and links on the page whose text matches the words given, with their handles.",
  parameters: json.object({ text: json.string() }, ["text"]),
  input: z.object({ text: z.string().trim().min(1).max(200) }),
  label: () => "Looking for something on the page",
  effect: "read",
  async execute(input, context) {
    const lease = await leaseFor(context);
    const observation = await pageToolsFor(lease).observe();
    const words = input.text.toLowerCase().split(/\s+/u).filter(Boolean);
    const hit = (label: string) => {
      const text = label.toLowerCase();
      return words.every((word) => text.includes(word));
    };
    const matches = [
      ...observation.controls
        .filter((control) =>
          hit(`${control.label} ${control.groupLabel} ${control.placeholder}`),
        )
        .map((control) => ({
          ref: control.ref,
          what: "field",
          label: control.label,
        })),
      ...observation.actions
        .filter((action) => hit(action.label))
        .map((action) => ({
          ref: action.ref,
          what: `button (${action.kind})`,
          label: action.label,
        })),
      ...observation.links
        .filter((link) => hit(`${link.label} ${link.href ?? ""}`))
        .map((link) => ({
          ref: link.ref,
          what: "link",
          label: link.label,
          href: link.href,
        })),
      ...observation.clickables
        .filter((entry) => hit(entry.label))
        .map((entry) => ({
          ref: entry.ref,
          what: "clickable",
          label: entry.label,
        })),
    ].slice(0, 25);
    return {
      summary: matches.length
        ? `${plural(matches.length, "match", "matches")} on ${observation.url}.`
        : `Nothing on ${observation.url} matches "${input.text}".`,
      data: matches,
    };
  },
});

export const browserUploadTool = defineTool({
  name: "browser_upload",
  group: "browser",
  description:
    "Puts one of the person's files (by document id from list_documents) into a file field or drop zone on the page. A file list_documents shows as written for one job (forJob) is only for that job: pass that job's id as jobId. When no letter fits this job, leave the field empty and say so, or write one for this job.",
  parameters: json.object(
    {
      ref: json.string(),
      documentId: json.string(),
      jobId: json.string(
        "The saved job this application is for, when known. Required for a file written for one job.",
      ),
    },
    ["ref", "documentId"],
  ),
  input: z.object({ ref: Id, documentId: Id, jobId: Id.optional() }),
  label: () => "Uploading a file into the page",
  effect: "external",
  async execute(input, context) {
    const lease = await leaseFor(context);
    const document = (await context.ports.listDocuments()).find(
      (candidate) => candidate.id === input.documentId,
    );
    // A letter written for one job must never land in another job's form:
    // checked before anything touches the page, so the field stays empty.
    if (document?.forJob && document.forJob.jobId !== input.jobId) {
      throw new AssistantToolError(
        "refused",
        `${document.originalName} was written for ${document.forJob.title} at ${document.forJob.company}. Nothing was uploaded. Use a file made for this job, or write one for it.`,
      );
    }
    const file = await context.ports.loadDocumentFile(input.documentId);
    context.session.assertCurrent();
    const result = await lease.hands.uploadFile(input.ref, {
      name: file.name,
      mimeType: file.mimeType,
      bytes: file.bytes,
    });
    if (!result.ok) throw new AssistantToolError("transient", result.error);
    return { summary: `Attached ${file.name}.` };
  },
});

function postingKey(posting: JobPosting): string {
  return `${posting.company}|${posting.title}|${posting.canonicalUrl}`.toLowerCase();
}

export const collectPageJobsTool = defineTool({
  name: "collect_page_jobs",
  group: "browser",
  description:
    "Reads the job postings on the current page into a result set (nothing is saved or applied). To cover more pages, move to the next page and call again with appendTo; say how far the collection got. Use save_page_jobs for the ones the person wants kept.",
  parameters: json.object({
    appendTo: json.string("Result set to extend."),
    single: json.boolean("The page shows one job in full."),
  }),
  input: z.object({
    appendTo: Id.optional(),
    single: z.boolean().default(false),
  }),
  label: () => "Collecting the jobs on this page",
  effect: "read",
  async execute(input, context) {
    const lease = await leaseFor(context);
    const pageUrl = lease.currentUrl();
    const pageText = await readPageTextWithLinks(lease);
    const postings = await context.service.extractJobsFromPageText({
      pageText,
      pageUrl,
      pageType: input.single ? "job_detail" : "search_results",
      maxJobs: input.single ? 1 : 50,
      signal: context.session.signal,
    });
    const existing = input.appendTo
      ? await context.session.getResultSet(input.appendTo)
      : null;
    if (input.appendTo && (!existing || existing.kind !== "page_jobs")) {
      throw new AssistantToolError(
        "not_found",
        "No collected set with that id.",
      );
    }
    const previous = (existing?.pageItems ?? [])
      .map((item) => JobPostingSchema.safeParse(item))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    const seen = new Set(previous.map(postingKey));
    const added = postings.filter((posting) => {
      const key = postingKey(posting);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const all = [...previous, ...added];
    const collectionId =
      existing?.id ?? context.session.createId("page_collection");
    const itemIds = all.map(
      (_posting, index) =>
        existing?.itemIds[index] ?? `page_job_${collectionId}_${index + 1}`,
    );
    const coverage =
      `${existing?.coverage ? `${existing.coverage}; ` : ""}${pageUrl} (${added.length} new)`.slice(
        -600,
      );
    let resultSetId: string;
    if (existing) {
      await context.session.saveResultSet({
        ...existing,
        itemIds,
        pageItems: all,
        coverage,
      });
      resultSetId = existing.id;
    } else {
      const created = await context.session.createResultSet({
        kind: "page_jobs",
        label: `Jobs on ${new URL(pageUrl).host}`,
        itemIds,
        source: "page_collection",
        coverage,
        pageItems: all,
        pageUrl,
      });
      resultSetId = created.id;
    }
    return {
      summary: `Collected ${plural(added.length, "new job")} from this page; ${all.length} in result set ${resultSetId}.`,
      data: {
        resultSetId,
        jobs: all.slice(0, 50).map((posting, index) => ({
          id: itemIds[index],
          position: index + 1,
          title: posting.title,
          company: posting.company,
          location: posting.location,
          workMode: posting.workMode,
          salary: posting.salaryText,
          url: posting.applicationUrl ?? posting.canonicalUrl,
          summary: posting.summary?.slice(0, 300) ?? null,
        })),
        coverage,
      },
    };
  },
});

export const savePageJobsTool = defineTool({
  name: "save_page_jobs",
  group: "browser",
  description:
    "Saves collected jobs the person picked (positions in the collected result set) as saved jobs in the active search plan, merging with jobs already saved. Returns their job ids for shortlisting or applying.",
  parameters: json.object(
    {
      resultSetId: json.string(),
      positions: json.array(json.number(), "1-based; omit for all."),
    },
    ["resultSetId"],
  ),
  input: z.object({
    resultSetId: Id,
    positions: z.array(z.number().int().min(1)).max(100).optional(),
  }),
  label: () => "Saving the jobs you picked",
  effect: "local_write",
  async execute(input, context) {
    const resultSet = await context.session.getResultSet(input.resultSetId);
    if (!resultSet || resultSet.kind !== "page_jobs") {
      throw new AssistantToolError(
        "not_found",
        "No collected set with that id.",
      );
    }
    const postings = resultSet.pageItems
      .map((item) => JobPostingSchema.safeParse(item))
      .map((parsed) => (parsed.success ? parsed.data : null));
    const picked = (
      input.positions ?? postings.map((_entry, index) => index + 1)
    )
      .map((position) => postings[position - 1])
      .filter((posting): posting is JobPosting => Boolean(posting));
    if (picked.length === 0) {
      throw new AssistantToolError(
        "invalid_input",
        "Those positions are not in the set.",
      );
    }
    context.session.assertCurrent();
    const saved = await context.service.saveJobsFromPage({
      postings: picked,
      pageUrl: resultSet.pageUrl ?? "about:blank",
    });
    context.ports.publishWorkspaceUpdate();
    const snapshot = await context.service.getWorkspaceSnapshot();
    const jobs = snapshot.discoveryJobs.filter((job) =>
      saved.savedJobIds.includes(job.id),
    );
    const savedSet = await context.session.createResultSet({
      kind: "jobs",
      label: "Saved from the page",
      itemIds: saved.savedJobIds,
      source: "page_collection",
    });
    const matched = saved.mergedJobIds
      .map((id) => findJob(snapshot, id))
      .filter((job): job is NonNullable<typeof job> => job !== null);
    return {
      summary: [
        `Saved ${plural(saved.newJobIds.length, "new job")} (result set ${savedSet.id}).`,
        matched.length > 0
          ? `Already saved and left as they were: ${matched
              .map(
                (job) =>
                  `${job.title} at ${job.company} (${job.status.replaceAll("_", " ")})`,
              )
              .join("; ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      data: { jobIds: saved.savedJobIds, resultSetId: savedSet.id },
      parts: jobs.length
        ? [
            jobRowsPart({
              jobs,
              title: "Saved from the page",
              resultSetId: savedSet.id,
            }),
          ]
        : [],
    };
  },
});

export const applyHereTool = defineTool({
  name: "apply_here",
  group: "browser",
  description:
    "For 'apply on this link': reads the job on the current page, saves it (or finds it if already saved) and returns its job id. The application runs on this page's form, because the person picked it, even when the same job was saved from another site. Then record the person's instruction and call apply_to_jobs; the application service opens and fills the form in its own tab, and sends only if the instruction says so.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Taking the job from this page",
  effect: "local_write",
  async execute(_input, context) {
    const lease = await leaseFor(context);
    const pageUrl = lease.currentUrl();
    const postings = await context.service.extractJobsFromPageText({
      pageText: await readPageTextWithLinks(lease),
      pageUrl,
      pageType: "job_detail",
      maxJobs: 1,
      signal: context.session.signal,
    });
    const posting = postings[0];
    if (!posting) {
      throw new AssistantToolError(
        "missing_information",
        "This page does not show one job. Open the job's own page first.",
      );
    }
    context.session.assertCurrent();
    const saved = await context.service.saveJobsFromPage({
      postings: [posting],
      pageUrl,
      applyOnThisPage: true,
    });
    const jobId = saved.savedJobIds[0];
    if (!jobId)
      throw new AssistantToolError("transient", "The job could not be saved.");
    await context.session.createResultSet({
      kind: "jobs",
      label: `This page: ${posting.title}`,
      itemIds: [jobId],
      source: "page_collection",
    });
    context.ports.publishWorkspaceUpdate();
    // Say where the application will really run: a page merged into a job
    // saved from another site applies on that job's own address.
    const snapshot = await context.service.getWorkspaceSnapshot();
    const job = findJob(snapshot, jobId);
    const applicationUrl = job?.applicationUrl ?? job?.canonicalUrl ?? null;
    const merged = saved.mergedJobIds.includes(jobId);
    const samePage =
      applicationUrl !== null && sameOrigin(applicationUrl, pageUrl);
    return {
      summary: [
        merged
          ? `This page is the same job as saved job ${jobId} (${job?.title ?? posting.title} at ${job?.company ?? posting.company}).`
          : `This page is ${posting.title} at ${posting.company}; saved as job ${jobId}.`,
        applicationUrl
          ? samePage
            ? `The application will run on this site (${applicationUrl}).`
            : `The application will run on ${applicationUrl}, not on this page (${pageUrl}).`
          : "The saved job has no application address.",
      ].join(" "),
      data: {
        jobId,
        title: job?.title ?? posting.title,
        company: job?.company ?? posting.company,
        mergedIntoExistingJob: merged,
        applicationUrl,
        applicationRunsOnThisPage: samePage,
      },
    };
  },
});

function sameOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.origin === b.origin &&
      a.pathname.split("/")[1] === b.pathname.split("/")[1]
    );
  } catch {
    return false;
  }
}

export const browserTools: AssistantToolDefinition[] = [
  ...FORWARDED,
  browserOpenTool,
  browserUseApplicationTool,
  browserFindTool,
  browserUploadTool,
  collectPageJobsTool,
  savePageJobsTool,
  applyHereTool,
];
