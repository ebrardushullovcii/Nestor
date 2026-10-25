import { resumeProposalPreview } from "../proposal-preview";
import type { AssistantHostPorts } from "../ports";
import {
  NonEmptyStringSchema,
  ResumeDraftPatchOperationSchema,
  TailoringModeSchema,
  type AssistantChangeEntry,
  type JobFinderResumeWorkspace,
  type JobFinderWorkspaceSnapshot,
  type ResumeDraft,
} from "@nestor/contracts";
import { z } from "zod";

import { AssistantEditConflictError } from "../../internal/workspace-assistant-edit-methods";
import {
  AssistantToolError,
  argText,
  defineTool,
  json,
  type AssistantToolContext,
} from "../tool-kit";
import { findJob, RESUME_ROUTE, plural, pausedByPersonMessage } from "./format";

const Id = NonEmptyStringSchema.max(200);
const OWNERSHIP_STATEMENT = "I confirm this content is accurate and my own.";

function compactDraft(draft: ResumeDraft, sectionId?: string | null) {
  return {
    draftId: draft.id,
    revision: draft.updatedAt,
    status: draft.status,
    templateId: draft.templateId,
    targetPageCount: draft.targetPageCount,
    language: draft.language ?? null,
    writtenLanguage: draft.writtenLanguage ?? null,
    sections: draft.sections
      .filter((section) => !sectionId || section.id === sectionId)
      .map((section) => ({
        id: section.id,
        kind: section.kind,
        label: section.label,
        included: section.included,
        locked: section.locked,
        text: section.text,
        bullets: section.bullets.map((bullet) => ({
          id: bullet.id,
          text: bullet.text,
          included: bullet.included,
          locked: bullet.locked,
        })),
        entries: section.entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          subtitle: entry.subtitle,
          dateRange: entry.dateRange,
          included: entry.included,
          summary: entry.summary,
          bullets: entry.bullets.map((bullet) => ({
            id: bullet.id,
            text: bullet.text,
            included: bullet.included,
            locked: bullet.locked,
          })),
        })),
      })),
  };
}

function linesToConfirm(workspace: JobFinderResumeWorkspace) {
  return (workspace.validation?.claimAssessments ?? [])
    .filter((assessment) => assessment.status === "confirm_needed")
    .map((assessment) => ({
      claimId: assessment.id,
      text: assessment.claimText,
      sectionId: assessment.sectionId,
      entryId: assessment.entryId,
      bulletId: assessment.bulletId,
    }));
}

/**
 * Lines the checker found no saved evidence for. They block approval and
 * cannot be kept as written, unlike Lines to confirm.
 */
function unsupportedLines(workspace: JobFinderResumeWorkspace) {
  return (workspace.validation?.claimAssessments ?? [])
    .filter((assessment) => assessment.status === "unsupported")
    .map((assessment) => ({
      claimId: assessment.id,
      text: assessment.claimText,
      sectionId: assessment.sectionId,
      entryId: assessment.entryId,
      bulletId: assessment.bulletId,
    }));
}

function resumeMode(
  workspace: JobFinderResumeWorkspace,
  originalDefault: boolean,
) {
  const mode =
    workspace.job.resumeApplicationMode ??
    (originalDefault ? "original_resume" : "tailored_per_job");
  return mode === "original_resume" ? "original" : "editable";
}

