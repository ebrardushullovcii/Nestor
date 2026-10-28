import type {
  JobFinderSettings,
  ResumeRenderDocument,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

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

it.each(["classic_ats", "modern_split", "technical_matrix"])(
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
  },
);
