import type {
  JobFinderSettings,
  ResumeRenderDocument,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { listLocalResumeTemplates } from "./job-finder-resume-catalog";
import { renderResumeTemplateHtml } from "./job-finder-resume-renderer";

const settings = {
  fontPreset: "inter_requisite",
} as JobFinderSettings;

const document: ResumeRenderDocument = {
  fullName: "Alex Morgan",
  headline: "Frontend Engineer",
  location: "Portland, Oregon",
  contactItems: [{ field: "email", text: "alex.morgan@example.test" }],
  sections: [
    {
      id: "section_summary",
      kind: "summary",
      label: "Summary",
      text: "Frontend engineer with 16 years building accessible web applications.",
      bullets: [],
      entries: [],
    },
    {
      id: "section_skills",
      kind: "skills",
      label: "Core Skills",
      text: null,
      bullets: [
        { id: "skill_1", text: "TypeScript" },
        { id: "skill_2", text: "SQL" },
      ],
      entries: [],
    },
    {
      id: "section_additional_skills",
      kind: "skills",
      label: "Additional Skills",
      text: null,
      bullets: [{ id: "skill_3", text: "Figma" }],
      entries: [],
    },
    {
      id: "section_experience",
      kind: "experience",
      label: "Experience",
      text: null,
      bullets: [],
      entries: [],
    },
  ],
};

describe("ATS resume rendering", () => {
  it.each([
    "feb. 2018 - jul. 2019",
    "nov. 2021 – actualidad",
    "2024年4月〜現在",
  ])("keeps the supplied display dates %s", (dateRange) => {
    const localized = structuredClone(document);
    localized.sections[3]!.entries.push({
      id: "role",
      title: "Developer",
      subtitle: null,
      location: null,
      dateRange,
      startDate: "2021-11",
      endDate: null,
      isCurrent: true,
      heading: null,
      summary: null,
      bullets: [],
    });
    for (const mode of ["preview", "export"] as const) {
      const html = renderResumeTemplateHtml(
        { renderDocument: localized, settings, templateId: "classic_ats" },
        { mode },
      );
      expect(html).toContain(`>${dateRange}</span>`);
    }
  });

  it("renders skills as a plain list without the app's Core/Additional labels", () => {
    const html = renderResumeTemplateHtml({
      renderDocument: document,
      settings,
      templateId: "classic_ats",
    });
    expect(html).toContain("TypeScript");
    expect(html).toContain("SQL");
    expect(html).toContain("Figma");
    expect(html).toContain("<h3>Skills</h3>");
    expect(html).not.toContain("Core:");
    expect(html).not.toContain("Additional:");
  });
});

it.each(["classic_ats", "modern_split", "technical_matrix"] as const)(
  "keeps translated skill and language labels in %s",
  (templateId) => {
    const translated = structuredClone(document);
    translated.sections[1]!.id = "section_core_skills";
    translated.sections[1]!.label = "Kernkompetenzen";
    translated.sections[1]!.bullets = [{ id: "bi", text: "Power BI" }];
    translated.sections[2]!.label = "Weitere Kenntnisse";
    translated.sections.push({
      id: "section_languages",
      kind: "skills",
      label: "Sprachen",
      text: null,
      bullets: [{ id: "de", text: "Deutsch — C2" }],
      entries: [],
    });
    translated.sections.push({
      id: "custom_skills",
      kind: "skills",
      label: "Werkzeuge",
      text: null,
      bullets: [{ id: "excel", text: "Excel" }],
      entries: [],
    });
    const html = renderResumeTemplateHtml({
      renderDocument: translated,
      settings,
      templateId,
    });
    expect(html).toContain("<h3>Kernkompetenzen</h3>");
    expect(html).toContain("<h3>Sprachen</h3>");
    expect(html).not.toContain("<h3>Skills</h3>");
    expect(html).not.toContain("Power BI.");
    expect(html).not.toContain("Excel.");
    expect(html).not.toContain("Deutsch — C2.");
    translated.sections = translated.sections.filter(
      (section) => section.id !== "section_core_skills",
    );
    const additionalOnly = renderResumeTemplateHtml({
      renderDocument: translated,
      settings,
      templateId,
    });
    expect(additionalOnly).toContain("<h3>Weitere Kenntnisse</h3>");
    expect(additionalOnly).not.toContain("Additional Skills");
  },
);

// R7: every resume printed "Shipped · v1.8.0 Skills used: …" as one bullet.
it.each(listLocalResumeTemplates().map((template) => template.id))(
  "puts a project's status and its skills on separate lines in %s",
  (templateId) => {
    const project = (
      summary: string,
      bullets: Array<{ id: string; text: string }> = [],
    ): ResumeRenderDocument["sections"][number]["entries"][number] => ({
      id: `project_${bullets.length}`,
      title: "Clip Tool",
      subtitle: null,
      location: null,
      dateRange: null,
      startDate: null,
      endDate: null,
      isCurrent: false,
      heading: null,
      summary,
      bullets,
    });
    const withProjects = structuredClone(document);
    withProjects.sections.push({
      id: "section_projects",
      kind: "projects",
      label: "Projects",
      text: null,
      bullets: [],
      entries: [
        // A long description reads as bullets.
        project(
          "A free game-clipping app.\nA rolling buffer keeps the last two minutes.\nShipped · v1.8.0\nSkills used: C++, Electron.",
        ),
        // With bullets of its own, the description stays a paragraph.
        project("A schedule tracker.\nLive on the web\nSkills used: Expo.", [
          { id: "b1", text: "Built discovery" },
          { id: "b2", text: "Built watchlists" },
        ]),
      ],
    });
    const html = renderResumeTemplateHtml({
      renderDocument: withProjects,
      settings,
      templateId,
    });
    expect(html).not.toMatch(/v1\.8\.0\.? Skills used/u);
    expect(html).not.toMatch(/Live on the web\.? Skills used/u);
    expect(html).toContain(">Shipped · v1.8.0.</li>");
    expect(html).toContain(">Skills used: C++, Electron.</li>");
    expect(html).toContain(
      ">A schedule tracker.<br />Live on the web<br />Skills used: Expo.</p>",
    );
  },
);