export const readResumeTool = defineTool({
  name: "read_resume",
  group: "resume",
  description:
    "Reads the resume draft for one job: sections, entries and bullets with ids, the revision to edit against, validation issues, lines waiting for the person's Keep or Remove, the page count and target, and whether the job sends the original file (Original) or an editable draft.",
  parameters: json.object(
    { jobId: json.string(), sectionId: json.string("Only this section.") },
    ["jobId"],
  ),
  input: z.object({ jobId: Id, sectionId: Id.optional() }),
  label: () => "Reading the resume",
  effect: "read",
  async execute(input, { service, session }) {
    const workspace = await service.getResumeWorkspace(input.jobId);
    const snapshot = await service.getWorkspaceSnapshot();
    const originalDefault =
      snapshot.settings.resumeApplicationMode === "original_resume";
    const issues = (workspace.validation?.issues ?? []).map((issue) => ({
      severity: issue.severity,
      message: issue.message,
      sectionId: issue.sectionId,
      entryId: issue.entryId,
      bulletId: issue.bulletId,
    }));
    const editor = session.context?.editor;
    const unsaved =
      editor?.editor === "resume" &&
      editor.jobId === input.jobId &&
      editor.hasUnsavedEdits;
    return {
      summary: `Resume for ${workspace.job.title} at ${workspace.job.company}: ${plural(workspace.draft.sections.length, "section")}, revision ${workspace.draft.updatedAt}.`,
      data: {
        job: {
          id: workspace.job.id,
          title: workspace.job.title,
          company: workspace.job.company,
        },
        mode: resumeMode(workspace, originalDefault),
        level:
          resumeMode(workspace, originalDefault) === "original"
            ? "original"
            : workspace.effectiveTailoringStrength,
        pageCount: workspace.validation?.pageCount ?? null,
        draft: compactDraft(workspace.draft, input.sectionId ?? null),
        issues: issues.slice(0, 30),
        linesToConfirm: linesToConfirm(workspace).slice(0, 30),
        unsupportedLines: unsupportedLines(workspace).slice(0, 30),
        ...(unsupportedLines(workspace).length > 0
          ? {
              unsupportedLinesNote:
                "Unsupported lines cannot be kept as written. Rewrite them from the profile's evidence or remove them with edit_resume, or, if the person confirms the fact, add it to the profile first with edit_profile and then regenerate that section.",
            }
          : {}),
        approved:
          resumeMode(workspace, originalDefault) === "editable" &&
          workspace.draft.status === "approved",
        approvedExportId: workspace.draft.approvedExportId,
        approvalRevision: workspace.draft.updatedAt,
        ...(unsaved
          ? {
              unsavedInEditor:
                "The person has unsaved edits in the resume editor. Edits you make are saved to the draft; tell them the editor will show your change after their own edits are saved or discarded.",
            }
          : {}),
        ...(editor?.editor === "resume" &&
        editor.jobId === input.jobId &&
        editor.selection
          ? { selection: editor.selection }
          : {}),
      },
    };
  },
});

const PatchInput = z.object({
  operation: ResumeDraftPatchOperationSchema,
  sectionId: Id,
  entryId: Id.nullable().optional(),
  bulletId: Id.nullable().optional(),
  anchorEntryId: Id.nullable().optional(),
  anchorBulletId: Id.nullable().optional(),
  position: z.enum(["before", "after"]).nullable().optional(),
  text: z.string().trim().min(1).max(4_000).nullable().optional(),
  included: z.boolean().nullable().optional(),
  locked: z.boolean().nullable().optional(),
});

function toPatch(patch: z.infer<typeof PatchInput>, at: string) {
  return {
    operation: patch.operation,
    targetSectionId: patch.sectionId,
    targetEntryId: patch.entryId ?? null,
    anchorEntryId: patch.anchorEntryId ?? null,
    targetBulletId: patch.bulletId ?? null,
    anchorBulletId: patch.anchorBulletId ?? null,
    position: patch.position ?? null,
    newText: patch.text ?? null,
    newIncluded: patch.included ?? null,
    newLocked: patch.locked ?? null,
    newBullets: null,
    conflictReason: null,
    appliedAt: at,
  };
}

/**
 * An explicit edit on an Original job switches that job to an editable
 * draft at the saved level (the upload and the global default stay as
 * they are), then the edit is applied.
 */
/**
 * What a committed resume change actually says now, read from the saved
 * change entries rather than from the model's own summary.
 */
export function describeSavedResumeChanges(
  changes: readonly { entries: readonly AssistantChangeEntry[] }[],
): string {
  const lines: string[] = [];
  for (const entry of changes.flatMap((change) => change.entries)) {
    const key = entry.path.at(-1) ?? "";
    const label = entry.label ?? entry.path.join(".");
    if (key === "origin" || key === "sourceRefs") continue;
    if (entry.kind === "remove") lines.push(`${label}: removed`);
    else if (typeof entry.after === "string")
      lines.push(`${label} now reads "${entry.after.slice(0, 240)}"`);
    else if (entry.kind === "insert") lines.push(`${label}: added`);
    else lines.push(`${label}: changed`);
  }
  return lines.length > 0
    ? lines.slice(0, 8).join("; ")
    : "no visible text changed";
}

async function ensureEditableJob(
  context: AssistantToolContext,
  jobId: string,
): Promise<string | null> {
  const snapshot = await context.service.getWorkspaceSnapshot();
  const job = snapshot.discoveryJobs
    .concat(snapshot.companyJobs)
    .find((entry) => entry.id === jobId);
  const mode =
    job?.resumeApplicationMode ??
    snapshot.settings.resumeApplicationMode ??
    "tailored_per_job";
  if (mode !== "original_resume") return null;
  const level =
    job?.resumeTailoringMode ?? snapshot.searchPreferences.tailoringMode;
  context.session.assertCurrent();
  await context.service.setJobResumeApplicationMode(
    jobId,
    "tailored_per_job",
    level,
  );
  return `This job used the original file, so it now uses an editable ${level === "conservative" ? "Light" : level === "balanced" ? "Tailored" : "Aggressive"} resume. Your uploaded file and the default are unchanged.`;
}

