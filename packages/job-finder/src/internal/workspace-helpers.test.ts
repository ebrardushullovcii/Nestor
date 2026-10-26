import { describe, expect, test } from "vitest";

import type { ApplicationEvent } from "@nestor/contracts";

import {
  MAX_APPLICATION_EVENT_HISTORY,
  buildInstructionGuidance,
  enrichSearchPreferencesFromProfile,
  mergeEvents,
} from "./workspace-helpers";
import {
  createSeed,
  createSourceInstructionArtifact,
} from "../test-fixtures";

describe("workspace profile-inferred search intent", () => {
  test("uses saved experience titles when explicit target roles are empty", () => {
    const seed = createSeed();
    const preferences = {
      ...seed.searchPreferences,
      targetRoles: [],
      jobFamilies: [],
    };
    const profile = {
      ...seed.profile,
      targetRoles: [],
      experiences: [
        { ...seed.profile.experiences[0]!, title: "Operations Coordinator" },
        { ...seed.profile.experiences[0]!, id: "experience_2", title: null },
      ],
    };

    expect(
      enrichSearchPreferencesFromProfile(preferences, profile).targetRoles,
    ).toEqual(["Operations Coordinator", "Senior systems designer"]);
  });

  test("does not turn the current address into a search constraint for remote-only discovery", () => {
    const seed = createSeed();
    const preferences = {
      ...seed.searchPreferences,
      locations: [],
      workModes: ["remote" as const],
    };
    const profile = {
      ...seed.profile,
      currentLocation: "Prishtina, Kosovo",
    };

    expect(
      enrichSearchPreferencesFromProfile(preferences, profile).locations,
    ).toEqual([]);
  });
});

describe("workspace discovery instruction guidance", () => {
  test("passes the reviewed guidance through as written, by category", () => {
    const artifact = createSourceInstructionArtifact({
      id: "instruction_linkedin_discovery_guidance_filtering",
      targetId: "1",
      status: "draft",
      createdAt: "2026-04-21T10:26:35.684Z",
      updatedAt: "2026-04-21T10:31:47.360Z",
      acceptedAt: null,
      basedOnRunId: "source_debug_target_linkedin",
      basedOnAttemptIds: ["attempt_1"],
      notes: null,
      navigationGuidance: [
        "URL-based search: /jobs/search/?keywords=...&location=...",
        "Direct navigation to /jobs/ for job hub",
        'LinkedIn jobs surface is fully accessible. Best entry path is /jobs/search/?keywords=...&location=... URL parameters. Jobs hub at /jobs/ shows recommendation rows with "Show all available jobs" and "Show all top job picks for you" links. Job listings are clickable and open detail panels. Filter button ("Show all filters") available on search results.',
      ],
      searchGuidance: [
        'LinkedIn jobs search surface has reliable controls: URL-based search with keywords/location parameters, "Show all filters" button opens inline filter panel with checkboxes (Remote, On-site, Experience level), and URL parameters like f_R=on can filter results. Jobs open in side panels, not separate pages.',
        "Apply button appears on job detail side panels",
      ],
      detailGuidance: [
        "Job listings are clickable and open detail side panels/modals",
      ],
      applyGuidance: [
        'LinkedIn jobs expose a stable apply path: click a job listing to open the side detail panel, then click the "Apply" button on that panel.',
      ],
      warnings: [],
      intelligence: {
        provider: {
          key: "linkedin",
          label: "LinkedIn Jobs",
          confidence: 0.98,
          apiAvailability: "not_supported",
          publicApiUrlTemplate: null,
          boardToken: null,
          boardSlug: null,
          providerIdentifier: "linkedin_jobs",
        },
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [],
          searchRouteTemplates: [],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: [],
        },
      },
      versionInfo: {
        promptProfileVersion: "source-debug-v1",
        toolsetVersion: "browser-tools-v1",
        adapterVersion: "target_site-adapter-v1",
        appSchemaVersion: "job-finder-source-debug-v1",
      },
      verification: null,
    });

    // The final review decided what to keep (ADR 0041); no keyword list
    // drops lines on the way to the agent.
    expect(buildInstructionGuidance(artifact)).toEqual([
      ...artifact.navigationGuidance.map((line) => `[Navigation] ${line}`),
      ...artifact.searchGuidance.map((line) => `[Search] ${line}`),
      ...artifact.detailGuidance.map((line) => `[Detail] ${line}`),
      ...artifact.applyGuidance.map((line) => `[Apply] ${line}`),
    ]);
  });
});

