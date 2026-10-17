import { completeTailoredResumeDraft } from "@nordri/ai-providers";
import { describe, expect, test } from "vitest";
import { sanitizeResumeDraft } from "./resume-workspace-helpers";
import { createSeed } from "../workspace-service.test-support";
import {
  buildResumeDraftFromTailoredDraft,
  buildResumeRenderDocument,
} from "./resume-workspace-structure";

function generate(startDate = "2017") {
  const seed = createSeed();
  const profile = {
    ...seed.profile,
    skills: [
      "Workday (basic)",
      "Excel (advanced)",
      "Articulate Rise (learning)",
      ...Array.from({ length: 24 }, (_, i) => `Saved skill ${i}`),
    ],
    experiences: [
      {
        ...seed.profile.experiences[0]!,
        companyName: null,
        title: "Freelance Writer",
        startDate,
        endDate: "2018",
        isCurrent: false,
        achievements: [
          "Mentored 5 engineers.",
          "Mentored 4 SDRs; two promoted to AE.",
          "Created an assessment rubric.",
          "Wrote captions for campaigns.",
          "Improved seasonal onboarding.",
          "Built learning materials.",
        ],
      },
    ],
    education: Array.from({ length: 4 }, (_, i) => ({
      ...seed.profile.education[0]!,
      id: `credential_${i}`,
      degree:
        i === 3 ? "Fachkraft für Lagerlogistik (IHK)" : `Qualification ${i}`,
      endDate: "2013",
    })),
    certifications: [
      {
        ...seed.profile.certifications[0]!,
        id: "green_belt",
        name: "Lean Six Sigma Green Belt",
        issueDate: "2017",
        expiryDate: null,
      },
      {
        ...seed.profile.certifications[0]!,
        id: "ils",
        name: "ILS renewed",
        issueDate: "2025",
        expiryDate: null,
      },
      {
        ...seed.profile.certifications[0]!,
        id: "mentorship",
        name: "Mentorship course",
        issueDate: "2019",
        expiryDate: null,
      },
      {
        ...seed.profile.certifications[0]!,
        id: "fourth",
        name: "Fourth qualification",
        issueDate: "2020",
        expiryDate: null,
      },
    ],
  };
  const job = seed.savedJobs[0]!;
  const generated = completeTailoredResumeDraft(
    {},
    {
      profile,
      job,
      settings: seed.settings,
      searchPreferences: {
        ...seed.searchPreferences,
        tailoringMode: "conservative",
      },
      resumeText: null,
    },
  );
  const draft = buildResumeDraftFromTailoredDraft({
    profile,
    job,
    draft: generated,
    templateId: seed.settings.resumeTemplateId,
    generationMethod: "ai",
    createdAt: "2026-10-05T00:00:00.000Z",
  });
  return {
    profile,
    generated,
    draft,
    rendered: buildResumeRenderDocument(
      profile,
      sanitizeResumeDraft({ draft, profile, job }),
    ),
  };
}

describe("Resume Studio source fact benchmark", () => {
  test("keeps every achievement and skill on the draft, showing the chosen ones", () => {
    const { profile, draft, rendered } = generate();
    // Nothing the person saved is lost: the lines the resume does not show
    // stay on the draft, hidden, for the person to show again.
    const draftLines = draft.sections.flatMap((section) => [
      ...section.bullets.map((bullet) => bullet.text),
      ...section.entries.flatMap((entry) =>
        entry.bullets.map((bullet) => bullet.text),
      ),
    ]);
    for (const fact of [
      ...profile.experiences[0]!.achievements,
      ...profile.skills,
    ])
      expect(draftLines).toContain(fact);
    // The resume itself shows a chosen subset, with proficiency kept whole.
    const text = JSON.stringify(rendered);
    expect(text).toContain("Workday (basic)");
    expect(
      profile.experiences[0]!.achievements.some((fact) => !text.includes(fact)),
    ).toBe(true);
  });
  test("keeps every qualification with its original year and record identity", () => {
    const { generated, rendered } = generate();
    expect(
      generated.certificationEntries.map((entry) => entry.profileRecordId),
    ).toEqual(["green_belt", "ils", "mentorship", "fourth"]);
    const text = JSON.stringify(rendered);
    for (const fact of [
      "Fachkraft für Lagerlogistik (IHK)",
      "2013",
      "2017",
      "2025",
      "2019",
      "Fourth qualification",
    ])
      expect(text).toContain(fact);
  });
  test("keeps seasonal date wording in the rendered document", () => {
    expect(JSON.stringify(generate("Summer 2017").rendered)).toContain(
      "Summer 2017",
    );
  });
  test("includes a saved freelance role without inventing its employer", () => {
    const { rendered } = generate();
    const role = rendered.sections.find(
      (section) => section.kind === "experience",
    )?.entries[0];
    expect(role).toMatchObject({
      title: "Freelance Writer",
      subtitle: null,
      dateRange: "2017 – 2018",
    });
  });
});