export const editResumeTool = defineTool({
  name: "edit_resume",
  group: "resume",
  description:
    "Makes targeted edits to one job's resume draft against the revision from read_resume: replace_section_text, replace_entry_summary, replace_entry_date_range (text restores factual date wording such as '(summers)' without changing startDate/endDate/isCurrent), insert_bullet (text, anchorBulletId/position), update_bullet, remove_bullet, move_bullet, move_entry, toggle_include, set_lock, reset_entry_order. mode apply commits all edits as one change with Undo; mode suggest leaves a proposal. Preserve seasonal qualifiers and use the person's words or saved evidence, never invent dates. For a large rewrite use revise_resume instead. An edit on an Original job switches that job to an editable draft at its saved level by itself; say so in a sentence, don't ask first. Report what the result says was saved, not what you intended.",
  parameters: json.object(
    {
      jobId: json.string(),
      revision: json.string("The draft revision you read."),
      summary: json.string(),
      mode: json.enumOf(["apply", "suggest"]),
      edits: json.array(
        json.object(
          {
            operation: json.enumOf([
              "replace_section_text",
              "replace_entry_summary",
              "replace_entry_date_range",
              "insert_bullet",
              "update_bullet",
              "remove_bullet",
              "move_bullet",
              "move_entry",
              "reset_entry_order",
              "toggle_include",
              "set_lock",
            ]),
            sectionId: json.string(),
            entryId: json.string(),
            bulletId: json.string(),
            anchorEntryId: json.string(),
            anchorBulletId: json.string(),
            position: json.enumOf(["before", "after"]),
            text: json.string(),
            included: json.boolean(),
            locked: json.boolean(),
          },
          ["operation", "sectionId"],
        ),
      ),
    },
    ["jobId", "summary", "edits"],
  ),
  input: z.object({
    jobId: Id,
    revision: z.string().max(200).nullable().optional(),
    summary: z.string().trim().min(1).max(300),
    mode: z.enum(["apply", "suggest"]).default("apply"),
    edits: z.array(PatchInput).min(1).max(40),
  }),
  label: (input) =>
    input.mode === "suggest"
      ? "Preparing suggested resume changes"
      : `Editing the resume: ${argText(input.summary).slice(0, 80)}`,
  effect: "local_write",
  async execute(input, context) {
    const { service, session, ports } = context;
    const at = session.now();
    const patches = input.edits.map((edit) => toPatch(edit, at));
    if (input.mode === "suggest") {
      const workspace = await service.getResumeWorkspace(input.jobId);
      const { proposal, part } = await session.createProposal({
        kind: "resume_patches",
        targetId: input.jobId,
        summary: input.summary,
        items: input.edits.map((edit, index) => ({
          id: `item_${index + 1}`,
          ...resumeProposalPreview(patches[index]!, workspace.draft),
          payload: patches[index],
        })),
        baseRevision: input.revision ?? null,
      });
      return {
        summary: `Suggested ${plural(patches.length, "change")}; nothing changes until the person accepts.`,
        data: { proposalId: proposal.id },
        parts: [part],
      };
    }
    const switched = await ensureEditableJob(context, input.jobId);
    session.assertCurrent();
    let result: Awaited<ReturnType<typeof service.applyAssistantResumePatches>>;
    try {
      result = await service.applyAssistantResumePatches({
        jobId: input.jobId,
        patches: patches.map((patch) => {
          const { appliedAt, ...rest } = patch;
          void appliedAt;
          return rest;
        }),
        expectedDraftUpdatedAt: switched ? null : (input.revision ?? null),
        summary: input.summary,
      });
    } catch (error) {
      if (error instanceof AssistantEditConflictError) {
        const workspace = await service.getResumeWorkspace(input.jobId);
        throw new AssistantToolError(
          error.kind === "stale_revision" ? "stale_revision" : "conflict",
          `${error.message}${switched ? ` (${switched})` : ""}`,
          error.kind === "stale_revision"
            ? { revision: workspace.draft.updatedAt }
            : undefined,
        );
      }
      if (error instanceof Error && /unable to find/iu.test(error.message)) {
        throw new AssistantToolError("invalid_input", error.message);
      }
      throw error;
    }
    const parts = [];
    let receiptId: string | null = null;
    for (const change of result.changes) {
      const recorded = await session.recordChange({
        target: change.target,
        targetId: change.targetId,
        summary: input.summary,
        entries: change.entries,
      });
      parts.push(recorded.part);
      receiptId = recorded.receipt.id;
    }
    ports.publishWorkspaceUpdate();
    return {
      summary: `Saved. ${describeSavedResumeChanges(result.changes)}.${switched ? ` ${switched}` : ""} New revision ${result.draftUpdatedAt}.`,
      data: { receiptId, revision: result.draftUpdatedAt },
      parts,
    };
  },
});