function createApplicationEvent(
  id: string,
  at: string,
  overrides: Partial<ApplicationEvent> = {},
): ApplicationEvent {
  return {
    id,
    at,
    title: `Event ${id}`,
    detail: `Detail for ${id}`,
    emphasis: "neutral",
    ...overrides,
  };
}

function eventTimestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
}

describe("mergeEvents application event history bound", () => {
  test("keeps every event below the history limit", () => {
    const existing = [
      createApplicationEvent("event_old", eventTimestamp(0)),
      createApplicationEvent("event_mid", eventTimestamp(1)),
    ];
    const additional = [
      createApplicationEvent("event_new", eventTimestamp(2), {
        emphasis: "positive",
      }),
    ];

    expect(mergeEvents(existing, additional)).toHaveLength(3);
  });

  test("keeps every event exactly at the history limit", () => {
    const events = Array.from(
      { length: MAX_APPLICATION_EVENT_HISTORY },
      (_, index) =>
        createApplicationEvent(`event_${index}`, eventTimestamp(index)),
    );

    const merged = mergeEvents(events, []);

    expect(merged).toHaveLength(MAX_APPLICATION_EVENT_HISTORY);
    expect(merged[0]?.id).toBe(`event_${MAX_APPLICATION_EVENT_HISTORY - 1}`);
  });

  test("keeps only the newest events above the history limit", () => {
    const total = MAX_APPLICATION_EVENT_HISTORY + 3;
    const existing = Array.from({ length: total }, (_, index) =>
      createApplicationEvent(`event_${index}`, eventTimestamp(index)),
    );

    const merged = mergeEvents(existing, []);

    expect(merged).toHaveLength(MAX_APPLICATION_EVENT_HISTORY);
    expect(merged[0]?.id).toBe(`event_${total - 1}`);
    expect(merged.at(-1)?.id).toBe(
      `event_${total - MAX_APPLICATION_EVENT_HISTORY}`,
    );
    for (const dropped of [0, 1, 2]) {
      expect(merged.some((event) => event.id === `event_${dropped}`)).toBe(
        false,
      );
    }
  });

  test("replaces duplicate ids without growing history or consuming extra slots", () => {
    const existing = Array.from(
      { length: MAX_APPLICATION_EVENT_HISTORY },
      (_, index) =>
        createApplicationEvent(`event_${index}`, eventTimestamp(index)),
    );
    const retried = createApplicationEvent("event_5", eventTimestamp(5), {
      title: "Retry outcome",
      emphasis: "warning",
    });
    const fresh = createApplicationEvent(
      "event_fresh",
      eventTimestamp(MAX_APPLICATION_EVENT_HISTORY),
    );

    const merged = mergeEvents(existing, [fresh, retried]);

    expect(merged).toHaveLength(MAX_APPLICATION_EVENT_HISTORY);
    expect(merged.find((event) => event.id === "event_5")).toMatchObject({
      title: "Retry outcome",
      emphasis: "warning",
    });
    expect(merged.some((event) => event.id === "event_0")).toBe(false);
  });

  test("orders timestamp ties deterministically by input order", () => {
    const sameTime = eventTimestamp(0);
    const existing = [
      createApplicationEvent("existing_a", sameTime),
      createApplicationEvent("existing_b", sameTime),
    ];
    const additional = [createApplicationEvent("additional_c", sameTime)];

    const merged = mergeEvents(existing, additional);

    expect(merged.map((event) => event.id)).toEqual([
      "existing_a",
      "existing_b",
      "additional_c",
    ]);
  });

  test("returns a stable newest-first order regardless of input order", () => {
    const merged = mergeEvents(
      [createApplicationEvent("mid", eventTimestamp(1))],
      [
        createApplicationEvent("newest", eventTimestamp(2)),
        createApplicationEvent("oldest", eventTimestamp(0)),
      ],
    );

    expect(merged.map((event) => event.id)).toEqual([
      "newest",
      "mid",
      "oldest",
    ]);
  });
});
