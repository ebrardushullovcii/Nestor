import { assistantJobListPage } from "@nestor/job-finder/resumes";
import { createApplicationStore } from "@nestor/db/applications";
import { createNeedsYouCommandRunner } from "@nestor/job-finder/applications";
import {
  needsYouCommandTools,
  type RunNeedsYouCommand,
} from "@nestor/job-finder";
import {
  createDeterministicJobFinderAiClient,
  resolveAssistantModelRouteFromEnvironment,
} from "@nestor/ai-providers";
import { createStubBrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  JOB_COMMANDS,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  SavedJobSchema,
  ResumeDraftSchema,
  createFreshStartCandidateProfile,
  type AssistantContextReference,
  type AssistantEvent,
  type AssistantMessage,
  type CandidateProfile,
  type JobCommandOutputs,
  type JobCommandName,
  type JobSearchPreferences,
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
  createResumeStore,
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

/**
 * One isolated Job Finder workspace with the assistant attached, built from
 * synthetic data only. Background work (searches, applications, sends) goes
 * to recording fakes: the lane grades what the assistant asked for and what
 * changed in the workspace, never a real site.
 */

export type AssistantLaneModel = "scripted" | "live";

/** The person and goals the assistant may have changed. */
export interface AssistantLaneSnapshot {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}

export interface AssistantLaneRecorder {
  inputs: {
    messageTokens: number;
    schemaTokens: number;
    toolCount: number;
    reportedInputTokens: number | null;
  }[];
  searches: string[];
  applications: { jobIds: string[]; mode: string }[];
  sends: string[][];
}

export interface AssistantLaneWorld {
  host: AssistantSessionHost;
  recorder: AssistantLaneRecorder;
  events: AssistantEvent[];
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

function recordingPorts(
  recorder: AssistantLaneRecorder,
  store: JobStore,
  needsYou: RunNeedsYouCommand,
  repository: JobFinderRepository,
): AssistantHostPorts {
  const runJobCommand = createJobCommandRunner({ store });
  const tracker = createTrackerStore(store);
  return {
    savePageJobs: (input) => Promise.resolve(savePageJobs(store, input)),
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
        enabledSiteCount: 0,
        resumeImportActive: false,
        availableResumeTemplates: [],
        generatedAt: NOW,
      };
    },
    commands: [
      ...assistantCommandTools<typeof JOB_COMMANDS, JobCommandOutputs>(
        JOB_COMMANDS,
        (name, input) => {
          if (name === "start_search") {
            recorder.searches.push(JSON.stringify(input).slice(0, 400));
            return Promise.reject(
              new Error("Searching is not part of this eval world."),
            );
          }
          return runJobCommand(name, input);
        },
        {
          group: "jobs",
          results: {
            list_jobs: (page) => ({
              summary: `${page.total} jobs match.`,
              data: assistantJobListPage(store, page),
            }),
          },
        },
      ),
      ...needsYouCommandTools(needsYou),
    ],
    checkSource: () => Promise.resolve(),
    listDocuments: () => Promise.resolve([]),
    readDocumentText: () => Promise.resolve(null),
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
  scenario?: "ready_resume",
): Promise<AssistantLaneWorld> {
  const jobs = laneJobStore();
  const repository = createJobFinderRepository(jobs.store);
  await seedLaneProfile(repository);
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
  const resolution = resolveLaneModel(model);
  const host = new AssistantSessionHost({
    repository: createAssistantRepository({ filePath: ":memory:" }),
    service,
    ports: recordingPorts(recorder, jobs.store, needsYou, repository),
    resolveModel: () => resolution,
    publish: (event) => events.push(event),
    stallAfterMs: 60_000,
    log: (message, detail) => {
      if (message === "Assistant input budget")
        recorder.inputs.push(detail as AssistantLaneRecorder["inputs"][number]);
    },
  });
  return {
    host,
    recorder,
    events,
    jobs: LANE_JOBS,
    snapshot: async () => ({
      profile: await repository.getProfile(),
      searchPreferences: await repository.getSearchPreferences(),
    }),
    stageOf: (laneJobId) => {
      const id = jobs.ids.get(laneJobId);
      return (id ? jobs.store.getJob(id)?.stage : null) ?? "missing";
    },
    shutdown: async () => {
      try {
        await host.shutdown();
      } finally {
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
