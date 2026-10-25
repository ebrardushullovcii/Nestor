import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import type { JobFinderGlobalSearchEntry } from "./job-finder-global-search";
import { buildJobFinderContextRoute } from "./job-finder-context-navigation";
import { buildResumeWorkspaceRoute } from "./resume-workspace-route";
import { JOB_FINDER_ROUTE_PATHS } from "./job-finder-route-hrefs";
import {
  isEmployerAbsenceLabel,
  isLocationAbsenceLabel,
  resolveJobEmployerDisplay,
  resolveJobLocationDisplay,
} from "./job-employer-location-display";

/**
 * Every screen, so "set" then Enter opens Settings. The extra words are what
 * a person might type for it.
 */
function screen(
  id: string,
  title: string,
  subtitle: string,
  href: string,
  words: readonly string[],
): JobFinderGlobalSearchEntry {
  return {
    href,
    id: `screen:${id}`,
    kind: "screen",
    metadata: words,
    subtitle,
    title,
  };
}

const SCREEN_ENTRIES: readonly JobFinderGlobalSearchEntry[] = [
  screen("home", "Home", "Your next step", "/job-finder/home", ["start"]),
  screen(
    "profile",
    "Profile",
    "Experience and documents",
    JOB_FINDER_ROUTE_PATHS.profile,
    ["resume", "experience"],
  ),
  screen(
    "job-sources",
    "Job sources",
    "Profile",
    JOB_FINDER_ROUTE_PATHS.profileSources,
    ["sites", "boards", "feeds"],
  ),
  screen(
    "discovery",
    "Find jobs",
    "Search and triage",
    JOB_FINDER_ROUTE_PATHS.discovery,
    ["discover", "search now"],
  ),
  screen(
    "review-queue",
    "Shortlisted",
    "Resumes and applying",
    JOB_FINDER_ROUTE_PATHS.reviewQueue,
    ["review", "approve"],
  ),
  screen(
    "applications",
    "Applications",
    "Where each application stands",
    JOB_FINDER_ROUTE_PATHS.applications,
    ["tracker", "interviews"],
  ),
  screen(
    "campaigns",
    "Search plans",
    "Roles, places and sources",
    JOB_FINDER_ROUTE_PATHS.campaigns,
    ["plans"],
  ),
  screen(
    "settings",
    "Settings",
    "Applying, AI, appearance",
    JOB_FINDER_ROUTE_PATHS.settings,
    ["preferences", "options"],
  ),
  screen(
    "settings-applying",
    "Applying settings",
    "Settings",
    `${JOB_FINDER_ROUTE_PATHS.settings}#settings-application-authority`,
    ["send for me", "fill in"],
  ),
];

