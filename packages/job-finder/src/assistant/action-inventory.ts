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
    channels: ["home:summary"],
    coverage: tools("get_workspace_summary"),
  },
  {
    id: "home.pause",
    screen: "Home",
    action: "Pause or resume Job Finder",
    channels: ["activity:feed"],
    coverage: tools("pause_activity"),
  },
  {
    id: "home.search_now",
    screen: "Home",
    action: "Search now",
    channels: ["jobs:run"],
    coverage: tools("start_search"),
  },

  // Profile
  {
    id: "profile.edit_fields",
    screen: "Profile",
    action: "Edit basics, headline, summary, contact, skills, target roles",
    channels: ["jobs:run"],
    coverage: tools("read_profile", "edit_profile", "undo_change"),
  },
  {
    id: "profile.edit_experience",
    screen: "Profile",
    action:
      "Add, edit, merge, split or remove work history, education, certifications",
    channels: ["jobs:run"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.edit_background",
    screen: "Profile",
    action: "Projects, links, languages, proof points",
    channels: ["jobs:run"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.edit_preferences",
    screen: "Profile",
    action:
      "Search preferences: roles, locations, work modes, pay, excluded places",
    channels: ["jobs:run"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.import_resume",
    screen: "Profile",
    action: "Import a resume",
    channels: [
      "profile-workflow:import-resume",
      "job-finder:cancel-import-resume",
      "profile-workflow:run",
    ],
    coverage: tools("import_resume"),
  },
  {
    id: "profile.import_review",
    screen: "Profile",
    action: "Keep, dismiss or clear an import suggestion",
    channels: ["profile-workflow:run"],
    coverage: tools("read_profile", "resolve_import_suggestion"),
  },
  {
    id: "profile.timeline_repair",
    screen: "Profile",
    action: "Accept or undo a work-history date repair",
    channels: ["profile-workflow:run"],
    coverage: tools("edit_profile"),
  },
  {
    id: "profile.setup_state",
    screen: "Setup",
    action: "Finish guided setup",
    channels: ["profile-workflow:run"],
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
    channels: ["profile-workflow:check-site", "profile-workflow:run"],
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
    channels: [],
    coverage: tools("edit_profile", "undo_change"),
  },

  // Find jobs: every row action is a job command (jobs:run).
  {
    id: "discovery.list",
    screen: "Find jobs",
    action: "Browse and filter found, hidden and shortlisted jobs",
    channels: [],
    coverage: tools("list_jobs", "get_job"),
  },
  {
    id: "discovery.search",
    screen: "Find jobs",
    action: "Search with a few choices, and follow it",
    channels: [],
    coverage: tools("start_search", "search_status"),
  },
  {
    id: "discovery.cancel",
    screen: "Find jobs",
    action: "Stop search",
    channels: [],
    coverage: tools("stop_search"),
  },
  {
    id: "discovery.shortlist",
    screen: "Find jobs",
    action: "Shortlist",
    channels: [],
    coverage: tools("move_jobs"),
  },
  {
    id: "discovery.dismiss",
    screen: "Find jobs",
    action: "Hide",
    channels: [],
    coverage: tools("move_jobs"),
  },
  {
    id: "discovery.restore",
    screen: "Find jobs",
    action: "Show again or move back to Find jobs",
    channels: [],
    coverage: tools("move_jobs"),
  },
  {
    id: "discovery.open_listing",
    screen: "Find jobs",
    action: "Open the listing",
    channels: ["browser:command"],
    coverage: tools("browser_open", "open_in_app"),
  },

  // Shortlisted and resumes
  {
    id: "shortlist.list",
    screen: "Shortlisted",
    action: "See shortlisted jobs and their resume state",
    channels: [],
    coverage: tools("list_jobs"),
  },
  {
    id: "shortlist.remove",
    screen: "Shortlisted",
    action: "Remove from shortlist",
    channels: ["jobs:run"],
    coverage: tools("move_jobs"),
  },
  // Store commands are shared with Shortlisted; their runtime tests exercise them over MCP.
  {
    id: "resume.commands",
    screen: "Shortlisted",
    action: "Read, edit, level, rewrite and approve a resume, with Undo",
    channels: ["resumes:run", "resumes:preview"],
    coverage: tools(
      "list_shortlisted",
      "get_resume",
      "save_resume",
      "edit_resume",
      "set_resume_level",
      "undo_resume_level",
      "undo_resume_change",
      "rewrite_resume",
      "approve_resume",
    ),
  },
  {
    id: "resume.export_pdf",
    screen: "Resume editor",
    action: "Export the saved resume as a PDF",
    channels: ["resumes:run", "resumes:export-pdf"],
    coverage: tools("export_resume_pdf"),
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
    channels: ["job-finder:send-application"],
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

  // Store commands are shared with Applications; their runtime tests exercise them over MCP.
  {
    id: "needs_you.answers",
    screen: "Needs you",
    action: "Add, read, edit and forget saved form answers",
    channels: ["needs-you:run"],
    coverage: tools(
      "create_form_answer",
      "upsert_form_answer",
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
    channels: ["jobs:run"],
    coverage: tools("update_ai_behavior"),
  },
  {
    id: "settings.applying",
    screen: "Settings",
    action: "Apply mode, template, font, letters",
    channels: ["jobs:run"],
    coverage: tools("update_apply_settings"),
  },
  {
    id: "settings.workspace",
    screen: "Settings",
    action:
      "Keep sessions, search only, collapse the side menu with the assistant",
    channels: ["jobs:run"],
    coverage: tools("update_workspace_behavior"),
  },
  {
    id: "settings.theme",
    screen: "Settings",
    action: "Appearance theme and text size",
    channels: ["jobs:run"],
    coverage: tools("set_appearance", "action_zoom"),
  },
  {
    id: "settings.diagnostics",
    screen: "Settings",
    action: "Export diagnostics, reset",
    channels: [
      "job-finder:export-diagnostics",
      "job-finder:reset-workspace",
      "job-finder:get-startup-reset-recovery",
    ],
    coverage: tools(
      "action_export_diagnostics",
      "action_reset_workspace",
      "action_reset_browser",
      "action_get_startup_reset_recovery",
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
    channels: ["browser:command"],
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
