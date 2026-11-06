import type { CandidateProfile } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createSeed } from "../test-fixtures";
import { isPlausibleAggressiveHeadline } from "./write-resume";

function profileWith(
  headline: string,
  titles: readonly string[],
  yearsExperience: number,
): CandidateProfile {
  const seed = createSeed().profile;
  const template = seed.experiences[0]!;
  return {
    ...seed,
    headline,
    yearsExperience,
    experiences: titles.map((title, index) => ({
      ...template,
      id: `experience_${index}`,
      title,
      isCurrent: index === 0,
    })),
  };
}

describe("aggressive headline policy", () => {
  it.each([
    ["Backend Engineer", "Principal Frontend Engineer", 12, false],
    ["Software Engineer", "Software Developer", 6, true],
    ["Lifecycle Marketing Manager", "Marketing Manager", 9, true],
    ["Instructional Designer", "Teacher", 8, true],
    ["Senior Software Engineer", "Software Engineer", 6, true],
    [
      "Senior AI Data & Analytics Engineer II",
      "Principal Frontend Engineer",
      15,
      true,
    ],
    ["Senior Software Engineer", "Software Engineer", 2, false],
    ["Engineering Manager", "Senior Software Engineer", 10, true],
    ["Director of Engineering", "Engineering Manager", 12, false],
    ["Registered Nurse", "Teacher", 10, false],
    ["Director Registered Nurse", "Teacher", 10, false],
    ["Director Data Analyst", "Data Science Student", 1, false],
    ["Junior Marketing Coordinator", "Marketing Director", 17, false],
    ["Backend Engineer", "Warehouse Operations Manager", 10, false],
  ])("%s for a %s (%i years) is %s", (target, ownTitle, years, expected) => {
    expect(
      isPlausibleAggressiveHeadline(
        target,
        profileWith(ownTitle, [ownTitle], years),
      ),
    ).toBe(expected);
  });
});

it.each(["Kenntnisse", "Compétences", "スキル"])(
  "carries %s to a skills section created during writing",
  async (label) => {
    const { applyResumeLanguage, collectResumeLanguageFields } =
      await import("../internal/resume-workspace-language");
    const { seedResumeDraft } =
      await import("../internal/resume-workspace-structure");
    const seed = createSeed();
    const draft = seedResumeDraft({
      profile: seed.profile,
      job: seed.savedJobs[0]!,
      templateId: seed.settings.resumeTemplateId,
    });
    const skills = draft.sections.find(
      (section) => section.id === "section_skills",
    )!;
    draft.sections = draft.sections.filter(
      (section) => section.id !== "section_additional_skills",
    );
    draft.sections.push({
      ...structuredClone(skills),
      id: "section_additional_skills",
      label: "Additional Skills",
    });
    expect(collectResumeLanguageFields(draft)).toContainEqual({
      id: "section_additional_skills:label",
      text: "Additional Skills",
    });
    const result = applyResumeLanguage(draft, {
      language: label,
      translations: [{ id: "section_skills:label", text: label }],
    });
    expect(result.sections.at(-1)!.label).toBe(label);
    const explicit = applyResumeLanguage(draft, {
      language: label,
      translations: [
        { id: "section_skills:label", text: label },
        { id: "section_additional_skills:label", text: `${label} +` },
      ],
    });
    expect(explicit.sections.at(-1)!.label).toBe(`${label} +`);
  },
);

it("detects restored source prose beside translated fields without assuming a language or script", async () => {
  const { hasUntranslatedResumeSourceProse } =
    await import("../internal/resume-workspace-language");
  const { seedResumeDraft } =
    await import("../internal/resume-workspace-structure");
  const seed = createSeed();
  const profile = {
    ...seed.profile,
    summary: "Built accessible public services with measurable results.",
  };
  const draft = seedResumeDraft({
    profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  draft.writtenLanguage = "German";
  expect(hasUntranslatedResumeSourceProse(draft, profile)).toBe(false);
  draft.sections[0]!.sourceRefs.push({
    id: "original",
    sourceKind: "resume",
    sourceId: `draft:${draft.id}:field:headline`,
    snippet: "Engineer",
  });
  expect(hasUntranslatedResumeSourceProse(draft, profile)).toBe(true);
  profile.summary = "";
  profile.experiences = [];
  profile.projects = [];
  expect(hasUntranslatedResumeSourceProse(draft, profile)).toBe(false);
});
