import { describe, expect, test } from "vitest";
import {
  JobPostingSchema,
  SavedJobDiscoveryProvenanceSchema,
  type JobPosting,
  type SavedJobDiscoveryProvenance,
} from "@nestor/contracts";

import { createSeed } from "../test-fixtures";
import {
  classifySightingRoute,
  selectApplicationSighting,
  selectCanonicalSighting,
} from "./listing-sightings";
import { mergeDiscoveredPostings } from "./matching";

const HOST = "http://127.0.0.1:47000";

function sighting(
  overrides: Partial<SavedJobDiscoveryProvenance> & { site: string },
): SavedJobDiscoveryProvenance {
  const { site, ...rest } = overrides;
  return SavedJobDiscoveryProvenanceSchema.parse({
    targetId: `target_${site}`,
    adapterKind: "auto",
    resolvedAdapterKind: "target_site",
    startingUrl: `${HOST}/${site}/`,
    discoveredAt: "2026-09-23T10:00:00.000Z",
    collectionMethod: "careers_page",
    listingUrl: `${HOST}/${site}/jobs/9`,
    applicationUrl: `${HOST}/${site}/jobs/9`,
    sourceJobId: "9",
    applyPath: "unknown",
    ...rest,
  });
}

describe("classifySightingRoute", () => {
  const board = sighting({
    site: "board",
    pageApplyUrl: `${HOST}/employer-a/apply/9`,
    routeReadAt: "2026-09-23T10:05:00.000Z",
  });
  const form = sighting({
    site: "forms",
    pageApplyUrl: `${HOST}/forms/apply/9`,
    routeReadAt: "2026-09-23T10:05:00.000Z",
  });

  test("an apply link that stays on the listing's own site is the employer's form", () => {
    expect(classifySightingRoute(form, [board, form])).toBe("employer_form");
  });

  test("an apply link that leaves the listing's site is a hand-off, even on a shared host", () => {
    expect(classifySightingRoute(board, [board, form])).toBe("handoff");
  });

  test("on its own host, a different path on the same site still counts as the site's form", () => {
    const own = sighting({
      site: "careers",
      startingUrl: "https://careers.acme.example/",
      listingUrl: "https://careers.acme.example/jobs/9",
      pageApplyUrl: "https://apply.acme.example/form/9",
    });
    expect(classifySightingRoute(own, [own])).toBe("employer_form");
  });

  test("a provider feed is the employer's form; quick apply, redirects and access gates are not", () => {
    expect(
      classifySightingRoute(sighting({ site: "feed", providerKey: "lever" })),
    ).toBe("employer_form");
    expect(
      classifySightingRoute(
        sighting({ site: "quick", applyPath: "easy_apply" }),
      ),
    ).toBe("handoff");
    expect(
      classifySightingRoute(
        sighting({ site: "away", applyPath: "external_redirect" }),
      ),
    ).toBe("handoff");
    expect(
      classifySightingRoute(
        sighting({
          site: "gate",
          listingUrl: `${HOST}/gate/security/9`,
          pageApplyUrl: `${HOST}/gate/apply/9`,
        }),
      ),
    ).toBe("handoff");
  });

  test("a sighting nobody has read is unknown", () => {
    expect(classifySightingRoute(sighting({ site: "forms" }))).toBe("unknown");
  });
});

describe("selectCanonicalSighting", () => {
  const boardFirst = sighting({
    site: "board",
    discoveredAt: "2026-09-23T10:00:00.000Z",
  });
  const formSecond = sighting({
    site: "forms",
    discoveredAt: "2026-09-23T10:01:00.000Z",
  });

  test("with nothing read yet, the first discovered wins in either order", () => {
    expect(selectCanonicalSighting([boardFirst, formSecond])?.targetId).toBe(
      "target_board",
    );
    expect(selectCanonicalSighting([formSecond, boardFirst])?.targetId).toBe(
      "target_board",
    );
  });

  test("once read, the employer's own form wins over an earlier hand-off, in either order", () => {
    const readBoard = {
      ...boardFirst,
      pageApplyUrl: `${HOST}/employer-a/apply/9`,
      routeReadAt: "2026-09-23T10:05:00.000Z",
    };
    const readForm = {
      ...formSecond,
      pageApplyUrl: `${HOST}/forms/apply/9`,
      routeReadAt: "2026-09-23T10:05:00.000Z",
    };
    expect(selectCanonicalSighting([readBoard, readForm])?.targetId).toBe(
      "target_forms",
    );
    expect(selectCanonicalSighting([readForm, readBoard])?.targetId).toBe(
      "target_forms",
    );
  });

  test("two employer forms: first discovered wins; a timestamp tie goes to the lower target id", () => {
    const a = sighting({
      site: "alpha",
      discoveredAt: "2026-09-23T10:02:00.000Z",
      pageApplyUrl: `${HOST}/alpha/apply/9`,
    });
    const b = sighting({
      site: "bravo",
      discoveredAt: "2026-09-23T10:01:00.000Z",
      pageApplyUrl: `${HOST}/bravo/apply/9`,
    });
    expect(selectCanonicalSighting([a, b])?.targetId).toBe("target_bravo");
    const tied = { ...a, discoveredAt: b.discoveredAt };
    expect(selectCanonicalSighting([b, tied])?.targetId).toBe("target_alpha");
    expect(selectCanonicalSighting([tied, b])?.targetId).toBe("target_alpha");
  });

  test("an access-gate listing never wins while another exists", () => {
    const gate = sighting({
      site: "gate",
      listingUrl: `${HOST}/gate/security/9`,
      discoveredAt: "2026-09-23T09:00:00.000Z",
    });
    expect(selectCanonicalSighting([gate, formSecond])?.targetId).toBe(
      "target_forms",
    );
  });
});

