import { describe, expect, test } from "vitest";

import type { JobDiscoveryTarget } from "@nestor/contracts";

import { createSourceInstructionArtifact } from "../test-fixtures";
import {
  deriveSourceDebugStartingUrls,
  getSourceDebugMaxSteps,
  resolveSourceDebugPhases,
} from "./workspace-source-debug-helpers";

function createTarget(
  overrides: Partial<JobDiscoveryTarget> = {},
): JobDiscoveryTarget {
  return {
    id: "unknown_careers",
    label: "Unknown Careers",
    startingUrl: "https://example.com/careers",
    enabled: true,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
    ...overrides,
  };
}

function createUnknownCareersTarget(): JobDiscoveryTarget {
  return createTarget();
}

function createSearchSurfaceTarget(): JobDiscoveryTarget {
  return createTarget({
    id: "linkedin_default",
    label: "LinkedIn Jobs",
    startingUrl: "https://www.linkedin.com/feed/",
  });
}

function createPublicProviderTarget(): JobDiscoveryTarget {
  return createTarget({
    id: "greenhouse_remote",
    label: "Remote Greenhouse",
    startingUrl: "https://job-boards.greenhouse.io/remote",
  });
}

type RouteKind =
  | "anchor"
  | "listing"
  | "search"
  | "detail"
  | "apply"
  | "collection";

function artifactWithRoutes(
  target: JobDiscoveryTarget,
  routes: {
    startingRoutes?: ReadonlyArray<{ url: string; kind: RouteKind }>;
    searchRouteTemplates?: ReadonlyArray<{ url: string; kind: RouteKind }>;
  },
) {
  const toRoute = (route: { url: string; kind: RouteKind }) => ({
    ...route,
    label: "Route the review recorded",
    confidence: 0.8,
  });
  return createSourceInstructionArtifact({
    id: `instruction_${target.id}`,
    targetId: target.id,
    status: "draft",
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:01:00.000Z",
    acceptedAt: null,
    basedOnRunId: `debug_run_${target.id}`,
    basedOnAttemptIds: [],
    notes: null,
    navigationGuidance: [],
    searchGuidance: [],
    detailGuidance: [],
    applyGuidance: [],
    warnings: [],
    versionInfo: {
      promptProfileVersion: "v1",
      toolsetVersion: "v1",
      adapterVersion: "v1",
      appSchemaVersion: "v1",
    },
    verification: null,
    intelligence: {
      provider: null,
      collection: {
        preferredMethod: "listing_route",
        rankedMethods: ["listing_route", "fallback_search"],
        startingRoutes: (routes.startingRoutes ?? []).map(toRoute),
        searchRouteTemplates: (routes.searchRouteTemplates ?? []).map(toRoute),
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
  });
}

describe("deriveSourceDebugStartingUrls", () => {
  test("starts from the routes the review recorded, by the kind it gave them (ADR 0041)", () => {
    const target = createSearchSurfaceTarget();
    const artifact = artifactWithRoutes(target, {
      startingRoutes: [
        {
          url: "https://www.linkedin.com/jobs/collections/recommended/",
          kind: "collection",
        },
      ],
      searchRouteTemplates: [
        { url: "https://www.linkedin.com/jobs/search/", kind: "search" },
      ],
    });

    expect(
      deriveSourceDebugStartingUrls(target, artifact, "search_filter_probe"),
    ).toEqual([
      "https://www.linkedin.com/jobs/search/",
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/jobs/collections/recommended/",
    ]);
    expect(
      deriveSourceDebugStartingUrls(target, artifact, "site_structure_mapping"),
    ).toEqual([
      "https://www.linkedin.com/jobs/collections/recommended/",
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/jobs/search/",
    ]);
  });

  test("drops broken, detail and apply routes and cleans selection params", () => {
    const target = createUnknownCareersTarget();
    const artifact = artifactWithRoutes(target, {
      startingRoutes: [
        {
          url: "https://example.com/jobs/search?selectedJobId=456",
          kind: "search",
        },
        { url: "https://example.com/404", kind: "listing" },
        { url: "https://example.com/jobs/view/123", kind: "detail" },
        { url: "https://example.com/apply/123", kind: "apply" },
        { url: "https://example.com/vacancies", kind: "listing" },
      ],
    });

    expect(
      deriveSourceDebugStartingUrls(target, artifact, "search_filter_probe"),
    ).toEqual([
      "https://example.com/jobs/search",
      "https://example.com/vacancies",
      "https://example.com/careers",
    ]);
  });

  test("the model's kind stands over what the address looks like", () => {
    const target = createUnknownCareersTarget();
    const artifact = artifactWithRoutes(target, {
      startingRoutes: [
        { url: "https://example.com/jobs/search", kind: "listing" },
      ],
    });

    // Called a listing by the review, it is not tried as a search route.
    expect(
      deriveSourceDebugStartingUrls(target, artifact, "search_filter_probe"),
    ).toEqual([
      "https://example.com/jobs/search",
      "https://example.com/careers",
    ]);
  });

  test("no search address is built from the person's goals", () => {
    const target = createTarget({
      id: "kosovajob",
      label: "KosovaJob",
      startingUrl: "https://kosovajob.com/",
    });
    const artifact = artifactWithRoutes(target, {
      startingRoutes: [{ url: "https://kosovajob.com/jobs", kind: "listing" }],
    });

    expect(
      deriveSourceDebugStartingUrls(target, artifact, "search_filter_probe"),
    ).toEqual(["https://kosovajob.com/jobs", "https://kosovajob.com/"]);
  });

  test("keeps complete browser fallback coverage when a public provider API is unavailable at runtime", () => {
    expect(
      resolveSourceDebugPhases({
        target: createPublicProviderTarget(),
        instructionArtifact: null,
      }),
    ).toEqual(["site_structure_mapping", "replay_verification"]);
  });

  test("falls back to inferred intelligence when persisted intelligence is malformed", () => {
    const instructionArtifact = createSourceInstructionArtifact({
      id: "instruction_malformed_intelligence",
      targetId: createPublicProviderTarget().id,
      status: "draft",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:01:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_malformed_intelligence",
      basedOnAttemptIds: ["debug_attempt_malformed_intelligence"],
      notes: null,
      navigationGuidance: [],
      searchGuidance: [],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: null,
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
    });
    // Simulate malformed persisted intelligence while keeping the rest of the artifact intact.
    (instructionArtifact as unknown as { intelligence: unknown }).intelligence =
      {
        bad: true,
      };

    expect(
      resolveSourceDebugPhases({
        target: createPublicProviderTarget(),
        instructionArtifact,
      }),
    ).toEqual(["site_structure_mapping", "replay_verification"]);
  });
});

describe("getSourceDebugMaxSteps", () => {
  test("reduces non-auth phase budgets when reusable route context already exists", () => {
    expect(
      getSourceDebugMaxSteps("search_filter_probe", {
        hasLearnedRouteHints: true,
        hasPriorPhaseSummary: true,
        hasExistingInstructionArtifact: true,
      }),
    ).toBe(10);

    expect(
      getSourceDebugMaxSteps("access_auth_probe", {
        hasLearnedRouteHints: true,
        hasPriorPhaseSummary: true,
        hasExistingInstructionArtifact: true,
      }),
    ).toBe(16);
  });
});