export const reviseResumeTool = defineTool({
  name: "revise_resume",
  group: "resume",
  description:
    "Hands a substantial rewrite to the resume revision specialist: tailor a section harder, cut to a page target, restructure. Give it an explicit brief with what the person asked. It returns checked, measured changes; mode apply commits them as one change with Undo, mode suggest leaves them for the person to accept.",
  parameters: json.object(
    {
      jobId: json.string(),
      brief: json.string("What to change and why, in full sentences."),
      mode: json.enumOf(["apply", "suggest"]),
    },
    ["jobId", "brief"],
  ),
  input: z.object({
    jobId: Id,
    brief: z.string().trim().min(1).max(4_000),
    mode: z.enum(["apply", "suggest"]).default("apply"),
  }),
  label: () => "Revising the resume",
  effect: "local_write",
  async execute(input, context) {
    const { service, session, ports } = context;
    const switched =
      input.mode === "apply"
        ? await ensureEditableJob(context, input.jobId)
        : null;
    const excerpt = (await session.searchConversation("", 6)).map((entry) => ({
      role: entry.role === "user" ? ("user" as const) : ("assistant" as const),
      content: entry.excerpt,
    }));
    const result = await service.runResumeRevisionSpecialist({
      jobId: input.jobId,
      brief: input.brief,
      recentExcerpt: excerpt,
    });
    if (result.patches.length === 0) {
      return {
        summary:
          `The specialist proposed no change. ${result.note} ${result.droppedNotes.join(" ")}`.trim(),
        status: "done",
      };
    }
    const blockers = result.approvalBlockers.map((blocker) => blocker.message);
    if (input.mode === "suggest") {
      const workspace = await service.getResumeWorkspace(input.jobId);
      const { proposal, part } = await session.createProposal({
        kind: "resume_patches",
        targetId: input.jobId,
        summary: input.brief.slice(0, 300),
        items: result.patches.map((patch, index) => ({
          id: `item_${index + 1}`,
          ...resumeProposalPreview(patch, workspace.draft),
          payload: patch,
        })),
        baseRevision: result.baseDraftUpdatedAt,
      });
      return {
        summary: `Suggested ${plural(result.patches.length, "change")}. ${result.note}`,
        data: { proposalId: proposal.id, approvalBlockers: blockers },
        parts: [part],
      };
    }
    session.assertCurrent();
    const applied = await service.applyAssistantResumeRevision({
      jobId: input.jobId,
      patches: result.patches,
      baseDraftUpdatedAt: result.baseDraftUpdatedAt,
      summary: input.brief.slice(0, 200),
    });
    const parts = [];
    let receiptId: string | null = null;
    for (const change of applied.changes) {
      const recorded = await session.recordChange({
        target: change.target,
        targetId: change.targetId,
        summary: input.brief.slice(0, 200),
        entries: change.entries,
      });
      parts.push(recorded.part);
      receiptId = recorded.receipt.id;
    }
    ports.publishWorkspaceUpdate();
    return {
      summary: `Saved. ${describeSavedResumeChanges(applied.changes)}. ${result.note}${switched ? ` ${switched}` : ""}`,
      data: {
        receiptId,
        revision: applied.draftUpdatedAt,
        linesNeedingTheirDecision: blockers,
      },
      parts,
    };
  },
});

export const setResumeLevelTool = defineTool({
  name: "set_resume_level",
  group: "resume",
  description:
    "Sets only named jobs' resume level: original, light, tailored or aggressive. It does not change the default for new jobs; use set_default_resume_level for that. For overlapping resume writing, pass level to generate_resumes so the change waits for the current writer.",
  parameters: json.object(
    {
      jobIds: json.ids(),
      level: json.enumOf(["original", "light", "tailored", "aggressive"]),
    },
    ["jobIds", "level"],
  ),
  input: z.object({
    jobIds: z.array(Id).min(1).max(50),
    level: z.enum(["original", "light", "tailored", "aggressive"]),
  }),
  label: (input) => `Setting the resume level to ${argText(input.level)}`,
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const tailoring =
      input.level === "light"
        ? TailoringModeSchema.enum.conservative
        : input.level === "tailored"
          ? TailoringModeSchema.enum.balanced
          : input.level === "aggressive"
            ? TailoringModeSchema.enum.aggressive
            : null;
    for (const jobId of input.jobIds) {
      session.assertCurrent();
      await service.setJobResumeApplicationMode(
        jobId,
        input.level === "original" ? "original_resume" : "tailored_per_job",
        tailoring,
      );
    }
    ports.publishWorkspaceUpdate();
    return {
      summary: `Set ${plural(input.jobIds.length, "job")} to ${input.level}.`,
    };
  },
});