describe("merging the same job from two sources", () => {
  const seed = createSeed();

  function posting(site: string, discoveredAt: string): JobPosting {
    return JobPostingSchema.parse({
      source: "target_site",
      sourceJobId: "9",
      discoveryMethod: "browser_agent",
      collectionMethod: "careers_page",
      canonicalUrl: `${HOST}/${site}/jobs/9`,
      applicationUrl: `${HOST}/${site}/jobs/9`,
      title: "Frontend Engineer",
      company: "Cedar Components",
      location: "Remote, Europe",
      workMode: ["remote"],
      applyPath: "unknown",
      easyApplyEligible: false,
      discoveredAt,
      salaryText: null,
      description:
        "Build reliable software for a fictional collaborative planning product.",
    });
  }

  function mergeInOrder(first: string, second: string) {
    const provenanceFor = (item: JobPosting) => ({
      targetId: `target_${item.canonicalUrl.split("/")[3]}`,
      adapterKind: "auto" as const,
      resolvedAdapterKind: "target_site" as const,
      startingUrl: `${HOST}/${item.canonicalUrl.split("/")[3]}/`,
      discoveredAt: item.discoveredAt,
      collectionMethod: item.collectionMethod,
      providerKey: null,
      providerBoardToken: null,
      titleTriageOutcome: "pass" as const,
    });
    const one = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [],
      [posting(first, "2026-09-23T10:00:00.000Z")],
      provenanceFor,
    );
    return mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      one.mergedJobs,
      [posting(second, "2026-09-23T10:01:00.000Z")],
      provenanceFor,
    );
  }

  test("the later sighting no longer takes over the listing, and the pair is never mixed", () => {
    const result = mergeInOrder("board", "forms");
    expect(result.duplicatesMerged).toBe(1);
    const [job] = result.mergedJobs;
    expect(job?.canonicalUrl).toBe(`${HOST}/board/jobs/9`);
    expect(job?.applicationUrl).toBe(`${HOST}/board/jobs/9`);
    expect(job?.provenance.map((entry) => entry.listingUrl)).toEqual([
      `${HOST}/board/jobs/9`,
      `${HOST}/forms/jobs/9`,
    ]);
  });

  test("the same job on two hosts is one job, with the employer's form as its route", () => {
    // A board listed on localhost and an applicant tracking site on
    // 127.0.0.1: the card carries only title, employer and place.
    const other = "http://localhost:47000";
    const provenanceFor = (item: JobPosting) => ({
      targetId: `target_${item.canonicalUrl.split("/")[3]}`,
      adapterKind: "auto" as const,
      resolvedAdapterKind: "target_site" as const,
      startingUrl: `${new URL(item.canonicalUrl).origin}/${item.canonicalUrl.split("/")[3]}/`,
      discoveredAt: item.discoveredAt,
      collectionMethod: item.collectionMethod,
      providerKey: null,
      providerBoardToken: null,
      titleTriageOutcome: "pass" as const,
    });
    const onForms = posting("forms", "2026-09-23T10:00:00.000Z");
    const onBoard = JobPostingSchema.parse({
      ...posting("authboard", "2026-09-23T10:01:00.000Z"),
      sourceJobId: "lantern-2",
      canonicalUrl: `${other}/authboard/jobs/2`,
      applicationUrl: `${other}/authboard/jobs/2`,
      description: "Remote",
    });
    for (const order of [
      [onForms, onBoard],
      [onBoard, onForms],
    ]) {
      const one = mergeDiscoveredPostings(
        seed.profile,
        seed.searchPreferences,
        [],
        [order[0]!],
        provenanceFor,
      );
      const read = one.mergedJobs.map((job) => ({
        ...job,
        provenance: job.provenance.map((entry) => ({
          ...entry,
          routeReadAt: "2026-09-23T10:05:00.000Z",
          pageApplyUrl: entry.listingUrl?.startsWith(other)
            ? `${other}/employer-a/apply/2`
            : `${HOST}/forms/apply/9`,
        })),
      }));
      const result = mergeDiscoveredPostings(
        seed.profile,
        seed.searchPreferences,
        read,
        [order[1]!],
        (item) => ({
          ...provenanceFor(item),
          routeReadAt: "2026-09-23T10:05:00.000Z",
          pageApplyUrl: item.canonicalUrl.startsWith(other)
            ? `${other}/employer-a/apply/2`
            : `${HOST}/forms/apply/9`,
        }),
      );
      expect(result.mergedJobs).toHaveLength(1);
      expect(result.duplicatesMerged).toBe(1);
      expect(result.mergedJobs[0]?.canonicalUrl).toBe(`${HOST}/forms/jobs/9`);
    }
  });

  test("two openings with the same title on one site stay two jobs", () => {
    const provenanceFor = (item: JobPosting) => ({
      targetId: "target_forms",
      adapterKind: "auto" as const,
      resolvedAdapterKind: "target_site" as const,
      startingUrl: `${HOST}/forms/`,
      discoveredAt: item.discoveredAt,
      collectionMethod: item.collectionMethod,
      providerKey: null,
      providerBoardToken: null,
      titleTriageOutcome: "pass" as const,
    });
    const result = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [],
      [
        posting("forms", "2026-09-23T10:00:00.000Z"),
        JobPostingSchema.parse({
          ...posting("forms", "2026-09-23T10:00:00.000Z"),
          sourceJobId: "10",
          canonicalUrl: `${HOST}/forms/jobs/10`,
          applicationUrl: `${HOST}/forms/jobs/10`,
        }),
      ],
      provenanceFor,
    );
    expect(result.mergedJobs).toHaveLength(2);
  });

  test("a job whose work has started keeps its listing whatever arrives later", () => {
    const first = mergeInOrder("board", "forms").mergedJobs[0]!;
    const drafting = { ...first, status: "drafting" as const };
    const readForm = drafting.provenance.map((entry) =>
      entry.targetId === "target_forms"
        ? { ...entry, pageApplyUrl: `${HOST}/forms/apply/9` }
        : entry,
    );
    const result = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [{ ...drafting, provenance: readForm }],
      [posting("forms", "2026-09-23T11:00:00.000Z")],
      () => readForm[1]!,
    );
    expect(result.mergedJobs[0]?.canonicalUrl).toBe(`${HOST}/board/jobs/9`);
  });

  test("once the second source is known to be the employer's form, a merge moves the whole route there", () => {
    const first = mergeInOrder("board", "forms").mergedJobs[0]!;
    const read = first.provenance.map((entry) => ({
      ...entry,
      routeReadAt: "2026-09-23T10:05:00.000Z",
      pageApplyUrl:
        entry.targetId === "target_forms"
          ? `${HOST}/forms/apply/9`
          : `${HOST}/employer-a/apply/9`,
    }));
    const result = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [{ ...first, provenance: read }],
      [posting("board", "2026-09-23T12:00:00.000Z")],
      () => read[0]!,
    );
    const job = result.mergedJobs[0]!;
    expect(job.canonicalUrl).toBe(`${HOST}/forms/jobs/9`);
    expect(job.applicationUrl).toBe(`${HOST}/forms/apply/9`);
  });

  test("a later card sighting keeps the record of the earlier page read", () => {
    const first = mergeInOrder("board", "forms").mergedJobs[0]!;
    const read = {
      ...first,
      listingDetailFetch: {
        attemptedAt: "2026-09-23T10:05:00.000Z",
        outcome: "enriched" as const,
        method: "json_ld" as const,
        detail:
          "Read the listing's structured JobPosting record from its page.",
      },
    };
    const result = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [read],
      [posting("board", "2026-09-23T12:00:00.000Z")],
      () => read.provenance[0]!,
    );
    expect(result.mergedJobs[0]?.listingDetailFetch?.outcome).toBe("enriched");
  });
});

