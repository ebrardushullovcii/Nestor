import type {
  JobFinderSettings,
  ResumeRenderDocument,
} from "@nestor/contracts";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

import { listLocalResumeTemplates } from "./job-finder-resume-catalog";
import { renderResumeTemplateHtml } from "./job-finder-resume-renderer";

// R12: Senior Brief exported its wrapped contact line as
// "| github.com/... | linkedin.com/..." because every item after the first
// drew a separator in front of itself, including the first item on a new line.

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const settings = { fontPreset: "inter_requisite" } as JobFinderSettings;

const resume: ResumeRenderDocument = {
  fullName: "Avery Quinn",
  headline: "Senior Platform Engineer",
  location: "Lisbon, Portugal",
  contactItems: [
    { field: "email", text: "avery.quinn.engineering@example.test" },
    { field: "phone", text: "+351 210 000 000" },
    {
      field: "personalWebsiteUrl",
      text: "https://avery-quinn-portfolio.example.test/",
    },
    { field: "githubUrl", text: "https://github.example.test/avery-quinn-dev" },
    {
      field: "linkedinUrl",
      text: "https://linkedin.example.test/in/avery-quinn-platform-0000",
    },
  ],
  sections: [
    {
      id: "section_skills",
      kind: "skills",
      label: "Core Skills",
      text: null,
      bullets: [
        "TypeScript",
        "Kubernetes",
        "PostgreSQL",
        "Terraform",
        "Observability and incident response",
        "Distributed systems design",
        "Go",
        "gRPC",
        "Event-driven architecture",
        "Release engineering",
        "Capacity planning",
        "Developer experience tooling",
      ].map((text, index) => ({ id: `skill_${index}`, text })),
      entries: [],
    },
  ],
};

/** The rendered lines of each separated list, with each item's generated text. */
async function wrappedLists(html: string) {
  const page = await browser.newPage({
    viewport: { width: 816, height: 1056 },
  });
  try {
    await page.emulateMedia({ media: "print" });
    await page.setContent(html);
    return await page.evaluate(() => {
      const lists = [
        ...document.querySelectorAll(
          "header .meta, header .meta-pill-list, header .meta-stack, .skill-pill-list",
        ),
      ];
      return lists.map((list) => {
        const items = [...list.children].map((item) => ({
          top: Math.round(item.getBoundingClientRect().top),
          before: getComputedStyle(item, "::before").content,
          after: getComputedStyle(item, "::after").content,
        }));
        const lines = new Map<number, typeof items>();
        for (const item of items) {
          lines.set(item.top, [...(lines.get(item.top) ?? []), item]);
        }
        return {
          className: list.className,
          lines: [...lines.values()],
        };
      });
    });
  } finally {
    await page.close();
  }
}

const isGlyph = (content: string) => content !== "none" && content !== "normal";

test("classic ATS gives Languages the same section gap as Education in print", async () => {
  const page = await browser.newPage();
  try {
    await page.emulateMedia({ media: "print" });
    await page.setContent(
      renderResumeTemplateHtml({
        renderDocument: {
          ...resume,
          sections: [
            ...resume.sections,
            {
              id: "section_education",
              kind: "education",
              label: "Education",
              text: null,
              bullets: [],
              entries: [
                {
                  id: "degree",
                  title: "Example College",
                  subtitle: "BSc",
                  location: null,
                  dateRange: "2018 - 2022",
                  heading: null,
                  summary: null,
                  bullets: [],
                },
              ],
            },
            {
              id: "section_languages",
              kind: "skills",
              label: "Languages",
              text: null,
              bullets: [{ id: "en", text: "English" }],
              entries: [],
            },
          ],
        },
        settings,
        templateId: "classic_ats",
      }),
    );
    const gaps = await page.locator(".body-grid-classic").evaluate((body) => {
      const education = [...body.querySelectorAll("h3")]
        .find((heading) => heading.textContent === "Education")!
        .closest(".section-block")!;
      const languages = [...body.querySelectorAll("h3")]
        .find((heading) => heading.textContent === "Languages")!
        .closest(".section-block")!;
      const firstSection = body.firstElementChild!;
      const gap = (next: Element, previous: Element) =>
        next.getBoundingClientRect().top -
        previous.getBoundingClientRect().bottom;
      return {
        education: gap(education, firstSection),
        languages: gap(languages, education),
      };
    });
    expect(gaps.languages).toBeCloseTo(gaps.education, 0);
  } finally {
    await page.close();
  }
});

test.each(listLocalResumeTemplates().map((template) => template.id))(
  "no wrapped contact or skill line in %s starts with a separator",
  async (templateId) => {
    const lists = await wrappedLists(
      renderResumeTemplateHtml({
        renderDocument: resume,
        settings,
        templateId,
      }),
    );
    expect(lists.some((list) => list.className.includes("meta"))).toBe(true);
    for (const list of lists) {
      for (const line of list.lines) {
        // Nothing is drawn in front of the first item on any line.
        expect(isGlyph(line[0]!.before), list.className).toBe(false);
      }
      if (list.className.includes("meta")) {
        // Contact items carry no glyph at either end, so a line never ends
        // on a dangling separator either; spacing alone separates them.
        for (const item of list.lines.flat()) {
          expect(isGlyph(item.before) || isGlyph(item.after)).toBe(false);
        }
      }
    }
  },
  30_000,
);

test("the Senior Brief contact line wraps onto a second line for this header", async () => {
  const lists = await wrappedLists(
    renderResumeTemplateHtml({
      renderDocument: resume,
      settings,
      templateId: "compact_exec",
    }),
  );
  const contact = lists.find((list) =>
    list.className.includes("meta-pill-list"),
  );
  expect(contact?.lines.length).toBeGreaterThan(1);
  const skills = lists.find((list) => list.className === "skill-pill-list");
  if (skills) expect(skills.lines.length).toBeGreaterThan(0);
});