export const generateResumesTool = defineTool({
  name: "generate_resumes",
  group: "resume",
  description:
    "Writes missing tailored resumes for the requested jobs, two at a time, in the background. Original jobs, completed drafts (unless regenerate or level is requested), and jobs in Applications are skipped and reported. Work overlapping a UI or assistant writer queues behind it; initial deterministic drafts are not completed rewrites. Pass language to translate an existing draft, headings and credentials together in one pass without regenerating it. With regenerate or level, the writer uses that language for the new draft. Pass level for a requested rewrite at a particular level; it is set only after earlier writers finish. Each job keeps its saved level and settings. The conversation continues when all are done. Stop or cancel_resumes prevents further jobs from starting; active drafts finish.",
  parameters: json.object(
    {
      jobIds: json.ids(),
      regenerate: json.boolean("Rewrite existing drafts from scratch."),
      language: json.string(
        "Language for the whole resume, such as German; preserves the chosen rewrite level.",
      ),
      level: json.enumOf(
        ["light", "tailored", "aggressive"],
        "Requested level for this batch; waits for earlier writers and rewrites existing drafts.",
      ),
    },
    ["jobIds"],
  ),
  input: z.object({
    jobIds: z.array(Id).min(1).max(100),
    regenerate: z.boolean().default(false),
    language: z.string().trim().min(1).max(120).optional(),
    level: z.enum(["light", "tailored", "aggressive"]).optional(),
  }),
  label: (input) =>
    `Writing ${plural(Array.isArray(input.jobIds) ? input.jobIds.length : 1, "resume")}`,
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    const snapshot = await service.getWorkspaceSnapshot();
    const paused = pausedByPersonMessage(
      snapshot.activityControl,
      "resume writing",
    );
    if (paused) throw new AssistantToolError("refused", paused);
    const skipped: ResumeBatchSkip[] = [];
    const requestedJobIds = [...new Set(input.jobIds)];
    const jobIds = requestedJobIds.filter((jobId) => {
      const reason = resumeBatchSkipReason(
        snapshot,
        jobId,
        input.regenerate || !!input.level || input.language !== undefined,
        undefined,
        input.level,
      );
      if (reason) skipped.push({ jobId, reason });
      return reason === null;
    });
    if (jobIds.length === 0) {
      return {
        summary: `No resumes started. ${describeResumeBatchSkips(skipped)}`,
        data: { jobIds: [], skipped },
      };
    }
    const runId = session.createId("resume_batch");
    const batch: BackgroundResumeBatch = {
      conversationId: session.conversationId,
      jobIds: requestedJobIds,
      startedAt: session.now(),
      done: false,
      cancelled: false,
      activeJobIds: new Set(),
      completedJobIds: [],
      failures: [],
      skipped: [...skipped],
      durationsMs: [],
    };
    const predecessors = [...backgroundBatches.values()].filter(
      (previous) => !previous.done,
    );
    backgroundBatches.set(runId, batch);
    const persist = () =>
      service.saveResumeBatchCheckpoint({
        id: runId,
        jobIds,
        activeJobIds: [...batch.activeJobIds],
        completedJobIds: [
          ...batch.completedJobIds,
          ...batch.skipped.map((entry) => entry.jobId),
        ],
        done: batch.done && !batch.cancelled,
        stopRequested: batch.cancelled,
        requests: jobIds.map((jobId) => ({
          jobId,
          regenerate: input.regenerate,
          ...(input.level ? { level: input.level } : {}),
          ...(input.language !== undefined ? { language: input.language } : {}),
        })),
        durationsMs: [...batch.durationsMs],
        running: !batch.done,
      });
    try {
      await persist();
    } catch (error) {
      backgroundBatches.delete(runId);
      throw error;
    }
    const queue = [...jobIds];
    const cancel = () => {
      batch.cancelled = true;
    };
    session.signal.addEventListener("abort", cancel, { once: true });
    if (session.signal.aborted) cancel();
    try {
      await session.watchRun(
        { kind: "resume_generation", id: runId, jobIds: requestedJobIds },
        `Writing resumes for ${plural(jobIds.length, "job")}`,
      );
      session.assertCurrent();
    } catch (error) {
      batch.cancelled = true;
      batch.done = true;
      session.signal.removeEventListener("abort", cancel);
      throw error;
    }
    const worker = async () => {
      while (queue.length > 0 && !batch.cancelled) {
        const jobId = queue.shift()!;
        let startedAt: number | null = null;
        try {
          // Earlier drafts may take minutes; dispatch under the latest saved
          // settings and application standing rather than the initial snapshot.
          // Only earlier writers are waited for: later batches wait for us.
          while (!batch.cancelled) {
            const ui = ports.readResumeBatch?.();
            const uiOwnsJob =
              ui &&
              !ui.done &&
              ui.jobIds.includes(jobId) &&
              (ui.activeJobIds.includes(jobId) ||
                (!ui.stopRequested && !ui.completedJobIds.includes(jobId)));
            const earlierOwnsJob = predecessors.some(
              (previous) =>
                !previous.done &&
                previous.jobIds.includes(jobId) &&
                !previous.skipped.some((entry) => entry.jobId === jobId) &&
                (!previous.cancelled || previous.activeJobIds.has(jobId)),
            );
            const latest = await service.getWorkspaceSnapshot();
            if (latest.activityControl.paused) batch.cancelled = true;
            const generating = latest.tailoredAssets.some(
              (asset) => asset.jobId === jobId && asset.status === "generating",
            );
            if (!uiOwnsJob && !earlierOwnsJob && !generating) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const current = await service.getWorkspaceSnapshot();
          if (current.activityControl.paused) batch.cancelled = true;
          if (batch.cancelled) return;
          const reason = resumeBatchSkipReason(
            current,
            jobId,
            input.regenerate || !!input.level || input.language !== undefined,
            runId,
            input.level,
          );
          if (reason) {
            batch.skipped.push({ jobId, reason });
            continue;
          }
          batch.activeJobIds.add(jobId);
          await persist();
          startedAt = Date.now();
          if (input.level) {
            await setResumeLevelTool.execute(
              { jobIds: [jobId], level: input.level },
              {
                service,
                ports,
                session: {
                  ...session,
                  assertCurrent: () => {
                    if (batch.cancelled)
                      throw new Error("Resume writing was stopped.");
                  },
                },
              },
            );
          }
          let translated: JobFinderWorkspaceSnapshot | null = null;
          if (
            input.language !== undefined &&
            !input.regenerate &&
            !input.level &&
            current.resumeDrafts.some((draft) => draft.jobId === jobId)
          ) {
            const workspace = await service.getResumeWorkspace(jobId);
            translated = await service.saveResumeDraft({
              ...workspace.draft,
              language: input.language,
            });
          }
          const generationArgs: [string, { language: string }?] =
            input.language !== undefined
              ? [jobId, { language: input.language }]
              : [jobId];
          const written =
            translated && !input.regenerate && !input.level
              ? translated
              : input.regenerate ||
                  input.level ||
                  current.resumeDrafts.some((draft) => draft.jobId === jobId)
                ? await service.regenerateResumeDraft(...generationArgs)
                : await service.generateResume(...generationArgs);
          const savedDraft = written.resumeDrafts.find(
            (draft) => draft.jobId === jobId,
          );
          if (!translated && savedDraft?.generationMethod !== "ai") {
            throw new Error(
              "The draft was saved, but the AI rewrite did not complete. Retry with generate_resumes regenerate true; do not call it a completed rewrite.",
            );
          }
          batch.completedJobIds.push(jobId);
          batch.durationsMs.push(Math.max(0, Date.now() - startedAt));
        } catch (error) {
          batch.failures.push(
            `${jobId}: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`,
          );
        } finally {
          batch.activeJobIds.delete(jobId);
          await persist();
          ports.publishWorkspaceUpdate();
        }
      }
    };
    void Promise.all([worker(), worker()])
      .finally(async () => {
        batch.done = true;
        session.signal.removeEventListener("abort", cancel);
        await persist();
        ports.publishWorkspaceUpdate();
      })
      .catch((error: unknown) => {
        batch.cancelled = true;
        batch.done = true;
        console.warn("Resume batch checkpoint could not be saved.", error);
        ports.publishWorkspaceUpdate();
      });
    return {
      summary: `Started writing ${plural(jobIds.length, "resume")} in the background (run ${runId}).${skipped.length ? ` ${describeResumeBatchSkips(skipped)}` : ""} This conversation continues when they are done.`,
      data: { runId, jobIds, skipped },
    };
  },
});

