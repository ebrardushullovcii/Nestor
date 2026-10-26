// IPC channel names, kept apart from the schemas of what they carry so the
// preload can name its channels without building those schemas. The modules
// the channels belong to re-export them.

export const LAUNCH_CONTEXT_CHANNEL = "launch:context";
export const HOME_SUMMARY_CHANNEL = "home:summary";

export const JOBS_RUN_CHANNEL = "jobs:run";
export const JOBS_CHANGED_CHANNEL = "jobs:changed";
export const JOBS_SEARCH_STATUS_CHANNEL = "jobs:search-status";
/** A window asks once to hear changes and search progress. */
export const JOBS_SUBSCRIBE_CHANNEL = "jobs:subscribe";

export const RESUMES_RUN_CHANNEL = "resumes:run";
export const RESUMES_PREVIEW_CHANNEL = "resumes:preview";
export const RESUMES_EXPORT_PDF_CHANNEL = "resumes:export-pdf";

export const NEEDS_YOU_RUN_CHANNEL = "needs-you:run";

export const TRACKER_RUN_CHANNEL = "tracker:run";
export const TRACKER_EXPORT_CHANNEL = "tracker:export";
