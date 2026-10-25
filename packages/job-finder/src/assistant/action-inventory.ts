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
    coverage: tools(
      "list_documents",
      "read_document",
      "action_candidate_assets_import",
      "action_candidate_assets_open",
      "action_candidate_assets_restore",
      "action_candidate_assets_list",
    ),
  },
  {
    id: "profile.files_delete",
    screen: "Profile › Files",
    action: "Delete a file",
    channels: ["job-finder:candidate-assets:delete"],
    coverage: tools("action_candidate_assets_delete"),
  },
  {
    id: "profile.sources",
    screen: "Profile › Sources",
    action: "Add sources, turn them on or off",
    channels: ["jobs:run"],
    coverage: tools(
      "list_sites",
      "get_site",
      "add_sites",
      "update_site",
      "remove_site",
      "set_sites_enabled",
      "undo_site_change",
    ),
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
    coverage: tools(
      "check_source",
      "get_site",
      "action_cancel_source_debug",
      "action_get_source_debug_run_details",
      "action_list_source_debug_runs",
      "action_save_source_instruction_artifact",
      "action_accept_source_instruction_draft",
      "action_verify_source_instructions",
    ),
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
    coverage: tools("action_judge_unjudged_jobs", "assess_job_listing"),
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
    id: "discovery.open_listing",
    screen: "Find jobs",
    action: "Open the listing",
    channels: ["job-finder:open-browser-session"],
    coverage: tools("browser_open", "open_in_app"),
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
    coverage: tools(
      "export_resume",
      "action_approve_resume",
      "action_clear_resume_approval",
      "action_reveal_saved_file",
    ),
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
    coverage: tools("action_set_work_history_review_acknowledgment"),
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

  // Apply's shared store commands; tracker statuses have their own catalog.
  {
    id: "apply.work",
    screen: "Shortlisted / Applications",
    action:
      "Apply to one, selected, page or all approved jobs; read, open or stop work",
    channels: [
      "job-finder:apply-jobs",
      "job-finder:list-applications",
      "job-finder:applications-for-jobs",
      "job-finder:get-application-details",
      "job-finder:open-application",
      "job-finder:stop-application",
    ],
    coverage: tools(
      "record_instruction",
      "apply_to_jobs",
      "list_application_work",
      "applications_for_jobs",
      "get_application_details",
      "open_application",
      "stop_application",
    ),
  },
  {
    id: "apply.send",
    screen: "Applications",
    action: "Send a ready form under the person's instruction and send guards",
    channels: ["job-finder:send-prepared-applications"],
    coverage: tools("record_instruction", "send_application"),
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
      "action_get_application_authority_readiness",
      "action_approve_current_application_answers",
      "action_list_application_authority_envelopes",
      "action_get_application_authority_envelope",
      "action_create_application_authority_envelope",
      "action_update_application_authority_envelope",
      "action_revoke_application_authority_envelope",
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
    coverage: tools("action_resolve_submission_outcome"),
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
    action: "Answer once, open the page and check completed browser steps",
    channels: ["needs-you:run"],
    coverage: tools("answer_need", "open_need", "check_need"),
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

  // Store commands are shared with Applications; their runtime tests exercise them over MCP.
  {
    id: "needs_you.answers",
    screen: "Needs you",
    action: "Add, read, edit and forget saved form answers",
    channels: ["needs-you:run"],
    coverage: tools(
      "create_form_answer",
      "list_form_answers",
      "get_form_answer",
      "save_form_answer",
      "forget_form_answers",
    ),
  },
  {
    id: "tracking.commands",
    screen: "Applications",
    action: "Status, history, tags, saved views, export and per-change Undo",
    channels: ["tracker:run", "tracker:export"],
    coverage: tools(
      "list_applications",
      "get_application",
      "set_status",
      "add_event",
      "update_event",
      "delete_event",
      "set_tags",
      "save_view",
      "delete_view",
      "export_applications",
      "undo_tracker_change",
      "list_tracker_agenda",
    ),
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
    action: "Apply mode, template, font, letters",
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
    action: "Appearance theme and text size",
    channels: ["job-finder:update-appearance-theme"],
    coverage: tools("set_appearance", "action_zoom"),
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
    coverage: tools(
      "action_export_diagnostics",
      "action_get_performance_snapshot",
      "action_reset_workspace",
      "action_reset_browser",
      "action_get_startup_reset_recovery",
      "action_get_startup_database_recovery",
      "action_dismiss_startup_database_recovery_notice",
      "action_export_personal_workspace",
      "action_preview_personal_workspace_restore",
      "action_confirm_personal_workspace_restore",
    ),
  },
  {
    id: "settings.clipboard",
    screen: "Anywhere",
    action: "Copy text",
    channels: ["job-finder:write-clipboard-text"],
    coverage: tools("action_write_clipboard_text"),
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
