import {
  type JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { buildJobFinderGlobalSearchEntries } from "./build-job-finder-global-search-entries";
import { searchJobFinderEntries } from "./job-finder-global-search";

function buildWorkspaceFixture(activeCampaignId: string | null) {
  return {
    applicationRecords: [
      {
        company: "Acme",
        crm: null,
        id: "application-active",
        jobId: "job-active",
        lastActionLabel: null,
        nextActionLabel: null,
        status: "prepared",
        title: "Active plan application",
      },
      {
        company: "Globex",
        crm: null,
        id: "application-other",
        jobId: "job-other",
        lastActionLabel: null,
        nextActionLabel: null,
        status: "applied",
        title: "Other plan application",
      },
      {
        company: "Initech",
        crm: null,
        id: "application-unassigned",
        jobId: "job-missing",
        lastActionLabel: null,
        nextActionLabel: null,
        status: "prepared",
        title: "Unassigned application",
      },
    ],
    campaigns: [
      {
        description: "",
        id: "campaign-active",
        jobIds: ["job-active"],
        mode: "precision",
        name: "Active plan",
        status: "active",
      },
      {
        description: "",
        id: "campaign-other",
        jobIds: ["job-other"],
        mode: "scale",
        name: "Other plan",
        status: "draft",
      },
    ],
    discoveryJobs: [
      {
        company: "Acme",
        id: "job-active",
        location: "Remote",
        matchAssessment: { reasons: [], recommendation: "review" },
        status: "new",
        title: "Active plan job",
        workMode: ["remote"],
      },
      {
        company: "Globex",
        id: "job-other",
        location: "Berlin",
        matchAssessment: { reasons: [], recommendation: "review" },
        status: "new",
        title: "Other plan job",
        workMode: ["hybrid"],
      },
      {
        company: "Initech",
        id: "job-unassigned",
        location: "Remote",
        matchAssessment: { reasons: [], recommendation: "review" },
        status: "new",
        title: "Unassigned job",
        workMode: ["remote"],
      },
    ],
    intelligence: { companies: [] },
    resumeExportArtifacts: [
      {
        filePath: "/exports/active-plan-resume.pdf",
        format: "pdf",
        id: "export-active",
        jobId: "job-active",
        templateId: "modern",
      },
    ],
    tailoredAssets: [
      {
        id: "asset-active",
        jobId: "job-active",
        label: "Active plan resume",
        status: "ready",
        templateName: "Modern",
        version: "v1",
      },
      {
        id: "asset-other",
        jobId: "job-other",
        label: "Other plan resume",
        status: "ready",
        templateName: "Classic",
        version: "v1",
      },
    ],
    activeCampaignId,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("buildJobFinderGlobalSearchEntries", () => {

  it("keeps the exact job and application context in search links", () => {
    const workspace = {
      campaigns: [],
      discoveryJobs: [
        {
          company: "Acme",
          id: "job-target",
          location: "Remote",
          matchAssessment: { reasons: [], recommendation: "review" },
          status: "new",
          title: "Target job",
          workMode: ["remote"],
        },
      ],
      applicationRecords: [
        {
          company: "Acme",
          id: "application-target",
          jobId: "job-target",
          lastActionLabel: null,
          nextActionLabel: null,
          status: "prepared",
          title: "Target application",
          crm: null,
        },
      ],
      intelligence: { companies: [] },
      resumeExportArtifacts: [],
      tailoredAssets: [],
    } as unknown as JobFinderRendererWorkspaceSnapshot;

    const entries = buildJobFinderGlobalSearchEntries(workspace);

    expect(entries.find((entry) => entry.kind === "job")?.href).toBe(
      "/job-finder/discovery?jobId=job-target",
    );
    expect(entries.find((entry) => entry.kind === "application")?.href).toBe(
      "/job-finder/applications?applicationRecordId=application-target",
    );
  });

  it("keeps the retired company catalog out of global search", () => {
    const workspace = {
      campaigns: [],
      discoveryJobs: [],
      applicationRecords: [],
      intelligence: {
        companies: [
          {
            aliases: [],
            applicationRecordIds: [],
            canonicalName: "Employer not stated",
            domains: [],
            id: "company-placeholder",
            jobIds: ["job-1"],
            preference: "neutral",
          },
          {
            aliases: [],
            applicationRecordIds: [],
            canonicalName: "Acme Inc",
            domains: [],
            id: "company-real",
            jobIds: ["job-2"],
            preference: "follow",
          },
        ],
      },
      resumeExportArtifacts: [],
      tailoredAssets: [],
    } as unknown as JobFinderRendererWorkspaceSnapshot;

    const companyIds = buildJobFinderGlobalSearchEntries(workspace)
      .filter((entry) => entry.kind === "company")
      .map((entry) => entry.id);

    expect(companyIds).toEqual([]);
  });

  it("keeps every saved record searchable and labels the ones outside the active plan", () => {
    // Home advertises every job saved on the device; a search box that denied
    // 35 of 50 existed read as the app losing them. Out-of-plan rows stay
    // findable and say where they stand.
    const entries = buildJobFinderGlobalSearchEntries(
      buildWorkspaceFixture("campaign-active"),
    );

    const idsOf = (kind: string) =>
      entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);

    expect(idsOf("job")).toEqual(["job-active", "job-other", "job-unassigned"]);
    expect(idsOf("application")).toEqual([
      "application-active",
      "application-other",
      "application-unassigned",
    ]);
    expect(idsOf("document")).toEqual([
      "asset-active",
      "asset-other",
      "export-active",
    ]);

    const jobEntry = entries.find((entry) => entry.id === "job-active");
    expect(jobEntry?.campaignId).toBe("campaign-active");
    expect(jobEntry?.href).toBe("/job-finder/discovery?jobId=job-active");
    expect(jobEntry?.subtitle).toBe("Acme · Remote · Active plan");

    const otherPlanJob = entries.find((entry) => entry.id === "job-other");
    expect(otherPlanJob?.campaignId).toBeNull();
    expect(otherPlanJob?.subtitle).toBe(
      "Globex · Berlin · Saved on this device, not in this search plan",
    );
  });

  it("includes every record when no search plan is active", () => {
    const entries = buildJobFinderGlobalSearchEntries(
      buildWorkspaceFixture(null),
    );

    const idsOf = (kind: string) =>
      entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);

    expect(idsOf("job")).toEqual(["job-active", "job-other", "job-unassigned"]);
    expect(idsOf("application")).toEqual([
      "application-active",
      "application-other",
      "application-unassigned",
    ]);
    expect(idsOf("document")).toEqual([
      "asset-active",
      "asset-other",
      "export-active",
    ]);

    // Records carrying a campaign id keep their own campaign metadata.
    const otherPlanJob = entries.find((entry) => entry.id === "job-other");
    expect(otherPlanJob?.campaignId).toBe("campaign-other");
    expect(otherPlanJob?.subtitle).toBe("Globex · Berlin · Other plan");

    // Unassigned records stay searchable without a campaign label.
    const unassignedJob = entries.find(
      (entry) => entry.id === "job-unassigned",
    );
    expect(unassignedJob?.campaignId).toBeNull();
    expect(unassignedJob?.subtitle).toBe("Initech · Remote");
  });
});

describe("screens in the workspace search", () => {
  it("finds a screen by name or by a word for it, under any plan", () => {
    const workspace = buildWorkspaceFixture("campaign_1");
    const entries = buildJobFinderGlobalSearchEntries(workspace);
    const first = (query: string) =>
      searchJobFinderEntries(entries, query, { campaignId: "campaign_1" })[0];

    expect(first("sett")).toMatchObject({ kind: "screen" });
    expect(first("sett")?.entries[0]?.title).toBe("Settings");
    expect(first("send for me")?.entries[0]).toMatchObject({
      title: "Applying settings",
      href: "/job-finder/settings#settings-application-authority",
    });
    expect(first("shortl")?.entries[0]?.href).toBe("/job-finder/review-queue");
  });
});
