import type { AssistantPersonalState } from "../store-reads";
import type { AssistantMessagePart } from "@nestor/contracts";
import {
  AiBehaviorPreferenceSchema,
  ApplicationAttestationKindSchema,
  ApplicationApplyModeSchema,
  CoverLetterPolicySchema,
  ProfileAssistantInitiativeSchema,
  ProfileAssistantReplyStyleSchema,
  UpdateAiBehaviorInputSchema,
  UpdateApplicationDefaultsInputSchema,
  UpdateWorkspaceBehaviorInputSchema,
  collapsesSideMenuWithAssistant,
  writesResumesOnShortlist,
  WrittenAnswerLengthSchema,
} from "@nestor/contracts";
import { z } from "zod";
import { defaultResumeLevelLabel } from "../prompt";
import { diffValues } from "../change-diff";
import type { AssistantToolContext } from "../tool-kit";
import { argText, AssistantToolError, defineTool, json } from "../tool-kit";
import { readAssistantWorkState } from "../work-state";

const SETTINGS_LABELS: Record<string, string> = {
  applicationAutomationMode: "Apply mode",
  resumeTemplateId: "Resume template",
  fontPreset: "Font",
  resumeApplicationMode: "Resume level",
  coverLetter: "Cover letters",
  aiBehavior: "AI behavior",
  keepSessionAlive: "Keep browser tabs after runs",
  discoveryOnly: "Search only",
  collapseSideMenuWithAssistant:
    "Collapse the side menu while the assistant is open",
  writeResumesOnShortlist: "Write resumes when I shortlist",
  tailoringMode: "Resume level",
  searchSelectivity: "Search selectivity",
};

/**
 * Settings writes go through the same narrow methods Settings uses, and the
 * before/after difference becomes the undo receipt.
 */
