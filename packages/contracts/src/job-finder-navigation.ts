export const JOB_FINDER_SETTINGS_SECTIONS = {
  "app-device": { label: "App & device", tone: "default" },
  "ai-behavior": { label: "AI behavior", tone: "default" },
  "application-defaults": { label: "Resume look", tone: "default" },
  "application-authority": { label: "Applying", tone: "default" },
  diagnostics: { label: "Diagnostics", tone: "default" },
  "danger-zone": { label: "Delete everything", tone: "destructive" },
} as const;
export type JobFinderSettingsSection =
  keyof typeof JOB_FINDER_SETTINGS_SECTIONS;
export const JOB_FINDER_SETTINGS_SECTION_IDS = Object.keys(
  JOB_FINDER_SETTINGS_SECTIONS,
) as [JobFinderSettingsSection, ...JobFinderSettingsSection[]];
export const settingsSectionElementId = (section: JobFinderSettingsSection) =>
  `settings-${section}` as const;

// Plain values only: the window imports these at startup, and a module
// that imports zod would bring all of zod with it. Their schemas live in
// job-finder-navigation-schemas.ts.
export const RESUME_VIEW_MODES = ["read", "edit"] as const;
export type ResumeViewMode = (typeof RESUME_VIEW_MODES)[number];
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
        (RESUME_VIEW_MODES as readonly string[]).includes(value)),
  );
}

/** Explicit Assistant requests must reach a kept screen even when its URL repeats. */
export const ASSISTANT_NAVIGATION_STATE = {
  assistantNavigationRequest: true,
} as const;
export function isAssistantNavigationRequest(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "assistantNavigationRequest" in state &&
    state.assistantNavigationRequest === true
  );
}
