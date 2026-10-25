import { describe, expect, test } from "vitest";

import {
  DISCOVERY_OBSERVATION_ACCESSIBILITY_SUMMARY_MAX,
  DISCOVERY_OBSERVATION_ACTION_CANDIDATES_MAX,
  DISCOVERY_OBSERVATION_POSTING_CANDIDATES_MAX,
  DISCOVERY_OBSERVATION_PAGINATION_CANDIDATES_MAX,
  DISCOVERY_OBSERVATION_TEXT_SAMPLE_MAX,
  DiscoveryCompactObservationControlRefSchema,
  DiscoveryCompactObservationSchema,
  getDiscoveryCompactObservationControlRef,
  isCurrentDiscoveryCompactObservationRef,
} from "./discovery";

const identityInput = {
  observationId: "obs_target_1_0001",
  revision: 3,
  targetId: "target_1",
  observedAt: "2026-08-26T10:00:00.000Z",
  pageUrl: "https://example.com/jobs",
};

const supportedInput = {
  kind: "supported" as const,
  ...identityInput,
  sourceKind: "accessibility_snapshot" as const,
};

// Same minimal shape the existing source-generic posting contracts accept;
// compact observations reuse JobPostingSchema instead of a parallel shape.
const postingCandidate = {
  source: "target_site" as const,
  sourceJobId: "job_1",
  canonicalUrl: "https://example.com/jobs/job-1",
  title: "Software Engineer",
  company: "Acme",
  location: "Remote",
  workMode: ["remote"] as const,
  applyPath: "unknown" as const,
  easyApplyEligible: false,
  discoveredAt: "2026-08-26T10:00:00.000Z",
  salaryText: null,
  description: "Software Engineer role at Acme",
};

