import { createHash } from "node:crypto";
import {
  ASSISTANT_JOB_COMMANDS,
  ASSISTANT_RESUME_COMMANDS,
  assistantJobListPage,
  assistantJobCounts,
  readAssistantJobs,
  countAssistantJobs,
  createResumeCommandReads,
  createResumeCommandRunner,
  createResumeService,
  type ResumeService,
} from "@nestor/job-finder/resumes";
import { createTrackerCommandRunner } from "@nestor/job-finder/tracker-commands";
import { createApplicationStore } from "@nestor/db/applications";
import { createNeedsYouCommandRunner } from "@nestor/job-finder/applications";
import {
  needsYouCommandTools,
  decideUnderGrants,
  AssistantToolError,
  type RunNeedsYouCommand,
} from "@nestor/job-finder";
import {
  createDeterministicJobFinderAiClient,
  resolveAssistantModelRouteFromEnvironment,
} from "@nestor/ai-providers";
import { createStubBrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  TRACKER_COMMANDS,
  APPLICATION_COMMANDS,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  SavedJobSchema,
  ResumeDraftSchema,
  ApplicationResumeArtifactSchema,
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  SubmissionOutcomeRecordSchema,
  CandidateAssetSchema,
  createFreshStartCandidateProfile,
  type AssistantContextReference,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantNavigationDisplay,
  type CandidateProfile,
  type SavedFormAnswer,
  type JobSearchSettings,
  type JobSearchStatus,
  WriteClipboardTextInputSchema,
  type JobCommandOutputs,
  type ResumeCommandOutputs,
  type TrackerCommandOutputs,
  type ApplicationCommandOutputs,
  type JobCommandName,
  type JobSearchPreferences,
  type JobFinderSettings,
  type SavedJob,
} from "@nestor/contracts";
import {
  createAssistantRepository,
  type JobFinderRepository,
} from "@nestor/db";
import {
  createJobFinderRepository,
  openJobStore,
  createTrackerStore,
  createJobSitesStore,
  createResumeStore,
  approveOriginalResumesForTests,
  seedTrackerDemo,
  type JobStore,
} from "@nestor/db/job-store";
import {
  createJobCommandRunner,
  savePageJobs,
} from "@nestor/job-finder/job-commands";
import {
  AssistantSessionHost,
  assistantCommandTools,
  createAssistantModelHandle,
  createProfileService,
  createScriptedAssistantModelHandle,
  type ProfileServiceOptions,
  type AssistantHostPorts,
  type AssistantModelResolution,
} from "@nestor/job-finder";

type ResumeCommands = typeof ASSISTANT_RESUME_COMMANDS;

/**
 * One isolated Job Finder workspace with the assistant attached, built from
 * synthetic data only. Background work (searches, applications, sends) goes
 * to recording fakes: the lane grades what the assistant asked for and what
 * changed in the workspace, never a real site.
 */

export type AssistantLaneModel = "scripted" | "live";
export type AssistantLaneScenario =
  | "no_sites"
  | "ready_resume"
  | "ready_application"
  | "tracked_application"
  | "send_by_default"
  | "navigation"
  | "approved_shortlist";

/** The person and goals the assistant may have changed. */
export interface AssistantLaneSnapshot {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  settings: JobFinderSettings;
  northwindTracking: TrackerCommandOutputs["get_application"];
  savedAnswers: SavedFormAnswer[];
}

export interface AssistantLaneRecorder {
  inputs: {
    messageTokens: number;
    schemaTokens: number;
    toolCount: number;
    reportedInputTokens: number | null;
  }[];
  searches: string[];
  clipboard: string[];
  applications: { jobIds: string[]; mode: string }[];
  sends: string[][];
}

export interface AssistantLaneWorld {
  host: AssistantSessionHost;
  commandNames: readonly string[];
  commands: NonNullable<AssistantHostPorts["commands"]>;
  recorder: AssistantLaneRecorder;
  events: AssistantEvent[];
  /** Routes the assistant opened, in order. */
  navigations: string[];
  /** The screen the person is on for the next message, as the renderer sees it. */
  show(context: AssistantContextReference): void;
  snapshot(): Promise<AssistantLaneSnapshot>;
  jobs: readonly SavedJob[];
  /** Where a lane job sits in the job store: found, hidden, shortlisted... */
  stageOf: (laneJobId: string) => string;
  shutdown(): Promise<void>;
}

