import { describe, expect, test } from "vitest";
import { JobPostingSchema } from "@nestor/contracts";

import { stripPictographGlyphs } from "@nestor/browser-agent/listing-detail-extraction";
import {
  normalizeListingText,
  resolveListingEmployer,
  resolvePostingProducingTarget,
} from "./workspace-discovery-methods";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";

/** The glyph a broken byte leaves behind, written here without pasting it. */
const REPLACEMENT = String.fromCodePoint(0xfffd);

describe("normalizeListingText", () => {
  test("decodes HTML entities in plain listing text", () => {
    expect(normalizeListingText("Rose, Klein &amp; Marias")).toBe(
      "Rose, Klein & Marias",
    );
    expect(normalizeListingText("Caf&eacute; &#8212; Remote")).toBe(
      "Café — Remote",
    );
  });

  test("strips markup and decodes entities together", () => {
    expect(normalizeListingText("<strong>Jon &amp; Jon</strong>")).toBe(
      "Jon & Jon",
    );
  });

  test("keeps the original text rather than normalizing it away", () => {
    expect(normalizeListingText("<span></span>")).toBe("<span></span>");
  });

  test("never lets a replacement glyph reach a title", () => {
    expect(
      normalizeListingText("Sales Development Representative Attribut&#65533;"),
    ).toBe("Sales Development Representative Attribut");
    expect(
      normalizeListingText(
        "Sales Development Representative Attribut" + REPLACEMENT,
      ),
    ).toBe("Sales Development Representative Attribut");
    // The glyph stood in for one lost character, so the word closes up.
    expect(normalizeListingText("Acme" + REPLACEMENT + "Corp")).toBe(
      "AcmeCorp",
    );
    expect(normalizeListingText("Acme " + REPLACEMENT + " Corp")).toBe(
      "Acme Corp",
    );
  });

  test("keeps the original text when nothing decodable is left", () => {
    expect(normalizeListingText(REPLACEMENT)).toBe(REPLACEMENT);
  });

  test("passes through absent values", () => {
    expect(normalizeListingText(null)).toBeNull();
    expect(normalizeListingText(undefined)).toBeUndefined();
  });
});

describe("resolveListingEmployer", () => {
  test("keeps a real employer, decoded", () => {
    expect(
      resolveListingEmployer("Rose, Klein &amp; Marias", "Support Agent"),
    ).toBe("Rose, Klein & Marias");
  });

  test("refuses an employer that repeats the job title", () => {
    expect(
      resolveListingEmployer(
        "Customer Support Agent",
        "Customer Support Agent",
      ),
    ).toBe("Employer not stated");
    expect(
      resolveListingEmployer(
        "customer support agent!",
        "Customer Support Agent",
      ),
    ).toBe("Employer not stated");
  });

  test("keeps a one-character employer and refuses a missing employer", () => {
    expect(resolveListingEmployer("X", "Junior Procurement Specialist")).toBe(
      "X",
    );
    expect(resolveListingEmployer(null, "Data Entry Assistant")).toBe(
      "Employer not stated",
    );
  });
});

