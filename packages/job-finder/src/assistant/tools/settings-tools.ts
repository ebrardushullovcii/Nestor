import { readAssistantWorkState } from "../work-state";
import { stopResumeWork } from "./resume-tools";
import {
  AiBehaviorPreferenceSchema,
  ApplicationAttestationKindSchema,
  ApplicationAutomationModeSchema,
  CompanyPreferenceSchema,
  CoverLetterPolicySchema,
  JobSearchSelectivitySchema,
  NonEmptyStringSchema,
  ProfileAssistantInitiativeSchema,
  ProfileAssistantReplyStyleSchema,
  UpdateAiBehaviorInputSchema,
  UpdateApplicationDefaultsInputSchema,
  UpdateWorkspaceBehaviorInputSchema,
  WrittenAnswerLengthSchema,
  collapsesSideMenuWithAssistant,
  type AssistantMessagePart,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { z } from "zod";

import { diffValues } from "../change-diff";
import {
  AssistantToolError,
  argText,
  defineTool,
  json,
  type AssistantToolContext,
} from "../tool-kit";

const Id = NonEmptyStringSchema.max(200);

const SETTINGS_LABELS: Record<string, string> = {
  applicationAutomationMode: "Apply mode",
  maxApplicationsPerLocalDay: "Daily application limit",
  resumeTemplateId: "Resume template",
  fontPreset: "Font",
  resumeApplicationMode: "Resume level",
  coverLetter: "Cover letters",
  aiBehavior: "AI behavior",
  keepSessionAlive: "Keep browser tabs after runs",
  discoveryOnly: "Search only",
  collapseSideMenuWithAssistant:
    "Collapse the side menu while the assistant is open",
  tailoringMode: "Resume level",
  discovery: "Search selectivity",
};

/**
 * Settings writes go through the same narrow methods Settings uses, and the
 * before/after difference becomes the undo receipt.
 */
async function recordSettingsChange(
  context: AssistantToolContext,
  before: JobFinderWorkspaceSnapshot,
  after: JobFinderWorkspaceSnapshot,
  summary: string,
): Promise<{ parts: AssistantMessagePart[]; receiptId: string | null }> {
  const labelFor = (path: readonly string[]) =>
    SETTINGS_LABELS[path[0] ?? ""] ?? null;
  const entries = [
    ...diffValues(before.settings, after.settings, { labelFor }).map(
      (entry) => ({
        ...entry,
        path: ["settings", ...entry.path],
      }),
    ),
    ...diffValues(
      {
        tailoringMode: before.searchPreferences.tailoringMode,
        discovery:
          before.searchPreferences.discovery.collectOnlyHardCriteriaMatches,
      },
      {
        tailoringMode: after.searchPreferences.tailoringMode,
        discovery:
          after.searchPreferences.discovery.collectOnlyHardCriteriaMatches,
      },
      { labelFor },
    )
      .filter((entry) => entry.path[0] === "tailoringMode")
      .map((entry) => ({
        ...entry,
        path: ["search_preferences", ...entry.path],
      })),
  ];
  if (entries.length === 0) return { parts: [], receiptId: null };
  const recorded = await context.session.recordChange({
    target: "settings",
    targetId: null,
    summary,
    entries,
  });
  return { parts: [recorded.part], receiptId: recorded.receipt.id };
}

export const readSettingsTool = defineTool({
  name: "read_settings",
  group: "settings",
  description:
    "Reads Settings: apply mode and daily limit, resume level, template and font, cover letters, AI behavior, search plans and the resume templates available.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Reading your settings",
  effect: "read",
  async execute(_input, { service }) {
    const snapshot = await service.getWorkspaceSnapshot();
    return {
      summary: `Apply mode ${snapshot.settings.applicationAutomationMode ?? "prepare_only"}, resume level ${snapshot.settings.resumeApplicationMode === "original_resume" ? "original" : snapshot.searchPreferences.tailoringMode}.`,
      data: {
        applyMode:
          snapshot.settings.applicationAutomationMode ?? "prepare_only",
        dailyLimit: snapshot.settings.maxApplicationsPerLocalDay ?? 20,
        resumeLevel:
          snapshot.settings.resumeApplicationMode === "original_resume"
            ? "original_resume"
            : snapshot.searchPreferences.tailoringMode,
        resumeTemplateId: snapshot.settings.resumeTemplateId,
        fontPreset: snapshot.settings.fontPreset,
        coverLetter: snapshot.settings.coverLetter,
        aiBehavior: AiBehaviorPreferenceSchema.parse(
          snapshot.settings.aiBehavior ?? {},
        ),
        keepSessionAlive: snapshot.settings.keepSessionAlive,
        discoveryOnly: snapshot.settings.discoveryOnly,
        collapseSideMenuWithAssistant: collapsesSideMenuWithAssistant(
          snapshot.settings,
        ),
        activityPaused: snapshot.activityControl.paused ?? false,
        searchPlans: snapshot.campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          active: campaign.id === snapshot.activeCampaignId,
        })),
        templates: snapshot.availableResumeTemplates.map((template) => ({
          id: template.id,
          label: template.label,
          density: template.density,
        })),
      },
    };
  },
});