const NOW = "2026-09-27T09:00:00.000Z";

/** Synthetic postings; companies and people are invented. */
export const LANE_JOBS: readonly SavedJob[] = [
  lanePosting(
    "job_lane_1",
    "Senior Product Designer",
    "Northwind Labs",
    92,
    "Remote",
  ),
  lanePosting(
    "job_lane_2",
    "Staff Product Designer",
    "Bluebird Health",
    88,
    "Berlin, Germany",
  ),
  lanePosting(
    "job_lane_3",
    "Design Systems Lead",
    "Quartz Freight",
    84,
    "Remote",
  ),
  lanePosting("job_lane_4", "UX Designer", "Harbor Mutual", 71, "London, UK"),
  lanePosting(
    "job_lane_5",
    "Product Design Manager",
    "Cinder Robotics",
    66,
    "Remote",
  ),
];

function lanePosting(
  id: string,
  title: string,
  company: string,
  score: number,
  location: string,
): SavedJob {
  return SavedJobSchema.parse({
    id,
    source: "target_site",
    sourceJobId: `${id}_source`,
    discoveryMethod: "catalog_seed",
    canonicalUrl: `http://127.0.0.1:47950/jobs/${id}`,
    applicationUrl: `http://127.0.0.1:47950/jobs/${id}/apply`,
    title,
    company,
    location,
    workMode: location === "Remote" ? ["remote"] : ["hybrid"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: NOW,
    postedAtText: null,
    discoveredAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastVerifiedActiveAt: NOW,
    salaryText: null,
    summary: `${title} at ${company}.`,
    description: `${company} is hiring a ${title} to lead product design work across web and mobile.`,
    keySkills: ["Figma", "Design systems", "User research"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
    },
    keywordSignals: [],
    benefits: [],
    status: "discovered",
    matchAssessment: { score, reasons: ["Design systems overlap"], gaps: [] },
    provenance: [],
  });
}

/** Saves the lane's synthetic person, goals and settings. */
async function seedLaneProfile(repository: JobFinderRepository) {
  const fresh = createFreshStartCandidateProfile();
  await repository.saveProfileAndSearchPreferences(
    {
      ...fresh,
      id: "candidate_lane",
      firstName: "Riley",
      lastName: "Okafor",
      fullName: "Riley Okafor",
      headline: "Product designer",
      summary: "Designs calm tools for busy operations teams.",
      currentLocation: "Lisbon, Portugal",
      yearsExperience: 8,
      email: "riley.okafor@example.test",
      skills: ["Figma", "Prototyping"],
      baseResume: {
        ...fresh.baseResume,
        id: "resume_lane",
        fileName: "riley-okafor.txt",
        uploadedAt: NOW,
        storagePath: "/tmp/nestor-assistant-lane/riley-okafor.txt",
        textContent:
          "Riley Okafor\nProduct designer\nFigma, prototyping, design systems\nLead designer at Example Freight 2020-2026",
        textUpdatedAt: NOW,
        extractionStatus: "ready",
        lastAnalyzedAt: NOW,
      },
    },
    JobSearchPreferencesSchema.parse({
      targetRoles: ["Product Designer"],
      jobFamilies: [],
      locations: ["Remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
    }),
  );
  await repository.saveProfileSetupState(
    ProfileSetupStateSchema.parse({
      status: "completed",
      currentStep: "ready_check",
      completedAt: NOW,
      reviewItems: [],
      lastResumedAt: null,
    }),
  );
  await repository.saveSettings(
    JobFinderSettingsSchema.parse({
      resumeTemplateId: "classic_ats",
      resumeFormat: "pdf",
      fontPreset: "inter_requisite",
      appearanceTheme: "system",
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
    }),
  );
}

type DocumentManager = ProfileServiceOptions["documentManager"];

function laneDocumentManager(): DocumentManager {
  const unavailable = () =>
    Promise.reject(new Error("Rendering is not part of the assistant lane."));
  return {
    listResumeTemplates: () => [],
    renderResumePreview: unavailable,
    renderResumeArtifact: unavailable,
  };
}

/** The lane jobs in an in-memory job store, scored, so job commands run on them. */
function laneJobStore(): { store: JobStore; ids: Map<string, number> } {
  const store = openJobStore(":memory:");
  const { added } = store.saveFoundJobs({
    searchId: null,
    jobs: LANE_JOBS.map((job) => ({
      title: job.title,
      company: job.company,
      location: job.location,
      workModes: job.workMode,
      url: job.canonicalUrl,
      applyUrl: job.applicationUrl,
      sourceId: "lane",
      sourceLabel: "Lane board",
      sourceJobId: job.sourceJobId,
      postedAt: job.postedAt,
      salaryText: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      seniority: null,
      employmentType: null,
      summary: job.summary,
      description: job.description,
    })),
  });
  store.setFit(
    LANE_JOBS.map((job, index) => ({
      id: added[index]!,
      score: job.matchAssessment.score,
      summary: job.summary ?? "",
      reasons: [],
      gaps: [],
    })),
  );
  return {
    store,
    ids: new Map(LANE_JOBS.map((job, index) => [job.id, added[index]!])),
  };
}

/**
 * Bluebird and Quartz shortlisted, Northwind sent through Apply so it sits in
 * Applications as applied; the rest are found.
 */
function seedNavigationWorkspace(store: JobStore, ids: Map<string, number>) {
  store.setStage(
    [ids.get("job_lane_2")!, ids.get("job_lane_3")!],
    "shortlisted",
  );
  const sent = ids.get("job_lane_1")!;
  approveOriginalResumesForTests(store, [sent]);
  createApplicationStore(store).applyJobs(
    { selection: { ids: [sent] } },
    "confirm_before_submit",
  );
  const at = Date.parse(NOW);
  store
    .sql(
      "UPDATE applications SET state = 'submitted', submitted_at = ?, updated_at = ? WHERE job_id = ?",
    )
    .run(at, at, sent);
  store.setStage([sent], "applied");
}

/**
 * What the renderer acknowledges after an open_in_app request: the route is
 * displayed, unless the person has unsaved Profile typing and the route
 * leaves Profile, where the app's leave dialog holds the page.
 */
function laneDisplay(
  route: string,
  showing: AssistantContextReference | null,
): AssistantNavigationDisplay {
  const next = new URL(route, "https://nestor.local");
  const leavesUnsavedProfile =
    showing?.editor?.editor === "profile" &&
    showing.editor.dirtyFields.length > 0 &&
    next.pathname !== "/job-finder/profile";
  if (leavesUnsavedProfile)
    return {
      displayedRoute: showing.route,
      section: null,
      overlay: "dialog",
      status: "blocked",
      reason: "The requested page has not been displayed.",
    };
  return {
    displayedRoute: route,
    section:
      next.pathname === "/job-finder/settings"
        ? next.hash.slice(1) || null
        : next.searchParams.get("section"),
    overlay: "none",
    status: "displayed",
    reason: null,
  };
}

function recordingPorts(
  recorder: AssistantLaneRecorder,
  store: JobStore,
  needsYou: RunNeedsYouCommand,
  repository: JobFinderRepository,
  resumes: ResumeService,
): AssistantHostPorts {
  const sites = createJobSitesStore(store);
  let searchStatus: JobSearchStatus = {
    search: null,
    sources: [],
    progress: null,
    sourceRevision: 0,
  };
  const search = {
    start: (settings: JobSearchSettings) => {
      const selected = sites
        .list({ filter: "enabled" })
        .rows.filter((site) =>
          "ids" in settings.sites
            ? settings.sites.ids.includes(site.id)
            : !settings.sites.except.includes(site.id),
        );
      if (!selected.length)
        return Promise.reject(
          new Error("Add or enable a job source before searching."),
        );
      recorder.searches.push(JSON.stringify(settings));
      searchStatus = {
        ...searchStatus,
        search: {
          id: `synthetic_search_${recorder.searches.length}`,
          state: "done",
          settings,
          startedAt: NOW,
          finishedAt: NOW,
          sourcesTotal: selected.length,
          sourcesDone: selected.length,
          found: 0,
          added: 0,
          merged: 0,
          scored: 0,
          error: null,
        },
      };
      return Promise.resolve();
    },
    stop: () => {},
    retrySource: () => Promise.resolve(),
    keepReading: () => Promise.resolve(),
    scoreUnscored: () => Promise.resolve(0),
    status: () => searchStatus,
  };
  const runJobCommand = createJobCommandRunner({
    store,
    search: () => Promise.resolve(search),
    currentSearch: () => search,
  });
  const runResumeCommand = createResumeCommandRunner(
    () => Promise.resolve(resumes),
    () => Promise.resolve(createResumeCommandReads(store, () => [])),
  );
  const tracker = createTrackerStore(store);
  const applications = createApplicationStore(store);
  const runTrackerCommand = createTrackerCommandRunner(store);
  return {
    savePageJobs: (input) => Promise.resolve(savePageJobs(store, input)),
    resolveApprovedJobs: (selection) =>
      Promise.resolve(applications.selectedJobIds(selection)),
    readCommand: async (name, input) => {
      if (name === "list_applications")
        return tracker.list(input as never) as never;
      if (name === "needs_you_counts" || name === "application_needs")
        return (await needsYou(name, input)) as never;
      return (await runJobCommand(name as JobCommandName, input)) as never;
    },
    async readPersonalState() {
      const [
        profile,
        searchPreferences,
        settings,
        profileSetupState,
        activityControl,
        latestResumeImportRun,
      ] = await Promise.all([
        repository.getProfile(),
        repository.getSearchPreferences(),
        repository.getSettings(),
        repository.getProfileSetupState(),
        repository.getActivityControl(),
        repository.getLatestResumeImportRun(),
      ]);
      return {
        profile,
        searchPreferences,
        settings,
        profileSetupState,
        activityControl,
        latestResumeImportRun,
        latestResumeImportReviewCandidates: [],
        latestResumeImportBundle: null,
        enabledSiteCount: sites.list({ filter: "enabled" }).enabledTotal,
        resumeImportActive: false,
        availableResumeTemplates: [],
        generatedAt: NOW,
      };
    },
    commands: [
      ...assistantCommandTools<
        typeof ASSISTANT_JOB_COMMANDS,
        JobCommandOutputs
      >(ASSISTANT_JOB_COMMANDS, runJobCommand, {
        group: "jobs",
        results: {
          stage_counts: (counts) => ({
            summary: "Current job counts.",
            data: assistantJobCounts(counts),
          }),
          count_jobs: (_value, input) => ({
            summary: "Matching jobs.",
            data: { total: countAssistantJobs(store, input) },
          }),
          list_jobs: async (_page, input, { session }) => {
            const page = readAssistantJobs(store, input);
            await session.createResultSet({
              kind: "jobs",
              label: "Matching jobs",
              itemIds: page.rows.map((job) => String(job.id)),
              source: "tool_query",
            });
            return {
              summary: `${page.total} jobs match.`,
              data: assistantJobListPage(store, page),
            };
          },
        },
      }),
      ...assistantCommandTools<ResumeCommands, ResumeCommandOutputs>(
        ASSISTANT_RESUME_COMMANDS,
        runResumeCommand,
        {
          group: "resume",
          results: {
            list_shortlisted: (_page, input) => ({
              summary: "Matching shortlisted jobs.",
              data: assistantJobListPage(
                store,
                readAssistantJobs(store, input),
              ),
            }),
          },
        },
      ),
      ...assistantCommandTools<typeof TRACKER_COMMANDS, TrackerCommandOutputs>(
        TRACKER_COMMANDS,
        runTrackerCommand,
        { group: "tracking" },
      ),
      ...assistantCommandTools<
        Pick<typeof APPLICATION_COMMANDS, "list_application_work">,
        Pick<ApplicationCommandOutputs, "list_application_work">
      >(
        { list_application_work: APPLICATION_COMMANDS.list_application_work },
        (_name, input) => applications.listApplications(input),
        { group: "applications" },
      ),
      ...assistantCommandTools<
        Pick<typeof APPLICATION_COMMANDS, "applications_for_jobs">,
        Pick<ApplicationCommandOutputs, "applications_for_jobs">
      >(
        { applications_for_jobs: APPLICATION_COMMANDS.applications_for_jobs },
        (_name, input) => applications.forJobs(input.jobIds),
        { group: "applications" },
      ),
      ...assistantCommandTools<
        Pick<typeof APPLICATION_COMMANDS, "get_application_details">,
        Pick<ApplicationCommandOutputs, "get_application_details">
      >(
        {
          get_application_details: APPLICATION_COMMANDS.get_application_details,
        },
        (_name, { id }) => {
          const application = applications.getApplication(id);
          if (!application) return null;
          const work = applications.getWork(id);
          return {
            application,
            summary: work?.execution.summary ?? null,
            detail: work?.execution.detail ?? null,
            resumeFileName:
              applications.getResumeArtifact(id)?.fileName ?? null,
            reviewCard: work?.reviewCard ?? null,
            receipt: applications.getSubmissionReceipt(id),
          };
        },
        { group: "applications" },
      ),
      ...needsYouCommandTools(needsYou),
      ...assistantCommandTools<
        Pick<typeof APPLICATION_COMMANDS, "send_application">,
        Pick<ApplicationCommandOutputs, "send_application">
      >(
        { send_application: APPLICATION_COMMANDS.send_application },
        (_name, { id }) => {
          const row = applications.getApplication(id)!;
          if (!applications.beginSubmission(id, row.attempt)) return false;
          // A recording fake, never a browser send or employer receipt.
          const at = new Date().toISOString();
          const recorded = applications.recordSubmission(
            id,
            row.attempt,
            SubmissionOutcomeRecordSchema.parse({
              id: `lane_receipt_${id}`,
              preflightId: "lane_preflight",
              idempotencyKey: `lane_send_${id}`,
              authorityEnvelopeId: "lane_permission",
              authorityRevision: 1,
              jobId: String(row.jobId),
              applicationRecordId: `application_${id}`,
              runId: `application_run_${id}`,
              resultId: `application_${id}_attempt_${row.attempt}`,
              outcome: "submitted",
              attemptedAt: at,
              verifiedAt: at,
              evidence: [
                {
                  id: "lane_confirmation",
                  kind: "employer_site_state",
                  observedAt: at,
                  destination: {
                    origin: "http://127.0.0.1:47950",
                    safePath: "/thanks",
                  },
                  artifactRefId: null,
                  summary: "Synthetic eval confirmation; no site contacted.",
                },
              ],
              retry: { eligible: false, blockReason: "submission_confirmed" },
            }),
          );
          if (recorded) recorder.sends.push([String(row.jobId)]);
          return recorded;
        },
        {
          group: "applications",
          before: {
            send_application: async ({ id }, { session }) => {
              const row = applications.getApplication(id);
              if (!row)
                throw new AssistantToolError(
                  "not_found",
                  "That application no longer exists.",
                );
              if ((await repository.getActivityControl()).paused)
                throw new AssistantToolError(
                  "refused",
                  "Background work is paused.",
                );
              const currentMode = (await repository.getSettings())
                .applicationAutomationMode;
              const [decision] = decideUnderGrants({
                grants: await session.grants.list(),
                jobIds: [String(row.jobId)],
                action: "send",
                savedMode:
                  row.mode === "autonomous_submit" &&
                  currentMode === "autonomous_submit"
                    ? "autonomous_submit"
                    : "confirm_before_submit",
              });
              if (!decision?.allowed)
                throw new AssistantToolError(
                  "refused",
                  decision?.reason ?? "Record a send instruction first.",
                );
            },
          },
          results: {
            send_application: (sent) => ({
              summary: sent
                ? "The synthetic eval recorded the send; no site was contacted."
                : "Nothing was sent.",
              data: sent,
            }),
          },
        },
      ),
    ],
    executeAction: (actionId, input) => {
      if (actionId !== "write-clipboard-text")
        return Promise.reject(
          new Error(
            `Action ${actionId} is not implemented in this eval world.`,
          ),
        );
      recorder.clipboard.push(WriteClipboardTextInputSchema.parse(input).text);
      return Promise.resolve();
    },
    checkSource: () => Promise.resolve(),
    listDocuments: async () => {
      const { baseResume } = await repository.getProfile();
      return [
        CandidateAssetSchema.parse({
          id: "original_resume",
          kind: "resume",
          originalName: baseResume.fileName,
          mime: "text/plain",
          byteSize: Buffer.byteLength(baseResume.textContent ?? ""),
          sha256: createHash("sha256")
            .update(baseResume.textContent ?? "")
            .digest("hex"),
          createdAt: NOW,
          sensitivity: "standard",
          consentScope: "job_application_attachment",
          retention: "until_deleted",
        }),
      ];
    },
    readDocumentText: async (id) =>
      id === "original_resume"
        ? (await repository.getProfile()).baseResume.textContent
        : null,
    loadDocumentFile: () =>
      Promise.reject(new Error("No files in the assistant lane.")),
    importResumeDocument: () => Promise.resolve(),
    publishWorkspaceUpdate: () => undefined,
  };
}

export function resolveLaneModel(
  model: AssistantLaneModel,
): AssistantModelResolution {
  if (model === "scripted") {
    return { kind: "ready", handle: createScriptedAssistantModelHandle() };
  }
  const resolution = resolveAssistantModelRouteFromEnvironment(process.env);
  if (!resolution.available)
    return { kind: "unavailable", detail: resolution.detail };
  return {
    kind: "ready",
    handle: createAssistantModelHandle(resolution.route, resolution.fallback),
  };
}

export async function createAssistantLaneWorld(
  model: AssistantLaneModel,
  scenario?: AssistantLaneScenario,
): Promise<AssistantLaneWorld> {
  const jobs = laneJobStore();
  const repository = createJobFinderRepository(jobs.store);
  await seedLaneProfile(repository);
  if (scenario !== "no_sites")
    createJobSitesStore(jobs.store).add({
      text: "https://synthetic.example.test/jobs",
    });
  if (scenario === "approved_shortlist")
    approveOriginalResumesForTests(jobs.store, [1, 2, 3]);
  if (scenario === "navigation") seedNavigationWorkspace(jobs.store, jobs.ids);
  if (scenario === "tracked_application") {
    seedTrackerDemo(jobs.store, [jobs.ids.get("job_lane_1")!]);
  }
  if (scenario === "send_by_default") {
    await repository.saveSettings({
      ...(await repository.getSettings()),
      applicationAutomationMode: "autonomous_submit",
    });
  }
  if (scenario === "ready_application") {
    const jobId = jobs.ids.get("job_lane_1")!;
    approveOriginalResumesForTests(jobs.store, [jobId]);
    const applications = createApplicationStore(jobs.store);
    applications.applyJobs(
      { selection: { ids: [jobId] } },
      "confirm_before_submit",
    );
    const row = applications.claimNext()!;
    applications.saveWork(row.id, {
      attempt: row.attempt,
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "lane_resume_artifact",
        jobId: String(jobId),
        source: "original_upload",
        fileName: "riley-okafor.txt",
        filePath: "/tmp/nestor-assistant-lane/riley-okafor.txt",
        approvedAt: NOW,
      }),
      execution: ApplyExecutionResultSchema.parse({
        state: "ready",
        summary: "Northwind application is filled and ready to send.",
        detail: "Synthetic prepared application; no site contacted.",
        submittedAt: null,
        outcome: null,
        nextActionLabel: "Send",
      }),
      reviewCard: ApplicationReviewCardSchema.parse({
        siteLabel: "Lane replica",
        pageUrl: LANE_JOBS[0]!.applicationUrl,
        preparedAt: NOW,
      }),
      authorityEnvelopeId: null,
      profileDigest: "lane_profile",
    });
    applications.finishPreparation({
      id: row.id,
      attempt: row.attempt,
      state: "ready",
    });
  }
  if (scenario === "ready_resume") {
    const id = jobs.ids.get("job_lane_1")!;
    jobs.store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    const resumes = createResumeStore(jobs.store);
    resumes.startWriting(id, "tailored");
    resumes.finishWriting(
      id,
      ResumeDraftSchema.parse({
        id: "lane_ready_draft",
        jobId: String(id),
        status: "draft",
        templateId: "classic_ats",
        identity: { fullName: "Riley Okafor", headline: "Product designer" },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }
  const service = createProfileService({
    repository,
    aiClient: createDeterministicJobFinderAiClient(
      "The assistant lane uses the deterministic Job Finder client.",
    ),
    browserRuntime: createStubBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    }),
    documentManager: laneDocumentManager(),
  });
  const recorder: AssistantLaneRecorder = {
    inputs: [],
    searches: [],
    clipboard: [],
    applications: [],
    sends: [],
  };
  const applications = createApplicationStore(jobs.store);
  const needsYou = createNeedsYouCommandRunner(() => applications, {
    retry: () => Promise.resolve(),
    open: () => Promise.resolve(false),
    check: () => Promise.resolve(false),
  });
  const events: AssistantEvent[] = [];
  const resumes = createResumeService({
    store: jobs.store,
    aiClient: createDeterministicJobFinderAiClient(),
    documentManager: laneDocumentManager(),
    readInputs: async () => ({
      profile: await repository.getProfile(),
      searchPreferences: await repository.getSearchPreferences(),
      settings: await repository.getSettings(),
    }),
    fetchListingHtml: () =>
      Promise.reject(new Error("No network in the assistant lane.")),
  });
  resumes.start();
  const ports = recordingPorts(
    recorder,
    jobs.store,
    needsYou,
    repository,
    resumes,
  );
  const navigations: string[] = [];
  let showing: AssistantContextReference | null = null;
  const resolution = resolveLaneModel(model);
  const host: AssistantSessionHost = new AssistantSessionHost({
    repository: createAssistantRepository({ filePath: ":memory:" }),
    service,
    ports,
    resolveModel: () => resolution,
    publish: (event) => {
      events.push(event);
      const payload = event.payload;
      if (payload.type !== "open_route") return;
      navigations.push(payload.route);
      const display = laneDisplay(payload.route, showing);
      if (display.status === "displayed" && showing)
        showing = { ...showing, route: payload.route, editor: null };
      if (payload.navigationRequestId)
        setTimeout(() =>
          host.acknowledgeNavigation({
            ...display,
            conversationId: event.conversationId,
            navigationRequestId: payload.navigationRequestId!,
          }),
        );
    },
    stallAfterMs: 60_000,
    log: (message, detail) => {
      if (message === "Assistant input budget")
        recorder.inputs.push(detail as AssistantLaneRecorder["inputs"][number]);
    },
  });
  return {
    host,
    commandNames: (ports.commands ?? []).map((tool) => tool.name),
    commands: ports.commands ?? [],
    recorder,
    events,
    navigations,
    show: (context) => {
      showing = context;
    },
    jobs: LANE_JOBS,
    snapshot: async () => ({
      profile: await repository.getProfile(),
      searchPreferences: await repository.getSearchPreferences(),
      settings: await repository.getSettings(),
      savedAnswers: applications.needsYou
        .listAnswers({})
        .rows.flatMap((row) => {
          const answer = applications.needsYou.savedAnswer(row.id);
          return answer ? [answer] : [];
        }),
      northwindTracking: await createTrackerCommandRunner(jobs.store)(
        "get_application",
        { jobId: jobs.ids.get("job_lane_1")! },
      ),
    }),
    stageOf: (laneJobId) => {
      const id = jobs.ids.get(laneJobId);
      return (id ? jobs.store.getJob(id)?.stage : null) ?? "missing";
    },
    shutdown: async () => {
      try {
        await host.shutdown();
      } finally {
        resumes.stop();
        jobs.store.close();
      }
    },
  };
}

export function laneContext(
  overrides: Partial<AssistantContextReference> = {},
): AssistantContextReference {
  return {
    screen: "home",
    route: "/job-finder",
    sectionLabel: null,
    focus: null,
    list: null,
    editor: null,
    browser: null,
    selectedText: null,
    mentions: [],
    attachments: [],
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function lastReply(
  messages: readonly AssistantMessage[],
): AssistantMessage | null {
  return (
    messages.filter((message) => message.role === "assistant").at(-1) ?? null
  );
}
