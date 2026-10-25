import { describe, expect, test } from "vitest";
import { extractReadablePage, extractResearchSignals } from "./research";

describe("extractReadablePage", () => {
  test("pulls readable title and text from html", () => {
    const result = extractReadablePage({
      url: "https://example.com/about",
      html: `
        <html>
          <head><title>Example About</title></head>
          <body>
            <main>
              <article>
                <h1>Example Platform</h1>
                <p>Example Platform builds workflow software for distributed teams.</p>
                <p>Customers use the product to manage approvals, hiring, and internal operations.</p>
              </article>
            </main>
          </body>
        </html>
      `,
    });

    expect(result.title).toBe("Example About");
    expect(result.text).toContain("workflow software");
  });
});

describe("extractResearchSignals", () => {
  test("derives notes, vocabulary, and themes from repeated research text", () => {
    const result = extractResearchSignals(
      [
        "Signal Systems builds workflow automation for regulated teams.",
        "The platform improves workflow automation, approvals, and compliance reviews.",
        "Customers rely on workflow automation and compliance operations across distributed teams.",
      ].join(" "),
    );

    expect(result.companyNotes).toContain("Signal Systems builds workflow automation");
    expect(result.domainVocabulary).toEqual(
      expect.arrayContaining(["automation", "compliance", "workflow"]),
    );
    expect(result.priorityThemes.length).toBeGreaterThan(0);
  });
});
