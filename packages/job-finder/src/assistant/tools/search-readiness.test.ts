import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildContextBlock,
  buildProfileDigest,
  getAssistantSearchReadiness,
} from "../prompt";
import { getWorkspaceSummaryTool } from "./workspace-tools";

async function freshSnapshot() {
  const { workspaceService } = createWorkspaceServiceHarness();
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  snapshot.browserSession = {
    ...snapshot.browserSession,
    driver: "uninitialized",
    status: "unknown",
  };
  snapshot.activityControl.paused = false;
  return snapshot;
}

async function summary(snapshot: JobFinderWorkspaceSnapshot) {
  return getWorkspaceSummaryTool.execute(
    {},
    {
      service: {
        getWorkspaceSnapshot: () => Promise.resolve(snapshot),
      } as never,
      session: {} as never,
      ports: {} as never,
    },
  );
}

describe("sidebar search readiness", () => {
  it("names the missing source when profile details are saved but Search now is disabled", async () => {
    const snapshot = await freshSnapshot();
    snapshot.searchPreferences.discovery.targets = [];
    const outcome = await summary(snapshot);
    expect(outcome.summary).toContain(
      "Add or enable at least one valid public job-source URL",
    );
    expect(outcome.data).toMatchObject({
      search: {
        enabledSourceCount: 0,
        enabledSources: [],
        canStartSearch: false,
        resumeRequired: false,
        targetRolesRequired: false,
        missingRequirements: [
          "Add or enable at least one valid public job-source URL before searching.",
        ],
      },
    });
    expect(buildProfileDigest(snapshot)).toContain(
      "Use list_sites for current source IDs",
    );
    expect(buildProfileDigest(snapshot)).not.toContain(
      "Enabled valid job sources:",
    );
    const context = buildContextBlock({
      context: null,
      resultSets: [],
      snapshot,
      plan: null,
      grants: [],
      pendingQuestions: [],
      now: "2026-09-30T00:00:00.000Z",
    });
    expect(context).toContain("Search readiness: Add or enable");
    expect(context).toContain("A resume is not required for searching");
  });

  it("only counts enabled HTTP sources and gives their IDs and URLs", async () => {
    const snapshot = await freshSnapshot();
    const base = snapshot.searchPreferences.discovery.targets[0]!;
    snapshot.searchPreferences.discovery.targets = [
      {
        ...base,
        id: "off",
        enabled: false,
        startingUrl: "https://jobs.example.test/off",
      },
      {
        ...base,
        id: "invalid",
        enabled: true,
        startingUrl: "file:///resume.pdf",
      },
      {
        ...base,
        id: "on",
        label: "Public Board",
        enabled: true,
        startingUrl: "https://jobs.example.test/board",
      },
    ];
    const outcome = await summary(snapshot);
    expect(outcome.data).toMatchObject({
      search: {
        enabledSourceCount: 1,
        canStartSearch: true,
        enabledSources: [
          {
            id: "on",
            label: "Public Board",
            url: "https://jobs.example.test/board",
          },
        ],
      },
    });
    const digest = buildProfileDigest(snapshot);
    expect(digest).toContain("Job sites are stored separately from Profile");
    expect(digest).not.toContain("Public Board");
    expect(digest).not.toContain("https://jobs.example.test/off");
    expect(digest).not.toContain("file:///resume.pdf");
  });

  it("does not turn missing resume, roles or eligibility into search prerequisites", async () => {
    const snapshot = await freshSnapshot();
    snapshot.profile.baseResume.storagePath = null;
    snapshot.profile.baseResume.textContent = null;
    snapshot.profile.workEligibility.authorizedWorkCountries = [];
    snapshot.profile.workEligibility.requiresVisaSponsorship = null;
    snapshot.searchPreferences.targetRoles = [];
    snapshot.searchPreferences.jobFamilies = [];
    expect(getAssistantSearchReadiness(snapshot)).toMatchObject({
      canStartSearch: true,
      missingRequirements: [],
      resumeRequired: false,
      targetRolesRequired: false,
    });
    expect((await summary(snapshot)).summary).toContain("Ready to search");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "not prerequisites for searching",
    );
  });

  it("reports a person's pause and unavailable browser separately from setup gaps", async () => {
    const snapshot = await freshSnapshot();
    snapshot.activityControl.paused = true;
    expect(getAssistantSearchReadiness(snapshot)).toMatchObject({
      canStartSearch: false,
      missingRequirements: [
        "Background work is paused; ask whether to resume before starting a search.",
      ],
    });
    snapshot.activityControl.paused = false;
    snapshot.browserSession.status = "blocked";
    expect(getAssistantSearchReadiness(snapshot).missingRequirements).toEqual([
      "The Job Finder browser needs attention before the next search.",
    ]);
    snapshot.browserSession.driver = "catalog_seed";
    expect(getAssistantSearchReadiness(snapshot).missingRequirements).toEqual([
      "Current-source searching is temporarily unavailable; try again in a moment.",
    ]);
  });
});