async function recordSettingsChange(
  context: AssistantToolContext,
  before: AssistantPersonalState,
  after: AssistantPersonalState,
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
        searchSelectivity: before.searchPreferences.searchSelectivity,
      },
      {
        tailoringMode: after.searchPreferences.tailoringMode,
        searchSelectivity: after.searchPreferences.searchSelectivity,
      },
      { labelFor },
    )
      .filter((entry) =>
        ["tailoringMode", "searchSelectivity"].includes(entry.path[0] ?? ""),
      )
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
    "Reads Settings: apply mode, template and font, cover letters, AI behavior and available resume templates. The default resume level belongs to Profile > Preferences.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Reading your settings",
  effect: "read",
  async execute(_input, { ports }) {
    const snapshot = await ports.readPersonalState();
    return {
      summary: `Apply mode ${snapshot.settings.applicationAutomationMode ?? "confirm_before_submit"}. Profile > Preferences resume level: ${defaultResumeLevelLabel(snapshot)}.`,
      data: {
        applyMode:
          snapshot.settings.applicationAutomationMode ??
          "confirm_before_submit",
        resumeLevel: defaultResumeLevelLabel(snapshot),
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
        writeResumesOnShortlist: writesResumesOnShortlist(snapshot.settings),
        activityPaused: snapshot.activityControl.paused ?? false,
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
    "Changes how applying works by default: fill and leave for the person's click (confirm_before_submit) or send for them (autonomous_submit), resume template, font, cover letter preference, or the default resume level (original_resume or tailored_per_job). Saved with Undo. Only when the person asks to change the default: to send applications they told you to send, use send_application and leave this alone.",
  parameters: json.object({
    applicationAutomationMode: json.enumOf(ApplicationApplyModeSchema.options),
    resumeTemplateId: json.string(),
    fontPreset: json.string(),
    resumeApplicationMode: json.enumOf(["tailored_per_job", "original_resume"]),
    coverLetter: json.looseObject(),
  }),
  input: UpdateApplicationDefaultsInputSchema,
  label: () => "Changing your applying settings",
  effect: "local_write",
  async execute(input, context) {
    const before = await context.ports.readPersonalState();
    context.session.assertCurrent();
    await context.service.updateApplicationDefaults(input);
    const after = await context.ports.readPersonalState();
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
    "Changes Settings › AI behavior and Applying writing: how much the assistant volunteers and how long it talks (aiBehavior.profileAssistant), Count remote jobs as any location (aiBehavior.jobSearch.remoteCountsAsAnyLocation: true or false), how applications are written (aiBehavior.applying), cover letters, and the resume approach (original_resume, conservative, balanced, aggressive). How picky a search is is not a setting; it is chosen on Find jobs before each search. Send only the fields to change; omitted fields and declaration approvals stay saved.",
  parameters: json.object({
    aiBehavior: json.object({
      profileAssistant: json.object({
        initiative: json.enumOf(ProfileAssistantInitiativeSchema.options),
        replyStyle: json.enumOf(ProfileAssistantReplyStyleSchema.options),
      }),
      jobSearch: json.object({
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
    const before = await context.ports.readPersonalState();
    context.session.assertCurrent();
    await context.service.updateAiBehavior(input);
    const after = await context.ports.readPersonalState();
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
    "Changes whether browser tabs stay open after runs, whether Job Finder only searches (never prepares applications), whether the left side menu folds to icons while this assistant sidebar is open (Settings > App & device), and whether a resume starts writing as soon as a job is shortlisted (Settings > AI behavior > Resumes). Send only the fields to change.",
  parameters: json.object({
    keepSessionAlive: json.boolean(),
    discoveryOnly: json.boolean(),
    collapseSideMenuWithAssistant: json.boolean(
      "On (the default) folds the side menu while the assistant is open.",
    ),
    writeResumesOnShortlist: json.boolean(
      "On (the default) starts writing a job's resume at its level as soon as it is shortlisted. Off leaves resumes for the person to create.",
    ),
  }),
  input: UpdateWorkspaceBehaviorInputSchema,
  label: () => "Changing workspace settings",
  effect: "local_write",
  async execute(input, context) {
    const before = await context.ports.readPersonalState();
    context.session.assertCurrent();
    await context.service.updateWorkspaceBehavior(input);
    const after = await context.ports.readPersonalState();
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
    const before = await context.ports.readPersonalState();
    context.session.assertCurrent();
    await context.service.updateAppearanceTheme(input.theme);
    const after = await context.ports.readPersonalState();
    const recorded = await recordSettingsChange(
      context,
      before,
      after,
      `Changed appearance to ${input.theme}`,
    );
    context.ports.publishWorkspaceUpdate();
    return {
      canFinish: true,
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
    const after = await ports.readPersonalState();
    const work = readAssistantWorkState(ports, after);
    // Applications already filling or sending finish; pausing stops the next.
    const finishing = input.paused
      ? (
          await Promise.all(
            (["running", "submitting"] as const).map((state) =>
              ports.readCommand("list_application_work", { state, limit: 1 }),
            ),
          )
        ).some((page) => page.rows.length > 0)
      : false;
    ports.publishWorkspaceUpdate();
    return {
      summary: input.paused
        ? `Background work is paused.${work.resumeImport.active ? " Resume import is still running; it was not stopped." : ""}${finishing ? " Current applications are still finishing." : ""}`
        : "Resumed.",
      data: {
        activityPaused: after.activityControl.paused,

        resumeImport: work.resumeImport,
      },
    };
  },
});

export const setDefaultResumeLevelTool = defineTool({
  name: "set_default_resume_level",
  group: "settings",
  description:
    "Sets Profile > Preferences > Resume level for newly shortlisted jobs: Original, Light, Tailored, Aggressive. Existing jobs keep their levels. Use for default requests; set_resume_level changes only named jobs. This setting is not in Settings.",
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
    const saved = await context.ports.readPersonalState();
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
      summary: `The saved default resume level in Profile > Preferences is ${actual[0]!.toUpperCase()}${actual.slice(1)}. Existing job choices are preserved.`,
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
];