interface ResumeBatchSkip {
  jobId: string;
  reason: string;
}
interface BackgroundResumeBatch {
  conversationId: string;
  jobIds: string[];
  startedAt: string;
  done: boolean;
  cancelled: boolean;
  activeJobIds: Set<string>;
  completedJobIds: string[];
  failures: string[];
  skipped: ResumeBatchSkip[];
  durationsMs: number[];
}
/** Live scheduling state; durable checkpoints are saved by the service. */
const backgroundBatches = new Map<string, BackgroundResumeBatch>();

function resumeBatchSkipReason(
  snapshot: JobFinderWorkspaceSnapshot,
  jobId: string,
  regenerate: boolean,
  _ownRunId?: string,
  requestedLevel?: string,
): string | null {
  const job = findJob(snapshot, jobId);
  if (!job) return "job not found";
  if (
    !requestedLevel &&
    (job.resumeApplicationMode ?? snapshot.settings.resumeApplicationMode) ===
      "original_resume"
  )
    return "Original resume is unchanged";
  if (snapshot.applicationRecords.some((record) => record.jobId === jobId))
    return "already in Applications";
  if (
    !regenerate &&
    snapshot.resumeDrafts.some(
      (draft) =>
        draft.jobId === jobId &&
        (draft.generationMethod === "ai" ||
          draft.generationMethod === "manual"),
    )
  )
    return "resume already exists";
  return null;
}