describe("selectApplicationSighting", () => {
  test("names the source the job's own listing came from, not the last one to see it", () => {
    const greenhouse = sighting({ site: "greenhouse" });
    const lever = sighting({
      site: "lever",
      discoveredAt: "2026-09-23T10:09:00.000Z",
    });
    expect(
      selectApplicationSighting({
        canonicalUrl: `${HOST}/greenhouse/jobs/9`,
        applicationUrl: `${HOST}/greenhouse/jobs/9`,
        provenance: [greenhouse, lever],
      })?.targetId,
    ).toBe("target_greenhouse");
  });

  test("provenance saved before sightings kept links is matched by the source's pages", () => {
    const legacy = (site: string) =>
      sighting({ site, listingUrl: null, applicationUrl: null });
    const provenance = [legacy("greenhouse"), legacy("board"), legacy("lever")];
    expect(
      selectApplicationSighting({
        canonicalUrl: `${HOST}/greenhouse/jobs/8`,
        applicationUrl: `${HOST}/greenhouse/jobs/8`,
        provenance,
      })?.targetId,
    ).toBe("target_greenhouse");
    // A link no single source owns names none, and the caller keeps its fallback.
    expect(
      selectApplicationSighting({
        canonicalUrl: `${HOST}/workday/jobs/8`,
        applicationUrl: null,
        provenance,
      }),
    ).toBeNull();
  });
});