describe("run-wide salary normalization", () => {
  test("keeps a shared band only where the listing body states it", async () => {
    const sharedBand = "$80000 - 150000";
    const descriptions = [
      "Base pay is $80,000 - $150,000 depending on experience.",
      "Lead product design systems.",
      "Improve customer-facing workflows.",
      "Build accessible design foundations.",
    ];
    const browserRuntime = createAgentBrowserRuntime(
      descriptions.map((description, index) => ({
        source: "target_site",
        sourceJobId: `shared_salary_${index + 1}`,
        discoveryMethod: "browser_agent",
        canonicalUrl: `https://jobs.example.test/${index + 1}`,
        title: `Senior Product Designer ${index + 1}`,
        company: "Example Corp",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "unknown",
        easyApplyEligible: false,
        postedAt: null,
        postedAtText: null,
        discoveredAt: "2026-09-12T10:00:00.000Z",
        salaryText: sharedBand,
        summary: description,
        description,
        keySkills: ["Design Systems"],
      })),
    );
    const seed = createSeed();
    seed.savedJobs = [];
    seed.discovery.pendingDiscoveryJobs = [];
    seed.discovery.discoveryLedger = [];
    seed.searchPreferences.companyWhitelist = [];
    seed.searchPreferences.targetRoles = ["Senior Product Designer"];
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_salary_shape",
        label: "Salary shape target",
        startingUrl: "https://jobs.example.test/search",
      },
    ];
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_salary_shape",
      () => {},
      new AbortController().signal,
    );
    const salaryBySourceJobId = Object.fromEntries(
      snapshot.discoveryJobs.map((job) => [
        job.sourceJobId,
        job.salaryText ?? "not stated",
      ]),
    );

    expect(salaryBySourceJobId).toEqual({
      shared_salary_1: sharedBand,
      shared_salary_2: "not stated",
      shared_salary_3: "not stated",
      shared_salary_4: "not stated",
    });
  });

  test("reassesses a removed furniture band before campaign retention", async () => {
    // The pay band every listing shared is site furniture: removed before the
    // plan keeps its jobs, so no pay comparison rests on it.
    const sharedBand = "$180k - $220k";
    const seed = createSeed();
    seed.savedJobs = [];
    seed.discovery.pendingDiscoveryJobs = [];
    seed.discovery.discoveryLedger = [];
    seed.searchPreferences.companyWhitelist = [];
    seed.searchPreferences.locations = ["London"];
    seed.searchPreferences.workModes = ["hybrid"];
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_salary_retention",
        label: "Salary retention target",
        startingUrl: "https://jobs.example.test/search",
      },
    ];
    const postings = Array.from({ length: 4 }, (_, index) =>
      JobPostingSchema.parse({
        source: "target_site",
        sourceJobId: `salary_retention_${index + 1}`,
        discoveryMethod: "browser_agent",
        canonicalUrl: `https://jobs.example.test/retention/${index + 1}`,
        title: "Senior Product Designer",
        company: `Example Corp ${index + 1}`,
        location: "London, UK",
        workMode: ["hybrid"],
        applyPath: "unknown",
        easyApplyEligible: false,
        postedAt: null,
        postedAtText: null,
        discoveredAt: "2026-09-12T10:00:00.000Z",
        salaryText: sharedBand,
        summary: "Lead product workflow design.",
        description:
          "Lead product workflow design, accessible design systems, and Figma delivery for a growing platform.",
        keySkills: ["Figma"],
        responsibilities: ["Lead accessible product workflow design."],
        minimumQualifications: ["Figma"],
        preferredQualifications: [],
        seniority: "Senior",
        employmentType: "Full-time",
        department: "Design",
        team: "Product Design",
        employerWebsiteUrl: `https://example-${index + 1}.test`,
        employerDomain: `example-${index + 1}.test`,
        benefits: ["Flexible collaboration"],
        detailQuality: "detail_enriched",
      }),
    );
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createAgentBrowserRuntime(postings),
      aiClient: createAgentAiClient(),
    });
    const initial = await workspaceService.getWorkspaceSnapshot();
    const active = initial.campaigns.find(
      (campaign) => campaign.id === initial.activeCampaignId,
    );
    if (!active) throw new Error("Expected the default search plan.");

    const snapshot = await workspaceService.runAgentDiscovery();
    const sanitized = snapshot.discoveryJobs.find(
      (job) => job.sourceJobId === "salary_retention_1",
    );

    expect(sanitized).toMatchObject({
      salaryText: null,
      matchAssessment: { compensationFit: { state: "unknown" } },
    });
  });
});

describe("stripPictographGlyphs", () => {
  const PIN = String.fromCodePoint(0x1f4cd);
  const FLAG = String.fromCodePoint(0x1f1f7) + String.fromCodePoint(0x1f1fa);

  test("removes emoji from a scraped field", () => {
    expect(stripPictographGlyphs(PIN + " Remote, Germany")).toBe(
      "Remote, Germany",
    );
    expect(stripPictographGlyphs("Acme Corp " + FLAG)).toBe("Acme Corp");
  });

  test("keeps a company name written in another script", () => {
    expect(stripPictographGlyphs("Яндекс")).toBe("Яндекс");
    expect(stripPictographGlyphs("شركة أراмко")).toBe("شركة أراмко");
  });

  test("passes through absent values", () => {
    expect(stripPictographGlyphs(null)).toBeNull();
    expect(stripPictographGlyphs(undefined)).toBeUndefined();
  });
});

test("attributes a redirected extraction to the producing configured source through persistence", async () => {
  const seed = createSeed();
  const atlas = {
    ...seed.searchPreferences.discovery.targets[0]!,
    id: "atlas",
    label: "Atlas",
    startingUrl: "https://atlas.example.test/jobs",
  };
  const lever = {
    ...atlas,
    id: "lever",
    label: "Lever",
    startingUrl: "https://lever.example.test/employer",
  };
  seed.searchPreferences.discovery.targets = [atlas, lever];
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  const posting = JobPostingSchema.parse({
    ...createSeed().savedJobs[0]!,
    canonicalUrl: "https://lever.example.test/employer/one",
    producingPageUrl: "https://lever.example.test/employer/one",
  });
  expect(resolvePostingProducingTarget(posting, atlas, [atlas, lever])).toEqual(
    lever,
  );
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed,
    browserRuntime: createAgentBrowserRuntime([posting]),
    aiClient: createAgentAiClient(),
  });
  await workspaceService.runDiscoveryForTarget(
    atlas.id,
    () => {},
    new AbortController().signal,
  );
  const state = await repository.getDiscoveryState();
  const jobs = [
    ...(await repository.listSavedJobs()),
    ...state.pendingDiscoveryJobs,
  ];
  expect(
    jobs.find((job) => job.canonicalUrl === posting.canonicalUrl)?.provenance[0]
      ?.targetId,
  ).toBe(lever.id);
  expect(
    jobs.find((job) => job.canonicalUrl === posting.canonicalUrl)?.provenance[0]
      ?.startingUrl,
  ).toBe(lever.startingUrl);
  const unknownPage = {
    ...posting,
    producingPageUrl: "https://unconfigured.example.test/one",
  };
  expect(
    resolvePostingProducingTarget(unknownPage, atlas, [atlas, lever])
      .startingUrl,
  ).toBe(unknownPage.producingPageUrl);
});