function describeResumeBatchSkips(skipped: readonly ResumeBatchSkip[]): string {
  const byReason = new Map<string, number>();
  for (const item of skipped)
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  return `Skipped ${plural(skipped.length, "job")}: ${[...byReason].map(([reason, count]) => `${count} ${reason}`).join("; ")}.`;
}

export function readBackgroundBatch(id: string) {
  const batch = backgroundBatches.get(id);
  return batch ? { ...batch, activeJobIds: [...batch.activeJobIds] } : null;
}

export function cancelBackgroundBatch(id: string): void {
  const batch = backgroundBatches.get(id);
  if (batch) batch.cancelled = true;
}

export function listBackgroundResumeBatches() {
  return [...backgroundBatches.entries()]
    .filter(([, batch]) => !batch.done)
    .map(([id, batch]) => ({
      id,
      jobIds: batch.jobIds,
      activeJobIds: [...batch.activeJobIds],
      completedJobIds: batch.completedJobIds,
      done: batch.done,
      stopRequested: batch.cancelled,
    }));
}

export function stopResumeWork(ports: AssistantHostPorts) {
  const batches = [...backgroundBatches.values()].filter(
    (batch) => !batch.done,
  );
  for (const batch of batches) batch.cancelled = true;
  const uiBatch = ports.stopResumeBatch?.() ?? null;
  const active =
    batches.reduce((count, batch) => count + batch.activeJobIds.size, 0) +
    (uiBatch?.activeJobIds.length ?? 0);
  return {
    summary: `No further resume jobs will start. Completed drafts are kept.${active ? ` ${plural(active, "active draft")} will finish.` : ""}${!ports.stopResumeBatch ? " The UI resume queue could not be checked or stopped." : ""}`,
    data: {
      stoppedBatches: batches.length + (uiBatch ? 1 : 0),
      activeDrafts: active,
      uncheckedWork: ports.stopResumeBatch ? [] : ["UI resume queue"],
    },
  };
}

export const cancelResumesTool = defineTool({
  name: "cancel_resumes",
  group: "resume",
  description:
    "Stops all resume batches, including batches started from the UI, from starting more jobs. Completed drafts are kept and active drafts finish. Reports any work it could not stop; does not stop searches or applications.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Stopping new resume drafts",
  effect: "local_write",
  execute(_input, { session, ports }) {
    session.assertCurrent();
    const result = stopResumeWork(ports);
    ports.publishWorkspaceUpdate();
    return Promise.resolve(result);
  },
});

export const previewResumeTool = defineTool({
  name: "preview_resume",
  group: "resume",
  description:
    "Renders the current draft the way the application PDF will look and reports the page count and any render warnings.",
  parameters: json.object({ jobId: json.string() }, ["jobId"]),
  input: z.object({ jobId: Id }),
  label: () => "Checking how the resume renders",
  effect: "read",
  async execute(input, { service }) {
    const workspace = await service.getResumeWorkspace(input.jobId);
    const preview = await service.previewResumeDraft(workspace.draft);
    return {
      summary: `The resume renders to ${preview.metadata.pageCount ?? "an unknown number of"} page(s) (target ${workspace.draft.targetPageCount}).`,
      data: {
        pageCount: preview.metadata.pageCount,
        targetPageCount: workspace.draft.targetPageCount,
        warnings: preview.warnings
          .slice(0, 10)
          .map((warning) => warning.message),
      },
    };
  },
});

