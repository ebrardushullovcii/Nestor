import {
  PROFILE_SETUP_PLACEHOLDER_HEADLINE,
  PROFILE_SETUP_PLACEHOLDER_LOCATION,
  PROFILE_SETUP_PLACEHOLDER_SUMMARY,
  type JobSource,
  type SourceDebugPhase,
} from "@nestor/contracts";

// Profile placeholder strings - canonical definitions live in contracts.
// These aliases remain for legacy-workspace detection in import reconciliation.
export const PROFILE_PLACEHOLDER_HEADLINE = PROFILE_SETUP_PLACEHOLDER_HEADLINE;
export const PROFILE_PLACEHOLDER_LOCATION = PROFILE_SETUP_PLACEHOLDER_LOCATION;
export const PROFILE_PLACEHOLDER_SUMMARY = PROFILE_SETUP_PLACEHOLDER_SUMMARY;

// Agent discovery defaults
export const DEFAULT_ROLE = "software engineer";
export const DEFAULT_TARGET_JOB_COUNT = 100;
export const DEFAULT_MAX_STEPS = 60;
export const DEFAULT_MAX_TARGET_ROLES = 4;
export const DEFAULT_DISCOVERY_HISTORY_LIMIT = 5;
export const LEGACY_DEFAULT_TARGET_STARTING_URL =
  "https://www.linkedin.com/jobs/search/";
export const SOURCE_DEBUG_PROMPT_PROFILE_VERSION = "source-debug-v1";
export const SOURCE_DEBUG_TOOLSET_VERSION = "browser-tools-v1";
export const SOURCE_DEBUG_APP_SCHEMA_VERSION = "job-finder-source-debug-v1";
export const SOURCE_DEBUG_RECENT_HISTORY_LIMIT = 5;
export const LEGACY_DEFAULT_TARGET_ID = "target_linkedin_default";
export const LEGACY_DEFAULT_TARGET_LABEL = "LinkedIn Jobs";
export const GENERIC_DEFAULT_TARGET_LABEL = "Primary target";
export const SOURCE_DEBUG_PHASES: SourceDebugPhase[] = [
  "access_auth_probe",
  "site_structure_mapping",
  "search_filter_probe",
  "job_detail_validation",
  "apply_path_validation",
  "replay_verification",
];

export interface ResolvedDiscoveryAdapter {
  kind: JobSource;
  label: string;
  experimental: boolean;
  siteInstructions: string[];
  toolUsageNotes: string[];
  relevantUrlSubstrings: string[];
}

export const discoveryAdapters: Record<JobSource, ResolvedDiscoveryAdapter> = {
  target_site: {
    kind: "target_site",
    label: "Target site",
    experimental: false,
    siteInstructions: [
      "Stay within the configured hostname and do not roam to third-party domains unless the target explicitly hands off to a first-party jobs surface.",
      "Prefer repeatable job-list routes, canonical detail pages, and visible search or filter controls over one-off landing-page promos.",
      "Use visible controls before handcrafted URL parameters when the interface already exposes a reusable search path.",
      "Keep the result set small and high confidence when the page structure is unstable or identity signals are weak.",
    ],
    toolUsageNotes: [
      "Use navigation sparingly and stay bounded to the configured hostname.",
      "Favor explicit careers, jobs, openings, positions, or hiring routes when they exist.",
      "Test obvious visible search boxes, chips, dropdowns, and top-level filters before concluding the site has no reusable controls.",
      "Skip saving low-confidence results that do not expose a stable job identity.",
    ],
    relevantUrlSubstrings: [
      "/job",
      "/jobs",
      "/career",
      "/careers",
      "/opening",
      "/openings",
      "/position",
      "/positions",
      "/vacancy",
      "/vacancies",
      "/konkurs",
      "/pune",
      "/pozit",
      "/karriere",
      "/apliko",
    ],
  },
};
