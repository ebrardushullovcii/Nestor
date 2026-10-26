import { z } from "zod";

export const JOB_FINDER_SETTINGS_SECTIONS = {
  "app-device": { label: "App & device", tone: "default" },
  "ai-behavior": { label: "AI behavior", tone: "default" },
  "application-defaults": { label: "Resume look", tone: "default" },
  "application-authority": { label: "Applying", tone: "default" },
  "workspace-behavior": { label: "Browser & saved jobs", tone: "default" },
  diagnostics: { label: "Diagnostics", tone: "default" },
  "danger-zone": { label: "Delete everything", tone: "destructive" },
} as const;
export type JobFinderSettingsSection =
  keyof typeof JOB_FINDER_SETTINGS_SECTIONS;
export const JOB_FINDER_SETTINGS_SECTION_IDS = Object.keys(
  JOB_FINDER_SETTINGS_SECTIONS,
) as [JobFinderSettingsSection, ...JobFinderSettingsSection[]];
export const JobFinderSettingsSectionSchema = z.enum(
  JOB_FINDER_SETTINGS_SECTION_IDS,
);
export const settingsSectionElementId = (section: JobFinderSettingsSection) =>
  `settings-${section}` as const;

export const RESUME_VIEW_MODES = ["read", "edit"] as const;
export const ResumeViewModeSchema = z.enum(RESUME_VIEW_MODES);
export type ResumeViewMode = z.infer<typeof ResumeViewModeSchema>;
const resumeModeLabels = { read: "Resume", edit: "Edit" } as const;
export const RESUME_VIEW_MODE_OPTIONS = RESUME_VIEW_MODES.map((value) => ({
  value,
  label: resumeModeLabels[value],
}));

/** The renderer consumes resumeMode after applying it; its acknowledgment must still check pane visibility. */
export function matchesJobFinderNavigationSearch(
  expected: URL,
  actual: URL,
): boolean {
  return [...expected.searchParams].every(
    ([key, value]) =>
      actual.searchParams.get(key) === value ||
      (expected.pathname === "/job-finder/review-queue" &&
        key === "resumeMode" &&
        !actual.searchParams.has(key) &&
        ResumeViewModeSchema.safeParse(value).success),
  );
}