export const exportResumeTool = defineTool({
  name: "export_resume",
  group: "resume",
  description:
    "Builds the application PDF from the current draft and, when approve is true, approves it for applications (lines waiting for the person block approval). Aggressive resumes need the person's own approval.",
  parameters: json.object({ jobId: json.string(), approve: json.boolean() }, [
    "jobId",
  ]),
  input: z.object({ jobId: Id, approve: z.boolean().default(false) }),
  label: (input) =>
    input.approve
      ? "Exporting and approving the resume"
      : "Exporting the resume",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    try {
      await service.exportResumePdf(input.jobId, null);
    } catch (error) {
      if (
        error instanceof Error &&
        /still need your decision/iu.test(error.message)
      ) {
        throw new AssistantToolError(
          "missing_information",
          "Some lines in this resume still need the person's decision (Keep or Remove) before it can be exported.",
        );
      }
      throw error;
    }
    const workspace = await service.getResumeWorkspace(input.jobId);
    const latest = [...workspace.exports].sort((left, right) =>
      right.exportedAt.localeCompare(left.exportedAt),
    )[0];
    if (input.approve && latest) {
      if (workspace.effectiveTailoringStrength === "aggressive") {
        return {
          summary:
            "Exported. An Aggressive resume is approved by the person after reading it; it was not approved.",
          status: "refused",
          data: { exportId: latest.id },
        };
      }
      await service.approveResume(input.jobId, latest.id);
    }
    ports.publishWorkspaceUpdate();
    return {
      summary: `Exported${input.approve ? " and approved" : ""} the resume (${latest?.pageCount ?? "?"} pages).`,
      data: { exportId: latest?.id ?? null, route: RESUME_ROUTE(input.jobId) },
    };
  },
});

export const confirmResumeLineTool = defineTool({
  name: "confirm_resume_line",
  group: "resume",
  description:
    "Keeps one line under Lines to confirm with the person's ownership statement. Only when the person said to keep that exact line; to drop it, remove the bullet with edit_resume.",
  parameters: json.object(
    {
      jobId: json.string(),
      claimId: json.string("From read_resume linesToConfirm."),
    },
    ["jobId", "claimId"],
  ),
  input: z.object({ jobId: Id, claimId: Id }),
  label: () => "Keeping a line you confirmed",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const workspace = await service.getResumeWorkspace(input.jobId);
    const claim = workspace.validation?.claimAssessments.find(
      (assessment) => assessment.id === input.claimId,
    );
    if (claim?.status === "unsupported") {
      throw new AssistantToolError(
        "refused",
        "That line has no saved evidence behind it and cannot be kept as written. Rewrite or remove it with edit_resume, or add the fact to the profile first.",
      );
    }
    if (!claim || claim.status !== "confirm_needed") {
      throw new AssistantToolError(
        "not_found",
        "That line is not waiting for a decision.",
      );
    }
    session.assertCurrent();
    await service.setResumeClaimConfirmation({
      intent: "add",
      jobId: input.jobId,
      draftId: workspace.draft.id,
      expectedDraftUpdatedAt: workspace.draft.updatedAt,
      field: claim.field,
      sectionId: claim.sectionId,
      entryId: claim.entryId,
      bulletId: claim.bulletId,
      confirmedClaimContentHash: claim.contentHash as never,
      ownershipStatement: OWNERSHIP_STATEMENT,
    });
    ports.publishWorkspaceUpdate();
    return { summary: `Kept "${claim.claimText.slice(0, 120)}".` };
  },
});

export const setResumeTemplateTool = defineTool({
  name: "set_resume_template",
  group: "resume",
  description:
    "Changes the template or the page target of one job's resume. List templates with read_settings.",
  parameters: json.object(
    {
      jobId: json.string(),
      templateId: json.string(),
      targetPageCount: json.number("1 to 3."),
    },
    ["jobId"],
  ),
  input: z.object({
    jobId: Id,
    templateId: Id.optional(),
    targetPageCount: z.number().int().min(1).max(3).optional(),
  }),
  label: () => "Changing the resume layout",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const workspace = await service.getResumeWorkspace(input.jobId);
    session.assertCurrent();
    await service.saveResumeDraft({
      ...workspace.draft,
      ...(input.templateId
        ? { templateId: input.templateId as ResumeDraft["templateId"] }
        : {}),
      ...(input.targetPageCount
        ? { targetPageCount: input.targetPageCount }
        : {}),
    });
    ports.publishWorkspaceUpdate();
    const after = await service.getResumeWorkspace(input.jobId);
    const wasApproved = workspace.draft.status === "approved";
    const approvalCleared = wasApproved && after.draft.status !== "approved";
    return {
      summary: approvalCleared
        ? "Updated the resume layout. This cleared the resume's approval: it must be approved again before it is used for another application. Applications already sent keep the version they sent. Say this in your reply."
        : "Updated the resume layout.",
      data: { approved: after.draft.status === "approved", approvalCleared },
    };
  },
});

export const resumeTools = [
  readResumeTool,
  editResumeTool,
  reviseResumeTool,
  setResumeLevelTool,
  generateResumesTool,
  cancelResumesTool,
  previewResumeTool,
  exportResumeTool,
  confirmResumeLineTool,
  setResumeTemplateTool,
];