export const updateApplySettingsTool = defineTool({
  name: "update_apply_settings",
  group: "settings",
  description:
    "Changes how applying works by default: apply mode (prepare_only, confirm_before_submit, autonomous_submit), daily limit, resume template, font, cover letter preference, or the default resume level (original_resume or tailored_per_job). Saved with Undo. Only when the person asks to change the default: to send applications they told you to send, use send_applications and leave this alone.",
  parameters: json.object({
    applicationAutomationMode: json.enumOf(
      ApplicationAutomationModeSchema.options,
    ),
    maxApplicationsPerLocalDay: json.number(),
    resumeTemplateId: json.string(),
    fontPreset: json.string(),
    resumeApplicationMode: json.enumOf(["tailored_per_job", "original_resume"]),
    coverLetter: json.looseObject(),
  }),
  input: UpdateApplicationDefaultsInputSchema,
  label: () => "Changing your applying settings",
  effect: "local_write",
  async execute(input, context) {
    const before = await context.service.getWorkspaceSnapshot();
    context.session.assertCurrent();
    const after = await context.service.updateApplicationDefaults(input);
    const recorded = await recordSettingsChange(
      context,
      before,
      after,
      "Changed applying settings",
    );
    context.ports.publishWorkspaceUpdate();
    return {
      summary: recorded.receiptId
        ? "Saved the applying settings."
        : "Nothing changed.",
      data: { receiptId: recorded.receiptId, savedSettings: after.settings },
      parts: recorded.parts,
    };
  },
});

export const updateAiBehaviorTool = defineTool({
  name: "update_ai_behavior",
  group: "settings",
  description:
    "Changes Settings › AI behavior: how much the assistant volunteers and how long it talks (aiBehavior.profileAssistant), How picky a search is (aiBehavior.jobSearch.selectivity: best_matches, balanced, wide_net), Count remote jobs as any location (aiBehavior.jobSearch.remoteCountsAsAnyLocation: true or false), how applications are written (aiBehavior.applying), cover letters, and the resume approach (original_resume, conservative, balanced, aggressive). Cast a wide net is selectivity wide_net. Send only the fields to change; omitted fields and declaration approvals stay saved.",
  parameters: json.object({
    aiBehavior: json.object({
      profileAssistant: json.object({
        initiative: json.enumOf(ProfileAssistantInitiativeSchema.options),
        replyStyle: json.enumOf(ProfileAssistantReplyStyleSchema.options),
      }),
      jobSearch: json.object({
        selectivity: json.enumOf(JobSearchSelectivitySchema.options),
        remoteCountsAsAnyLocation: json.boolean(
          "Count remote jobs as any location. false requires a listing to match a saved place even when it is remote.",
        ),
      }),
      applying: json.object({
        coverLetterPolicy: json.enumOf(CoverLetterPolicySchema.options),
        writtenAnswerLength: json.enumOf(WrittenAnswerLengthSchema.options),
        preApprovedDeclarations: json.array(
          json.enumOf(ApplicationAttestationKindSchema.options),
        ),
      }),
    }),
    coverLetter: json.looseObject(),
    resumeApproach: json.enumOf([
      "original_resume",
      "conservative",
      "balanced",
      "aggressive",
    ]),
  }),
  input: UpdateAiBehaviorInputSchema,
  label: () => "Changing AI behavior settings",
  effect: "local_write",
  async execute(input, context) {
    const before = await context.service.getWorkspaceSnapshot();
    context.session.assertCurrent();
    const after = await context.service.updateAiBehavior(input);
    const recorded = await recordSettingsChange(
      context,
      before,
      after,
      "Changed AI behavior",
    );
    context.ports.publishWorkspaceUpdate();
    return {
      summary: recorded.receiptId ? "Saved AI behavior." : "Nothing changed.",
      data: {
        receiptId: recorded.receiptId,
        aiBehavior: AiBehaviorPreferenceSchema.parse(
          after.settings.aiBehavior ?? {},
        ),
        resumeApplicationMode: after.settings.resumeApplicationMode,
        resumeApproach:
          after.settings.resumeApplicationMode === "original_resume"
            ? "original_resume"
            : after.searchPreferences.tailoringMode,
      },
      parts: recorded.parts,
    };
  },
});

