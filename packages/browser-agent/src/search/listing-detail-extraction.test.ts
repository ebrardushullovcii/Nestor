import { describe, expect, it } from "vitest";
import {
  extractListingDetailFromHtml,
  listingPageLinks,
  findApplyLinkInHtml,
  htmlToPlainText,
  listingPageText,
} from "./listing-detail-extraction";

const JOB_POSTING_PAGE = `<!doctype html>
<html><head>
<title>Senior Software Engineer at Garner Health</title>
<meta property="og:title" content="Senior Software Engineer - Garner Health">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Senior Software Engineer",
  "datePosted": "2026-08-30",
  "validThrough": "2026-10-30T00:00:00Z",
  "employmentType": "FULL_TIME",
  "hiringOrganization": { "@type": "Organization", "name": "Garner Health" },
  "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress", "addressLocality": "New York", "addressRegion": "NY", "addressCountry": "US" } },
  "jobLocationType": "TELECOMMUTE",
  "baseSalary": { "@type": "MonetaryAmount", "currency": "USD", "value": { "@type": "QuantitativeValue", "minValue": 180000, "maxValue": 220000, "unitText": "YEAR" } },
  "description": "<p>Garner is building the tools that make healthcare affordable.</p><h3>What you&rsquo;ll do</h3><ul><li>Design and ship C# and .NET services.</li><li>Own MongoDB schema design &amp; query tuning.</li></ul><p>Requirements: 5+ years with .NET Core, REST APIs, and cloud services on Azure or AWS.</p>"
}
</script>
</head><body><nav>Home Jobs</nav><main><h1>Senior Software Engineer</h1></main></body></html>`;

