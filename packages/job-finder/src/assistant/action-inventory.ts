import type { JobFinderWorkspaceService } from "../internal/workspace-service-contracts";

/**
 * Every visible Job Finder action and how the assistant reaches it (plan
 * §6.4). An entry maps to tools, or is excluded with a reason. The eval lane
 * holds an outcome test per mapped entry; `action-inventory.test.ts` checks
 * that every named tool exists and every desktop channel is listed.
 */

export type ActionCoverage =
  | { kind: "tools"; tools: readonly string[] }
  | { kind: "excluded"; reason: string };

export interface ActionInventoryEntry {
  id: string;
  screen: string;
  action: string;
  /** The desktop IPC channel the screen uses for it. */
  channels: readonly string[];
  coverage: ActionCoverage;
}

const tools = (...names: string[]): ActionCoverage => ({
  kind: "tools",
  tools: names,
});
const excluded = (reason: string): ActionCoverage => ({
  kind: "excluded",
  reason,
});

export const ACTION_INVENTORY: readonly ActionInventoryEntry[] = [
  // Home
  {
    id: "home.summary",
    screen: "Home",
    action: "See where the search stands",
    channels: [
      "job-finder:get-workspace",
      "job-finder:get-workspace-bootstrap",
      "job-finder:sync-workspace",
    ],
    coverage: tools("get_workspace_summary"),
  },
  {
    id: "home.pause",
    screen: "Home",
    action: "Pause or resume Job Finder",
    channels: ["job-finder:set-activity-control"],
    coverage: tools("pause_activity"),
  },
  {
    id: "home.search_now",
    screen: "Home",
    action: "Search now",
    channels: ["job-finder:run-agent-discovery", "job-finder:run-discovery"],
    coverage: tools("search_for_jobs"),
  },
  {
    id: "home.notifications",
    screen: "Home",
    action: "Mark plan notifications read",
    channels: [
      "job-finder:mark-campaign-notification-read",
      "job-finder:mark-all-campaign-notifications-read",
    ],
    coverage: excluded(
      "Reading notifications is presentation state of the bell, not work.",
    ),
  },

  // Profile
  {
    id: "profile.edit_fields",
    screen: "Profile",
    action: "Edit basics, headline, summary, contact, skills, target roles",
    channels: ["job-finder:save-profile", "job-finder:save-workspace-inputs"],
    coverage: tools("read_profile", "edit_profile", "undo_change"),
  },
  {
    id: "profile.edit_experience",
    screen: "Profile",
    action:
      "Add, edit, merge, split or remove work history, education, certifications",
    channels: ["job-finder:save-profile"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.edit_background",
    screen: "Profile",
    action: "Projects, links, languages, proof points, saved answers",
    channels: ["job-finder:save-profile"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.edit_preferences",
    screen: "Profile",
    action:
      "Search preferences: roles, locations, work modes, pay, excluded places",
    channels: [
      "job-finder:save-search-preferences",
      "job-finder:save-workspace-inputs",
    ],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.import_resume",
    screen: "Profile",
    action: "Import a resume",
    channels: [
      "job-finder:import-resume",
      "job-finder:cancel-import-resume",
      "job-finder:analyze-profile-from-resume",
    ],
    coverage: tools("import_resume"),
  },
  {
    id: "profile.import_review",
    screen: "Profile",
    action: "Keep, dismiss or clear an import suggestion",
    channels: ["job-finder:apply-profile-setup-review-action"],
    coverage: tools("read_profile", "resolve_import_suggestion"),
  },
  {
    id: "profile.timeline_repair",
    screen: "Profile",
    action: "Accept or undo a work-history date repair",
    channels: ["job-finder:apply-resume-timeline-repair-action"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.setup_state",
    screen: "Setup",
    action: "Finish guided setup",
    channels: ["job-finder:save-profile-setup-state"],
    coverage: tools("read_profile", "finish_profile_setup"),
  },
  {
    id: "profile.files",
    screen: "Profile › Files",
    action: "Add, list, restore or delete files",
    channels: [
      "job-finder:candidate-assets:import",
      "job-finder:candidate-assets:list",
      "job-finder:candidate-assets:restore",
      "job-finder:candidate-assets:delete",
    ],
    coverage: tools("list_documents", "read_document"),
  },
  {
    id: "profile.files_delete",
    screen: "Profile › Files",
    action: "Delete a file",
    channels: ["job-finder:candidate-assets:delete"],
    coverage: excluded("Deleting the person's files stays with the person."),
  },
  {
    id: "profile.sources",
    screen: "Profile › Sources",
    action: "Add sources, turn them on or off",
    channels: ["job-finder:save-search-preferences"],
    coverage: tools("list_sources", "update_sources"),
  },
  {
    id: "profile.source_check",
    screen: "Profile › Sources",
    action: "Check a source, review and accept learned instructions",
    channels: [
      "job-finder:run-source-debug",
      "job-finder:cancel-source-debug",
      "job-finder:get-source-debug-run",
      "job-finder:get-source-debug-run-details",
      "job-finder:list-source-debug-runs",
      "job-finder:save-source-instruction-artifact",
      "job-finder:accept-source-instruction-draft",
      "job-finder:verify-source-instructions",
    ],
    coverage: tools("check_source", "list_sources"),
  },
  {
    id: "profile.legacy_copilot",
    screen: "Profile",
    action: "Old Profile chat (retired)",
    channels: [
      "job-finder:send-profile-copilot-message",
      "job-finder:apply-profile-copilot-patch-group",
      "job-finder:reject-profile-copilot-patch-group",
      "job-finder:undo-profile-revision",
    ],
    coverage: tools("edit_profile", "undo_change"),
  },

  // Find jobs
  {
    id: "discovery.list",
    screen: "Find jobs",
    action: "Browse, filter and compare found jobs",
    channels: [],
    coverage: tools("query_jobs", "get_job", "compare_jobs", "read_result"),
  },
  {
    id: "discovery.search",
    screen: "Find jobs",
    action: "Search with a goal, breadth, freshness and sources",
    channels: ["job-finder:run-agent-discovery"],
    coverage: tools("search_for_jobs"),
  },
  {
    id: "discovery.cancel",
    screen: "Find jobs",
    action: "Stop search",
    channels: ["job-finder:cancel-discovery-run"],
    coverage: tools("cancel_search"),
  },
  {
    id: "discovery.judge_unjudged",
    screen: "Find jobs",
    action: "Judge fit for every job not judged yet",
    channels: ["job-finder:judge-unjudged-jobs"],
    coverage: excluded(
      "A long background pass over the whole list; the person starts it from Find jobs, and the assistant judges one listing with assess_job_listing.",
    ),
  },
  {
    id: "discovery.shortlist",
    screen: "Find jobs",
    action: "Shortlist",
    channels: ["job-finder:queue-job-for-review"],
    coverage: tools("shortlist_jobs"),
  },
  {
    id: "discovery.dismiss",
    screen: "Find jobs",
    action: "Hide a job with reasons",
    channels: ["job-finder:dismiss-discovery-job"],
    coverage: tools("dismiss_jobs"),
  },
  {
    id: "discovery.restore",
    screen: "Find jobs",
    action: "Restore a hidden job",
    channels: ["job-finder:restore-dismissed-discovery-job"],
    coverage: tools("restore_jobs"),
  },
  {
    id: "discovery.exclude_employer",
    screen: "Find jobs",
    action: "Exclude an employer, lift an exclusion",
    channels: [
      "job-finder:preview-employer-exclusion",
      "job-finder:remove-employer-exclusion",
    ],
    coverage: tools("exclude_employer", "include_employer"),
  },
  {
    id: "discovery.rapid_review",
    screen: "Quick review",
    action: "Keep, skip or undo in quick review",
    channels: ["job-finder:mutate-rapid-review"],
    coverage: tools("shortlist_jobs", "dismiss_jobs", "restore_jobs"),
  },
  {
    id: "discovery.open_listing",
    screen: "Find jobs",
    action: "Open the listing",
    channels: ["job-finder:open-browser-session"],
    coverage: tools("browser_open", "open_in_app"),
  },

  // Search plans
  {
    id: "campaigns.select",
    screen: "Search plans",
    action: "Switch the active plan",
    channels: ["job-finder:select-campaign"],
    coverage: tools("select_search_plan"),
  },
  {
    id: "campaigns.edit",
    screen: "Search plans",
    action: "Create or edit a named plan and its schedule",
    channels: ["job-finder:save-campaign"],
    coverage: tools("list_search_plans", "save_search_plan"),
  },
  {
    id: "campaigns.rules",
    screen: "Search plans",
    action: "Delete plans or edit their rules and funnel",
    channels: [
      "job-finder:delete-campaign",
      "job-finder:save-campaign-rule",
      "job-finder:delete-campaign-rule",
      "job-finder:toggle-campaign-rule",
      "job-finder:project-campaign-rule-funnel",
    ],
    coverage: excluded(
      "Plan deletion, rules and funnel editing still use Search plans; Undo can remove a plan just created in chat.",
    ),
  },
  {
    id: "campaigns.run_now",
    screen: "Search plans",
    action: "Run a plan now",
    channels: ["job-finder:run-campaign-now"],
    coverage: tools("search_for_jobs"),
  },

  // Shortlisted and resumes
  {
    id: "shortlist.list",
    screen: "Shortlisted",
    action: "See shortlisted jobs and their resume state",
    channels: [],
    coverage: tools("query_jobs"),
  },
  {
    id: "shortlist.remove",
    screen: "Shortlisted",
    action: "Remove from shortlist",
    channels: ["job-finder:remove-job-from-review"],
    coverage: tools("remove_from_shortlist"),
  },
  {
    id: "shortlist.level",
    screen: "Shortlisted",
    action: "Pick a resume level per job",
    channels: ["job-finder:set-job-resume-application-mode"],
    coverage: tools("set_resume_level"),
  },
  {
    id: "shortlist.create_resumes",
    screen: "Shortlisted",
    action: "Create missing resumes",
    channels: ["job-finder:generate-resume"],
    coverage: tools("generate_resumes"),
  },
  {
    id: "resume.read",
    screen: "Resume studio",
    action: "Read the draft, issues and lines to confirm",
    channels: ["job-finder:get-resume-workspace"],
    coverage: tools("read_resume"),
  },
  {
    id: "resume.edit",
    screen: "Resume studio",
    action: "Edit text, bullets, include or lock sections, reorder",
    channels: ["job-finder:apply-resume-patch", "job-finder:save-resume-draft"],
    coverage: tools("edit_resume", "undo_change"),
  },
  {
    id: "resume.revise",
    screen: "Resume studio",
    action: "Ask for a rewrite or a page target",
    channels: [
      "job-finder:send-resume-assistant-message",
      "job-finder:resolve-resume-assistant-proposal",
    ],
    coverage: tools("revise_resume"),
  },
  {
    id: "resume.regenerate",
    screen: "Resume studio",
    action: "Regenerate the draft or one section",
    channels: [
      "job-finder:regenerate-resume-draft",
      "job-finder:regenerate-resume-section",
    ],
    coverage: tools("generate_resumes"),
  },
  {
    id: "resume.preview",
    screen: "Resume studio",
    action: "Preview and page count",
    channels: ["job-finder:preview-resume-draft"],
    coverage: tools("preview_resume"),
  },
  {
    id: "resume.export_approve",
    screen: "Resume studio",
    action: "Export PDF and approve",
    channels: [
      "job-finder:export-resume-pdf",
      "job-finder:approve-resume",
      "job-finder:clear-resume-approval",
      "job-finder:reveal-saved-file",
    ],
    coverage: tools("export_resume"),
  },
  {
    id: "resume.lines_to_confirm",
    screen: "Resume studio",
    action: "Keep or remove a line to confirm",
    channels: ["job-finder:set-resume-claim-confirmation"],
    coverage: tools("confirm_resume_line", "edit_resume"),
  },
  {
    id: "resume.work_history_ack",
    screen: "Resume studio",
    action: "Acknowledge a work-history suggestion",
    channels: ["job-finder:set-work-history-review-acknowledgment"],
    coverage: excluded(
      "Acknowledging an intentional omission is a statement only the person makes.",
    ),
  },
  {
    id: "resume.template",
    screen: "Resume studio",
    action: "Change template or page target",
    channels: ["job-finder:save-resume-draft"],
    coverage: tools("set_resume_template"),
  },
  {
    id: "resume.history",
    screen: "Resume studio",
    action: "Restore a version, undo an AI edit",
    channels: [
      "job-finder:restore-resume-draft-revision",
      "job-finder:undo-resume-assistant-edit",
    ],
    coverage: tools("restore_resume_version", "undo_change"),
  },
  {
    id: "resume.legacy_chat",
    screen: "Resume studio",
    action: "Old resume Assistant (retired)",
    channels: ["job-finder:get-resume-assistant-messages"],
    coverage: tools("read_resume"),
  },
  {
    id: "resume.strategies",
    screen: "Resume approaches",
    action: "Save, select, disable or recommend resume approaches",
    channels: [
      "job-finder:save-resume-strategy",
      "job-finder:select-resume-strategy",
      "job-finder:disable-resume-strategy",
      "job-finder:recommend-resume-strategy",
      "job-finder:set-campaign-resume-strategy-default",
    ],
    coverage: excluded(
      "Named resume approaches are an advanced surface without a tool yet; logged as a gap.",
    ),
  },

  // Applications
  {
    id: "apply.queue",
    screen: "Shortlisted / Applications",
    action: "Queue the whole selection, pause, continue, stop or remove waiting jobs",
    channels: [
      "job-finder:start-apply-queue",
      "job-finder:control-apply-queue",
      "job-finder:remove-from-apply-queue",
      "job-finder:approve-resumes",
    ],
    coverage: excluded("Durable queue controls and bulk approval are missing from the assistant."),
  },
  {
    id: "apply.move_back",
    screen: "Applications",
    action: "Move an unsent application back to Shortlisted, or undo the move",
    channels: [
      "job-finder:return-application-to-shortlist",
      "job-finder:undo-return-application-to-shortlist",
    ],
    coverage: excluded("The assistant cannot yet move an application back."),
  },
  {
    id: "apply.reopen",
    screen: "Applications",
    action: "Read kept page state and reopen a closed application page",
    channels: [
      "job-finder:get-application-page-states",
      "job-finder:reopen-application-page",
    ],
    coverage: excluded("Page recovery is missing from the assistant."),
  },
  {
    id: "apply.start",
    screen: "Shortlisted / Applications",
    action: "Apply, Apply to all, Try again",
    channels: [
      "job-finder:start-auto-apply-queue-run",
      "job-finder:start-auto-apply-run",
      "job-finder:start-apply-copilot-run",
      "job-finder:approve-apply",
    ],
    coverage: tools(
      "record_instruction",
      "apply_to_jobs",
      "continue_application",
    ),
  },
  {
    id: "apply.send",
    screen: "Applications",
    action: "Send a filled-in application",
    channels: [
      "job-finder:send-prepared-applications",
      "job-finder:submit-prepared-application",
    ],
    coverage: tools("record_instruction", "send_applications"),
  },
  {
    id: "apply.cancel",
    screen: "Applications",
    action: "Stop a batch",
    channels: [
      "job-finder:cancel-apply-run",
      "job-finder:revoke-apply-run-approval",
    ],
    coverage: tools("cancel_applications"),
  },
  {
    id: "apply.approve_run",
    screen: "Applications",
    action: "Approve a waiting run or consent",
    channels: [
      "job-finder:approve-apply-run",
      "job-finder:resolve-apply-consent-request",
    ],
    coverage: tools("apply_to_jobs"),
  },
  {
    id: "apply.details",
    screen: "Applications",
    action: "See questions, answers, blocker",
    channels: ["job-finder:get-apply-run-details"],
    coverage: tools("get_application", "list_applications"),
  },
  {
    id: "apply.answer",
    screen: "Applications / Needs you",
    action: "Answer a question, clear an answer",
    channels: [
      "job-finder:save-application-answer",
      "job-finder:clear-application-answer",
    ],
    coverage: tools("answer_application_question", "resolve_needs_you"),
  },
  {
    id: "apply.open_page",
    screen: "Applications",
    action: "Open the kept page",
    channels: ["job-finder:focus-prepared-application-page"],
    coverage: tools("continue_application"),
  },
  {
    id: "apply.packet",
    screen: "Applications",
    action: "Export the application packet",
    channels: ["job-finder:export-application-packet"],
    coverage: excluded(
      "Writing files to a chosen folder stays a person's action for now.",
    ),
  },
  {
    id: "apply.documents",
    screen: "Applications",
    action: "Propose, edit, approve or export a letter",
    channels: [
      "job-finder:list-application-documents",
      "job-finder:propose-application-document",
      "job-finder:approve-application-document",
      "job-finder:edit-application-document",
      "job-finder:export-application-document",
    ],
    coverage: excluded(
      "Application letters are written by the apply agent; editing them from the sidebar is a logged gap.",
    ),
  },
  {
    id: "apply.authority",
    screen: "Settings / Applications",
    action: "Sending permissions and answer approval",
    channels: [
      "job-finder:get-application-authority-readiness",
      "job-finder:approve-current-application-answers",
      "job-finder:list-application-authority-envelopes",
      "job-finder:get-application-authority-envelope",
      "job-finder:create-application-authority-envelope",
      "job-finder:update-application-authority-envelope",
      "job-finder:revoke-application-authority-envelope",
    ],
    coverage: tools(
      "record_instruction",
      "update_instruction",
      "update_apply_settings",
    ),
  },
  {
    id: "apply.uncertain",
    screen: "Applications",
    action: "Resolve an uncertain send after checking the employer site",
    channels: ["job-finder:resolve-submission-outcome"],
    coverage: excluded(
      "Only the person can check the employer's site; the two-step confirmation stays theirs (ADR 0012).",
    ),
  },

  // Needs you
  {
    id: "needs_you.list",
    screen: "Needs you",
    action: "See steps waiting",
    channels: [],
    coverage: tools("list_needs_you"),
  },
  {
    id: "needs_you.act",
    screen: "Needs you",
    action: "Answer, open the page, mark done, skip",
    channels: ["job-finder:perform-user-action"],
    coverage: tools("resolve_needs_you"),
  },
  {
    id: "needs_you.grouped",
    screen: "Needs you",
    action: "Answer a grouped question once for many",
    channels: [
      "job-finder:project-grouped-manual-answer",
      "job-finder:apply-grouped-manual-answer",
      "job-finder:snooze-grouped-decision",
    ],
    coverage: tools("resolve_needs_you"),
  },

  // Tracking
  {
    id: "tracking.stage",
    screen: "Applications",
    action: "Stage, notes, reminders, tags, interviews",
    channels: ["job-finder:mutate-application-crm"],
    coverage: tools("update_tracking"),
  },
  {
    id: "tracking.bulk",
    screen: "Applications",
    action: "Move several to a stage",
    channels: ["job-finder:mutate-application-crm-bulk-stage"],
    coverage: tools("set_stage_for_applications"),
  },
  {
    id: "tracking.outcome",
    screen: "Outcomes",
    action: "Record an outcome",
    channels: [
      "job-finder:record-outcome",
      "job-finder:set-outcome-suggestion-enabled",
    ],
    coverage: tools("record_outcome"),
  },
  {
    id: "tracking.export",
    screen: "Applications",
    action: "Export the tracker",
    channels: ["job-finder:export-application-crm"],
    coverage: tools("export_tracker"),
  },
  {
    id: "tracking.no_response",
    screen: "Settings",
    action: "No-response automation",
    channels: [
      "job-finder:run-application-no-response-automation",
      "job-finder:update-tracker-crm",
    ],
    coverage: excluded(
      "Runs by itself on Settings changes; tracker settings are a logged gap.",
    ),
  },

  // Companies
  {
    id: "companies.preference",
    screen: "Companies",
    action: "Follow, prefer or exclude a company",
    channels: ["job-finder:set-company-preference"],
    coverage: tools("set_company_preference", "search_workspace"),
  },
  {
    id: "companies.intelligence",
    screen: "Companies",
    action: "Notes, contacts, merges, refresh",
    channels: [
      "job-finder:mutate-company-intelligence",
      "job-finder:review-company-merge",
      "job-finder:refresh-company-intelligence",
    ],
    coverage: excluded("Company notes and merges are a logged gap."),
  },

  // Settings
  {
    id: "settings.read",
    screen: "Settings",
    action: "See settings",
    channels: [],
    coverage: tools("read_settings"),
  },
  {
    id: "settings.ai_behavior",
    screen: "Settings",
    action: "AI behavior section",
    channels: ["job-finder:update-ai-behavior"],
    coverage: tools("update_ai_behavior"),
  },
  {
    id: "settings.applying",
    screen: "Settings",
    action: "Apply mode, daily limit, template, font, letters",
    channels: [
      "job-finder:update-application-defaults",
      "job-finder:save-settings",
    ],
    coverage: tools("update_apply_settings"),
  },
  {
    id: "settings.workspace",
    screen: "Settings",
    action:
      "Keep sessions, search only, collapse the side menu with the assistant",
    channels: ["job-finder:update-workspace-behavior"],
    coverage: tools("update_workspace_behavior"),
  },
  {
    id: "settings.theme",
    screen: "Settings",
    action: "Appearance theme",
    channels: ["job-finder:update-appearance-theme"],
    coverage: tools("set_appearance"),
  },
  {
    id: "settings.safeguards",
    screen: "Safeguards",
    action: "Review and change safeguards",
    channels: ["job-finder:mutate-safeguards"],
    coverage: excluded(
      "Safeguards limit the assistant itself; the person changes them.",
    ),
  },
  {
    id: "settings.diagnostics",
    screen: "Settings",
    action: "Export diagnostics, performance, reset",
    channels: [
      "job-finder:export-diagnostics",
      "job-finder:get-performance-snapshot",
      "job-finder:reset-workspace",
      "job-finder:get-startup-reset-recovery",
      "job-finder:get-startup-database-recovery",
      "job-finder:dismiss-startup-database-recovery-notice",
    ],
    coverage: excluded(
      "Maintenance and destructive reset stay with the person.",
    ),
  },
  {
    id: "settings.clipboard",
    screen: "Anywhere",
    action: "Copy text",
    channels: ["job-finder:write-clipboard-text"],
    coverage: excluded("Copying is a presentation convenience."),
  },

  // Browser
  {
    id: "browser.work",
    screen: "Browser",
    action:
      "Look, read, click, type, choose, scroll, go back, upload, open popups",
    channels: [
      "job-finder:open-browser-session",
      "job-finder:check-browser-session",
    ],
    coverage: tools(
      "browser_observe",
      "browser_read_text",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_set_checkbox",
      "browser_press_key",
      "browser_scroll",
      "browser_go_back",
      "browser_wait",
      "browser_navigate",
      "browser_follow_link",
      "browser_open",
      "browser_find",
      "browser_upload",
    ),
  },
  {
    id: "browser.collect",
    screen: "Browser",
    action: "Collect the jobs on a page, save the ones wanted",
    channels: [],
    coverage: tools("collect_page_jobs", "save_page_jobs"),
  },
  {
    id: "browser.apply_here",
    screen: "Browser",
    action: "Apply on this link",
    channels: [],
    coverage: tools("apply_here", "record_instruction", "apply_to_jobs"),
  },
];

/**
 * Secondary lint (plan §6.4): every workspace-service method is mapped to a
 * tool or marked internal. Typed as an exhaustive record, so a new service
 * method fails to compile until someone decides.
 */
export const SERVICE_METHOD_COVERAGE: Record<
  keyof JobFinderWorkspaceService,
  string
> = {
  refreshApprovedApplicationLetter: "internal",
  assessJobListing: "assess_job_listing",
  judgeUnjudgedJobs: "internal",
  saveUserActionAnswerDraft: "internal",
  withWorkspaceRestore: "internal",
  shutdown: "internal",
  saveResumeBatchCheckpoint: "internal",
  getWorkspaceSnapshot: "get_workspace_summary",
  getWorkspaceProjection: "internal",
  getApplicationDocumentContext: "internal",
  removeJobsFromReview: "internal",
  getWorkspaceBootstrap: "internal",
  getResumeImportState: "internal",
  openBrowserSession: "browser_open",
  checkBrowserSession: "internal",
  performUserAction: "resolve_needs_you",
  projectGroupedManualAnswer: "internal",
  applyGroupedManualAnswer: "resolve_needs_you",
  snoozeGroupedDecision: "internal",
  saveApplicationAnswer: "answer_application_question",
  clearApplicationAnswer: "internal",
  continueApplicationsWaitingForFiles: "internal",
  resetWorkspace: "internal",
  saveProfile: "edit_profile",
  saveProfileAndSearchPreferences: "edit_profile",
  runResumeImport: "import_resume",
  analyzeProfileFromResume: "import_resume",
  saveSearchPreferences: "update_sources",
  saveProfileSetupState: "finish_profile_setup",
  applyProfileSetupReviewAction: "resolve_import_suggestion",
  applyResumeTimelineRepairAction: "edit_profile",
  sendProfileCopilotMessage: "internal (retired chat)",
  proposeProfileCopilotChange: "internal (retired chat)",
  applyProfileCopilotPatchGroup:
    "internal (retired chat proposals, via resolve proposal)",
  rejectProfileCopilotPatchGroup:
    "internal (retired chat proposals, via resolve proposal)",
  undoProfileRevision: "undo_change",
  saveSettings: "update_apply_settings",
  updateApplicationDefaults: "update_apply_settings",
  updateWorkspaceBehavior: "update_workspace_behavior",
  updateAiBehavior: "update_ai_behavior",
  updateTrackerCrm: "internal",
  updateAppearanceTheme: "internal",
  saveCampaign: "internal",
  selectCampaign: "select_search_plan",
  deleteCampaign: "internal",
  setActivityControl: "pause_activity",
  runDiscovery: "search_for_jobs",
  runAgentDiscovery: "search_for_jobs",
  runDiscoveryForTarget: "search_for_jobs",
  cancelDiscoveryRun: "cancel_search",
  runCampaignNow: "search_for_jobs",
  runDueScheduledCampaigns: "internal",
  processDueScheduledCampaigns: "internal",
  markCampaignNotificationRead: "internal",
  markAllCampaignNotificationsRead: "internal",
  saveCampaignRule: "internal",
  deleteCampaignRule: "internal",
  toggleCampaignRule: "internal",
  projectCampaignRuleFunnel: "internal",
  runSourceDebug: "check_source",
  cancelSourceDebug: "internal",
  getSourceDebugRun: "internal",
  getSourceDebugRunDetails: "internal",
  listSourceDebugRuns: "list_sources",
  saveSourceInstructionArtifact: "internal",
  acceptSourceInstructionDraft: "internal",
  verifySourceInstructions: "internal",
  queueJobForReview: "shortlist_jobs",
  queueJobsForReview: "shortlist_jobs",
  setJobResumeApplicationMode: "set_resume_level",
  removeJobFromReview: "remove_from_shortlist",
  dismissDiscoveryJob: "dismiss_jobs",
  dismissDiscoveryJobs: "dismiss_jobs",
  excludeEmployerDiscoveryJobs: "exclude_employer",
  previewEmployerExclusion: "exclude_employer",
  removeEmployerExclusion: "include_employer",
  restoreDismissedDiscoveryJob: "restore_jobs",
  restoreDismissedDiscoveryJobs: "restore_jobs",
  mutateRapidReview: "shortlist_jobs",
  recordOutcome: "record_outcome",
  refreshCompanyIntelligence: "internal",
  setCompanyPreference: "set_company_preference",
  reviewCompanyMerge: "internal",
  mutateCompanyIntelligence: "internal",
  setOutcomeSuggestionEnabled: "internal",
  mutateSafeguards: "internal",
  getSafeguardsOverview: "internal",
  evaluateApplicationSafeguardBlockers: "internal",
  evaluateDiscoverySafeguardBlockers: "internal",
  saveResumeStrategy: "internal",
  disableResumeStrategy: "internal",
  selectResumeStrategy: "internal",
  recommendResumeStrategy: "internal",
  setCampaignResumeStrategyDefault: "internal",
  generateResume: "generate_resumes",
  generateResumeForBatch: "internal (Shortlisted bounded generation pipeline)",
  getResumeWorkspace: "read_resume",
  previewResumeDraft: "preview_resume",
  saveResumeDraft: "set_resume_template",
  restoreResumeDraftRevision: "restore_resume_version",
  undoResumeAssistantEdit: "undo_change",
  regenerateResumeDraft: "generate_resumes",
  regenerateResumeSection: "generate_resumes",
  exportResumePdf: "export_resume",
  approveResume: "export_resume",
  approveCurrentResume: "internal (bulk resume approval)",
  clearResumeApproval: "internal",
  setWorkHistoryReviewAcknowledgment: "internal",
  setResumeClaimConfirmation: "confirm_resume_line",
  applyResumePatch: "edit_resume",
  getResumeAssistantMessages: "internal (retired chat, archived)",
  getResumeAssistantHistory: "internal (read-only retired chat migration)",
  sendResumeAssistantMessage: "internal (retired chat)",
  resolveResumeAssistantProposal:
    "internal (retired chat proposals, via resolve proposal)",
  getApplyRunDetails: "get_application",
  writeApplicationDocumentText:
    "internal (drafts for Applications › Documents; the apply agent writes the letter it sends)",
  buildApplicationPacket: "internal",
  startApplyCopilotRun: "apply_to_jobs",
  startAutoApplyRun: "apply_to_jobs",
  startAutoApplyQueueRun: "apply_to_jobs",
  approveApplyRun: "apply_to_jobs",
  cancelApplyRun: "cancel_applications",
  resolveApplyConsentRequest: "internal",
  returnApplicationToShortlist: "internal",
  undoReturnApplicationToShortlist: "internal",
  revokeApplyRunApproval: "cancel_applications",
  inspectPreparedApplicationPage: "browser_use_application",
  focusPreparedApplicationPage: "continue_application",
  recordApplicationsSentByPerson: "internal",
  submitPreparedApplication: "send_applications",
  approveApply: "apply_to_jobs",
  recordLiveAssistantApplicationAction: "internal",
  mutateApplicationCrm: "update_tracking",
  mutateApplicationCrmBulkStage: "set_stage_for_applications",
  runApplicationNoResponseAutomation: "internal",
  exportApplicationCrm: "export_tracker",
  applyAssistantProfileOperations: "edit_profile",
  undoAssistantProfileChange: "undo_change",
  undoAssistantSettingsChange: "undo_change",
  applyAssistantResumePatches: "edit_resume",
  applyAssistantResumeRevision: "revise_resume",
  undoAssistantResumeChange: "undo_change",
  extractJobsFromPageText: "collect_page_jobs",
  addJobFromBrowserPage: "save_page_jobs",
  saveJobsFromPage: "save_page_jobs",
  runResumeRevisionSpecialist: "revise_resume",
};