describe("compact discovery observation contracts", () => {
  test("defaults a minimal supported observation to empty bounded content", () => {
    const observation = DiscoveryCompactObservationSchema.parse(
      supportedInput,
    );

    expect(observation.kind).toBe("supported");
    expect(observation).toMatchObject({
      observationId: identityInput.observationId,
      revision: 3,
      pageTitle: null,
      content: {
        textSample: null,
        accessibilitySummary: null,
        textTruncated: false,
        accessibilitySummaryTruncated: false,
      },
      postingCandidates: [],
      paginationCandidates: [],
      actionCandidates: [],
      uncertaintyNotes: [],
      omittedPostingCandidateCount: 0,
    });
  });

  test("parses posting candidates through the existing source-generic posting schema", () => {
    const observation = DiscoveryCompactObservationSchema.parse({
      ...supportedInput,
      postingCandidates: [postingCandidate],
      paginationCandidates: [
        {
          refId: "ctl_next",
          kind: "next_page",
          label: "Next",
          pageNumber: null,
        },
      ],
      actionCandidates: [
        {
          refId: "ctl_open_job_1",
          kind: "open_posting",
          label: "Software Engineer at Acme",
        },
      ],
    });
    expect(observation.kind).toBe("supported");
    if (observation.kind !== "supported") {
      throw new Error("Expected a supported observation.");
    }

    expect(observation.postingCandidates[0]).toMatchObject({
      title: "Software Engineer",
      company: "Acme",
      detailQuality: "card_only",
    });
    expect(observation.paginationCandidates[0]).toMatchObject({
      refId: "ctl_next",
      kind: "next_page",
      label: "Next",
    });
    expect(observation.actionCandidates[0]).toMatchObject({
      refId: "ctl_open_job_1",
      kind: "open_posting",
    });
  });

  test("preserves bounded summaries and explicit truncation flags", () => {
    const observation = DiscoveryCompactObservationSchema.parse({
      ...supportedInput,
      content: {
        textSample: "Senior Platform Engineer — Acme — Remote",
        accessibilitySummary:
          "list with 25 job cards, next page button, cookie dialog",
        textTruncated: true,
        accessibilitySummaryTruncated: true,
      },
      uncertaintyNotes: ["Two cards had no readable employer name."],
      omittedPostingCandidateCount: 7,
    });
    expect(observation.kind).toBe("supported");
    if (observation.kind !== "supported") {
      throw new Error("Expected a supported observation.");
    }

    expect(observation.content).toEqual({
      textSample: "Senior Platform Engineer — Acme — Remote",
      accessibilitySummary:
        "list with 25 job cards, next page button, cookie dialog",
      textTruncated: true,
      accessibilitySummaryTruncated: true,
    });
    expect(observation.omittedPostingCandidateCount).toBe(7);
  });

  test("parses an explicit unsupported observation without candidate fields", () => {
    const observation = DiscoveryCompactObservationSchema.parse({
      kind: "unsupported",
      ...identityInput,
      reason: "unsupported_layout",
      detail: "The listing grid rendered no readable cards after one probe.",
    });

    expect(observation.kind).toBe("unsupported");
    if (observation.kind !== "unsupported") {
      throw new Error("Expected an unsupported observation.");
    }
    expect(observation.reason).toBe("unsupported_layout");
    expect(observation.content.textSample).toBeNull();
    expect(Object.hasOwn(observation, "postingCandidates")).toBe(false);
    expect(Object.hasOwn(observation, "paginationCandidates")).toBe(false);
  });

  test("fails closed on malformed identity, kinds, reasons, and labels", () => {
    const malformedInputs = [
      { ...supportedInput, observedAt: "not-a-date" },
      { ...supportedInput, pageUrl: "not-a-url" },
      { ...supportedInput, revision: 0 },
      { ...supportedInput, revision: 1.5 },
      { ...supportedInput, kind: "partial" },
      { ...supportedInput, sourceKind: "raw_dom_html" },
      { ...supportedInput, omittedPostingCandidateCount: -1 },
      {
        kind: "unsupported",
        ...identityInput,
        reason: "too_slow",
      },
      {
        ...supportedInput,
        paginationCandidates: [
          { refId: "ctl_next", kind: "next_page", label: "" },
        ],
      },
      {
        ...supportedInput,
        paginationCandidates: [
          {
            refId: "ctl_page_zero",
            kind: "numbered_page",
            label: "Page zero",
            pageNumber: 0,
          },
        ],
      },
    ];

    for (const input of malformedInputs) {
      expect(
        DiscoveryCompactObservationSchema.safeParse(input).success,
        `expected rejection for ${JSON.stringify(input)}`,
      ).toBe(false);
    }
  });

  test("fails closed on oversized bounded fields", () => {
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        content: {
          textSample: "a".repeat(DISCOVERY_OBSERVATION_TEXT_SAMPLE_MAX),
        },
      }).success,
    ).toBe(true);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        content: {
          textSample: "a".repeat(DISCOVERY_OBSERVATION_TEXT_SAMPLE_MAX + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        content: {
          accessibilitySummary: "a".repeat(
            DISCOVERY_OBSERVATION_ACCESSIBILITY_SUMMARY_MAX + 1,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        paginationCandidates: Array.from(
          { length: DISCOVERY_OBSERVATION_PAGINATION_CANDIDATES_MAX + 1 },
          (_, index) => ({
            refId: `ctl_page_${index}`,
            kind: "numbered_page" as const,
            label: `Page ${index + 1}`,
            pageNumber: index + 1,
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        actionCandidates: Array.from(
          { length: DISCOVERY_OBSERVATION_ACTION_CANDIDATES_MAX + 1 },
          (_, index) => ({
            refId: `ctl_action_${index}`,
            kind: "open_posting" as const,
            label: `Open posting ${index + 1}`,
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        uncertaintyNotes: Array.from(
          { length: 17 },
          (_, index) => `Uncertainty ${index}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        postingCandidates: Array.from(
          { length: DISCOVERY_OBSERVATION_POSTING_CANDIDATES_MAX + 1 },
          () => postingCandidate,
        ),
      }).success,
    ).toBe(false);
  });

  test("fails closed when snapshot-scoped reference ids collide", () => {
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        paginationCandidates: [
          { refId: "ctl_dup", kind: "next_page", label: "Next" },
        ],
        actionCandidates: [
          { refId: "ctl_dup", kind: "open_posting", label: "Open" },
        ],
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        paginationCandidates: [
          { refId: "ctl_a", kind: "next_page", label: "Next" },
          { refId: "ctl_b", kind: "load_more", label: "Show more" },
        ],
        actionCandidates: [
          { refId: "ctl_c", kind: "close_overlay", label: "Accept" },
        ],
      }).success,
    ).toBe(true);
  });

  test("fails closed on extra keys so DOM handles and selectors cannot ride along", () => {
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        cssSelector: "#results-list li",
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationSchema.safeParse({
        ...supportedInput,
        paginationCandidates: [
          {
            refId: "ctl_next",
            kind: "next_page",
            label: "Next",
            locatorHandle: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationControlRefSchema.safeParse({
        observationId: "obs_1",
        observationRevision: 1,
        refId: "ctl_1",
        element: {},
      }).success,
    ).toBe(false);
    expect(
      DiscoveryCompactObservationControlRefSchema.safeParse({
        observationId: "",
        observationRevision: 0,
        refId: "",
      }).success,
    ).toBe(false);
  });

  test("detects stale snapshot-scoped references by observation id and revision", () => {
    const observation = DiscoveryCompactObservationSchema.parse({
      ...supportedInput,
      paginationCandidates: [
        { refId: "ctl_next", kind: "next_page", label: "Next" },
      ],
    });
    const ref = getDiscoveryCompactObservationControlRef(
      observation,
      "ctl_next",
    );

    expect(ref).toEqual({
      observationId: identityInput.observationId,
      observationRevision: 3,
      refId: "ctl_next",
    });
    expect(isCurrentDiscoveryCompactObservationRef(ref, observation)).toBe(
      true,
    );
    expect(
      isCurrentDiscoveryCompactObservationRef(ref, {
        observationId: identityInput.observationId,
        revision: 4,
      }),
    ).toBe(false);
    expect(
      isCurrentDiscoveryCompactObservationRef(ref, {
        observationId: "obs_target_1_0002",
        revision: 3,
      }),
    ).toBe(false);
  });
});