export const updateWorkspaceBehaviorTool = defineTool({
  name: "update_workspace_behavior",
  group: "settings",
  description:
    "Changes whether browser tabs stay open after runs, whether Job Finder only searches (never prepares applications), and whether the left side menu folds to icons while this assistant sidebar is open (Settings > App & device). Send only the fields to change.",
  parameters: json.object({
    keepSessionAlive: json.boolean(),
    discoveryOnly: json.boolean(),
    collapseSideMenuWithAssistant: json.boolean(
      "On (the default) folds the side menu while the assistant is open.",
    ),
  }),
  input: UpdateWorkspaceBehaviorInputSchema,
  label: () => "Changing workspace settings",
  effect: "local_write",
  async execute(input, context) {
    const before = await context.service.getWorkspaceSnapshot();
    context.session.assertCurrent();
    const after = await context.service.updateWorkspaceBehavior(input);
    const recorded = await recordSettingsChange(
      context,
      before,
      after,
      `Changed ${
        Object.entries(input)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) =>
            typeof value === "boolean"
              ? `${SETTINGS_LABELS[key] ?? key}: ${value ? "on" : "off"}`
              : (SETTINGS_LABELS[key] ?? key),
          )
          .join(", ") || "workspace settings"
      }`,
    );
    context.ports.publishWorkspaceUpdate();
    return {
      summary: "Saved.",
      data: { receiptId: recorded.receiptId },
      parts: recorded.parts,
    };
  },
});

export const setAppearanceTool = defineTool({
  name: "set_appearance",
  group: "settings",
  description:
    "Sets the app's appearance, as Settings > App & device does: light, dark, or follow the system.",
  parameters: json.object({ theme: json.enumOf(["light", "dark", "system"]) }, [
    "theme",
  ]),
  input: z.object({ theme: z.enum(["light", "dark", "system"]) }),
  label: (input) => `Switching to ${argText(input.theme)} appearance`,
  effect: "local_write",
  async execute(input, context) {
    const before = await context.service.getWorkspaceSnapshot();
    context.session.assertCurrent();
    const after = await context.service.updateAppearanceTheme(input.theme);
    const recorded = await recordSettingsChange(
      context,
      before,
      after,
      `Changed appearance to ${input.theme}`,
    );
    context.ports.publishWorkspaceUpdate();
    return {
      summary: `Appearance is now ${after.settings.appearanceTheme}.`,
      data: { receiptId: recorded.receiptId },
      parts: recorded.parts,
    };
  },
});

export const pauseActivityTool = defineTool({
  name: "pause_activity",
  group: "settings",
  description:
    "Pauses or resumes all background Job Finder work (searches, applications, resume queues), like Home's Pause. finishCurrent lets running work finish first. The pause is the person's brake: resume only when they ask to resume, or when they answer yes after you asked, never just because another request needs it.",
  parameters: json.object(
    {
      paused: json.boolean(),
      finishCurrent: json.boolean(),
      reason: json.string(),
    },
    ["paused"],
  ),
  input: z.object({
    paused: z.boolean(),
    finishCurrent: z.boolean().default(false),
    reason: z.string().trim().max(500).optional(),
  }),
  label: (input) =>
    input.paused ? "Pausing Job Finder" : "Resuming Job Finder",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    await service.setActivityControl({
      paused: input.paused,
      reason: input.reason ?? null,
      ...(input.finishCurrent
        ? { pauseBehavior: "finish_current" as const }
        : {}),
    });
    const resumes = input.paused ? stopResumeWork(ports) : null;
    const after = await service.getWorkspaceSnapshot();
    const work = readAssistantWorkState(ports, after);
    ports.publishWorkspaceUpdate();
    return {
      summary: input.paused
        ? `Background work is paused. ${resumes?.summary}${work.resumeImport.active ? " Resume import is still running; it was not stopped." : ""}${after.activeDiscoveryRun?.state === "running" ? " The current search is still finishing." : ""}${after.applyRuns.some((run) => run.state === "running") ? " Current applications are still finishing." : ""}${after.activeSourceDebugRun?.state === "running" ? " The source check is still running; it was not stopped." : ""}`
        : "Resumed.",
      data: {
        activityPaused: after.activityControl.paused,
        resumes: resumes?.data ?? null,
        finishingSearch:
          after.activeDiscoveryRun?.state === "running"
            ? after.activeDiscoveryRun.id
            : null,
        finishingApplications: after.applyRuns
          .filter((run) => run.state === "running")
          .map((run) => ({ id: run.id, jobIds: run.jobIds })),
        resumeImport: work.resumeImport,
      },
    };
  },
});