export function buildJobFinderGlobalSearchEntries(
  workspace: JobFinderRendererWorkspaceSnapshot,
): readonly JobFinderGlobalSearchEntry[] {
  const campaigns = workspace.campaigns ?? [];
  const discoveryJobs = workspace.discoveryJobs ?? [];
  const applicationRecords = workspace.applicationRecords ?? [];
  const tailoredAssets = workspace.tailoredAssets ?? [];
  const resumeExportArtifacts = workspace.resumeExportArtifacts ?? [];

  const campaignIdsByJobId = new Map<string, Set<string>>();
  for (const campaign of campaigns) {
    for (const jobId of campaign.jobIds ?? []) {
      const campaignIds = campaignIdsByJobId.get(jobId) ?? new Set<string>();
      campaignIds.add(campaign.id);
      campaignIdsByJobId.set(jobId, campaignIds);
    }
  }
  const campaignNameById = new Map(
    campaigns.map((campaign) => [campaign.id, campaign.name]),
  );
  // A null or stale activeCampaignId means no searchable plan scope. Valid
  // planless workspaces must still surface every job, application, and
  // document record instead of returning none — including records that carry
  // another plan's campaign id, which keep their own campaign metadata and
  // label. When an active plan resolves, scope those records to its jobs so
  // unrelated plans drop out; campaign and company entries always remain
  // searchable as shared context.
  const resolvesActivePlan = campaigns.some(
    (campaign) => campaign.id === workspace.activeCampaignId,
  );
  const campaignLabelFor = (campaignId: string | null) =>
    campaignId ? (campaignNameById.get(campaignId) ?? "Search plan") : null;
  const isInActivePlan = (jobId: string) =>
    campaignIdsByJobId.get(jobId)?.has(workspace.activeCampaignId) ?? false;
  // Nothing the app says it saved may be unfindable: Home advertises every
  // job saved on the device, so the search covers them all and labels the
  // ones outside the active plan instead of denying they exist.
  const outOfPlanLabel = (jobId: string) =>
    resolvesActivePlan && !isInActivePlan(jobId)
      ? "Saved on this device, not in this search plan"
      : null;
  const campaignIdForJob = resolvesActivePlan
    ? (jobId: string) =>
        isInActivePlan(jobId) ? workspace.activeCampaignId : null
    : (jobId: string) =>
        campaigns.find((campaign) =>
          campaignIdsByJobId.get(jobId)?.has(campaign.id),
        )?.id ?? null;

  const jobEntries: JobFinderGlobalSearchEntry[] = discoveryJobs.map((job) => {
    const employer = resolveJobEmployerDisplay({
      company: job.company,
      canonicalUrl: job.canonicalUrl,
    });
    const location = resolveJobLocationDisplay(job.location);
    const campaignId = campaignIdForJob(job.id);
    return {
      campaignId,
      // Built when a result is opened: building a link for each of thousands
      // of jobs every time the palette opened cost about 45 ms.
      get href() {
        return buildJobFinderContextRoute("/job-finder/discovery", {
          jobId: job.id,
        });
      },
      id: job.id,
      kind: "job" as const,
      metadata: [
        employer,
        location,
        ...(job.workMode ?? []),
        job.status,
        ...(job.matchAssessment?.reasons ?? []),
      ].filter(
        (value): value is string =>
          typeof value === "string" &&
          value.length > 0 &&
          !isEmployerAbsenceLabel(value) &&
          !isLocationAbsenceLabel(value),
      ),
      // The employer and location line, from the two values resolved above.
      subtitle: [
        employer,
        location,
        campaignLabelFor(campaignId) ?? outOfPlanLabel(job.id),
      ]
        .filter(Boolean)
        .join(" · "),
      title: job.title,
    };
  });
  const applicationEntries: JobFinderGlobalSearchEntry[] =
    applicationRecords.map((record) => ({
      campaignId: campaignIdForJob(record.jobId),
      href: buildJobFinderContextRoute("/job-finder/applications", {
        applicationRecordId: record.id,
      }),
      id: record.id,
      kind: "application",
      metadata: [
        record.company,
        record.status,
        record.lastActionLabel,
        record.nextActionLabel,
        ...(record.crm?.tags ?? []),
      ].filter((value): value is string => typeof value === "string"),
      subtitle: [
        record.company,
        (record.status ?? "").replaceAll("_", " "),
        campaignLabelFor(campaignIdForJob(record.jobId)),
      ]
        .filter(Boolean)
        .join(" · "),
      title: record.title,
    }));
  const documentEntries: JobFinderGlobalSearchEntry[] = [
    ...tailoredAssets.map((asset) => ({
      campaignId: campaignIdForJob(asset.jobId),
      href: buildResumeWorkspaceRoute(asset.jobId),
      id: asset.id,
      kind: "document" as const,
      metadata: [asset.templateName, asset.status, asset.version],
      subtitle: [
        asset.templateName,
        asset.status,
        campaignLabelFor(campaignIdForJob(asset.jobId)),
      ]
        .filter(Boolean)
        .join(" · "),
      title: asset.label,
    })),
    ...resumeExportArtifacts.map((artifact) => ({
      campaignId: campaignIdForJob(artifact.jobId),
      href: buildResumeWorkspaceRoute(artifact.jobId),
      id: artifact.id,
      kind: "document" as const,
      metadata: [artifact.templateId, artifact.format, artifact.filePath],
      subtitle: [
        (artifact.templateId ?? "").replaceAll("_", " "),
        `${(artifact.format ?? "").toUpperCase()} export`,
        campaignLabelFor(campaignIdForJob(artifact.jobId)),
      ]
        .filter(Boolean)
        .join(" · "),
      title: artifact.filePath.split(/[\\/]/).at(-1) ?? "Resume export",
    })),
  ];

  const campaignEntries: JobFinderGlobalSearchEntry[] = campaigns.map(
    (campaign) => ({
      campaignId: campaign.id,
      href: `${JOB_FINDER_ROUTE_PATHS.campaigns}?campaignId=${encodeURIComponent(campaign.id)}`,
      id: campaign.id,
      kind: "campaign",
      metadata: [campaign.description, campaign.mode, campaign.status].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
      subtitle:
        campaign.id === workspace.activeCampaignId
          ? "Current search plan"
          : "Search plan",
      title: campaign.name,
    }),
  );

  return [
    ...SCREEN_ENTRIES,
    ...campaignEntries,
    ...jobEntries,
    ...applicationEntries,
    ...documentEntries,
  ];
}
