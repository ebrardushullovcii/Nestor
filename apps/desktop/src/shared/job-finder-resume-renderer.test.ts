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
