import { describe, expect, test } from "vitest";

import {
  buildJobIdentityAliases,
  createJobIdentityIndex,
  normalizeJobIdentityUrl,
  type JobIdentityInput,
} from "./job-identity";

function identity(overrides: Partial<JobIdentityInput> = {}): JobIdentityInput {
  return {
    source: "target_site",
    sourceJobId: "5112809008",
    canonicalUrl:
      "https://www.linkedin.com/jobs/view/senior-engineer-5112809008",
    applicationUrl:
      "https://job-boards.greenhouse.io/acme/jobs/5112809008?gh_src=linkedin",
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    title: "Senior Software Engineer",
    company: "Acme",
    location: "Remote - United States",
    postedAt: "2026-08-08T12:30:00.000Z",
    postedAtText: "8 Aug 2026",
    ...overrides,
  };
}

describe("job identity", () => {
  test("cached mutable query facts cannot match after their identity changes", () => {
    const stored = identity();
    const index = createJobIdentityIndex([stored], (value) => value);
    const query = { ...stored };
    expect(index.find(query)).toBe(stored);
    query.sourceJobId = "different";
    query.canonicalUrl = "https://example.test/different";
    query.applicationUrl = "https://example.test/different/apply";
    query.title = "Office Administrator";
    expect(index.find(query)).toBeNull();
    Object.assign(query, stored);
    expect(index.find(query)).toBe(stored);
  });
  test("matches an aggregator listing to its ATS listing through the employer application URL", () => {
    const aggregator = identity();
    const index = createJobIdentityIndex([aggregator], (value) => value);

    const match = index.find(
      identity({
        sourceJobId: "greenhouse_5112809008",
        canonicalUrl: "https://job-boards.greenhouse.io/acme/jobs/5112809008",
        applicationUrl:
          "https://job-boards.greenhouse.io/acme/jobs/5112809008?utm_source=direct",
        providerKey: "greenhouse",
        providerBoardToken: "acme",
        providerIdentifier: "acme",
      }),
    );

    expect(match).toBe(aggregator);
  });

  test("a shared employer application endpoint does not merge different roles", () => {
    const existing = identity({
      applicationUrl: "https://employer.test/apply",
    });
    const index = createJobIdentityIndex([existing], (value) => value);
    expect(
      index.find(
        identity({
          sourceJobId: "junior",
          canonicalUrl: "https://other-board.test/jobs/junior",
          title: "Junior Software Engineer",
          applicationUrl: "https://employer.test/apply",
        }),
      ),
    ).toBeNull();
  });

  test("site-local posting numbers do not merge different sites on one host", () => {
    const first = identity({
      source: "target_site",
      sourceJobId: "2",
      canonicalUrl: "https://jobs.example.com/shared/first/jobs/2",
      applicationUrl: "https://jobs.example.com/shared/first/apply/2",
    });
    const second = identity({
      ...first,
      canonicalUrl: "https://jobs.example.com/shared/second/jobs/2",
      applicationUrl: "https://jobs.example.com/shared/second/apply/2",
    });
    expect(
      createJobIdentityIndex([first], (value) => value).find(second),
    ).toBeNull();
  });

  test("normalizes only non-identity URL decoration", () => {
    expect(
      normalizeJobIdentityUrl(
        "https://Jobs.Example.com/roles/123/?utm_source=board&ref=feed&department=eng#apply",
      ),
    ).toBe("https://jobs.example.com/roles/123?department=eng");
  });

  test("keeps corroborated facts possible and never auto-merges them alone", () => {
    const existing = identity();
    const index = createJobIdentityIndex([existing], (value) => value);
    const candidate = identity({
      sourceJobId: "another-opening",
      canonicalUrl: "https://careers.acme.test/jobs/another-opening",
      applicationUrl: "https://careers.acme.test/jobs/another-opening/apply",
    });

    expect(index.find(candidate)).toBeNull();
    expect(index.resolve(candidate)).toMatchObject({
      status: "possible",
      candidates: [existing],
    });
  });

  test("matches one job across hosts by title, employer, place and the same form path", () => {
    const existing = identity({
      sourceJobId: "2",
      canonicalUrl: "http://127.0.0.1:47963/board/jobs/2",
      applicationUrl: "http://127.0.0.1:47963/employer-a/apply/2",
      postedAt: null,
      postedAtText: null,
      matchAcrossSources: true,
    });
    const index = createJobIdentityIndex([existing], (value) => value);

    expect(
      index.find(
        identity({
          matchAcrossSources: true,
          sourceJobId: "lantern",
          canonicalUrl: "http://localhost:47963/authboard/jobs/2",
          applicationUrl: "http://localhost:47963/employer-a/apply/2",
          postedAt: null,
          postedAtText: null,
        }),
      ),
    ).toBe(existing);
    // A card that has not named its form yet matches too.
    expect(
      index.find(
        identity({
          matchAcrossSources: true,
          sourceJobId: "lantern",
          canonicalUrl: "http://localhost:47963/authboard/jobs/2",
          applicationUrl: null,
          postedAt: null,
          postedAtText: null,
        }),
      ),
    ).toBe(existing);
    // Indexes that did not ask for it (the ledger, company duplicates)
    // keep to link and content identity.
    expect(
      createJobIdentityIndex(
        [{ ...existing, matchAcrossSources: false }],
        (value) => value,
      ).find(
        identity({
          sourceJobId: "lantern",
          canonicalUrl: "http://localhost:47963/authboard/jobs/2",
          applicationUrl: null,
          postedAt: null,
          postedAtText: null,
        }),
      ),
    ).toBeNull();
    // Another site's listing with a different place is another job.
    expect(
      index.find(
        identity({
          matchAcrossSources: true,
          sourceJobId: "lantern",
          canonicalUrl: "http://localhost:47963/authboard/jobs/2",
          applicationUrl: null,
          location: "Berlin",
          postedAt: null,
          postedAtText: null,
        }),
      ),
    ).toBeNull();
  });

  test("does not merge a colliding generic source ID across companies and hosts", () => {
    const existing = identity({
      sourceJobId: "123",
      canonicalUrl: "https://jobs.alpha.test/roles/123",
      applicationUrl: null,
      company: "Alpha",
    });
    const index = createJobIdentityIndex([existing], (value) => value);

    expect(
      index.find(
        identity({
          sourceJobId: "123",
          canonicalUrl: "https://jobs.beta.test/roles/123",
          applicationUrl: null,
          company: "Beta",
        }),
      ),
    ).toBeNull();
  });

  test("rejects a canonical listing URL that conflicts with a known provider id", () => {
    const providerMatch = identity({
      providerKey: "greenhouse",
      providerBoardToken: "acme",
      providerIdentifier: "acme",
    });
    const urlMatch = identity({
      sourceJobId: "different-job",
      canonicalUrl: "https://jobs.example.test/roles/different-job",
      applicationUrl: "https://jobs.example.test/roles/different-job/apply",
    });
    const index = createJobIdentityIndex(
      [providerMatch, urlMatch],
      (value) => value,
    );

    expect(
      index.resolve(
        identity({
          providerKey: "greenhouse",
          providerBoardToken: "acme",
          providerIdentifier: "acme",
          applicationUrl: urlMatch.applicationUrl ?? null,
          canonicalUrl: urlMatch.canonicalUrl,
        }),
      ).status,
    ).toBe("conflict");
  });

  test("matches the same URL despite corrected employer, title and unknown feed id", () => {
    const urlMatch = identity();
    const index = createJobIdentityIndex([urlMatch], (value) => value);
    expect(
      index.find(
        identity({
          canonicalUrl: urlMatch.canonicalUrl,
          applicationUrl: null,
          company: "Wrong employer",
          title: "Corrected role title",
          sourceJobId: "wrong",
        }),
      ),
    ).toBe(urlMatch);
  });

  test("does not use generic posting numbers and similar facts to identify a new listing", () => {
    const first = identity({
      canonicalUrl: "https://careers.acme.test/jobs/first",
      applicationUrl: null,
      title: "Senior Software Engineer",
    });
    const second = identity({
      canonicalUrl: "https://careers.acme.test/jobs/second",
      applicationUrl: null,
      title: "Senior Data Engineer",
    });
    const index = createJobIdentityIndex([first, second], (value) => value);

    expect(
      index.find(
        identity({
          canonicalUrl: "https://careers.acme.test/jobs/new-route",
          applicationUrl: null,
          title: "Senior Data Engineer",
        }),
      ),
    ).toBeNull();
  });

  test("does not create a facts alias from a relative posted date", () => {
    const aliases = buildJobIdentityAliases(
      identity({ postedAt: null, postedAtText: "2 days ago" }),
    );

    expect(
      aliases.some((alias) => alias.kind === "corroborated_listing_facts"),
    ).toBe(false);
  });

  test("matches substantial exact listing content when one source shortens a qualified title", () => {
    const description =
      "Meadow Byte Guild Remote Worldwide Data Engineer Meadow Pipelines About the role. Build reliable software for a collaborative planning product. Work with a small team on accessible interfaces, APIs, data pipelines and developer tools. Design and ship maintainable software with TypeScript, SQL and automated tests. Collaborate across product and engineering. Improve performance, accessibility and reliability. Professional software development experience and clear communication. Apply now";
    const existing = identity({
      sourceJobId: "board-5",
      canonicalUrl: "https://jobs.example.test/board/5",
      applicationUrl: "https://jobs.example.test/board/5",
      title: "Data Engineer, Meadow Pipelines",
      company: "Meadow Byte Guild",
      location: "Remote, Worldwide",
      description,
      postedAt: null,
      postedAtText: "Posted 5d ago",
    });
    const index = createJobIdentityIndex([existing], (value) => value);

    expect(
      index.find(
        identity({
          sourceJobId: "gatekeeper-5",
          canonicalUrl: "https://jobs.example.test/gatekeeper/5",
          applicationUrl: "https://jobs.example.test/gatekeeper/apply/5",
          title: "Data Engineer",
          company: "Meadow Byte Guild",
          location: "Remote, Worldwide",
          description: description.replace(/Apply now$/u, "Apply"),
          postedAt: null,
          postedAtText: "Posted 5d ago",
        }),
      ),
    ).toBe(existing);

    expect(
      index.find(
        identity({
          sourceJobId: "workday-5",
          canonicalUrl: "https://jobs.example.test/workday/5",
          applicationUrl: "https://jobs.example.test/workday/apply/5",
          title: "Data Engineer,",
          company: "Meadow Byte Guild",
          location: "Remote, Worldwide",
          description: description.replace(/Apply now$/u, "Apply"),
          postedAt: null,
          postedAtText: "Posted 5d ago",
        }),
      ),
    ).toBe(existing);
  });

  test("does not merge different explicit title qualifiers with exact shared content", () => {
    const description =
      "Acme Remote Data Engineering About the role. Build reliable software for a collaborative planning product. Work with a small team on accessible interfaces, APIs, data pipelines and developer tools. Design and ship maintainable software with TypeScript, SQL and automated tests. Collaborate across product and engineering. Improve performance, accessibility and reliability. Professional software development experience and clear communication are required for every role on this team.";
    const existing = identity({
      title: "Data Engineer, Payments",
      company: "Acme",
      location: "Remote",
      description,
    });
    const index = createJobIdentityIndex([existing], (value) => value);

    expect(
      index.find(
        identity({
          sourceJobId: "risk-opening",
          canonicalUrl: "https://careers.acme.test/jobs/risk-opening",
          applicationUrl: "https://careers.acme.test/jobs/risk-opening/apply",
          title: "Data Engineer, Risk",
          company: "Acme",
          location: "Remote",
          description,
        }),
      ),
    ).toBeNull();
  });

  test("does not merge incompatible titles that share employer, location, and boilerplate", () => {
    const description =
      "Join our product organization and build reliable software for a collaborative planning product. Work with a small team on accessible interfaces, APIs, data pipelines and developer tools. Design and ship maintainable software with TypeScript, SQL and automated tests. Collaborate across product and engineering. Improve performance, accessibility and reliability. Professional software development experience and clear communication are required for every role on this team.";
    const existing = identity({
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      description,
    });
    const index = createJobIdentityIndex([existing], (value) => value);

    expect(
      index.find(
        identity({
          sourceJobId: "frontend-opening",
          canonicalUrl: "https://careers.acme.test/jobs/frontend-opening",
          applicationUrl:
            "https://careers.acme.test/jobs/frontend-opening/apply",
          title: "Frontend Engineer",
          company: "Acme",
          location: "Remote",
          description,
        }),
      ),
    ).toBeNull();
  });

  test("does not use short generic boilerplate as strong content identity", () => {
    const existing = identity({
      title: "Data Engineer, Pipelines",
      company: "Acme",
      location: "Remote",
      description: "Join our team and build useful software. Apply now",
    });
    const index = createJobIdentityIndex([existing], (value) => value);

    expect(
      index.find(
        identity({
          sourceJobId: "second-opening",
          canonicalUrl: "https://careers.acme.test/jobs/second-opening",
          applicationUrl: "https://careers.acme.test/jobs/second-opening/apply",
          title: "Data Engineer",
          company: "Acme",
          location: "Remote",
          description: "Join our team and build useful software. Apply",
        }),
      ),
    ).toBeNull();
  });
});