export const selectSearchPlanTool = defineTool({
  name: "select_search_plan",
  group: "settings",
  description:
    "Makes one search plan the active one (the plan Find jobs shows and searches use).",
  parameters: json.object({ campaignId: json.string() }, ["campaignId"]),
  input: z.object({ campaignId: Id }),
  label: () => "Switching the search plan",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    await service.selectCampaign(input.campaignId);
    ports.publishWorkspaceUpdate();
    return { summary: "Switched the active search plan." };
  },
});

export const setCompanyPreferenceTool = defineTool({
  name: "set_company_preference",
  group: "settings",
  description:
    "Marks a company as followed, preferred, to review, excluded or neutral.",
  parameters: json.object(
    {
      companyId: json.string("From search_workspace."),
      preference: json.enumOf(CompanyPreferenceSchema.options),
    },
    ["companyId", "preference"],
  ),
  input: z.object({ companyId: Id, preference: CompanyPreferenceSchema }),
  label: () => "Updating a company preference",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    try {
      await service.setCompanyPreference(input);
    } catch (error) {
      throw new AssistantToolError(
        "invalid_input",
        error instanceof Error
          ? error.message
          : "That company could not be updated.",
      );
    }
    ports.publishWorkspaceUpdate();
    return { summary: `Company marked ${input.preference}.` };
  },
});

export const setDefaultResumeLevelTool = defineTool({
  name: "set_default_resume_level",
  group: "settings",
  description:
    "Sets Settings > AI behavior > Default resume approach for newly shortlisted jobs. Existing jobs keep their overrides. Use for default requests; set_resume_level changes only named jobs.",
  parameters: json.object(
    { level: json.enumOf(["original", "light", "tailored", "aggressive"]) },
    ["level"],
  ),
  input: z.object({
    level: z.enum(["original", "light", "tailored", "aggressive"]),
  }),
  label: () => "Changing the default resume approach",
  effect: "local_write",
  async execute(input, context) {
    const approach = {
      original: "original_resume",
      light: "conservative",
      tailored: "balanced",
      aggressive: "aggressive",
    } as const;
    const result = await updateAiBehaviorTool.execute(
      { resumeApproach: approach[input.level] },
      context,
    );
    const saved = await context.service.getWorkspaceSnapshot();
    const actual =
      saved.settings.resumeApplicationMode === "original_resume"
        ? "original"
        : saved.searchPreferences.tailoringMode === "conservative"
          ? "light"
          : saved.searchPreferences.tailoringMode === "aggressive"
            ? "aggressive"
            : "tailored";
    if (actual !== input.level)
      throw new AssistantToolError(
        "conflict",
        "The saved default does not match the requested resume approach. Read Settings before reporting success.",
      );
    return {
      ...result,
      summary: `The saved default resume approach is ${actual}. Existing job choices are preserved.`,
      data: {
        ...(result.data as Record<string, unknown>),
        defaultResumeLevel: actual,
      },
    };
  },
});

export const settingsTools = [
  setDefaultResumeLevelTool,
  setAppearanceTool,
  readSettingsTool,
  updateApplySettingsTool,
  updateAiBehaviorTool,
  updateWorkspaceBehaviorTool,
  pauseActivityTool,
  selectSearchPlanTool,
  setCompanyPreferenceTool,
];