describe("extractListingDetailFromHtml", () => {
  it("reads a JobPosting record: body as readable text, pay, place, dates, remote", () => {
    const detail = extractListingDetailFromHtml({
      html: JOB_POSTING_PAGE,
      url: "https://jobs.example.test/4677969",
      expectedTitle: "Senior Software Engineer",
    });

    expect(detail?.method).toBe("json_ld");
    expect(detail?.title).toBe("Senior Software Engineer");
    expect(detail?.company).toBe("Garner Health");
    expect(detail?.location).toBe("New York, NY, US");
    expect(detail?.workModeHints).toContain("remote");
    expect(detail?.salaryText).toBe("USD 180,000 – 220,000 / year");
    expect(detail?.employmentType).toBe("Full-Time");
    expect(detail?.postedAt).toBe("2026-08-30T00:00:00.000Z");
    expect(detail?.validThrough).toBe("2026-10-30T00:00:00.000Z");
    // Entities decoded, headings and list items on their own lines.
    expect(detail?.description).toContain("What you’ll do");
    expect(detail?.description).toContain(
      "• Design and ship C# and .NET services.",
    );
    expect(detail?.description).toContain(
      "• Own MongoDB schema design & query tuning.",
    );
    expect(detail?.description).toContain(
      "Requirements: 5+ years with .NET Core",
    );
    expect(detail?.description).not.toMatch(/<[a-z]/iu);
  });

  it("walks an @graph and picks the record whose title matches the card", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Acme"},
      {"@type":"JobPosting","title":"Staff Designer","description":"<p>Design things for a long time with many words about brand and marketing and UI so this is the longer record.</p>","hiringOrganization":{"name":"Acme"}},
      {"@type":["JobPosting","Thing"],"title":"Backend Engineer","description":"<p>Build APIs.</p>","hiringOrganization":{"name":"Acme"}}
    ]}</script>`;

    const detail = extractListingDetailFromHtml({
      html,
      url: "https://acme.example.test/jobs/2",
      expectedTitle: "Backend Engineer",
    });

    expect(detail?.title).toBe("Backend Engineer");
    expect(detail?.description).toBe("Build APIs.");
  });

  it("tolerates a trailing comma and a second, unrelated ld+json block", () => {
    const html = `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
      <script type='application/ld+json'>{"@type":"JobPosting","title":"Data Engineer","description":"Own pipelines.","hiringOrganization":{"name":"Pipes"},}</script>`;

    const detail = extractListingDetailFromHtml({
      html,
      url: "https://pipes.example.test/jobs/1",
    });

    expect(detail?.method).toBe("json_ld");
    expect(detail?.company).toBe("Pipes");
    expect(detail?.description).toBe("Own pipelines.");
  });

  it("drops a broader place already contained in a more specific one", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"SE","description":"Do the thing well.","jobLocation":[{"address":{"addressLocality":"Austin","addressRegion":"Texas","addressCountry":"United States"}},{"address":{"addressCountry":"United States"}}]}</script>`;

    expect(
      extractListingDetailFromHtml({ html, url: "https://x.example.test/3" })
        ?.location,
    ).toBe("Austin, Texas, United States");
  });

  it("labels a remote-only posting by its applicant regions when no place is given", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"SRE","description":"Keep it up.","jobLocationType":"TELECOMMUTE","applicantLocationRequirements":[{"@type":"Country","name":"United States"},{"@type":"Country","name":"Canada"}]}</script>`;

    const detail = extractListingDetailFromHtml({
      html,
      url: "https://x.example.test/1",
    });

    expect(detail?.location).toBe("Remote (United States, Canada)");
    expect(detail?.workModeHints).toEqual(["remote"]);
  });

  it("returns null when the page publishes no record; the model reads those", () => {
    const html = `<html><head><title>Platform Engineer | Northwind</title></head><body><main><h1>Platform Engineer</h1><p>${"You will own services and work with the team. ".repeat(40)}</p></main></body></html>`;

    expect(
      extractListingDetailFromHtml({
        html,
        url: "https://northwind.example.test/jobs/9",
        expectedTitle: "Platform Engineer",
      }),
    ).toBeNull();
  });
});

describe("listingPageText", () => {
  it("turns the page into text for the model without judging what it says", () => {
    const body = "<p>You will own services and work with the team.</p>".repeat(
      12,
    );
    const html = `<html><head><title>Platform Engineer | Northwind</title><meta property="og:site_name" content="Northwind Careers"><script>track()</script><style>.x{}</style></head><body><header>Menu</header><main><h1>Platform Engineer</h1>${body}<h2>Requirements</h2><ul><li>Five years of experience.</li></ul></main><footer>© Northwind</footer></body></html>`;

    const text = listingPageText(html);

    expect(text.startsWith("Page title: Platform Engineer | Northwind")).toBe(
      true,
    );
    expect(text).toContain("Site name: Northwind Careers");
    expect(text).toContain("• Five years of experience.");
    expect(text).not.toContain("track()");
    // Keep all body sections; requirements may be outside main.
    expect(text).toContain("Menu");
    expect(text).toContain("© Northwind");
  });

  it("keeps the whole body when the page has no main or article", () => {
    const text = listingPageText(
      `<html><body><div><a href="/x">Thirrje</a></div><div><h1>Zhvillues Softueri</h1><div>Kc Commerce</div><p>Paragrafi 1</p></div></body></html>`,
    );

    expect(text).toContain("Thirrje");
    expect(text).toContain("Zhvillues Softueri");
    expect(text).toContain("Kc Commerce");
  });
});

describe("htmlToPlainText", () => {
  it("keeps paragraph rhythm and bullets, drops tags and scripts", () => {
    expect(
      htmlToPlainText(
        "<div><p>One</p><script>bad()</script><ul><li>A</li><li>B &amp; C</li></ul><p>Two<br>lines</p></div>",
      ),
    ).toBe("One\n\n• A\n\n• B & C\n\nTwo\nlines");
  });
});

describe("the apply link on a listing page", () => {
  it("reads a plain apply link so a run starts on the form", () => {
    expect(
      findApplyLinkInHtml(
        `<html><body><main><h1>Events Manager</h1><a class="btn" href="/apply/11124457">Apply now</a></main></body></html>`,
        "https://board.example.test/job/events-manager",
      ),
    ).toBe("https://board.example.test/apply/11124457");
  });

  it("reads an apply link that leads to the employer's own site", () => {
    expect(
      findApplyLinkInHtml(
        `<html><body><main><h1>Events Manager</h1><a href="https://employer.example.test/careers/apply">Apply on company site</a></main></body></html>`,
        "https://board.example.test/job/events-manager",
      ),
    ).toBe("https://employer.example.test/careers/apply");
  });

  it("leaves a page with no apply link alone", () => {
    expect(
      findApplyLinkInHtml(
        `<html><body><main><h1>Events Manager</h1><a href="/jobs">Similar jobs</a><a href="/help">How to apply</a></main></body></html>`,
        "https://board.example.test/job/events-manager",
      ),
    ).toBeNull();
  });
});

it("deduplicates and bounds page links in page order without choosing an application route", () => {
  const html =
    `<a href="#requirements">Requirements</a><a href="/logo.svg">Logo</a><a href="/style.css">Style</a><a href="/jobs/one">One</a><a href="/jobs/one">One again</a>` +
    Array.from(
      { length: 180 },
      (_, i) => `<a href="/page/${i}">Page ${i}</a>`,
    ).join("");
  const links = listingPageLinks(html, "https://jobs.example.test/listing");
  expect(links).toHaveLength(150);
  expect(links[0]).toEqual({
    label: "One",
    url: "https://jobs.example.test/jobs/one",
  });
  expect(links[149]?.url).toBe("https://jobs.example.test/page/148");
  expect(
    links.some(
      (link) =>
        link.label === "Requirements" ||
        link.label === "Logo" ||
        link.label === "Style" ||
        link.label === "One again",
    ),
  ).toBe(false);
});

it("bounds large page text and discloses omitted text while keeping ordinary listings whole", () => {
  const ordinary =
    "a".repeat(10000) + "Java and Dutch C1 are required" + "z".repeat(10000);
  expect(listingPageText(`<main>${ordinary}</main>`)).toBe(ordinary);
  const long = listingPageText(
    `<main>${"Body ".repeat(20000)}End requirements</main>`,
  );
  expect(long.length).toBeLessThanOrEqual(64000);
  expect(long).toContain("[Page text excerpt: middle omitted]");
  expect(long).toContain("End requirements");
});
